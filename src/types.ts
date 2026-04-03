// ─── Config ──────────────────────────────────────────────────────────────────

export type AIProvider = "anthropic" | "openai";
export type KeyStyle = "dot.notation" | "snake_case";
export type I18nLibrary =
  | "react-i18next"
  | "next-intl"
  | "react-intl"
  | "vue-i18n"
  | "i18next";

/**
 * Shape of .localizer.config.json in the user's project root.
 * Loaded via cosmiconfig from `.localizer.config.json` or the
 * `localizer` key in package.json.
 */
export interface LocalizerConfig {
  /** ISO 639-1 code. Source of truth for key extraction. */
  defaultLanguage: string;
  /** Target translation languages, e.g. ["fr", "ar", "es"]. */
  languages: string[];
  /** Directory where messages/[lang]/*.json files are written. */
  messagesDir: string;
  /** Directories to scan, e.g. ["./src", "./app"]. */
  include: string[];
  /** Glob patterns to skip, e.g. ["node_modules", "dist", "**\/*.test.*"]. */
  exclude: string[];
  /** Which AI provider to use. */
  aiProvider: AIProvider;
  /** Specific model string, e.g. "claude-sonnet-4-6". */
  aiModel: string;
  /** Format for generated key names. */
  keyStyle: KeyStyle;
  /** Target i18n library — affects rewrite output. */
  i18nLibrary: I18nLibrary;
  /** If true, re-translate keys that already exist in target JSONs. */
  overwriteExisting: boolean;
  /** If true, `validate` exits with code 1 on any untranslated string. */
  strictMode: boolean;
  /**
   * Enforced terminology per language.
   * e.g. { "fr": { "Settings": "Paramètres" } }
   */
  glossary: Record<string, Record<string, string>>;
  /** Additional glob patterns for strings to ignore during scanning. */
  ignorePatterns?: string[];
  /** File glob patterns to skip entirely, e.g. ["**\/*.stories.*"]. */
  ignoreFiles?: string[];
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

export type NodeType = "JSXText" | "JSXAttribute" | "TemplateLiteral" | "StringLiteral" | "JSXInterpolation";

/**
 * A variable embedded in a JSXInterpolation string.
 * e.g. "You have {{taskCount}} pending tasks" → { placeholder: "taskCount", expression: "taskCount" }
 */
export interface InterpolationVar {
  /** The placeholder name used inside {{...}} in the template */
  placeholder: string;
  /** The raw JSX expression source: "taskCount", "user.name", etc. */
  expression: string;
}

/**
 * A single hardcoded string detected by the scanner.
 * Carries enough context for the rewriter to locate and replace it.
 */
export interface ScanResult {
  /** Absolute path to the source file. */
  file: string;
  /** 1-based line number of the string in the source file. */
  line: number;
  /** 0-based column of the string start. */
  column: number;
  /** The raw string value, e.g. "Welcome back". */
  value: string;
  /** AST node type — determines which transform the rewriter applies. */
  nodeType: NodeType;
  /** Human-readable context, e.g. "JSXText inside <h1>". */
  context: string;
  /** Up to 5 lines of surrounding source code for AI prompt context. */
  surroundingCode: string;
  /** True if this string is already wrapped in a t() / i18n.t() call. */
  alreadyTranslated: boolean;
  /**
   * True if this string is at module level (outside any function/component).
   * Module-level strings cannot use t() — the hook is not available there.
   * The rewriter skips these; they appear in scan/translate output only.
   */
  isModuleLevel: boolean;
  /**
   * Resolved i18n key after the AI step.
   * null until translate has run.
   */
  resolvedKey: string | null;
  /**
   * For JSXInterpolation nodes — the variable substitutions in the template.
   * e.g. "You have {{taskCount}} pending tasks" → [{ placeholder: "taskCount", expression: "taskCount" }]
   */
  interpolations?: InterpolationVar[];
  /**
   * @internal Raw source text of all JSX children spanning this interpolation.
   * Used by the rewriter to locate and replace the full span. Not shown in reports.
   */
  rawSpan?: string;
  /**
   * @internal For object property values, the name of the parent object variable.
   * e.g. "statusConfig" for the "online" property in { online: "..." }
   * Used to group related object properties as siblings.
   */
  objectKey?: string;
}

/** Full output of a scan command run. */
export interface ScanReport {
  generatedAt: string;
  file?: string;
  dir?: string;
  results: ScanResult[];
}

// ─── AI ──────────────────────────────────────────────────────────────────────

/** Payload sent to an AI provider for a single unique string. */
export interface AIRequest {
  file: string;
  componentContext: string;
  element: string;
  surroundingCode: string;
  value: string;
  keyStyle: KeyStyle;
  /** Glossary entries relevant to this string, keyed by language. */
  glossary: Record<string, string>;
  targetLanguages: string[];
  /**
   * Other strings from the same component context (siblings).
   * Used to hint at consistent key naming.
   * e.g. ["Total views", "Total clicks", "Conversion rate"]
   */
  relatedStrings?: string[];
  /**
   * @internal Grouping key for finding siblings: "file:componentName"
   * Not sent to AI, used internally for post-processing.
   */
  contextKey?: string;
}

/** Parsed response from an AI provider. */
export interface AIResponse {
  key: string;
  /** Maps language code → translated string, e.g. { fr: "Se connecter" }. */
  translations: Record<string, string>;
}

// ─── Rewriter ────────────────────────────────────────────────────────────────

/** Outcome of rewriting a single source file. */
export interface RewriteResult {
  file: string;
  /** Whether the user confirmed and the file was actually written. */
  applied: boolean;
  /** Number of strings replaced. */
  changesCount: number;
  /** Unified diff string shown to the user before confirmation. */
  diff: string;
  /** The full modified source — caller writes this to disk after confirmation. */
  modifiedSource: string;
}

// ─── Validator ───────────────────────────────────────────────────────────────

/** Coverage report for a single target language. */
export interface ValidationResult {
  language: string;
  totalKeys: number;
  presentKeys: number;
  missingKeys: string[];
  coveragePercent: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

/** Single file record stored in .localizer/cache.json. */
export interface CacheEntry {
  /** SHA-256 hex digest of the file contents at processing time. */
  hash: string;
  processedAt: string;
  stringCount: number;
}

/** Full shape of .localizer/cache.json. */
export interface CacheStore {
  version: 1;
  /** Keyed by file path relative to the user's project root. */
  entries: Record<string, CacheEntry>;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/** Options shared across all CLI commands. */
export interface RunOptions {
  file?: string;
  dir?: string;
  /** Target languages override, e.g. ["fr", "ar"]. */
  lang?: string[];
  dryRun?: boolean;
  /** Skip confirmation prompts (apply all changes automatically). */
  yes?: boolean;
  /** Ignore cache and re-process all files. */
  force?: boolean;
  skipRewrite?: boolean;
  skipValidate?: boolean;
  /** Machine-readable mode — exits with code 1 on any failure. */
  ci?: boolean;
  /** Path to write a JSON report file. */
  output?: string;
}

/** Summary returned after a full `localizer run` pipeline. */
export interface PipelineResult {
  file?: string;
  dir?: string;
  /** Total strings detected by scanner. */
  scanned: number;
  /** Strings sent to AI and written to messages JSON. */
  translated: number;
  /** Source files rewritten. */
  rewritten: number;
  /** Whether the final validate step passed. */
  validated: boolean;
  durationMs: number;
  /** Estimated USD cost of AI calls made during this run. */
  aiCostUsd: number;
}
