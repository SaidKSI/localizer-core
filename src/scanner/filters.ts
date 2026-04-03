import type { LocalizerConfig } from "../types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_LENGTH = 2;

const URL_RE = /^(https?:\/\/|ftp:\/\/|mailto:|\/\/)/i;
const NUMERIC_RE = /^\d+(\.\d+)?(%|px|em|rem|vh|vw)?$/;
const RELATIVE_PATH_RE = /^\.\.?\//;
// Bare module specifier: "react", "@scope/pkg", "@scope/pkg/sub"
// Must start with lowercase or @ — avoids filtering user-facing words like "Password", "Settings"
const MODULE_SPECIFIER_RE = /^(@[\w-]+\/[\w.-]+|[a-z][\w-]*)(\/[\w./-]+)?$/;
// A single CSS utility token: "flex", "text-sm", "bg-gray-100", "sm:flex", "w-[100px]", "!important"
const CSS_TOKEN_RE = /^-?!?[a-z][a-z0-9]*([:-][a-z0-9]+)*(\[.+\])?(%)?$/;

/**
 * JSX attribute names whose string values are never user-facing text.
 * Strings in these attributes are silently skipped by the scanner.
 */
export const NON_TRANSLATABLE_ATTRS = new Set([
  "className",
  "class",
  "style",
  "href",
  "src",
  "srcSet",
  "srcset",
  "action",
  "method",
  "type",
  "id",
  "name",
  "key",
  "ref",
  "tabIndex",
  "tabindex",
  "htmlFor",
  "for",
  "target",
  "rel",
  "download",
  "accept",
  "pattern",
  "autoComplete",
  "autocomplete",
  "encType",
  "enctype",
  "role",
  "value",
  "data-testid",
  "data-cy",
  "data-test",
  "xmlns",
  "fill",
  "stroke",
  "viewBox",
  "d", // SVG path
]);

/** Translation function names — strings inside these calls are already translated. */
export const TRANSLATION_FNS = new Set([
  "t",
  "formatMessage",
  "$t",
  "i18n",
]);

/**
 * Functions that take default/placeholder values as arguments (not UI text to translate).
 * E.g., useState("John Doe") — "John Doe" is a default, should not be translated.
 */
export const STATE_INITIALIZATION_FNS = new Set([
  "useState",
  "useRef",
  "useReducer",
]);

// ─── Individual filter predicates (exported for unit testing) ─────────────────

export function isTooShort(value: string): boolean {
  return value.trim().length < MIN_LENGTH;
}

export function isPurelyNumeric(value: string): boolean {
  return NUMERIC_RE.test(value.trim());
}

export function isUrl(value: string): boolean {
  return URL_RE.test(value.trim());
}

export function isRelativePath(value: string): boolean {
  return RELATIVE_PATH_RE.test(value.trim());
}

export function isModuleSpecifier(value: string): boolean {
  return MODULE_SPECIFIER_RE.test(value.trim());
}

/**
 * Returns true if the string looks like a multi-token CSS class string,
 * e.g. "flex items-center bg-gray-100 p-4".
 * Single tokens are NOT flagged — "Settings" and "flex" both match the token
 * pattern but only a space-separated list of tokens is conclusively CSS.
 * Additionally, at least one token must contain a CSS indicator (hyphen, colon,
 * or bracket) to avoid filtering plain English phrases like "pending tasks".
 */
export function isCssClassString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length <= 1) return false;
  const hasCssIndicator = tokens.some((tok) => /[-:[\]]/.test(tok));
  return hasCssIndicator && tokens.every((tok) => CSS_TOKEN_RE.test(tok));
}

export function matchesIgnorePattern(
  value: string,
  patterns: string[],
): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false;
    }
  });
}

// ─── Composite filter ────────────────────────────────────────────────────────

/**
 * Returns true if this string value should be discarded (not a translatable string).
 * Applied after AST-level checks (translation call, console call, attr name).
 *
 * @param value The string to check
 * @param config The localization config
 * @param isJSX If true, skip MODULE_SPECIFIER_RE filter (for strings already inside JSX)
 */
export function shouldFilter(
  value: string,
  config: Pick<LocalizerConfig, "ignorePatterns">,
  isJSX: boolean = false,
): boolean {
  const trimmed = value.trim();
  return (
    isTooShort(trimmed) ||
    isPurelyNumeric(trimmed) ||
    isUrl(trimmed) ||
    isRelativePath(trimmed) ||
    (!isJSX && isModuleSpecifier(trimmed)) ||
    isCssClassString(trimmed) ||
    matchesIgnorePattern(trimmed, config.ignorePatterns ?? [])
  );
}
