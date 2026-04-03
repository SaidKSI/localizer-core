import ts from "typescript";
import type { ScanResult, NodeType, LocalizerConfig, InterpolationVar } from "../types.js";
import { shouldFilter, NON_TRANSLATABLE_ATTRS, TRANSLATION_FNS, STATE_INITIALIZATION_FNS } from "./filters.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSurroundingLines(lines: string[], zeroBasedLine: number): string {
  const start = Math.max(0, zeroBasedLine - 2);
  const end = Math.min(lines.length - 1, zeroBasedLine + 2);
  return lines.slice(start, end + 1).join("\n");
}

function getJSXElementName(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return node.tagName.getText();
}

/** Walk ancestors to check if node is inside a translation call expression. */
function isInsideTranslationCall(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    current = current.parent;
    if (ts.isCallExpression(current)) {
      const expr = current.expression;
      // t("key"), $t("key"), formatMessage(...)
      if (ts.isIdentifier(expr) && TRANSLATION_FNS.has(expr.text)) return true;
      // i18n.t("key"), obj.formatMessage(...)
      if (
        ts.isPropertyAccessExpression(expr) &&
        TRANSLATION_FNS.has(expr.name.text)
      )
        return true;
    }
  }
  return false;
}

/** Walk ancestors to check if node is inside a console.* call. */
function isInsideConsoleCall(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    current = current.parent;
    if (ts.isCallExpression(current)) {
      const expr = current.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === "console"
      )
        return true;
    }
  }
  return false;
}

/** Walk ancestors to check if node is inside an import declaration. */
function isInsideImport(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    current = current.parent;
    if (ts.isImportDeclaration(current)) return true;
  }
  return false;
}

/**
 * Check if a node is inside a state initialization call like useState("default").
 * These strings are default/placeholder values, not user-facing text.
 */
function isInsideStateInitialization(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    current = current.parent;
    if (ts.isCallExpression(current)) {
      const expr = current.expression;
      if (ts.isIdentifier(expr) && STATE_INITIALIZATION_FNS.has(expr.text)) {
        return true;
      }
    }
  }
  return false;
}

/** True if node is inside a function body (not at module/file scope). */
function isInsideFunctionBody(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    current = current.parent;
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return true;
    }
  }
  return false;
}

