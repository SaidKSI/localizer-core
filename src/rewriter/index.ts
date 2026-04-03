import { readFile, writeFile } from "fs/promises";
import { resolve, basename, extname } from "path";
import type { ScanResult, RewriteResult, LocalizerConfig } from "../types.js";
import { applyStringReplacements, getAdapter } from "./transforms.js";
import { ensureTranslationBoilerplate } from "./ts-morph.js";

// ─── Diff generation ─────────────────────────────────────────────────────────

/**
 * Generate a readable line-level diff between two source strings.
 * Shows changed lines with - / + prefixes and up to 2 lines of context.
 */
export function generateDiff(
  original: string,
  modified: string,
  filePath: string,
): string {
  if (original === modified) return "";

  const origLines = original.split("\n");
  const modLines = modified.split("\n");
  const output: string[] = [`--- ${filePath}`, `+++ ${filePath}`];

  // Collect all changed line indices
  const maxLen = Math.max(origLines.length, modLines.length);
  const changedLines = new Set<number>();
  for (let i = 0; i < maxLen; i++) {
    if (origLines[i] !== modLines[i]) changedLines.add(i);
  }

  // Build context windows (±2 lines around each change)
  const CONTEXT = 2;
  const toShow = new Set<number>();
  for (const idx of changedLines) {
    for (let c = Math.max(0, idx - CONTEXT); c <= Math.min(maxLen - 1, idx + CONTEXT); c++) {
      toShow.add(c);
    }
  }

  const sortedIndices = [...toShow].sort((a, b) => a - b);
  let prevIdx = -1;

  for (const i of sortedIndices) {
    // Show separator for gaps
    if (prevIdx !== -1 && i > prevIdx + 1) {
      output.push("@@");
    }
    prevIdx = i;

    const orig = origLines[i];
    const mod = modLines[i];

    if (orig === mod) {
      output.push(`  ${orig ?? ""}`);
    } else {
      if (orig !== undefined) output.push(`- ${orig}`);
      if (mod !== undefined) output.push(`+ ${mod}`);
    }
  }

  return output.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Rewrite a source file: replace hardcoded strings with t() calls,
 * add the i18n import and hook if missing.
 *
 * Does NOT write to disk — returns the modified source and diff.
 * The CLI layer handles confirmation and calls `applyRewrite` to persist.
 */
export async function rewriteFile(
  filePath: string,
  results: ScanResult[],
  config: LocalizerConfig,
): Promise<RewriteResult> {
  const absolute = resolve(filePath);
  const originalSource = await readFile(absolute, "utf-8");

  const resolved = results.filter((r) => r.resolvedKey !== null);

  if (resolved.length === 0) {
    return {
      file: absolute,
      applied: false,
      changesCount: 0,
      diff: "",
      modifiedSource: originalSource,
    };
  }

  const adapter = getAdapter(config.i18nLibrary);

  // Step 1: Replace hardcoded strings with t() calls (positional, text-based)
  const { modified: afterReplacements, count } = applyStringReplacements(
    originalSource,
    resolved,
    adapter,
  );

  // Step 2: Ensure import + hook are present (ts-morph structural edits)
  // Derive namespace from filename: Login.tsx → "login", home.tsx → "home"
  const namespace = basename(filePath, extname(filePath)).toLowerCase();
  const finalSource = ensureTranslationBoilerplate(
    afterReplacements,
    filePath,
    adapter,
    namespace,
  );

  const diff = generateDiff(originalSource, finalSource, filePath);

  return {
    file: absolute,
    applied: false,
    changesCount: count,
    diff,
    modifiedSource: finalSource,
  };
}

/**
 * Write the modified source from a RewriteResult to disk.
 * Call this after the user confirms the diff.
 * Returns the result with `applied: true`.
 */
export async function applyRewrite(result: RewriteResult): Promise<RewriteResult> {
  await writeFile(result.file, result.modifiedSource, "utf-8");
  return { ...result, applied: true };
}

/**
 * Rewrite multiple files. Each file is processed independently.
 * Results are returned in the same order as the input file list.
 */
export async function rewriteFiles(
  fileResultsMap: Map<string, ScanResult[]>,
  config: LocalizerConfig,
): Promise<RewriteResult[]> {
  const rewrites: RewriteResult[] = [];
  for (const [filePath, results] of fileResultsMap) {
    const rewrite = await rewriteFile(filePath, results, config);
    rewrites.push(rewrite);
  }
  return rewrites;
}

/**
 * Group a flat ScanResult[] by source file.
 * Useful before calling rewriteFiles.
 */
export function groupResultsByFile(
  results: ScanResult[],
): Map<string, ScanResult[]> {
  const map = new Map<string, ScanResult[]>();
  for (const result of results) {
    const existing = map.get(result.file);
    if (existing) {
      existing.push(result);
    } else {
      map.set(result.file, [result]);
    }
  }
  return map;
}
