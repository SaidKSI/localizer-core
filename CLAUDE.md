# CLAUDE.md - @saidksi/localizer-core

Core library for the Localizer i18n CLI tool. This is a **public npm package** (`@saidksi/localizer-core`) that provides the business logic for AST scanning, AI-powered key generation, code transformation, and validation.

---

## Project Overview

**@saidksi/localizer-core** is a standalone, reusable library that:
- Detects hardcoded strings in TypeScript/JavaScript code (AST-based)
- Generates semantic i18n key names via AI (Anthropic or OpenAI)
- Transforms source code to replace strings with i18n function calls
- Validates translation key coverage across language files
- Caches file hashes to avoid re-processing unchanged code

**Status:** V0.1.0 — Core logic complete. Ready to publish to npm.

**Package:** `@saidksi/localizer-core@0.1.0` (npm)
**Repository:** https://github.com/SaidKSI/localizer-core
**GitHub Actions:** ✅ CI + Auto-publish on tags (v*)

---

## Build Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript to dist/
pnpm test             # Run unit tests (Vitest)
pnpm test:coverage    # Coverage report
pnpm lint             # Type check
pnpm clean            # Remove dist/
```

---

## Architecture

### Directory Structure

```
src/
├── types.ts              # All shared TypeScript interfaces
├── scanner/
│   ├── index.ts         # Main Scanner class
│   ├── typescript.ts    # TypeScript Compiler API handler
│   ├── babel.ts         # Babel parser handler
│   └── filters.ts       # String filtering logic
├── ai/
│   ├── index.ts         # AIClient class
│   ├── prompts.ts       # Anthropic/OpenAI prompts
│   ├── dedup.ts         # String deduplication before AI calls
│   ├── anthropic.ts     # Anthropic SDK integration
│   └── openai.ts        # OpenAI SDK integration
├── rewriter/
│   ├── index.ts         # Rewriter class
│   ├── ts-morph.ts      # ts-morph integration
│   └── transforms.ts    # AST transformation logic
├── validator/
│   └── index.ts         # Validator class (key coverage)
└── cache/
    └── index.ts         # Cache read/write logic

tests/
├── fixtures/            # Test .tsx files
│   ├── login.tsx
│   ├── already-translated.tsx
│   └── false-positives.tsx
```

### Exported API

```typescript
// Scanner
export { Scanner, type ScanResult, type ScanConfig } from "./scanner/index.js";

// AI
export { AIClient, type AIClientConfig, type TranslationResult } from "./ai/index.js";

// Rewriter
export { Rewriter, type RewriterConfig } from "./rewriter/index.js";

// Validator
export { Validator, type ValidatorConfig, type CoverageReport } from "./validator/index.js";

// Cache
export { Cache, type CacheEntry } from "./cache/index.js";

// Types (shared)
export type { ScanResult, Config, TranslationKey } from "./types.js";
```

---

## Key Constraints & Patterns

### TypeScript & Code Quality
- **Strict mode enabled** everywhere — `"strict": true` in tsconfig.json
- **No `any` types** — all types must be explicit
- **ESM only** — `import`/`export`, never `require()`
- **async/await only** — no callbacks or `.then()` chains
- **No unhandled promises** — all async operations awaited or caught

### Testing
- **Vitest** (not Jest) — native ESM support, fast in monorepos
- **No mocks for real code** — mock only at SDK boundaries (Anthropic, OpenAI APIs)
- **Fixture-based tests** — use real `.tsx` files in `tests/fixtures/`
- Test patterns: `packages/core/tests/[module]/[file].test.ts`

### Functionality Constraints
- **Never modify files silently** — all transforms must show a diff
- **AI is optional** — Scanner never requires AI; caching is optional
- **Merge, never overwrite** — existing JSON keys are preserved unless `overwriteExisting: true`
- **Respect `.gitignore`** — scanner skips gitignored paths

### External Dependencies
- `@babel/parser`, `@babel/traverse`, `@babel/types` — JS/JSX parsing
- `typescript` — TS Compiler API for .ts/.tsx
- `ts-morph` — AST manipulation and code generation
- `@anthropic-ai/sdk` — Anthropic API
- `openai` — OpenAI API
- `p-limit` — concurrency control (max 5 concurrent AI calls)
- `fast-glob` — file globbing

---

## Key Modules

### Scanner

Detects hardcoded strings in source code.

**Inputs:** File paths or directory patterns
**Outputs:** `ScanResult[]` with `{ filePath, string, line, column, context }`

**Features:**
- TypeScript Compiler API for .ts/.tsx
- Babel for .js/.jsx
- Filters false positives: < 2 chars, URLs, CSS classes, already-translated strings, etc.

**Key Function:**
```typescript
const scanner = new Scanner(config);
const results = await scanner.scan("./src");
```

### AI Client

Generates semantic i18n keys and translations via Anthropic or OpenAI.

**Inputs:** `ScanResult[]`, target languages, key style (dot.notation | snake_case)
**Outputs:** `{ key: string, translations: { [lang]: string } }[]`

**Features:**
- Provider-agnostic (Anthropic/OpenAI)
- Deduplicates identical strings before API calls
- Max 5 concurrent requests via `p-limit`
- Includes file context in prompts for better naming

**Key Function:**
```typescript
const aiClient = new AIClient({ provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY });
const translations = await aiClient.generateTranslations(scanResults, { languages: ["en", "fr"] });
```

### Rewriter

Transforms source code to use i18n function calls.

**Inputs:** File path, `ScanResult`, `TranslationResult`
**Outputs:** `{ modified: string, diff: string }`

**Features:**
- Uses `ts-morph` for reliable AST manipulation
- Auto-adds `useTranslation` import if missing
- Returns modified source (caller decides whether to write)
- Supports fallback to `jscodeshift` for plain JS

**Key Function:**
```typescript
const rewriter = new Rewriter();
const { modified, diff } = await rewriter.rewrite(filePath, scanResult, translation);
```

### Validator

Validates translation key coverage across language files.

**Inputs:** Messages directory, language list
**Outputs:** Coverage % per language, missing keys per language

**Features:**
- Compares keys across all language JSONs
- Reports coverage gaps
- Can exit with error in strict mode

**Key Function:**
```typescript
const validator = new Validator({ messagesDir: "./messages", languages: ["en", "fr"] });
const report = await validator.validate();
// → { en: { coverage: 100 }, fr: { coverage: 95, missingKeys: ["..." ] } }
```

### Cache

Smart caching to avoid re-processing unchanged files.

**Storage:** `.localizer/cache.json` (in user's project root)
**Key:** File path → SHA-256 hash + last scan metadata

**Features:**
- Skips unchanged files unless `--force` flag
- Persists across runs
- User can manually clear `.localizer/`

---

## Common Patterns

### Configuration via TypeScript Interfaces

All modules accept config objects:

```typescript
interface ScanConfig {
  defaultLanguage: string;
  include: string[];
  exclude: string[];
  ignoreFiles: string[];
}

