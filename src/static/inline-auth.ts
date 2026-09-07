// ============================================================================
// Inline security-check detector  —  task P1-T10  (requirement R26)
// ============================================================================
// Detects a security check that is the *first thing a handler body does* and
// emits it as a `route_chain` row at phase='handler_inline'. This is the second
// auth channel: `POST /api/v1/po` has no auth *hook*, and `checkUserAuth` is
// the handler's first statement. Reading the boot rows alone reports the route
// as unauthenticated.
//
// Two idioms, two inference strengths, both labelled `inferred`:
//
//   JS  sentinel-return — the handler binds a reviewed helper's error and
//       returns it when set:
//         const authErr = checkUserAuth(req, reply);
//         if (authErr) return authErr;
//       This binds a *human-reviewed helper name* (P1-T9's pack). A bare
//       reviewed-helper call with no sentinel guard is reported *too,* but
//       weaker: its result is discarded, so it is not evidence the request is
//       stopped — `detail` reads "reviewed helper X, unguarded call".
//
//   py  header-compare-and-early-401 — an authorization header is read into a
//       binding, a later `if` compares it, and the branch returns a 401:
//         auth = request.headers.get("authorization", "")
//         if token != SERVICE_TOKEN:
//             return JSONResponse(status_code=401, ...)
//       This matches a *source shape* with no named helper.
//
// The discriminator is written to `route_chain.detail` (migration 003) so the
// R40 coverage matrix (P1-T14) can tell the two apart — they are not equal
// coverage. Everything here is `inferred`/`treesitter`; this module never
// writes `'semgrep'` (plan note, settled 2026-09-07).
// ============================================================================

import type { Node } from "web-tree-sitter";
import type { ParsedFile } from "./treesitter/parser.ts";
import { walk, lineOf, colOf } from "./treesitter/parser.ts";
import type { FunctionRange, FileFindings } from "./treesitter/extract.ts";
import { enclosingFunction } from "./treesitter/extract.ts";
import type { BootRoute } from "../boot/dump.ts";
import type { FactStore } from "../store/db.ts";
import type { GraphWriter } from "../normalize/graph.ts";
import { ref } from "../normalize/keys.ts";
import type { CheckKindRules } from "./security-rules.ts";
import { classifyCheckKind } from "./security-rules.ts";

/** Function node types in the JS family. Nested ones are pruned when scanning. */
const FUNCTION_NODES = new Set([
  "function_declaration", "function_expression", "generator_function_declaration",
  "arrow_function", "method_definition",
]);

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield", "None", "True", "False",
]);

export const PY_DETAIL = "header-compare-and-early-401 shape, no named helper";

export interface InlineCheck {
  /** 1-based, the helper call (JS) or the 401 return (Python). */
  line: number;
  col: number;
  /** The reviewed helper (JS), or null for a Python shape match. */
  name: string | null;
  checkKind: string;
  detail: string;
}

/**
 * Detect inline security checks in one function body.
 *
 * `fn` is the handler the boot dump reported (resolved via `enclosingFunction`
 * on the handler line); the function node is located by its exact line range
 * so detection always runs against the body the framework said is the handler.
 */
export function detectInBody(
  parsed: ParsedFile,
  fn: FunctionRange,
  rules: CheckKindRules,
): InlineCheck[] {
  const node = functionNodeFor(parsed, fn);
  if (!node) return [];
  const body = node.childForFieldName("body");
  if (!body) return [];

  const checks = parsed.grammar === "python"
    ? detectPythonInBody(body, rules)
    : detectJsInBody(body, rules);
  checks.sort((a, b) => a.line - b.line || a.col - b.col);
  return checks;
}

// ----------------------------------------------------------------------------
// Boot wiring
// ----------------------------------------------------------------------------

