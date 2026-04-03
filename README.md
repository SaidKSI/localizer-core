# @saidksi/localizer-core

Core library for the Localizer i18n CLI tool. Provides AST-based string detection, AI-powered i18n key generation, code transformation, and validation.

## Features

- **Scanner**: AST-based detection of hardcoded strings in TypeScript/JavaScript code
- **AI Integration**: Provider-agnostic support for Anthropic and OpenAI APIs
- **Rewriter**: Automatic code transformation to replace hardcoded strings with i18n function calls
- **Validator**: Key coverage validation across multiple language files
- **Cache**: Smart caching to avoid re-processing unchanged files

## Installation

```bash
npm install @saidksi/localizer-core
# or
pnpm add @saidksi/localizer-core
```

## Quick Start

```typescript
import { Scanner, AIClient, Rewriter, Validator } from "@saidksi/localizer-core";

// 1. Scan for hardcoded strings
const scanner = new Scanner({ defaultLanguage: "en" });
const results = await scanner.scan("./src");

// 2. Generate keys and translations
const aiClient = new AIClient({
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const translations = await aiClient.generateTranslations(results);

// 3. Rewrite source code
const rewriter = new Rewriter();
const modified = await rewriter.rewrite(filePath, results[0], translations);

// 4. Validate translations
const validator = new Validator();
const coverage = await validator.validate("./messages");
```

## API

### Scanner

Detects hardcoded strings in source code:

```typescript
const scanner = new Scanner({
  defaultLanguage: "en",
  include: ["src/**/*.{ts,tsx,js,jsx}"],
  exclude: ["**/*.test.ts", "node_modules"],
  ignoreFiles: [],
});

const results = await scanner.scan(dirOrFilePath);
// Returns: ScanResult[] with { filePath, string, line, column, context }
```

### AIClient

Generates semantic i18n keys and translations:

```typescript
const client = new AIClient({
  provider: "anthropic" | "openai",
  apiKey: "your-api-key",
  model: "claude-3-sonnet" | "gpt-4",
});

const translations = await client.generateTranslations(scanResults, {
  languages: ["en", "fr", "es"],
  keyStyle: "dot.notation" | "snake_case",
  glossary: { /* domain-specific terms */ },
});
// Returns: { key: string, translations: { [lang]: string } }[]
```

### Rewriter

Transforms source code to use i18n function calls:

```typescript
const rewriter = new Rewriter();
const modified = await rewriter.rewrite(
  filePath,
  scanResult,
  translation,
  { 
    i18nLibrary: "react-i18next",
    dryRun: false,
  }
);
// Returns: { modified: string, diff: string }
```

### Validator

Validates translation coverage:

```typescript
const validator = new Validator({
  messagesDir: "./messages",
  languages: ["en", "fr"],
});

const report = await validator.validate();
// Returns coverage % per language and missing keys
```

## Configuration

Create a `.localizer.config.json` in your project root:

```json
{
  "defaultLanguage": "en",
  "languages": ["en", "fr", "es"],
  "messagesDir": "./messages",
  "include": ["src/**/*.{ts,tsx,js,jsx}"],
  "exclude": ["**/*.test.ts", "**/*.spec.ts"],
  "aiProvider": "anthropic",
  "aiModel": "claude-3-sonnet-20240229",
  "keyStyle": "dot.notation",
  "i18nLibrary": "react-i18next",
  "fileOrganization": "per-page",
  "strictMode": true,
  "glossary": {}
}
```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Tests
pnpm test
pnpm test:watch
pnpm test:coverage

# Type check
pnpm lint
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Repository

https://github.com/SaidKSI/localizer-core
