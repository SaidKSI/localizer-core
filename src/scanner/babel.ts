import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import type { ScanResult, NodeType, LocalizerConfig, InterpolationVar } from "../types.js";
import { shouldFilter, NON_TRANSLATABLE_ATTRS, TRANSLATION_FNS, STATE_INITIALIZATION_FNS } from "./filters.js";

// @babel/traverse ships CJS; handle both interop shapes
const traverse =
  typeof (_traverse as any).default === "function"
    ? (_traverse as any).default
    : (_traverse as any);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSurroundingLines(lines: string[], zeroBasedLine: number): string {
  const start = Math.max(0, zeroBasedLine - 2);
  const end = Math.min(lines.length - 1, zeroBasedLine + 2);
  return lines.slice(start, end + 1).join("\n");
}

function getJSXElementName(node: t.JSXOpeningElement): string {
  if (t.isJSXIdentifier(node.name)) return node.name.name;
  if (t.isJSXMemberExpression(node.name)) {
    const obj = t.isJSXIdentifier(node.name.object)
      ? node.name.object.name
      : "?";
    return `${obj}.${node.name.property.name}`;
  }
  return "?";
}

/** Walk up the path to check if this node is inside a translation call. */
function isInsideTranslationCall(path: any): boolean {
  return (
    path.findParent((p: any) => {
      if (!p.isCallExpression()) return false;
      const callee = p.node.callee;
      // t("key"), $t("key"), formatMessage(...)
      if (t.isIdentifier(callee) && TRANSLATION_FNS.has(callee.name))
        return true;
      // i18n.t("key"), obj.t("key")
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property) &&
        TRANSLATION_FNS.has(callee.property.name)
      )
        return true;
      return false;
    }) !== null
  );
}

/** Walk up the path to check if this node is inside a console.* call. */
function isInsideConsoleCall(path: any): boolean {
  return (
    path.findParent((p: any) => {
      if (!p.isCallExpression()) return false;
      const callee = p.node.callee;
      return (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object) &&
        callee.object.name === "console"
      );
    }) !== null
  );
}

/** Walk up to check if this node is inside an import declaration. */
function isInsideImport(path: any): boolean {
  return path.findParent((p: any) => p.isImportDeclaration()) !== null;
}

/** True if node is at module/file scope (not inside any function body). */
function isAtModuleLevel(path: any): boolean {
  return path.findParent(
    (p: any) =>
      p.isFunctionDeclaration() ||
      p.isFunctionExpression() ||
      p.isArrowFunctionExpression() ||
      p.isObjectMethod() ||
      p.isClassMethod(),
  ) === null;
}

/** True if node is inside a JSX element or expression container. */
function isInsideJSXElement(path: any): boolean {
  return path.findParent(
    (p: any) =>
      p.isJSXElement() ||
      p.isJSXFragment() ||
      p.isJSXAttribute() ||
      p.isJSXExpressionContainer() ||
      p.isJSXOpeningElement() ||
      p.isJSXSelfClosingElement(),
  ) !== null;
}

/**
 * Check if a path is inside a state initialization call like useState("default").
 * These strings are default/placeholder values, not user-facing text.
 */
function isInsideStateInitialization(path: any): boolean {
  return (
    path.findParent(
      (p: any) =>
        p.isCallExpression() &&
        t.isIdentifier(p.node.callee) &&
        STATE_INITIALIZATION_FNS.has(p.node.callee.name),
    ) !== null
  );
}

/**
 * Detect if a path is part of a BinaryExpression string concatenation chain.
 * Returns the root chain if yes, null otherwise.
 *
 * For a chain like A + B + C (parsed as (A + B) + C), walks up to find the outermost
 * BinaryExpression with a + operator.
 */
function getRootBinaryConcatenationChain(path: any): any {
  let current = path;
  let lastBinExpr: any = null;

  // Walk up the tree to find if this node is part of a + chain
  while (current.parentPath) {
    const parent = current.parentPath;
    if (parent.isBinaryExpression() && parent.node.operator === "+") {
      lastBinExpr = parent;
      current = parent;
    } else {
      // Non-+ operator or non-BinaryExpression parent — stop walking up
      break;
    }
  }

  return lastBinExpr;
}

/**
 * Collect all StringLiterals from a BinaryExpression chain, filtering out separators.
 * Separators are strings that contain only whitespace, dashes, punctuation, etc.
 * Returns array of meaningful strings only: ["Overview", "Real-time data"]
 * Returns null if not a pure string chain or no meaningful strings remain.
 *
 * Separator pattern: only whitespace, dashes, em-dashes, commas, periods, etc.
 */