export interface InlineIngestOptions {
  store: FactStore;
  /** The route chain expander's writer — same instance, same node ids. */
  writer: GraphWriter;
  service: string;
  repoId: number;
  /** `files.id` by repo-relative path, so rows carry provenance (R28). */
  fileIds: Map<string, number>;
  runId: number;
  rules: CheckKindRules;
  /** `parseFile` output retained from the tree-sitter pass, by repo-relative path. */
  parsedByPath: Map<string, ParsedFile>;
  /** `extract` output retained from the tree-sitter pass, by repo-relative path. */
  findingsByPath: Map<string, FileFindings>;
}

/**
 * Emit `handler_inline` chain rows for one service's routes (R26).
 *
 * Scans only the boot-dump's handler entry per route — a Fastify `addHook`
 * body or a Starlette `@app.middleware` body is middleware, not the handler,
 * and a middleware that does auth is already a boot-phase row, not inline.
 * Rows are `inferred`/`treesitter` and are cleaned up by provenance like every
 * other static row when their file is re-indexed.
 */
export function ingestInlineChecks(
  routes: BootRoute[], options: InlineIngestOptions,
): number {
  const { store, writer, service, repoId, fileIds, runId, rules, parsedByPath, findingsByPath } = options;
  let n = 0;

  for (const route of routes) {
    const handler = route.chain.find((c) => c.phase === "handler");
    if (!handler || handler.file === null || handler.line === null) continue;

    const findings = findingsByPath.get(handler.file);
    const parsed = parsedByPath.get(handler.file);
    if (!findings || !parsed) continue;

    const fn = resolveHandlerFunction(findings.functions, handler.line);
    if (!fn) continue;

    const checks = detectInBody(parsed, fn, rules);
    const routeNodeId = writer.node(ref.route(service, route.method, route.url));
    // Wholesale replace, mirroring the boot channel (expandRoutes →
    // `deleteChain(routeNodeId, ["boot"])`, R24). Un-reviewing a helper —
    // removing it from rules/check-kinds.yml — must empty the rows it produced,
    // or a revoked rule keeps asserting coverage. The inline channel owns the
    // static evidence kinds (`treesitter` today; a future real semgrep pass
    // joins this channel, never a second boot channel).
    store.deleteChain(routeNodeId, ["treesitter", "semgrep"]);
    for (const [position, check] of checks.entries()) {
      store.insertChainEntry({
        routeNodeId,
        position,
        phase: "handler_inline",
        symbolNodeId: null,
        key: `${handler.file}:${check.line}:${check.col}`,
        name: check.name,
        checkKind: check.checkKind,
        origin: "handler",
        inheritedFrom: null,
        confidence: "inferred",
        evidenceKind: "treesitter",
        fileId: fileIds.get(handler.file) ?? null,
        line: check.line,
        detail: check.detail,
        runId,
      });
      n += 1;
    }
  }

  return n;
}

/**
 * The handler function for a boot-reported line.
 *
 * Fastify reports the definition line, which is inside the function: a plain
 * `enclosingFunction` resolves it. FastAPI reports the *decorator* line, one
 * above `def`, so the second probe is how a decorator-leading handler joins.
 */
export function resolveHandlerFunction(
  functions: FunctionRange[], line: number,
): FunctionRange | null {
  return enclosingFunction(functions, line)
    ?? enclosingFunction(functions, line + 1);
}

