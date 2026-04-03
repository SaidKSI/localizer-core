import { createHash } from "crypto";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { resolve, join } from "path";
import type { CacheStore, CacheEntry } from "../types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_DIR = ".localizer";
const CACHE_FILE = "cache.json";
const CURRENT_VERSION = 1 as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCachePath(projectRoot: string): string {
  return join(resolve(projectRoot), CACHE_DIR, CACHE_FILE);
}

function emptyStore(): CacheStore {
  return { version: CURRENT_VERSION, entries: {} };
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hex digest of a string (file source contents).
 * Exported for unit testing.
 */
export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf-8").digest("hex");
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

/**
 * Read the cache store from `{projectRoot}/.localizer/cache.json`.
 * Returns an empty store if the file doesn't exist or is unreadable.
 */
export async function readCache(projectRoot: string): Promise<CacheStore> {
  const cachePath = getCachePath(projectRoot);
  try {
    const content = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(content) as CacheStore;
    // Invalidate on version mismatch
    if (parsed.version !== CURRENT_VERSION) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

/**
 * Persist the cache store to `{projectRoot}/.localizer/cache.json`.
 * Creates the `.localizer/` directory if it doesn't exist.
 */
export async function writeCache(
  projectRoot: string,
  store: CacheStore,
): Promise<void> {
  const cachePath = getCachePath(projectRoot);
  await mkdir(join(resolve(projectRoot), CACHE_DIR), { recursive: true });
  await writeFile(cachePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

/**
 * Delete the cache file entirely.
 * Used by `localizer run --force` to trigger a full re-process.
 */
export async function clearCache(projectRoot: string): Promise<void> {
  const cachePath = getCachePath(projectRoot);
  try {
    await unlink(cachePath);
  } catch {
    // Already gone — that's fine
  }
}

// ─── Cache checks ─────────────────────────────────────────────────────────────

/**
 * Check whether a file (identified by its path and current source contents)
 * has already been processed and hasn't changed since.
 *
 * @param store   The loaded CacheStore
 * @param relPath File path relative to project root (used as the cache key)
 * @param source  Current file contents
 */
export function isCached(
  store: CacheStore,
  relPath: string,
  source: string,
): boolean {
  const entry = store.entries[relPath];
  if (!entry) return false;
  return entry.hash === hashSource(source);
}

/**
 * Record that a file has been successfully processed.
 * Returns a new CacheStore with the entry upserted (immutable update).
 *
 * @param store       The current CacheStore
 * @param relPath     File path relative to project root
 * @param source      File contents at time of processing
 * @param stringCount Number of strings processed in this file
 */
export function markCached(
  store: CacheStore,
  relPath: string,
  source: string,
  stringCount: number,
): CacheStore {
  const entry: CacheEntry = {
    hash: hashSource(source),
    processedAt: new Date().toISOString(),
    stringCount,
  };
  return {
    ...store,
    entries: { ...store.entries, [relPath]: entry },
  };
}

/**
 * Remove a single file's entry from the cache.
 * Returns a new CacheStore (immutable update).
 */
export function evictEntry(store: CacheStore, relPath: string): CacheStore {
  const { [relPath]: _, ...rest } = store.entries;
  return { ...store, entries: rest };
}

// ─── Batch helpers ────────────────────────────────────────────────────────────

/**
 * Filter a list of file paths down to those that are NOT in the cache
 * (or whose contents have changed since last processing).
 *
 * @param store     Loaded CacheStore
 * @param files     Array of { relPath, source } objects
 */
export function filterUncached(
  store: CacheStore,
  files: Array<{ relPath: string; source: string }>,
): Array<{ relPath: string; source: string }> {
  return files.filter(({ relPath, source }) => !isCached(store, relPath, source));
}

/**
 * Apply a batch of processed files to the cache store.
 * Returns a new CacheStore with all entries upserted.
 */
export function markBatchCached(
  store: CacheStore,
  processed: Array<{ relPath: string; source: string; stringCount: number }>,
): CacheStore {
  let updated = store;
  for (const { relPath, source, stringCount } of processed) {
    updated = markCached(updated, relPath, source, stringCount);
  }
  return updated;
}
