import { readFile, readdir } from "fs/promises";
import { resolve, join, basename, extname } from "path";
import type { ValidationResult, LocalizerConfig, ScanResult } from "../types.js";

// ─── Key flattening ───────────────────────────────────────────────────────────

/**
 * Flatten a nested JSON object into dot-notation key paths.
 *
 * { auth: { sign_in: "Sign in", title: "Login" } }
 * → ["auth.sign_in", "auth.title"]
 *
 * Exported for unit testing.
 */
export function flattenKeys(
  obj: Record<string, unknown>,
  prefix = "",
): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v)
    ) {
      keys.push(...flattenKeys(v as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

// ─── Messages file reading ────────────────────────────────────────────────────

/**
 * Read and parse a single messages JSON file.
 * Returns an empty object if the file doesn't exist or is invalid JSON.
 */
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
 * List all .json filenames inside a language directory.
 * Returns [] if the directory doesn't exist.
 */
async function listPageFiles(langDir: string): Promise<string[]> {
  try {
    const entries = await readdir(langDir);
    return entries.filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * Read all keys for a language by scanning every .json page file
 * in `messagesDir/{lang}/`.
 *
 * Returns a Map of pageName → Set<dotNotationKey>.
 */
export async function readLanguageKeys(
  messagesDir: string,
  lang: string,
): Promise<Map<string, Set<string>>> {
  const langDir = join(resolve(messagesDir), lang);
  const pageFiles = await listPageFiles(langDir);
  const result = new Map<string, Set<string>>();

  await Promise.all(
    pageFiles.map(async (filename) => {
      const pageName = basename(filename, extname(filename));
      const filePath = join(langDir, filename);
      const json = await readMessagesFile(filePath);
      result.set(pageName, new Set(flattenKeys(json)));
    }),
  );

  return result;
}

/**
 * Merge all per-page key sets into a single flat Set<string>.
 * Used when validating total coverage without caring about pages.
 */
function mergeKeyMaps(pageKeys: Map<string, Set<string>>): Set<string> {
  const all = new Set<string>();
  for (const keys of pageKeys.values()) {
    for (const k of keys) all.add(k);
  }
  return all;
}

// ─── Validation logic ─────────────────────────────────────────────────────────

/**
 * Compute validation result for a single target language.
 * Compares its keys against the default language's keys.
 */
function computeValidationResult(
  lang: string,
  defaultKeys: Set<string>,
  langKeys: Set<string>,
): ValidationResult {
  const missingKeys: string[] = [];
  for (const key of defaultKeys) {
    if (!langKeys.has(key)) missingKeys.push(key);
  }

  const totalKeys = defaultKeys.size;
  const presentKeys = totalKeys - missingKeys.length;
  const coveragePercent =
    totalKeys === 0 ? 100 : Math.round((presentKeys / totalKeys) * 100);

  return {
    language: lang,
    totalKeys,
    presentKeys,
    missingKeys,
    coveragePercent,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /** Check only this language instead of all target languages */
  lang?: string;
  /**
   * Restrict validation to a single page file derived from the source filename.
   *
   * Source file → page name → JSON file (all languages):
   *   src/pages/Login.tsx    →  "login"  →  messages/{lang}/login.json
   *   app/checkout/page.tsx  →  "page"   →  messages/{lang}/page.json
   *
   * Pass the page name (no extension), not the full source path.
   * The CLI derives it via: basename(file, extname(file)).toLowerCase()
   */
  page?: string;
}

/**
 * Validate key coverage across all target languages.
 *
 * Reads all messages/{lang}/*.json files and computes:
 * - Which keys are present in the default language
 * - Which of those keys are missing in each target language
 * - Coverage percentage per language
 *
 * Always includes the default language in the result (always 100%).
 */
export async function validateCoverage(
  config: LocalizerConfig,
  options: ValidateOptions = {},
): Promise<ValidationResult[]> {
  const { messagesDir, defaultLanguage, languages } = config;

  // Read default language keys
  const defaultPageKeys = await readLanguageKeys(messagesDir, defaultLanguage);

  // If scoped to a specific page, narrow both sides
  const effectiveDefaultKeys =
    options.page
      ? (defaultPageKeys.get(options.page) ?? new Set<string>())
      : mergeKeyMaps(defaultPageKeys);

  // Determine which languages to check
  const targetLanguages =
    options.lang
      ? languages.filter((l) => l === options.lang)
      : languages;

  const results: ValidationResult[] = [];

  // Default language is always 100% — include it first
  results.push({
    language: defaultLanguage,
    totalKeys: effectiveDefaultKeys.size,
    presentKeys: effectiveDefaultKeys.size,
    missingKeys: [],
    coveragePercent: 100,
  });

  // Check each target language
  await Promise.all(
    targetLanguages.map(async (lang) => {
      if (lang === defaultLanguage) return; // already added above

      const langPageKeys = await readLanguageKeys(messagesDir, lang);

      const effectiveLangKeys =
        options.page
          ? (langPageKeys.get(options.page) ?? new Set<string>())
          : mergeKeyMaps(langPageKeys);

      results.push(
        computeValidationResult(lang, effectiveDefaultKeys, effectiveLangKeys),
      );
    }),
  );

  // Sort: default language first, then alphabetical
  return results.sort((a, b) => {
    if (a.language === defaultLanguage) return -1;
    if (b.language === defaultLanguage) return 1;
    return a.language.localeCompare(b.language);
  });
}

/**
 * Returns true if all target languages have 100% key coverage.
 * Convenience wrapper used by `localizer run` to decide the final status line.
 */
export async function isFullyCovered(
  config: LocalizerConfig,
): Promise<boolean> {
  const results = await validateCoverage(config);
  return results.every((r) => r.coveragePercent === 100);
}

// ─── Key resolution (used by rewrite command) ─────────────────────────────────

/**
 * Flatten a nested JSON object to a value→key reverse-lookup map.
 * Used to recover resolvedKey from messages JSON when rewrite runs standalone.
 *
 * { auth: { sign_in: "Sign in" } } → Map { "Sign in" → "auth.sign_in" }
 *
 * Note: if multiple keys have the same value, the last one wins.
 */
function buildValueToKeyMap(
  obj: Record<string, unknown>,
  prefix = "",
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      for (const [val, key] of buildValueToKeyMap(
        v as Record<string, unknown>,
        fullKey,
      )) {
        map.set(val, key);
      }
    } else if (typeof v === "string") {
      map.set(v, fullKey);
    }
  }
  return map;
}

/**
 * Populate `resolvedKey` on each ScanResult by looking up the string value
 * in the default language messages JSON for that page.
 *
 * Called by `localizer rewrite` when run standalone (after `localizer translate`
 * has already written the messages JSON).
 *
 * Results whose value cannot be found in the JSON are returned unchanged
 * (resolvedKey stays null — they will be skipped by the rewriter).
 */
export async function resolveKeysFromMessages(
  results: ScanResult[],
  config: LocalizerConfig,
): Promise<ScanResult[]> {
  // Build a cache of page → value→key map to avoid re-reading files
  const pageCache = new Map<string, Map<string, string>>();

  async function getValueToKey(pageName: string): Promise<Map<string, string>> {
    if (pageCache.has(pageName)) return pageCache.get(pageName)!;

    const filePath = join(
      resolve(config.messagesDir),
      config.defaultLanguage,
      `${pageName}.json`,
    );
    try {
      const content = await readFile(filePath, "utf-8");
      const map = buildValueToKeyMap(
        JSON.parse(content) as Record<string, unknown>,
      );
      pageCache.set(pageName, map);
      return map;
    } catch {
      const empty = new Map<string, string>();
      pageCache.set(pageName, empty);
      return empty;
    }
  }

  return Promise.all(
    results.map(async (r) => {
      if (r.resolvedKey !== null) return r; // already resolved
      const pageName = basename(r.file, extname(r.file)).toLowerCase();
      const valueToKey = await getValueToKey(pageName);
      const key = valueToKey.get(r.value) ?? null;
      return { ...r, resolvedKey: key };
    }),
  );
}

/**
 * Compute a diff of missing keys for a single language relative to the default.
 * Used by `localizer diff --lang ar`.
 */
export async function getMissingKeys(
  config: LocalizerConfig,
  lang: string,
  page?: string,
): Promise<string[]> {
  const options: ValidateOptions = { lang };
  if (page) options.page = page;
  const results = await validateCoverage(config, options);
  return results.find((r) => r.language === lang)?.missingKeys ?? [];
}