function functionNodeFor(parsed: ParsedFile, fn: FunctionRange): Node | null {
  let found: Node | null = null;
  walk(parsed.tree.rootNode, (node) => {
    if (found) return false;
    if (
      (parsed.grammar === "python" ? node.type === "function_definition"
        : FUNCTION_NODES.has(node.type))
      && lineOf(node) === fn.line
      && node.endPosition.row + 1 === fn.endLine
    ) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

// ----------------------------------------------------------------------------
// JS — sentinel-return over a reviewed helper
// ----------------------------------------------------------------------------

function detectJsInBody(body: Node, rules: CheckKindRules): InlineCheck[] {
  const bound = new Map<string, Node>();
  const calls: Node[] = [];
  const guards = new Set<string>();

  walk(body, (node) => {
    // Stop at nested functions: a closure inside the handler is not part of the
    // handler's own request-path logic.
    if (FUNCTION_NODES.has(node.type)) return false;

    switch (node.type) {
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (fn?.type === "identifier" && rules.byName.has(fn.text)) {
          const binding = bindingName(node);
          if (binding) bound.set(binding, node);
          else calls.push(node);
        }
        break;
      }
      case "if_statement": {
        // `if (authErr) return authErr;` parses the condition as a
        // parenthesized_expression — unwrap it before the identifier test.
        let cond = node.childForFieldName("condition");
        while (cond?.type === "parenthesized_expression") cond = cond.namedChild(0);
        if (cond?.type === "identifier" && guardReturns(node, cond.text)) {
          guards.add(cond.text);
        }
        break;
      }
      default:
        break;
    }
    return true;
  });

  const out: InlineCheck[] = [];
  for (const [name, node] of bound) {
    if (!guards.has(name)) continue;
    const helper = node.childForFieldName("function")!.text;
    out.push({
      line: lineOf(node), col: colOf(node), name: helper,
      checkKind: classifyCheckKind(helper, rules)!,
      detail: `reviewed helper ${helper}`,
    });
  }
  for (const node of calls) {
    const helper = node.childForFieldName("function")!.text;
    out.push({
      line: lineOf(node), col: colOf(node), name: helper,
      // A bare call whose result is discarded does not stop the request — this
      // is a weaker claim than the sentinel-return, so the detail says so
      // (P1-T14's matrix reads `detail`, not the phase).
      checkKind: classifyCheckKind(helper, rules)!,
      detail: `reviewed helper ${helper}, unguarded call`,
    });
  }
  return out;
}

/** `const X = helper(...)` / `let X = helper(...)` bindings the call feeds. */
function bindingName(call: Node): string | null {
  const parent = call.parent;
  if (parent?.type !== "variable_declarator") return null;
  const name = parent.childForFieldName("name");
  return name?.type === "identifier" ? name.text : null;
}

/** `if (X) return X;` — the sentinel-return half of the idiom. */
function guardReturns(ifNode: Node, name: string): boolean {
  const consequence = ifNode.childForFieldName("consequence");
  if (!consequence) return false;
  const statements = consequence.type === "statement_block"
    ? consequence.namedChildren.filter((c): c is Node => c?.type === "return_statement")
    : [consequence];
  return statements.some((s) => {
    // The `argument` field is not bound in this grammar build; the returned
    // expression is the return_statement's one named child.
    const arg = s.namedChild(0);
    return arg?.type === "identifier" && arg.text === name;
  });
}

// ----------------------------------------------------------------------------
// Python — header-compare-and-early-401
// ----------------------------------------------------------------------------

function detectPythonInBody(body: Node, _rules: CheckKindRules): InlineCheck[] {
  // Pass 1: every local assignment `name = value`. Values are resolved to the
  // header reads they trace back to in pass 2, so `token = auth.replace(...)`
  // counts even though the header read produced `auth`.
  const bindings = new Map<string, Node>();
  const headerDerived = new Set<string>();

  const collectBindings = (node: Node): void => {
    if (node.type !== "assignment") return;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right || left.type !== "identifier") return;
    bindings.set(left.text, right);
  };
  walk(body, (node) => {
    if (node.type === "function_definition") return false;
    collectBindings(node);
    return true;
  });

  // Fixpoint: a binding is header-derived when its value is a header read, or
  // references an identifier that already is.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, value] of bindings) {
      if (headerDerived.has(name)) continue;
      if (isHeaderRead(value) || identifiersIn(value).some((id) => headerDerived.has(id))) {
        headerDerived.add(name);
        grew = true;
      }
    }
  }

  // The 401 guards: an `if` whose condition reads a header-derived binding and
  // whose consequence returns a 401 response is an inline auth check.
  const out: InlineCheck[] = [];
  walk(body, (node) => {
    if (node.type === "function_definition") return false;
    if (node.type !== "if_statement") return true;

    const cond = node.childForFieldName("condition");
    if (!cond) return true;
    const referenced = identifiersIn(cond);
    // A guard is either a compared header-derived binding (`if token != X`) or a
    // header read done inline in the condition (`if request.headers.get(...) != X`).
    if (!referenced.some((id) => headerDerived.has(id)) && !containsHeaderRead(cond)) return true;

    const gone = earlyResponse(node);
    if (gone) {
      // The kind is asserted here, not read from P1-T9's reviewed pack: a 401
      // early-return is auth by definition, and there is no helper name to
      // classify. That is a different provenance than the JS branch's
      // `classifyCheckKind` — recorded in PLAN-DELTAS D23 — and the shape's
      // `detail` distinguishes it for P1-T14 either way.
      out.push({
        line: lineOf(gone), col: colOf(gone),
        name: null, checkKind: "auth", detail: PY_DETAIL,
      });
    }
    return true;
  });

  return out;
}

