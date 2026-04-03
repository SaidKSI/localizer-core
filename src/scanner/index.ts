import { readFile } from "fs/promises";
import { resolve, extname } from "path";
import fg from "fast-glob";
import type { ScanResult, ScanReport, LocalizerConfig } from "../types.js";
import { scanWithBabel } from "./babel.js";
import { scanWithTypeScript } from "./typescript.js";

// ─── Extension routing ───────────────────────────────────────────────────────

const BABEL_EXTS = new Set([".js", ".jsx"]);
const TS_EXTS = new Set([".ts", ".tsx"]);

function isSupportedFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return BABEL_EXTS.has(ext) || TS_EXTS.has(ext);
}

function routeFile(
  filePath: string,
  source: string,
  config: LocalizerConfig,
): ScanResult[] {
  const ext = extname(filePath).toLowerCase();
  if (BABEL_EXTS.has(ext)) return scanWithBabel(filePath, source, config);
  if (TS_EXTS.has(ext)) return scanWithTypeScript(filePath, source, config);
  return [];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan a single file for hardcoded strings.
 * Returns an empty array if the file extension is not supported.
 */
export async function scanFile(
  filePath: string,
  config: LocalizerConfig,
): Promise<ScanResult[]> {
  const absolute = resolve(filePath);
  if (!isSupportedFile(absolute)) return [];

  const source = await readFile(absolute, "utf-8");
  return routeFile(absolute, source, config);
}

/**
 * Scan a list of files and return all results, flattened.
 */
export async function scanFiles(
  filePaths: string[],
  config: LocalizerConfig,
): Promise<ScanResult[]> {
  const results = await Promise.all(
    filePaths.map((f) => scanFile(f, config)),
  );
  return results.flat();
}

/**
 * Scan all supported files inside a directory, respecting config.exclude patterns.
 */
export async function scanDirectory(
  dir: string,
  config: LocalizerConfig,
): Promise<ScanResult[]> {
  const patterns = [
    `${dir}/**/*.{js,jsx,ts,tsx}`,
  ];

  const ignorePatterns = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    ...config.exclude,
  ];

  const files = await fg(patterns, {
    ignore: ignorePatterns,
    absolute: true,
    onlyFiles: true,
  });

  return scanFiles(files, config);
}

/**
 * Build a structured ScanReport from a file or directory scan.
 */
export async function buildScanReport(
  options: { file?: string; dir?: string },
  config: LocalizerConfig,
): Promise<ScanReport> {
  let results: ScanResult[] = [];

  if (options.file) {
    results = await scanFile(options.file, config);
  } else if (options.dir) {
    results = await scanDirectory(options.dir, config);
  }

  const report: ScanReport = {
    generatedAt: new Date().toISOString(),
    results,
  };

  if (options.file) report.file = options.file;
  if (options.dir) report.dir = options.dir;

  return report;
}