function collectBinaryStringChainBabel(binExprPath: any): string[] | null {
  const allOperands: string[] = [];
  const SEPARATOR_RE = /^[\s\-—,\.;:/|+*]+$/; // Only punctuation/whitespace

  function collect(node: any): boolean {
    if (t.isStringLiteral(node)) {
      allOperands.push(node.value);
      return true;
    } else if (t.isBinaryExpression(node) && node.operator === "+") {
      return collect(node.left) && collect(node.right);
    }
    return false;
  }

  if (!collect(binExprPath.node)) return null;
  if (allOperands.length < 2) return null;

  // Filter out separator-only strings
  const meaningfulStrings = allOperands.filter(
    (str) => str.trim() && !SEPARATOR_RE.test(str)
  );

  return meaningfulStrings.length > 0 ? meaningfulStrings : null;
}

/**
 * For an ObjectProperty path, walk up to find the parent object's variable name.
 * e.g. const statusConfig = { online: "..." } → "statusConfig"
 * Returns null if the object is not assigned to a variable.
 */
function getBabelObjectVariableName(propPath: any): string | null {
  let current = propPath;

  while (current) {
    const parent = current.parentPath;
    if (!parent) break;

    // Found the object that contains this property
    if (parent.isObjectExpression()) {
      const objParent = parent.parentPath;

      // Check if it's a variable declaration: const name = {...}
      if (objParent && objParent.isVariableDeclarator()) {
        const varDecl = objParent.node;
        if (t.isIdentifier(varDecl.id)) {
          return varDecl.id.name;
        }
      }

      // Check if it's a property assignment: { name: {...} }
      if (objParent && objParent.isObjectProperty()) {
        // Continue walking to find the parent object
        current = objParent;
        continue;
      }

      // Stop if object is in some other context
      break;
    }
    current = parent;
  }

  return null;
}

/** Determine context description for non-JSX string literals. Returns null to skip. */
function getBabelNonJSXContext(path: any): string | null {
  const parent = path.parentPath;
  if (!parent) return null;

  // Function call argument: setError("..."), new Error("...")
  if (parent.isCallExpression() || parent.isNewExpression()) {
    const callee = parent.node.callee;
    const fnName = t.isIdentifier(callee)
      ? callee.name
      : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
        ? callee.property.name
        : "?";
    return `argument in ${fnName}()`;
  }

  // Object property value: { title: "..." }
  if (parent.isObjectProperty()) {
    const key = t.isIdentifier(parent.node.key)
      ? parent.node.key.name
      : t.isStringLiteral(parent.node.key)
        ? parent.node.key.value
        : "?";
    return `object property "${key}"`;
  }

  // Variable declaration: const msg = "..."
  if (parent.isVariableDeclarator()) {
    const name = t.isIdentifier(parent.node.id) ? parent.node.id.name : "?";
    return `variable "${name}"`;
  }

  // Return statement: return "..."
  if (parent.isReturnStatement()) return "return value";

  // Binary expression (string concatenation)
  if (parent.isBinaryExpression()) return "string concatenation";

  // Conditional expression: condition ? "Yes" : "No"
  if (parent.isConditionalExpression()) return "conditional expression";

  return null;
}

