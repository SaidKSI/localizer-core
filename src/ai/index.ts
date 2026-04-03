import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, basename, extname, join } from "path";
import type { ScanResult, AIResponse, LocalizerConfig, AIRequest } from "../types.js";
import { deduplicateResults, buildAIRequests, applyResolvedKeys } from "./dedup.js";
import { callAnthropic, estimateCost } from "./anthropic.js";
import { callOpenAI } from "./openai.js";
import { flattenKeys } from "../validator/index.js";

// ─── Key conflict resolution (flat key vs nested namespace) ──────────────────

/**
 * Detect and fix key namespace conflicts.
 *
 * When a flat key (e.g. "dashboard.admin_panel") is also a prefix of another
 * key (e.g. "dashboard.admin_panel.total_users"), JSON cannot represent it:
 * a value cannot be both a string leaf and an object node at the same path.
 *
 * Fix: append ".title" to the flat key so it becomes a leaf under the object.
 * "dashboard.admin_panel" → "dashboard.admin_panel.title"
 */
function resolveKeyConflicts(responses: Map<string, AIResponse>): void {
  const allKeys = Array.from(responses.values()).map((r) => r.key);

  for (const [value, response] of responses) {
    const key = response.key;
    const hasChildren = allKeys.some((k) => k !== key && k.startsWith(`${key}.`));
    if (hasChildren) {
      responses.set(value, {
        key: `${key}.title`,
        translations: response.translations,
      });
    }
  }
}

// ─── Key normalization (fix inconsistent namespaces for siblings) ───────────────

/**
 * Detect and fix key namespace inconsistencies for sibling strings.
 * If "Total views" and "Total clicks" get different namespace roots
 * (e.g., "dashboard.statistics" vs "dashboard.metrics"), normalize them.
 *
 * Strategy:
 *   1. Group keys by their contextKey (file + component)
 *   2. For each group, find the most common namespace prefix
 *   3. Apply it to all siblings with conflicting prefixes
 */
function normalizeConsistentKeys(
  requests: AIRequest[],
  responses: Map<string, AIResponse>,
): void {
  // Group requests by contextKey
  const byContext = new Map<string, AIRequest[]>();
  for (const req of requests) {
    const key = req.contextKey || `${req.file}:unknown`;
    if (!byContext.has(key)) byContext.set(key, []);
    byContext.get(key)!.push(req);
  }

  // For each context group, check for namespace inconsistencies
  for (const [, contextRequests] of byContext) {
    if (contextRequests.length < 2) continue; // No siblings to check

    // Collect all keys and their namespace roots
    const keysByRoot = new Map<string, { req: AIRequest; key: string }[]>();
    for (const req of contextRequests) {
      const response = responses.get(req.value);
      if (!response) continue;

      const key = response.key;
      const parts = key.split(".");
      const root = parts.length > 1 ? parts[0]! : key; // first segment = root

      if (!keysByRoot.has(root)) keysByRoot.set(root, []);
      keysByRoot.get(root)!.push({ req, key });
    }

    // If there are multiple roots (inconsistency), pick the most common one
    if (keysByRoot.size > 1) {
      const roots = Array.from(keysByRoot.entries());
      const mostCommon = roots.sort((a, b) => b[1].length - a[1].length)[0];
      if (!mostCommon) continue;

      const [dominantRoot, dominantEntries] = mostCommon;

      // Reassign keys with other roots to use the dominant root
      for (const [otherRoot, entries] of roots) {
        if (otherRoot === dominantRoot) continue;

        for (const { req, key } of entries) {
          const keyWithoutRoot = key.substring(otherRoot.length + 1); // remove root + dot
          const newKey = `${dominantRoot}.${keyWithoutRoot}`;

          // Update the response
          const oldResponse = responses.get(req.value);
          if (oldResponse) {
            responses.set(req.value, {
              key: newKey,
              translations: oldResponse.translations,
            });
          }
        }
      }
    }
  }
}

// ─── Messages JSON helpers ────────────────────────────────────────────────────

/** "src/pages/Login.tsx" → "login" */
function getPageName(filePath: string): string {
  return basename(filePath, extname(filePath)).toLowerCase();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep merge `source` into `target`.
 * When `overwrite` is false, existing leaf values in target are preserved.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  overwrite: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (key in result) {
      if (isPlainObject(result[key]) && isPlainObject(value)) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
          overwrite,
        );
      } else if (overwrite) {
        result[key] = value;
      }
      // If overwrite=false and key exists as a leaf → keep existing
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Expand a dot-notation key + value into a nested object.
 * "auth.sign_in_button", "Sign in" → { auth: { sign_in_button: "Sign in" } }
 * snake_case keys are stored flat.
 */