interface AIClientConfig {
  provider: "anthropic" | "openai";
  apiKey: string;
  model?: string;
}

interface RewriterConfig {
  i18nLibrary: string;
  dryRun?: boolean;
}
```

### Error Handling

Use explicit error types:

```typescript
try {
  const results = await scanner.scan(path);
} catch (error) {
  if (error instanceof ScanError) {
    console.error("Scan failed:", error.message);
  }
  throw error;
}
```

### Concurrency Control

Use `p-limit` for rate-limiting:

```typescript
import pLimit from "p-limit";

const limit = pLimit(5); // Max 5 concurrent
const promises = items.map(item => limit(() => apiCall(item)));
await Promise.all(promises);
```

---

## Development Workflow

### Adding a New Module

1. Create `src/[module]/index.ts` with main class
2. Export types in `src/types.ts`
3. Add tests in `tests/[module]/[file].test.ts`
4. Import and test locally
5. Update root exports in `src/index.ts`

### Testing

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage
pnpm test:coverage
```

### Building for npm

```bash
# Type check
pnpm lint

# Build (outputs to dist/)
pnpm build

# Publish (once API is stable)
npm publish
```

---

## Publishing to npm

**Current Status:** Ready to publish! ✅

**How Publishing Works:**
1. Tag a release: `git tag v0.1.0` 
2. Push tag: `git push origin v0.1.0`
3. GitHub Actions automatically:
   - Builds the package with `pnpm build`
   - Verifies output in `dist/`
   - Publishes to npm using `NPM_TOKEN` secret
   - You can watch at: https://github.com/SaidKSI/localize-core/actions

**Package Details:**
- **Name:** `@saidksi/localizer-core`
- **Version:** `0.1.0`
- **npm:** https://www.npmjs.com/package/@saidksi/localizer-core
- **Type:** ESM module
- **Exports:** `.` (default), `./types` (type definitions)
- **Files:** `dist/` only (source excluded)

**GitHub Secrets Required:**
- `NPM_TOKEN` — npm automation token (already configured)

---

## Confirmed Architecture Decisions

- **Testing Framework:** Vitest (not Jest) — native ESM, fast in monorepos
- **Code Generation:** ts-morph primary, jscodeshift fallback
- **Concurrency:** `p-limit` with max 5 concurrent AI calls
- **File Organization:** Per-page structure (messages/en/login.json)
- **API Keys:** Global `~/.localizer` (not per-project .env)
- **Merge Strategy:** New keys merged into existing JSON (never overwrite unless explicit flag)

---

## Related Repos

- **localizer-cli** — CLI app that uses this core library
  - Repo: https://github.com/SaidKSI/localizer-cli
  - Depends on: `@saidksi/localizer-core@^0.1.0` (npm)
  - Status: Ready to publish after core is available

- **localizer-sample-app** — Testing app for CLI
  - Repo: https://github.com/SaidKSI/localizer-sample-app
  - Framework: React 18 + Vite + TypeScript
  - 40+ hardcoded strings for CLI testing
  - Languages: en, fr, es (empty JSONs ready for translation)

- **localizer-dashboard** (Phase 2, private)
  - Will depend on `@saidksi/localizer-core`
  - Handles auth, billing, UI

---

## Key Contacts & Resources

- **GitHub Issues:** https://github.com/SaidKSI/localizer-core/issues
- **npm Package:** https://www.npmjs.com/package/@saidksi/localizer-core
- **GitHub Actions:** https://github.com/SaidKSI/localizer-core/actions
- **Author:** SaidKSI
- **License:** MIT
