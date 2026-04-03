import { basename, extname } from "path";
import type { ScanResult, AIRequest, LocalizerConfig } from "../types.js";

// ─── Component context ────────────────────────────────────────────────────────

/**
 * Derive a human-readable component description from a file path.
 * "src/pages/LoginPage.tsx" → "LoginPage component"
 */
function getComponentContext(filePath: string): string {
  const name = basename(filePath, extname(filePath));
  // PascalCase → spaced words: "LoginPage" → "Login Page"
  const spaced = name.replace(/([A-Z])/g, " $1").trim();
  return `${spaced} component`;
}

/**
 * Extract element description from a ScanResult context string.
 * "JSXText inside <h1>"           → "<h1>"
 * "\"placeholder\" attribute on <input>" → "<input>"
 * "Template literal"              → "template literal"
 */
function getElementFromContext(context: string): string {
  const match = context.match(/<([^>]+)>/);
  return match ? `<${match[1]}>` : context;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

/**
 * Group scan results by string value.
 * All results with the same value share one AI call.
 * The first result in each group provides context for the AI prompt.
 */
export function deduplicateResults(
  results: ScanResult[],
): Map<string, ScanResult[]> {
  const groups = new Map<string, ScanResult[]>();
  for (const result of results) {
    const existing = groups.get(result.value);
    if (existing) {
      existing.push(result);
    } else {
      groups.set(result.value, [result]);
    }
  }
  return groups;
}

/**
 * Derive a grouping key for finding sibling strings in the same component or object.
 * "src/pages/Dashboard.tsx" + null → "src/pages/Dashboard.tsx:dashboard"
 * "src/pages/Dashboard.tsx" + "statusConfig" → "src/pages/Dashboard.tsx:dashboard:statusConfig"
 *
 * For object properties, includes the object name so properties from the same
 * object are grouped together (e.g., statusConfig.online, statusConfig.offline).
 */
function getContextKey(filePath: string, objectKey?: string): string {
  const componentName = basename(filePath, extname(filePath)).toLowerCase();
  let key = `${filePath}:${componentName}`;
  if (objectKey) {
    key += `:${objectKey}`;
  }
  return key;
}

/**
 * Build one AIRequest per deduplicated group.
 * Uses the first (representative) ScanResult for context.
 * Includes related strings from the same component to guide consistent key naming.
 */
export function buildAIRequests(
  groups: Map<string, ScanResult[]>,
  config: LocalizerConfig,
  allResults?: ScanResult[],
): AIRequest[] {
  const requests: AIRequest[] = [];

  // Build a map of contextKey → all string values in that context
  // Used to find sibling strings
  const contextToValues = new Map<string, Set<string>>();
  if (allResults) {
    for (const result of allResults) {
      const contextKey = getContextKey(result.file, result.objectKey);
      if (!contextToValues.has(contextKey)) {
        contextToValues.set(contextKey, new Set());
      }
      contextToValues.get(contextKey)!.add(result.value);
    }
  }

  for (const [value, results] of groups) {
    const rep = results[0]!;
    const contextKey = getContextKey(rep.file, rep.objectKey);

    // Extract glossary entries relevant to this specific string
    const glossary: Record<string, string> = {};
    for (const [lang, terms] of Object.entries(config.glossary)) {
      const term = terms[value];
      if (term !== undefined) glossary[lang] = term;
    }

    // Find related strings (other strings in the same component, excluding self)
    const relatedStrings = allResults
      ? Array.from(contextToValues.get(contextKey) ?? [])
          .filter((v) => v !== value)
          .sort()
      : [];

    const request: AIRequest = {
      file: rep.file,
      componentContext: getComponentContext(rep.file),
      element: getElementFromContext(rep.context),
      surroundingCode: rep.surroundingCode,
      value,
      keyStyle: config.keyStyle,
      glossary,
      targetLanguages: config.languages,
      contextKey,
      ...(relatedStrings.length > 0 && { relatedStrings }),
    };

    requests.push(request);
  }

  return requests;
}

/**
 * Apply resolved keys back to all ScanResults.
 * All results with the same string value get the same key.
 */
export function applyResolvedKeys(
  results: ScanResult[],
  responses: Map<string, string>,
): ScanResult[] {
  return results.map((r) => ({
    ...r,
    resolvedKey: responses.get(r.value) ?? null,
  }));
}