function expandKey(key: string, value: string): Record<string, unknown> {
  const parts = key.split(".");
  if (parts.length === 1) return { [key]: value };

  const result: Record<string, unknown> = {};
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
  return result;
}

/** Read existing messages JSON or return empty object if file doesn't exist. */
async function readMessagesFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Merge a set of (key → translation) pairs into a messages JSON file.
 * Creates the file and parent directories if they don't exist.
 */
async function mergeIntoMessagesFile(
  filePath: string,
  entries: Array<{ key: string; translation: string }>,
  overwrite: boolean,
): Promise<void> {
  const existing = await readMessagesFile(filePath);

  let merged = existing;
  for (const { key, translation } of entries) {
    const expanded = expandKey(key, translation);
    merged = deepMerge(merged, expanded, overwrite);
  }

  await mkdir(resolve(filePath, ".."), { recursive: true });
  await writeFile(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

// ─── Write translations to disk ──────────────────────────────────────────────

/**
 * Given resolved scan results, write all translations to the messages directory.
 * Groups by source file → writes to messages/{lang}/{pageName}.json.
 *
 * Returns the list of file paths written.
 */
async function writeTranslations(
  results: ScanResult[],
  responses: Map<string, AIResponse>,
  config: LocalizerConfig,
  options: { dryRun: boolean; overwrite: boolean },
): Promise<string[]> {
  // Group resolved results by source file
  const byFile = new Map<string, ScanResult[]>();
  for (const result of results) {
    if (!result.resolvedKey) continue;
    const existing = byFile.get(result.file);
    if (existing) {
      existing.push(result);
    } else {
      byFile.set(result.file, [result]);
    }
  }

  const writtenPaths: string[] = [];

  for (const [sourceFile, fileResults] of byFile) {
    const pageName = getPageName(sourceFile);
    const allLanguages = [config.defaultLanguage, ...config.languages];

    // Collect unique keys for this file (deduplicated by key)
    const seen = new Set<string>();
    const entries: Array<{ key: string; response: AIResponse }> = [];
    for (const result of fileResults) {
      const key = result.resolvedKey!;
      if (seen.has(key)) continue;
      seen.add(key);
      const response = responses.get(result.value);
      if (response) entries.push({ key, response });
    }

    for (const lang of allLanguages) {
      const messagesPath = join(
        resolve(config.messagesDir),
        lang,
        `${pageName}.json`,
      );

      // Build (key, translation) pairs for this language
      const langEntries = entries.map(({ key, response }) => ({
        key,
        // Default language gets the original string value
        translation:
          lang === config.defaultLanguage
            ? (response.translations[lang] ?? fileResults.find((r) => r.resolvedKey === key)?.value ?? "")
            : (response.translations[lang] ?? ""),
      }));

      if (!options.dryRun) {
        await mergeIntoMessagesFile(messagesPath, langEntries, options.overwrite);
      }

      writtenPaths.push(messagesPath);
    }
  }

  return writtenPaths;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface TranslateOptions {
  dryRun?: boolean;
  /** Override config.overwriteExisting for this run */
  overwrite?: boolean;
}

export interface TranslateResult {
  /** Scan results updated with resolvedKey populated */
  results: ScanResult[];
  /** Estimated USD cost of all AI calls made */
  aiCostUsd: number;
  /** Absolute paths of messages JSON files written (empty if dryRun) */
  messagesWritten: string[];
  /** Number of unique strings sent to AI */
  uniqueStrings: number;
  /** Number of AI calls actually made (may be less if some were already cached externally) */
  aiCalls: number;
}

/**
 * Translate a list of scan results using the configured AI provider.
 *
 * Steps:
 * 1. Deduplicate by string value
 * 2. Build AI requests (one per unique string)
 * 3. Call Anthropic or OpenAI
 * 4. Assign resolvedKey back to all results
 * 5. Write to messages/{lang}/{pageName}.json (unless dryRun)
 */
export async function translateStrings(
  scanResults: ScanResult[],
  config: LocalizerConfig,
  apiKey: string,
  options: TranslateOptions = {},
): Promise<TranslateResult> {
  const { dryRun = false, overwrite = config.overwriteExisting } = options;

  // Filter out already-translated strings
  const untranslated = scanResults.filter((r) => !r.alreadyTranslated);

  if (untranslated.length === 0) {
    return {
      results: scanResults,
      aiCostUsd: 0,
      messagesWritten: [],
      uniqueStrings: 0,
      aiCalls: 0,
    };
  }

  // 1. Deduplicate
  const groups = deduplicateResults(untranslated);
  const uniqueStrings = groups.size;

  // 2. Build requests (pass allResults to find sibling strings for consistent naming)
  const requests = buildAIRequests(groups, config, untranslated);

  // 3. Call AI provider
  let aiResponses: Map<string, AIResponse>;
  let totalCostUsd: number;

  if (config.aiProvider === "anthropic") {
    const result = await callAnthropic(requests, config.aiModel, apiKey);
    aiResponses = result.responses;
    totalCostUsd = result.totalCostUsd;
  } else {
    const result = await callOpenAI(requests, config.aiModel, apiKey);
    aiResponses = result.responses;
    totalCostUsd = result.totalCostUsd;
  }

  // 3.5. Normalize inconsistent key namespaces for sibling strings
  // CRITICAL: normalizeConsistentKeys must run BEFORE resolveKeyConflicts.
  // normalizeConsistentKeys may create parent keys that would conflict with existing child keys,
  // so resolveKeyConflicts must then fix those conflicts.
  normalizeConsistentKeys(requests, aiResponses);

  // 3.6. Fix flat-key vs nested-namespace conflicts (e.g. "admin_panel" + "admin_panel.total_users")
  resolveKeyConflicts(aiResponses);

  // 4. Assign resolved keys back to all results (including the already-translated ones)
  const valueToKey = new Map<string, string>();
  for (const [value, response] of aiResponses) {
    valueToKey.set(value, response.key);
  }
  const updatedResults = applyResolvedKeys(scanResults, valueToKey);

  // 5. Write translations to disk
  const messagesWritten = await writeTranslations(
    updatedResults,
    aiResponses,
    config,
    { dryRun, overwrite },
  );

  return {
    results: updatedResults,
    aiCostUsd: totalCostUsd,
    messagesWritten: dryRun ? [] : messagesWritten,
    uniqueStrings,
    aiCalls: aiResponses.size,
  };
}

// ─── Translate existing keys (--from-existing) ───────────────────────────────

export interface ExistingKeyEntry {
  /** The i18n key, e.g. "auth.sign_in_button" */
  key: string;
  /** The string value in the default language */
  value: string;
  /** Page name derived from the JSON filename, e.g. "login" */
  pageName: string;
}

export interface TranslateExistingResult {
  translated: number;
  aiCostUsd: number;
  messagesWritten: string[];
  /** Number of AI API calls made (one per unique string value) */
  aiCalls: number;
}

/**
 * Translate a list of existing (key, value, pageName) entries into target languages.
 * Used by `localizer translate --from-existing` and `localizer add-lang`.
 *
 * Skips entries that already have translations in target languages
 * unless `overwrite` is true.
 */
export async function translateExistingKeys(
  entries: ExistingKeyEntry[],
  config: LocalizerConfig,
  apiKey: string,
  options: { dryRun?: boolean; overwrite?: boolean; langs?: string[] } = {},
): Promise<TranslateExistingResult> {
  const {
    dryRun = false,
    overwrite = config.overwriteExisting,
    langs = config.languages,
  } = options;

  if (entries.length === 0) {
    return { translated: 0, aiCostUsd: 0, messagesWritten: [], aiCalls: 0 };
  }

  // ── Pre-filter when not overwriting (--missing-only) ──────────────────────
  // Read each target language's existing keys and discard entries that are
  // already present in ALL target languages. This avoids wasting AI calls on
  // keys that are fully covered — only keys missing from at least one language
  // are sent to the AI provider.
  let entriesToTranslate = entries;
  if (!overwrite) {
    // Build a map of lang → Set<"pageName.key"> for fast lookup
    const existingByLang = new Map<string, Set<string>>();
    const pages = new Set(entries.map((e) => e.pageName));

    await Promise.all(
      langs.map(async (lang) => {
        const keys = new Set<string>();
        for (const page of pages) {
          const filePath = join(resolve(config.messagesDir), lang, `${page}.json`);
          try {
            const raw = await readFile(filePath, "utf-8");
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            for (const k of flattenKeys(parsed)) keys.add(`${page}.${k}`);
          } catch { /* file not yet created — all keys are missing */ }
        }
        existingByLang.set(lang, keys);
      }),
    );

    entriesToTranslate = entries.filter((entry) =>
      // Keep if missing from at least one target language
      langs.some((lang) => !existingByLang.get(lang)?.has(`${entry.pageName}.${entry.key}`)),
    );

    if (entriesToTranslate.length === 0) {
      return { translated: 0, aiCostUsd: 0, messagesWritten: [], aiCalls: 0 };
    }
  }

  // Dedup by value — same string value gets one AI call
  const uniqueValues = [...new Set(entriesToTranslate.map((e) => e.value))];

  // Build one request per unique value
  const { buildTranslationOnlyPrompt, parseTranslationOnlyResponse } =
    await import("./prompts.js");

  const limit = (await import("p-limit")).default;
  const pLimit = limit(5);

  const valueToTranslations = new Map<string, Record<string, string>>();
  let totalCostUsd = 0;

  await Promise.all(
    uniqueValues.map((value) =>
      pLimit(async () => {
        // Build per-string glossary
        const glossary: Record<string, string> = {};
        for (const [lang, terms] of Object.entries(config.glossary)) {
          if (terms[value]) glossary[lang] = terms[value]!;
        }

        const prompt = buildTranslationOnlyPrompt(value, langs, glossary);

        try {
          if (config.aiProvider === "anthropic") {
            const { default: Anthropic } = await import("@anthropic-ai/sdk");
            const client = new Anthropic({ apiKey });
            const msg = await client.messages.create({
              model: config.aiModel,
              max_tokens: 512,
              messages: [{ role: "user", content: prompt }],
            });
            const raw =
              msg.content[0]?.type === "text" ? msg.content[0].text : "";
            const translations = parseTranslationOnlyResponse(raw);
            valueToTranslations.set(value, translations);
            totalCostUsd += estimateCost(config.aiModel, msg.usage.input_tokens, msg.usage.output_tokens);
          } else {
            const { default: OpenAI } = await import("openai");
            const client = new OpenAI({ apiKey });
            const res = await client.chat.completions.create({
              model: config.aiModel,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 512,
              response_format: { type: "json_object" },
            });
            const raw = res.choices[0]?.message.content ?? "";
            const translations = parseTranslationOnlyResponse(raw);
            valueToTranslations.set(value, translations);
            if (res.usage) {
              totalCostUsd +=
                (res.usage.prompt_tokens * 5 +
                  res.usage.completion_tokens * 15) /
                1_000_000;
            }
          }
        } catch (err) {
          console.error(
            `[localizer] Translation failed for "${value}": ${String(err)}`,
          );
        }
      }),
    ),
  );

  if (dryRun) {
    return {
      translated: valueToTranslations.size,
      aiCostUsd: totalCostUsd,
      messagesWritten: [],
      aiCalls: uniqueValues.length,
    };
  }

  // Write translations grouped by pageName (only the filtered entries)
  const writtenPaths: string[] = [];
  const byPage = new Map<string, ExistingKeyEntry[]>();
  for (const entry of entriesToTranslate) {
    const existing = byPage.get(entry.pageName) ?? [];
    existing.push(entry);
    byPage.set(entry.pageName, existing);
  }

  for (const [pageName, pageEntries] of byPage) {
    for (const lang of langs) {
      const filePath = join(resolve(config.messagesDir), lang, `${pageName}.json`);

      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(
          await readFile(filePath, "utf-8"),
        ) as Record<string, unknown>;
      } catch { /* new file */ }

      let merged = existing;
      for (const { key, value } of pageEntries) {
        const translations = valueToTranslations.get(value);
        const translation = translations?.[lang];
        if (!translation) continue;
        const expanded = expandKey(key, translation);
        merged = deepMerge(merged, expanded, overwrite);
      }

      await mkdir(resolve(filePath, ".."), { recursive: true });
      await writeFile(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
      writtenPaths.push(filePath);
    }
  }

  return {
    translated: entriesToTranslate.length,
    aiCostUsd: totalCostUsd,
    messagesWritten: writtenPaths,
    aiCalls: uniqueValues.length,
  };
}

// ─── API key validation ───────────────────────────────────────────────────────

/**
 * Send a minimal test request to verify an API key is valid.
 * Used by `localizer init` before saving the key to ~/.localizer.
 * Returns true if the key works, false otherwise.
 */
export async function validateApiKey(
  provider: LocalizerConfig["aiProvider"],
  model: string,
  apiKey: string,
): Promise<boolean> {
  try {
    if (provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });
      await client.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }],
      });
    } else {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey });
      await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 1,
      });
    }
    return true;
  } catch {
    return false;
  }
}

// Re-export for consumers that need lower-level access
export { deduplicateResults, buildAIRequests } from "./dedup.js";
export { buildTranslationPrompt, parseAIResponse } from "./prompts.js";
