import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "path";
import { scanFile, buildScanReport } from "../../src/scanner/index.js";
import type { ScanResult } from "../../src/types.js";
import { makeConfig } from "../helpers/config.js";

describe("scanner", () => {
  const fixturesDir = resolve("tests/fixtures");
  const loginFixture = resolve(fixturesDir, "login.tsx");
  const falsePositivesFixture = resolve(fixturesDir, "false-positives.tsx");
  const alreadyTranslatedFixture = resolve(fixturesDir, "already-translated.tsx");

  const config = makeConfig();

  describe("scanFile", () => {
    it("scans login fixture and finds translatable strings", async () => {
      const results = await scanFile(loginFixture, config);

      expect(results.length).toBeGreaterThanOrEqual(4);
      const values = results.map((r) => r.value);
      expect(values).toContain("Welcome back");
      expect(values).toContain("Sign in to continue");
      expect(values).toContain("Enter your email");
      expect(values).toContain("Enter your password");
      expect(values).toContain("Sign in");
    });

    it("does not include href relative paths", async () => {
      const results = await scanFile(loginFixture, config);
      const values = results.map((r) => r.value);
      expect(values).not.toContain("/forgot-password");
    });

    it("does not include React Router Link 'to' attribute paths", async () => {
      // This test ensures that React Router's <Link to="/path" />
      // paths are not scanned as translatable text
      const results = await scanFile(loginFixture, config);
      const values = results.map((r) => r.value);
      // If there were any `to` attributes with paths, they should be filtered
      expect(values.every((v) => !v.startsWith("/"))).toBe(true);
    });

    it("includes file, line, column metadata", async () => {
      const results = await scanFile(loginFixture, config);
      const firstResult = results[0];

      expect(firstResult).toBeDefined();
      expect(firstResult?.file).toBe(loginFixture);
      expect(firstResult?.line).toBeGreaterThan(0);
      expect(firstResult?.column).toBeGreaterThanOrEqual(0);
    });

    it("filters false positives correctly", async () => {
      const results = await scanFile(falsePositivesFixture, config);
      const values = results.map((r) => r.value);

      // Should NOT include CSS classes, URLs, single chars, type attributes, or attributes
      expect(values).not.toContain("flex");
      expect(values).not.toContain("items-center");
      expect(values).not.toContain("justify-between");
      expect(values).not.toContain("bg-gray-100");
      expect(values).not.toContain("p-4");
      expect(values).not.toContain("A");
      expect(values).not.toContain("email");
      expect(values).not.toContain("https://example.com/logo.png");
      // data-testid and aria-label values are also filtered
    });

    it("does not flag already-translated strings", async () => {
      const results = await scanFile(alreadyTranslatedFixture, config);
      // All strings in this fixture are inside t() calls, so no results
      expect(results).toHaveLength(0);
    });

    it("includes nodeType in results", async () => {
      const results = await scanFile(loginFixture, config);
      const nodeTypes = results.map((r) => r.nodeType);

      // login.tsx has JSXText nodes
      expect(nodeTypes.length).toBeGreaterThan(0);
      expect(nodeTypes.every((t) => ["JSXText", "JSXAttribute"].includes(t))).toBe(
        true,
      );
    });

    it("includes context strings describing where string was found", async () => {
      const results = await scanFile(loginFixture, config);
      const firstResult = results[0];

      expect(firstResult?.context).toBeDefined();
      expect(typeof firstResult?.context).toBe("string");
      expect(firstResult?.context.length).toBeGreaterThan(0);
    });

    it("includes surroundingCode in results", async () => {
      const results = await scanFile(loginFixture, config);
      const firstResult = results[0];

      expect(firstResult?.surroundingCode).toBeDefined();
      expect(typeof firstResult?.surroundingCode).toBe("string");
    });

    it("marks alreadyTranslated as false for new strings", async () => {
      const results = await scanFile(loginFixture, config);
      expect(results.every((r) => r.alreadyTranslated === false)).toBe(true);
    });

    it("resolvedKey is null before translate step", async () => {
      const results = await scanFile(loginFixture, config);
      expect(results.every((r) => r.resolvedKey === null)).toBe(true);
    });
  });

  describe("buildScanReport", () => {
    it("creates a report from a single file scan", async () => {
      const report = await buildScanReport({ file: loginFixture }, config);

      expect(report).toBeDefined();
      expect(report.generatedAt).toBeDefined();
      expect(report.results).toBeDefined();
      expect(Array.isArray(report.results)).toBe(true);
      expect(report.file).toBe(loginFixture);
    });

    it("report includes scan results", async () => {
      const report = await buildScanReport({ file: loginFixture }, config);
      expect(report.results.length).toBeGreaterThanOrEqual(4);
    });

    it("generatedAt is a timestamp", async () => {
      const report = await buildScanReport({ file: loginFixture }, config);
      expect(new Date(report.generatedAt).getTime()).toBeGreaterThan(0);
    });
  });
});