/** `request.headers.get(...)` / `request.headers[...]` — the evidence of a guard. */
function isHeaderRead(node: Node): boolean {
  if (node.type === "call") {
    const fn = node.childForFieldName("function");
    return fn?.type === "attribute" && /(?:^|\.)headers\.(get|getitem|__getitem__)$/.test(fn.text);
  }
  if (node.type === "subscript") {
    const value = node.childForFieldName("value");
    return value?.type === "attribute" && /\.headers$/.test(value.text);
  }
  return false;
}

/**
 * Identifiers under a node, matched as whole text tokens.
 *
 * A node-level walk cannot find `auth` in `auth.replace("Bearer ", "").strip()`:
 * it is the *object* of a nested `attribute` node and tree-sitter-Python makes
 * it a child of that attribute. Whole-token matching on the node text is coarse
 * (a string containing a same-named identifier would count) but this is inferred
 * evidence about a single function scope, and coarseness is the honest trade.
 */
function identifiersIn(node: Node): string[] {
  const out = new Set<string>();
  for (const m of node.text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (!PY_KEYWORDS.has(m[0])) out.add(m[0]);
  }
  return [...out];
}

/** Whether a header read appears anywhere in a subtree (used for conditions). */
function containsHeaderRead(node: Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n.type === "function_definition") return false;
    if (isHeaderRead(n)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/** First 401 response returned inside an `if` (pruned of nested functions). */
function earlyResponse(ifNode: Node): Node | null {
  let found: Node | null = null;
  walk(ifNode, (node) => {
    if (found) return false;
    if (node.type === "function_definition") return false;
    if (node.type === "return_statement") {
      // `childForFieldName("argument")` is not bound in this grammar build, so
      // the argument is read by position: the `return` keyword is anonymous and
      // the argument is the only named child.
      const arg = node.namedChild(0);
      if (arg?.type === "call" && is401Response(arg)) found = node;
      return false;
    }
    return true;
  });
  return found;
}

/** `JSONResponse(status_code=401, ...)` / `HTTPException(status_code=401)`. */
function is401Response(call: Node): boolean {
  const fn = call.childForFieldName("function");
  if (fn?.text !== "JSONResponse" && fn?.text !== "HTTPException") return false;
  // The arguments live in the call's `argument_list` child, not as direct
  // children of the call node (as in the grammar's named-children listing).
  const args = call.childForFieldName("arguments");
  if (!args) return false;
  for (let i = 0; i < args.namedChildCount; i += 1) {
    const arg = args.namedChild(i);
    if (arg?.type === "keyword_argument") {
      const name = arg.childForFieldName("name");
      const value = arg.childForFieldName("value");
      if (name?.text === "status_code" && value?.type === "integer" && Number(value.text) === 401) {
        return true;
      }
    }
  }
  return false;
}