function makeResult(
  filePath: string,
  lines: string[],
  line: number,
  column: number,
  value: string,
  nodeType: NodeType,
  context: string,
  isModuleLevel: boolean,
  objectKey?: string,
): ScanResult {
  const result: ScanResult = {
    file: filePath,
    line,
    column,
    value,
    nodeType,
    context,
    surroundingCode: getSurroundingLines(lines, line - 1),
    alreadyTranslated: false,
    isModuleLevel,
    resolvedKey: null,
  };
  if (objectKey) {
    result.objectKey = objectKey;
  }
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function scanWithBabel(
  filePath: string,
  source: string,
  config: LocalizerConfig,
): ScanResult[] {
  const results: ScanResult[] = [];
  const lines = source.split("\n");

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx"],
      errorRecovery: true,
    });
  } catch {
    // Unparseable file — return empty
    return [];
  }

  // Track BinaryExpression chains we've already processed
  const processedBinaryChains = new WeakSet<t.BinaryExpression>();

  traverse(ast, {
    // ── JSXElement: detect interpolated children first
    // e.g. <p>You have {count} tasks</p> → one key "You have {{count}} tasks"
    JSXElement(path: any) {
      if (isInsideTranslationCall(path)) return;

      const children: t.JSXElement["children"] = path.node.children;
      if (children.length < 2) return;

      const interpolations: InterpolationVar[] = [];
      const templateParts: string[] = [];
      const usedNames = new Set<string>();
      let hasText = false;
      let hasExpr = false;

      for (const child of children) {
        if (t.isJSXText(child)) {
          templateParts.push(child.value);
          if (child.value.trim()) hasText = true;
        } else if (
          t.isJSXExpressionContainer(child) &&
          !t.isJSXEmptyExpression(child.expression)
        ) {
          // Extract expression source text directly via character offsets
          const exprSource =
            typeof child.expression.start === "number" &&
            typeof child.expression.end === "number"
              ? source.slice(child.expression.start, child.expression.end)
              : "";

          if (!exprSource) { return; } // can't identify variable — bail

          // Derive a clean placeholder name
          let placeholder = exprSource
            .replace(/\(.*\)/g, "")           // strip call parens
            .split(".").pop()!                 // last property segment
            .replace(/\[.*\]/g, "")            // strip array access
            .replace(/[^a-zA-Z0-9_]/g, "")    // strip specials
            || "value";

          // Deduplicate
          if (usedNames.has(placeholder)) {
            let i = 2;
            while (usedNames.has(`${placeholder}${i}`)) i++;
            placeholder = `${placeholder}${i}`;
          }
          usedNames.add(placeholder);
          interpolations.push({ placeholder, expression: exprSource });
          templateParts.push(`{{${placeholder}}}`);
          hasExpr = true;
        } else {
          // Nested JSX element — cannot merge into one interpolated string
          return;
        }
      }

      if (!hasText || !hasExpr) return;

      const rawTemplate = templateParts.join("");
      const trimmedTemplate = rawTemplate.trim();
      if (!trimmedTemplate) return;
      if (shouldFilter(trimmedTemplate, config, true)) return;

      // rawSpan: source text covering all children
      const firstChild = children[0]!;
      const lastChild = children[children.length - 1]!;
      const rawSpan =
        typeof firstChild.start === "number" && typeof lastChild.end === "number"
          ? source.slice(firstChild.start, lastChild.end)
          : "";

      const loc = firstChild.loc?.start;
      if (!loc) return;

      const tagName = t.isJSXIdentifier(path.node.openingElement.name)
        ? path.node.openingElement.name.name
        : "?";

      results.push({
        file: filePath,
        line: loc.line,
        column: loc.column,
        value: trimmedTemplate,
        nodeType: "JSXInterpolation",
        context: `interpolated JSX in <${tagName}>`,
        surroundingCode: getSurroundingLines(lines, loc.line - 1),
        alreadyTranslated: false,
        isModuleLevel: isAtModuleLevel(path),
        resolvedKey: null,
        interpolations,
        rawSpan,
      });

      // Prevent JSXText visitor from also processing these children
      path.skip();
    },

    // ── JSX text node: <h1>Welcome back</h1>
    JSXText(path: any) {
      const raw = path.node.value;
      const value = raw.trim();
      if (!value) return;
      if (isInsideTranslationCall(path)) return;
      if (shouldFilter(value, config, true)) return;

      const loc = path.node.loc?.start;
      if (!loc) return;

      const parentOpen = (path.parentPath?.node as t.JSXElement | undefined)
        ?.openingElement;
      const elementName = parentOpen ? getJSXElementName(parentOpen) : "?";

      results.push(
        makeResult(
          filePath,
          lines,
          loc.line,
          loc.column,
          value,
          "JSXText",
          `JSXText inside <${elementName}>`,
          isAtModuleLevel(path),
        ),
      );
    },

    // ── String literal: JSX attribute value OR non-JSX (function args, variables, etc.)
    StringLiteral(path: any) {
      const value = path.node.value.trim();
      if (!value) return;
      if (isInsideTranslationCall(path)) return;
      if (isInsideConsoleCall(path)) return;
      if (isInsideImport(path)) return;
      // Skip state initialization defaults: useState("John Doe"), useRef("initial")
      if (isInsideStateInitialization(path)) return;

      // ── Check for string concatenation chains: "a" + "b" + "c"
      // Split chains into individual meaningful strings (skip separators like " — ")
      // Emit each string separately so they can be translated individually
      if (path.parentPath?.isBinaryExpression() && path.parentPath.node.operator === "+") {
        const rootChain = getRootBinaryConcatenationChain(path);
        if (rootChain) {
          // Process only on first visit (when not yet in processedBinaryChains)
          if (!processedBinaryChains.has(rootChain.node)) {
            const meaningfulStrings = collectBinaryStringChainBabel(rootChain);
            if (
              meaningfulStrings &&
              meaningfulStrings.length > 0 &&
              !isInsideTranslationCall(rootChain) &&
              !isInsideConsoleCall(rootChain)
            ) {
              processedBinaryChains.add(rootChain.node);
              const isInJSX = isInsideJSXElement(rootChain);
              const loc = rootChain.node.loc?.start;
              if (loc) {
                // Emit each meaningful string as a separate translatable result
                for (const str of meaningfulStrings) {
                  if (!shouldFilter(str, config, isInJSX)) {
                    results.push(
                      makeResult(
                        filePath,
                        lines,
                        loc.line,
                        loc.column,
                        str,
                        "StringLiteral",
                        "string concatenation",
                        isAtModuleLevel(rootChain),
                      ),
                    );
                  }
                }
              }
            } else {
              // Mark as processed even if we don't emit (e.g., filtered)
              processedBinaryChains.add(rootChain.node);
            }
          }
          // Skip individual operand processing — chain already handled
          return;
        }
      }

      const loc = path.node.loc?.start;
      if (!loc) return;

      const parent = path.parentPath;
      const isInJSX = isInsideJSXElement(path);

      if (parent?.isJSXAttribute()) {
        // JSX attribute value: <input placeholder="..." />
        if (shouldFilter(value, config, true)) return;

        const attrName = t.isJSXIdentifier(parent.node.name)
          ? parent.node.name.name
          : "";
        if (NON_TRANSLATABLE_ATTRS.has(attrName)) return;
        if (attrName.startsWith("data-") || attrName === "aria-labelledby" || attrName === "aria-describedby") return;

        const openingEl = parent.parentPath?.node as t.JSXOpeningElement | undefined;
        const elementName = openingEl ? getJSXElementName(openingEl) : "?";

        results.push(
          makeResult(filePath, lines, loc.line, loc.column, value, "JSXAttribute",
            `"${attrName}" attribute on <${elementName}>`, isAtModuleLevel(path)),
        );
      } else {
        // Non-JSX string literal — check filter based on whether it's inside JSX or pure logic
        if (shouldFilter(value, config, isInJSX)) return;

        const context = getBabelNonJSXContext(path);
        if (context) {
          // For object properties, also track the parent object name
          let objectKey: string | undefined;
          if (context.startsWith("object property") && path.parentPath?.isObjectProperty()) {
            objectKey = getBabelObjectVariableName(path.parentPath) ?? undefined;
          }
          results.push(
            makeResult(filePath, lines, loc.line, loc.column, value, "StringLiteral", context, isAtModuleLevel(path), objectKey),
          );
        }
      }
    },

    // ── Template literal (static-only or with interpolation)
    // Static: `Hello world` → captured as-is
    // Dynamic: `Hello ${name}` → each static span captured separately
    TemplateLiteral(path: any) {
      if (isInsideTranslationCall(path)) return;
      if (isInsideConsoleCall(path)) return;

      const isInJSX = isInsideJSXElement(path);
      const isModLevel = isAtModuleLevel(path);

      if (path.node.expressions.length === 0) {
        // Static-only template literal
        const cooked = path.node.quasis[0]?.value.cooked ?? "";
        const value = cooked.trim();
        if (!value) return;
        if (shouldFilter(value, config, isInJSX)) return;

        const loc = path.node.loc?.start;
        if (!loc) return;

        results.push(
          makeResult(filePath, lines, loc.line, loc.column, value, "TemplateLiteral", "Template literal", isModLevel),
        );
      } else {
        // Dynamic template literal — extract each static quasi separately
        for (const quasi of path.node.quasis) {
          const cooked = quasi.value.cooked ?? "";
          const value = cooked.trim();
          if (!value) continue;
          if (shouldFilter(value, config, isInJSX)) continue;

          const loc = quasi.loc?.start;
          if (!loc) continue;

          results.push(
            makeResult(filePath, lines, loc.line, loc.column, value, "TemplateLiteral", "Template literal (static part)", isModLevel),
          );
        }
      }
    },

    // ── Array literal elements: ["Export Report", "Send Notification"]
    // Capture UI text arrays but skip code/identifier arrays like ["admin", "user"]
    ArrayExpression(path: any) {
      const isInJSX = isInsideJSXElement(path);
      const isModLevel = isAtModuleLevel(path);

      for (const element of path.node.elements) {
        if (!element || !t.isStringLiteral(element)) continue;

        const value = element.value.trim();
        if (!value) continue;
        if (isInsideTranslationCall(path)) continue;
        if (isInsideStateInitialization(path)) continue;
        if (shouldFilter(value, config, isInJSX)) continue;

        const loc = element.loc?.start;
        if (!loc) continue;

        results.push(
          makeResult(filePath, lines, loc.line, loc.column, value, "StringLiteral", "string in array", isModLevel),
        );
      }
    },
  });

  return results;
}