/** True if node is inside a JSX element or JSX attribute. */
function isInsideJSXElement(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    current = current.parent;
    if (
      ts.isJsxElement(current) ||
      ts.isJsxFragment(current) ||
      ts.isJsxAttribute(current) ||
      ts.isJsxOpeningElement(current) ||
      ts.isJsxSelfClosingElement(current)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detect if a StringLiteral is part of a BinaryExpression string concatenation chain.
 * Returns the root BinaryExpression if yes, null otherwise.
 * E.g., "Overview" + " — " + "Real-time data" → root BinaryExpression node
 *
 * For a chain like A + B + C (parsed as (A + B) + C), walks up to find the outermost
 * BinaryExpression with a + operator.
 */
function getRootConcatenationChain(node: ts.Node): ts.BinaryExpression | null {
  let current: ts.Node = node;
  let lastBinExpr: ts.BinaryExpression | null = null;

  // Walk up the tree to find if this node is part of a + chain
  while (current.parent) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent)) {
      const binExpr = parent as ts.BinaryExpression;
      if (binExpr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        lastBinExpr = binExpr;
        current = parent;
      } else {
        // Non-+ operator — stop walking up
        break;
      }
    } else {
      // Parent is not a BinaryExpression — stop walking up
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
function collectBinaryStringChain(
  binExpr: ts.BinaryExpression,
): string[] | null {
  const allOperands: string[] = [];
  const SEPARATOR_RE = /^[\s\-—,\.;:/|+*]+$/; // Only punctuation/whitespace

  // Recursively collect all operands
  function collect(node: ts.Node): boolean {
    if (ts.isStringLiteral(node)) {
      allOperands.push(node.text);
      return true;
    } else if (ts.isBinaryExpression(node)) {
      const be = node as ts.BinaryExpression;
      if (be.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
      return collect(be.left) && collect(be.right);
    }
    return false;
  }

  if (!collect(binExpr)) return null; // Not a pure string chain
  if (allOperands.length < 2) return null; // Single operand — not a concatenation

  // Filter out separator-only strings
  const meaningfulStrings = allOperands.filter(
    (str) => str.trim() && !SEPARATOR_RE.test(str)
  );

  return meaningfulStrings.length > 0 ? meaningfulStrings : null;
}

/**
 * For a PropertyAssignment node, walk up to find the parent object's variable name.
 * e.g. const statusConfig = { online: "..." } → "statusConfig"
 * Returns null if the object is not assigned to a variable.
 */
function getObjectVariableName(propAssignNode: ts.Node, sourceFile: ts.SourceFile): string | null {
  let current: ts.Node | undefined = propAssignNode.parent;

  while (current) {
    // Found the object literal that contains this property
    if (ts.isObjectLiteralExpression(current)) {
      const objParent: ts.Node | undefined = current.parent;
      if (!objParent) break;

      // Check if it's a variable declaration: const name = {...}
      if (ts.isVariableDeclaration(objParent)) {
        const name = objParent.name.getText(sourceFile);
        return name;
      }

      // Check if it's a property assignment: { name: {...} }
      if (ts.isPropertyAssignment(objParent)) {
        // Continue walking to find the parent object
        current = objParent.parent;
        continue;
      }

      // Stop if object is in some other context (function arg, return value, etc.)
      break;
    }
    current = current.parent;
  }

  return null;
}

/**
 * Determine context description for non-JSX string literals.
 * Returns null if the string is in a non-user-facing position (e.g. type annotation).
 */
function getNonJSXContext(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const parent = node.parent;

  // Function call argument: setError("..."), alert("..."), new Error("...")
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    const fnName = ts.isCallExpression(parent)
      ? parent.expression.getText(sourceFile)
      : parent.expression.getText(sourceFile);
    return `argument in ${fnName}()`;
  }

  // Object property value: { title: "..." }
  if (ts.isPropertyAssignment(parent)) {
    const key = parent.name.getText(sourceFile);
    return `object property "${key}"`;
  }

  // Variable declaration: const msg = "..."
  if (ts.isVariableDeclaration(parent)) {
    const name = parent.name.getText(sourceFile);
    return `variable "${name}"`;
  }

  // Return statement: return "..."
  if (ts.isReturnStatement(parent)) {
    return "return value";
  }

  // Binary expression (string concatenation): "Hello " + name
  if (ts.isBinaryExpression(parent)) {
    return "string concatenation";
  }

  // Conditional expression: condition ? "Yes" : "No"
  if (ts.isConditionalExpression(parent)) {
    return "conditional expression";
  }

  // Skip type-level positions (type assertions, type annotations, decorators)
  return null;
}

function makeResult(
  filePath: string,
  lines: string[],
  sourceFile: ts.SourceFile,
  node: ts.Node,
  value: string,
  nodeType: NodeType,
  context: string,
  objectKey?: string,
): ScanResult {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const result: ScanResult = {
    file: filePath,
    line: line + 1, // convert to 1-based
    column: character,
    value,
    nodeType,
    context,
    surroundingCode: getSurroundingLines(lines, line),
    alreadyTranslated: false,
    isModuleLevel: !isInsideFunctionBody(node),
    resolvedKey: null,
  };
  if (objectKey) {
    result.objectKey = objectKey;
  }
  return result;
}

// ─── JSX interpolation helpers ───────────────────────────────────────────────

/**
 * Derive a clean placeholder name from a JSX expression source string.
 * "taskCount" → "taskCount", "user.name" → "name", "getCount()" → "getCount"
 */
function simplifyExpressionName(expr: string): string {
  let name = expr.replace(/\(.*\)/g, "").trim();       // strip call args
  const parts = name.split(".");
  name = parts[parts.length - 1]!;                     // last property segment
  name = name.replace(/\[.*\]/g, "").replace(/[^a-zA-Z0-9_]/g, ""); // strip brackets/specials
  return name || "value";
}

/**
 * Detect a JSXElement whose direct children are a mix of JSXText and
 * JSXExpressionContainer (no nested JSX elements). If found, emit a single
 * JSXInterpolation result with an i18next-style template
 * ("You have {{taskCount}} pending tasks") instead of splitting into fragments.
 *
 * Returns true if handled — caller should NOT recurse into children.
 */
function tryHandleInterpolatedJSX(
  jsxElement: ts.JsxElement,
  filePath: string,
  lines: string[],
  sourceFile: ts.SourceFile,
  config: LocalizerConfig,
  results: ScanResult[],
  isInsideTranslationCallFn: (node: ts.Node) => boolean,
): boolean {
  // Skip if already inside a translation call
  if (isInsideTranslationCallFn(jsxElement)) return false;

  const children = jsxElement.children;
  if (children.length < 2) return false;

  type Part =
    | { kind: "text"; raw: string; node: ts.JsxText }
    | { kind: "expr"; source: string; node: ts.JsxExpression };

  const parts: Part[] = [];
  let hasText = false;
  let hasExpr = false;

  for (const child of children) {
    if (ts.isJsxText(child)) {
      parts.push({ kind: "text", raw: child.text, node: child });
      if (child.text.trim()) hasText = true;
    } else if (ts.isJsxExpression(child) && child.expression) {
      const source = child.expression.getText(sourceFile);
      parts.push({ kind: "expr", source, node: child });
      hasExpr = true;
    } else {
      // Nested JSX element — cannot group as a single interpolated string
      return false;
    }
  }

  // Need at least one meaningful text part AND at least one expression
  if (!hasText || !hasExpr) return false;

  // Build the interpolated template and variable map
  const interpolations: InterpolationVar[] = [];
  const usedNames = new Set<string>();
  const templateParts: string[] = [];

  for (const part of parts) {
    if (part.kind === "text") {
      templateParts.push(part.raw);
    } else {
      let placeholder = simplifyExpressionName(part.source);
      // Deduplicate placeholder names
      if (usedNames.has(placeholder)) {
        let i = 2;
        while (usedNames.has(`${placeholder}${i}`)) i++;
        placeholder = `${placeholder}${i}`;
      }
      usedNames.add(placeholder);
      interpolations.push({ placeholder, expression: part.source });
      templateParts.push(`{{${placeholder}}}`);
    }
  }

  // Trim outer whitespace from the assembled template
  const rawTemplate = templateParts.join("");
  const trimmedTemplate = rawTemplate.trim();
  if (!trimmedTemplate) return false;
  if (shouldFilter(trimmedTemplate, config, true)) return false;

  // rawSpan: original source of all children — used by the rewriter
  const firstChild = children[0]!;
  const lastChild = children[children.length - 1]!;
  const rawSpan = sourceFile.text.substring(firstChild.getStart(sourceFile), lastChild.getEnd());

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(firstChild.getStart(sourceFile));

  results.push({
    file: filePath,
    line: line + 1,
    column: character,
    value: trimmedTemplate,
    nodeType: "JSXInterpolation",
    context: `interpolated JSX in <${getJSXElementName(jsxElement.openingElement)}>`,
    surroundingCode: getSurroundingLines(lines, line),
    alreadyTranslated: false,
    isModuleLevel: !isInsideFunctionBody(jsxElement),
    resolvedKey: null,
    interpolations,
    rawSpan,
  });

  return true;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function scanWithTypeScript(
  filePath: string,
  source: string,
  config: LocalizerConfig,
): ScanResult[] {
  const results: ScanResult[] = [];
  const lines = source.split("\n");

  const scriptKind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  // Track BinaryExpression chains we've already processed to avoid duplicates
  const processedBinaryChains = new WeakSet<ts.BinaryExpression>();

  function visit(node: ts.Node): void {
    // ── JSXElement: detect interpolated children first
    // e.g. <p>You have {count} tasks</p> → one key "You have {{count}} tasks"
    if (ts.isJsxElement(node)) {
      if (tryHandleInterpolatedJSX(node, filePath, lines, sourceFile, config, results, isInsideTranslationCall)) {
        return; // Consumed as a single interpolated result — skip child visits
      }
      // Not interpolated — recurse normally into children
      ts.forEachChild(node, visit);
      return;
    }

    // ── JSX text node: <h1>Welcome back</h1>
    if (ts.isJsxText(node)) {
      const value = node.text.trim();
      if (value && !isInsideTranslationCall(node) && !shouldFilter(value, config, true)) {
        // Parent is JsxElement; grandparent opening element carries the tag name
        const jsxEl = node.parent;
        const elementName =
          ts.isJsxElement(jsxEl)
            ? getJSXElementName(jsxEl.openingElement)
            : "?";

        results.push(
          makeResult(
            filePath,
            lines,
            sourceFile,
            node,
            value,
            "JSXText",
            `JSXText inside <${elementName}>`,
          ),
        );
      }
    }

    // ── String literal as JSX attribute value: <input placeholder="..." />
    else if (ts.isStringLiteral(node)) {
      const value = node.text.trim();
      if (!value) {
        ts.forEachChild(node, visit);
        return;
      }

      const parent = node.parent;

      // ── Check for string concatenation chains: "a" + "b" + "c"
      // Split chains into individual meaningful strings (skip separators like " — ")
      // Emit each string separately so they can be translated individually
      if (parent && ts.isBinaryExpression(parent)) {
        const rootChain = getRootConcatenationChain(node);
        if (rootChain) {
          // Process only on first visit (when not yet in processedBinaryChains)
          if (!processedBinaryChains.has(rootChain)) {
            const meaningfulStrings = collectBinaryStringChain(rootChain);
            if (
              meaningfulStrings &&
              meaningfulStrings.length > 0 &&
              !isInsideTranslationCall(rootChain) &&
              !isInsideConsoleCall(rootChain)
            ) {
              processedBinaryChains.add(rootChain);
              const isInJSX = isInsideJSXElement(rootChain);
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                rootChain.getStart(sourceFile),
              );

              // Emit each meaningful string as a separate translatable result
              for (const str of meaningfulStrings) {
                if (!shouldFilter(str, config, isInJSX)) {
                  results.push({
                    file: filePath,
                    line: line + 1,
                    column: character,
                    value: str,
                    nodeType: "StringLiteral",
                    context: "string concatenation",
                    surroundingCode: getSurroundingLines(lines, line),
                    alreadyTranslated: false,
                    isModuleLevel: !isInsideFunctionBody(rootChain),
                    resolvedKey: null,
                  });
                }
              }
            } else {
              // Mark as processed even if we don't emit (e.g., filtered)
              processedBinaryChains.add(rootChain);
            }
          }
          // Skip individual operand processing — chain already handled
          ts.forEachChild(node, visit);
          return;
        }
      }

      if (ts.isJsxAttribute(parent)) {
        // Skip non-translatable attribute names
        const attrName = ts.isIdentifier(parent.name)
          ? parent.name.text
          : parent.name.getText(sourceFile);

        if (
          !NON_TRANSLATABLE_ATTRS.has(attrName) &&
          !attrName.startsWith("data-") &&
          attrName !== "aria-labelledby" &&
          attrName !== "aria-describedby" &&
          !isInsideTranslationCall(node) &&
          !isInsideConsoleCall(node) &&
          !shouldFilter(value, config, true)
        ) {
          // Get element name from JsxOpeningElement (grandparent of JsxAttribute)
          const openingEl = parent.parent;
          const elementName =
            ts.isJsxOpeningElement(openingEl) ||
            ts.isJsxSelfClosingElement(openingEl)
              ? getJSXElementName(openingEl)
              : "?";

          results.push(
            makeResult(
              filePath,
              lines,
              sourceFile,
              node,
              value,
              "JSXAttribute",
              `"${attrName}" attribute on <${elementName}>`,
            ),
          );
        }
      } else if (!ts.isImportDeclaration(parent) && !ts.isExportDeclaration(parent)) {
        // Skip state initialization defaults: useState("John Doe"), useRef("initial")
        // These are placeholders, not user-facing text
        if (isInsideStateInitialization(node)) {
          ts.forEachChild(node, visit);
          return;
        }

        // Non-JSX StringLiteral — capture if it looks user-facing
        // If inside JSX (e.g., ternary in JSX), treat as JSX to skip MODULE_SPECIFIER_RE filter
        const isInJSX = isInsideJSXElement(node);
        if (
          !isInsideTranslationCall(node) &&
          !isInsideConsoleCall(node) &&
          !isInsideImport(node) &&
          !shouldFilter(value, config, isInJSX)
        ) {
          const context = getNonJSXContext(node, sourceFile);
          if (context) {
            // For object properties, also track the parent object name
            let objectKey: string | undefined;
            if (
              context.startsWith("object property") &&
              ts.isPropertyAssignment(parent)
            ) {
              objectKey = getObjectVariableName(parent, sourceFile) ?? undefined;
            }
            results.push(
              makeResult(filePath, lines, sourceFile, node, value, "StringLiteral", context, objectKey),
            );
          }
        }
      }
    }

    // ── Static-only template literal: `Hello world`
    else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      const value = node.text.trim();
      if (
        value &&
        !isInsideTranslationCall(node) &&
        !isInsideConsoleCall(node) &&
        !isInsideImport(node) &&
        !shouldFilter(value, config)
      ) {
        results.push(
          makeResult(
            filePath,
            lines,
            sourceFile,
            node,
            value,
            "TemplateLiteral",
            "Template literal",
          ),
        );
      }
    }

    // ── Dynamic template literal with interpolation: `Hello ${name}, you have ${count} tasks`
    // Extract each static span (head, middle spans, tail) as separate translatable strings
    else if (ts.isTemplateExpression(node)) {
      if (
        isInsideTranslationCall(node) ||
        isInsideConsoleCall(node) ||
        isInsideImport(node)
      ) {
        ts.forEachChild(node, visit);
        return;
      }

      const isInJSX = isInsideJSXElement(node);

      // Template head: the part before the first ${}
      const headValue = node.head.text.trim();
      if (headValue && !shouldFilter(headValue, config, isInJSX)) {
        results.push(
          makeResult(
            filePath,
            lines,
            sourceFile,
            node.head,
            headValue,
            "TemplateLiteral",
            "Template literal (static part)",
          ),
        );
      }

      // Template spans: each middle/tail static part after a ${}
      for (const span of node.templateSpans) {
        const spanValue = span.literal.text.trim();
        if (spanValue && !shouldFilter(spanValue, config, isInJSX)) {
          results.push(
            makeResult(
              filePath,
              lines,
              sourceFile,
              span.literal,
              spanValue,
              "TemplateLiteral",
              "Template literal (static part)",
            ),
          );
        }
      }
    }

    // ── Array literal elements: ["Export Report", "Send Notification"]
    // Capture UI text arrays but skip code/identifier arrays like ["admin", "user"]
    if (ts.isArrayLiteralExpression(node)) {
      const isInJSX = isInsideJSXElement(node);
      for (const element of node.elements) {
        if (ts.isStringLiteral(element)) {
          const value = element.text.trim();
          if (
            value &&
            !isInsideTranslationCall(element) &&
            !isInsideStateInitialization(node) &&
            !shouldFilter(value, config, isInJSX)
          ) {
            results.push(
              makeResult(
                filePath,
                lines,
                sourceFile,
                element,
                value,
                "StringLiteral",
                "string in array",
              ),
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}
