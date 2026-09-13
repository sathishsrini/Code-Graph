// ============================================================================
// Intra-function control flow  —  task P1-T17  (requirements R75, R76)
// ============================================================================
// A syntactic, per-function CFG: branches, guards, try/catch, loops and exits,
// with nesting and source ranges. Its job is to answer "which branch succeeds
// and which errors", which a call graph plus a flat throw-list cannot.
//
// **The corpus is why this exists.** `THROWS` is zero on every backend service
// (D12). Failures are returned, not thrown:
//
//     const authErr = checkUserAuth(req, reply);
//     if (authErr) return authErr;                    <- sentinel guard
//     ...
//     return reply.status(body.status_code).send(body);  <- error envelope
//
// A `throw`-only failure surface finds nothing here. R76 therefore requires
// BOTH idioms, and the return-an-error-value form is the one that matters.
//
// **What decides `error_exit` is declared, not guessed.** The error-builder
// names come from the same reviewed rule pack as `check_kind` (P1-T9), because
// "is `envelopeError` an error builder" is a judgement about a codebase and
// belongs in a file a human reviews. What is *not* declared — a `throw`, a 4xx
// status literal — is structural and needs no vocabulary.
//
// Anything the rules do not cover is `unknown`, never `success`. A branch
// silently classified as succeeding is the failure mode this whole file exists
// to avoid: it would render green.
// ============================================================================

import type { Node } from "web-tree-sitter";
import type { ParsedFile } from "./treesitter/parser.ts";
import { colOf, lineOf, literalText, walk } from "./treesitter/parser.ts";
import type { FunctionRange } from "./treesitter/extract.ts";

export type BlockKind =
  | "root" | "branch" | "guard" | "try" | "catch" | "finally" | "loop" | "exit";
export type Outcome = "success" | "error_exit" | "unknown";
export type ExitForm = "throw" | "return_error" | "return_value" | "implicit";

/**
 * Which arm of ITS OWN PARENT a block sits in.
 *
 * `parentIndex` alone cannot tell a `then`-arm block from an `else`-arm one:
 * both are nested directly under the same `if`, sharing the same
 * `parentIndex`. This is the field the flowchart needs to know which side of
 * the diamond to draw a block on, and it is how edge derivation tells the two
 * arms apart when they share a parent.
 */
export type BranchLabel = "then" | "else" | "try_body" | "catch" | "finally" | "loop_body";

/** A directed edge in the decision-structure flowchart. */
export type CfgEdgeLabel = "true" | "false" | "next" | "loop_back" | "catch";

export interface CfgEdge {
  from: number;
  /** null = falls off the end of the function — an implicit exit. */
  to: number | null;
  label: CfgEdgeLabel;
}

export interface CfgBlock {
  blockIndex: number;
  parentIndex: number | null;
  /** Null at the root, and at any block with no meaningful arm of its own. */
  branchLabel: BranchLabel | null;
  kind: BlockKind;
  /** Verbatim condition source. Never evaluated. */
  conditionText: string | null;
  outcome: Outcome | null;
  exitForm: ExitForm | null;
  errorName: string | null;
  startLine: number;
  endLine: number;
  startCol: number;
}

export interface FunctionCfg {
  /** The function this CFG describes, as reported by the tree-sitter pass. */
  fn: FunctionRange;
  blocks: CfgBlock[];
  /** The flowchart's arrows — see `deriveEdges`. */
  edges: CfgEdge[];
}

export interface CfgRules {
  /** Functions whose return value IS an error. From the reviewed pack. */
  errorBuilders: Set<string>;
}

/** Node types that open a nested function — a CFG stops at them. */
const JS_FUNCTIONS = new Set([
  "function_declaration", "function_expression", "generator_function_declaration",
  "arrow_function", "method_definition",
]);

// ---------------------------------------------------------------------------

export function extractCfg(
  parsed: ParsedFile, functions: FunctionRange[], rules: CfgRules,
): FunctionCfg[] {
  const bodies = functionBodies(parsed);
  const out: FunctionCfg[] = [];

  for (const fn of functions) {
    const node = bodies.get(`${fn.line}:${fn.endLine}`);
    if (!node) continue;
    const body = node.childForFieldName("body");
    if (!body) continue;
    const blocks = parsed.grammar === "python"
      ? buildCfg(body, rules, PYTHON)
      : buildCfg(body, rules, JAVASCRIPT);
    out.push({ fn, blocks, edges: deriveEdges(blocks) });
  }
  return out;
}

function functionBodies(parsed: ParsedFile): Map<string, Node> {
  const map = new Map<string, Node>();
  const isFn = (t: string) =>
    parsed.grammar === "python" ? t === "function_definition" : JS_FUNCTIONS.has(t);
  walk(parsed.tree.rootNode, (node) => {
    if (isFn(node.type)) map.set(`${lineOf(node)}:${node.endPosition.row + 1}`, node);
    return true;
  });
  return map;
}

// ---------------------------------------------------------------------------
// Grammar-specific vocabulary
// ---------------------------------------------------------------------------

interface Dialect {
  ifNode: string;
  conditionField: string;
  consequenceField: string;
  alternativeField: string | null;
  tryNode: string;
  catchNodes: readonly string[];
  finallyNodes: readonly string[];
  loopNodes: readonly string[];
  returnNode: string;
  throwNode: string;
  callNode: string;
  isFunction: (type: string) => boolean;
  /** The returned/raised expression of a return/throw statement. */
  argumentOf: (node: Node) => Node | null;
}

const JAVASCRIPT: Dialect = {
  ifNode: "if_statement",
  conditionField: "condition",
  consequenceField: "consequence",
  alternativeField: "alternative",
  tryNode: "try_statement",
  catchNodes: ["catch_clause"],
  finallyNodes: ["finally_clause"],
  loopNodes: ["for_statement", "for_in_statement", "while_statement", "do_statement"],
  returnNode: "return_statement",
  throwNode: "throw_statement",
  callNode: "call_expression",
  isFunction: (t) => JS_FUNCTIONS.has(t),
  // The `argument` field is not bound in this grammar build, so the returned
  // expression is read by position: `return`/`throw` is an anonymous token and
  // the expression is the statement's only named child.
  argumentOf: (n) => n.namedChild(0),
};

const PYTHON: Dialect = {
  ifNode: "if_statement",
  conditionField: "condition",
  consequenceField: "consequence",
  alternativeField: "alternative",
  tryNode: "try_statement",
  catchNodes: ["except_clause"],
  finallyNodes: ["finally_clause"],
  loopNodes: ["for_statement", "while_statement"],
  returnNode: "return_statement",
  throwNode: "raise_statement",
  callNode: "call",
  isFunction: (t) => t === "function_definition",
  argumentOf: (n) => n.namedChild(0),
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function buildCfg(body: Node, rules: CfgRules, d: Dialect): CfgBlock[] {
  const blocks: CfgBlock[] = [{
    blockIndex: 0, parentIndex: null, branchLabel: null, kind: "root", conditionText: null,
    outcome: null, exitForm: null, errorName: null,
    startLine: lineOf(body), endLine: body.endPosition.row + 1, startCol: colOf(body),
  }];

  /**
   * Append a block under `parent` and return its index.
   *
   * `label` is the block's OWN arm relative to `parent` — inherited from
   * whichever region the caller is currently walking (ambient), except at the
   * three places a new region begins (`then`/`else`/`try_body`/`catch`/
   * `finally`/`loop_body`), where the caller passes the fresh label instead of
   * the ambient one.
   */
  const emit = (
    kind: BlockKind, node: Node, parent: number, condition: string | null,
    label: BranchLabel | null,
    exit?: Pick<CfgBlock, "outcome" | "exitForm" | "errorName">,
  ): number => {
    const blockIndex = blocks.length;
    blocks.push({
      blockIndex,
      parentIndex: parent,
      branchLabel: label,
      kind,
      conditionText: condition,
      outcome: exit?.outcome ?? null,
      exitForm: exit?.exitForm ?? null,
      errorName: exit?.errorName ?? null,
      startLine: lineOf(node),
      endLine: node.endPosition.row + 1,
      startCol: colOf(node),
    });
    return blockIndex;
  };

  /**
   * Sentinel bindings: `const authErr = checkUserAuth(...)`.
   *
   * Recorded so `if (authErr) return authErr;` can be classified as an error
   * exit. Without the binding it is just "returns a variable", which is
   * indistinguishable from returning a result.
   */
  const sentinels = new Set<string>();
  /**
   * Identifiers bound to a reviewed error builder:
   * `const body = envelopeError({ code: 'KRI40-AUTH-001' })`.
   *
   * This is the corpus's DOMINANT error shape, and it is indirect — the error
   * is built into a variable and returned a few lines later through a
   * framework call: `return reply.status(body.status_code).send(body)`. Without
   * tracking the binding, that return has no literal status and no builder in
   * call position, and classified as `success`. Every error path in
   * `proxyToEngine` rendered green.
   */
  const errorBound = new Map<string, string>();

  walk(body, (node) => {
    if (d.isFunction(node.type)) return false;
    if (node.type === "variable_declarator" || node.type === "assignment") {
      const name = node.childForFieldName("name") ?? node.childForFieldName("left");
      const value = node.childForFieldName("value") ?? node.childForFieldName("right");
      if (name?.type !== "identifier" || !value) return true;
      if (value.type === d.callNode) {
        sentinels.add(name.text);
        const callee = calleeName(value, d);
        if (callee && rules.errorBuilders.has(callee)) {
          errorBound.set(name.text, errorCodeIn(value) ?? callee);
        }
      }
    }
    return true;
  });

  function conditionText(node: Node): string | null {
    let c = node.childForFieldName(d.conditionField);
    while (c?.type === "parenthesized_expression") c = c.namedChild(0);
    return c ? c.text.replace(/\s+/g, " ").trim() : null;
  }

  const classifyReturn = (
    node: Node, parent: number,
  ): Pick<CfgBlock, "outcome" | "exitForm" | "errorName"> => {
    const arg = d.argumentOf(node);
    if (!arg) return { outcome: "success", exitForm: "implicit", errorName: null };

    // `return envelopeError({ code: 'KRI40-AUTH-001' })` — the corpus's idiom.
    const builderName = calleeName(arg, d);
    if (builderName && rules.errorBuilders.has(builderName)) {
      return {
        outcome: "error_exit", exitForm: "return_error",
        errorName: errorCodeIn(arg) ?? builderName,
      };
    }

    // `return reply.status(401).send(body)` / `JSONResponse(status_code=401)`.
    const status = statusCodeIn(arg);
    if (status !== null && status >= 400) {
      return { outcome: "error_exit", exitForm: "return_error", errorName: `HTTP ${status}` };
    }

    // `return reply.status(body.status_code).send(body)` where `body` was bound
    // to an error builder. Checked before the sentinel rule because the
    // identifier here is nested inside a framework call, not returned bare.
    for (const [name, code] of errorBound) {
      if (referencesIdentifier(arg, name)) {
        return { outcome: "error_exit", exitForm: "return_error", errorName: code };
      }
    }

    // `if (authErr) return authErr;` — the sentinel, only inside its own guard.
    if (arg.type === "identifier" && sentinels.has(arg.text)) {
      const guard = blocks[parent];
      if (guard && (guard.kind === "guard" || guard.kind === "branch") &&
          guard.conditionText?.includes(arg.text)) {
        return { outcome: "error_exit", exitForm: "return_error", errorName: arg.text };
      }
      // Bound to a call and returned outside a guard testing it: a result, not
      // a sentinel. `unknown` rather than `success` — the rules do not cover it
      // and guessing green is the one unsafe direction.
      return { outcome: "unknown", exitForm: "return_value", errorName: null };
    }

    return { outcome: "success", exitForm: "return_value", errorName: null };
  };

  /**
   * An `if` is a GUARD when its consequence exits, and a BRANCH otherwise.
   *
   * The distinction is the point of R76: `if (authErr) return authErr;` is not
   * a fork in the flow, it is a gate — everything after it is the success
   * continuation, and every call below is guarded by that condition.
   */
  const visitIf = (node: Node, parent: number, label: BranchLabel | null): void => {
    const consequence = node.childForFieldName(d.consequenceField);
    const alternative = d.alternativeField
      ? node.childForFieldName(d.alternativeField)
      : null;
    const guards = consequence !== null && exitsImmediately(consequence, d);
    const index = emit(guards ? "guard" : "branch", node, parent, conditionText(node), label);
    // `if (authErr) return authErr;` has the return AS the consequence, not
    // inside a block. `visit` iterates a node's children, so it would descend
    // into the returned expression and never emit the exit — the guard would
    // be recorded with no outcome at all.
    if (consequence) visitStatement(consequence, index, "then");
    if (alternative) visitStatement(alternative, index, "else");
  };

  /** One statement, which may itself be the exit rather than contain it. */
  function visitStatement(node: Node, parent: number, label: BranchLabel | null): void {
    if (node.type === d.returnNode) {
      emit("exit", node, parent, null, label, classifyReturn(node, parent));
      return;
    }
    if (node.type === d.throwNode) {
      emit("exit", node, parent, null, label, {
        outcome: "error_exit", exitForm: "throw",
        errorName: constructorName(d.argumentOf(node), d),
      });
      return;
    }
    if (node.type === d.ifNode) { visitIf(node, parent, label); return; }
    visit(node, parent, label);
  }

  function visit(node: Node, parent: number, label: BranchLabel | null): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (!child) continue;
      // A closure inside this function is its own CFG, walked when its own
      // FunctionRange comes round. Descending would merge two flows.
      if (d.isFunction(child.type)) continue;

      if (child.type === d.ifNode) { visitIf(child, parent, label); continue; }

      if (child.type === d.tryNode) {
        const tryIndex = emit("try", child, parent, null, label);
        const tryBody = child.childForFieldName("body") ?? child.namedChild(0);
        if (tryBody) visit(tryBody, tryIndex, "try_body");
        for (let j = 0; j < child.namedChildCount; j += 1) {
          const clause = child.namedChild(j)!;
          if (d.catchNodes.includes(clause.type)) {
            // Nested UNDER the try, not a sibling of it: a `finally` has to
            // run after both the try body and any catch, and deriving that
            // successor edge needs the real containment, not a flattened
            // "these three happen to be near each other" list.
            const catchIndex = emit("catch", clause, tryIndex, catchParam(clause), "catch");
            visit(clause, catchIndex, null);
          } else if (d.finallyNodes.includes(clause.type)) {
            const finallyIndex = emit("finally", clause, tryIndex, null, "finally");
            visit(clause, finallyIndex, null);
          }
        }
        continue;
      }

      if (d.loopNodes.includes(child.type)) {
        const loopIndex = emit("loop", child, parent, conditionText(child), label);
        visit(child, loopIndex, "loop_body");
        continue;
      }

      if (child.type === d.throwNode) {
        emit("exit", child, parent, null, label, {
          outcome: "error_exit", exitForm: "throw",
          errorName: constructorName(d.argumentOf(child), d),
        });
        continue;
      }

      if (child.type === d.returnNode) {
        emit("exit", child, parent, null, label, classifyReturn(child, parent));
        continue;
      }

      visit(child, parent, label);
    }
  }

  visit(body, 0, null);
  return blocks;
}

// ---------------------------------------------------------------------------
// Deriving the flowchart's arrows from the completed block list
// ---------------------------------------------------------------------------

/**
 * Turn the containment tree into directed successor edges.
 *
 * A pure function over the finished `CfgBlock[]`, deliberately separate from
 * the walk above: the tree already has everything needed (`parentIndex`,
 * `branchLabel`, and source order via `blockIndex`), so this is graph
 * derivation, not parsing, and is testable on a plain array with no
 * tree-sitter node in sight.
 *
 * **Scope, stated so it is not over-promised.** This models `if`/`else`,
 * `try`/`catch`/`finally` and loop entry/exit/repeat. It does NOT model
 * `break`/`continue` as separate jump targets — a `break` inside a loop body
 * is invisible to this pass, same as the file's existing exclusion of
 * interprocedural data flow. And a try's `catch` edge is one abstract "an
 * exception here transfers control there" arrow from the try node itself, not
 * from every individual statement in the body — real exception unwinding can
 * happen from any point in the try, which is unmodelable syntactically.
 */
export function deriveEdges(blocks: CfgBlock[]): CfgEdge[] {
  const edges: CfgEdge[] = [];

  const byParent = new Map<number, CfgBlock[]>();
  for (const b of blocks) {
    if (b.parentIndex === null) continue;
    const list = byParent.get(b.parentIndex);
    if (list) list.push(b); else byParent.set(b.parentIndex, [b]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.blockIndex - b.blockIndex);

  /** The first child of `parent`, optionally restricted to one arm. */
  const firstChild = (parent: number, label?: BranchLabel): number | null => {
    const list = byParent.get(parent) ?? [];
    const matches = label ? list.filter((b) => b.branchLabel === label) : list;
    return matches.length > 0 ? matches[0]!.blockIndex : null;
  };

  /** Every child of `parent` in one arm — for try's (possibly several) catches. */
  const childrenWithLabel = (parent: number, label: BranchLabel): CfgBlock[] =>
    (byParent.get(parent) ?? []).filter((b) => b.branchLabel === label);

  /**
   * What runs after `blockIndex`'s ENTIRE subtree finishes — its merge point.
   *
   * Climbs the containment tree looking for the next sibling in the SAME arm.
   * The one structural exception: falling out of a try's body or its catch
   * does not skip straight to whatever follows the try — a `finally`, if one
   * exists, runs first and is not optional the way an ordinary "next
   * statement" is.
   */
  const nextAfter = (blockIndex: number): number | null => {
    let current = blocks[blockIndex]!;
    for (;;) {
      const parent = current.parentIndex;
      if (parent === null) return null; // falls off the end of the function
      const siblings = (byParent.get(parent) ?? []).filter((b) =>
        b.branchLabel === current.branchLabel && b.blockIndex > current.blockIndex);
      if (siblings.length > 0) return siblings[0]!.blockIndex;

      const parentBlock = blocks[parent]!;
      if (parentBlock.kind === "try" &&
          (current.branchLabel === "try_body" || current.branchLabel === "catch")) {
        const finallyBlock = firstChild(parent, "finally");
        if (finallyBlock !== null) return finallyBlock;
      }
      current = parentBlock;
    }
  };

  for (const block of blocks) {
    const i = block.blockIndex;
    switch (block.kind) {
      case "exit":
        break; // terminal — no outgoing edges

      case "branch":
      case "guard": {
        const truthy = firstChild(i, "then");
        const falsy = firstChild(i, "else");
        edges.push({ from: i, to: truthy ?? nextAfter(i), label: "true" });
        edges.push({ from: i, to: falsy ?? nextAfter(i), label: "false" });
        break;
      }

      case "loop": {
        const bodyEntry = firstChild(i, "loop_body");
        // Only when the body holds a construct this pass captures. A body of
        // plain statements produces no block to point at, and a self-pointing
        // `true` edge would say the same thing as the back-edge below twice.
        if (bodyEntry !== null) edges.push({ from: i, to: bodyEntry, label: "true" });
        edges.push({ from: i, to: nextAfter(i), label: "false" });
        // Unconditional: a loop repeats whether or not its body contains
        // anything this pass models. Emitting it only for loops with nested
        // constructs would draw a loop that never loops.
        edges.push({ from: i, to: i, label: "loop_back" });
        break;
      }

      case "try": {
        const tryBody = firstChild(i, "try_body");
        const finallyBlock = firstChild(i, "finally");
        edges.push({ from: i, to: tryBody ?? finallyBlock ?? nextAfter(i), label: "next" });
        for (const c of childrenWithLabel(i, "catch")) {
          edges.push({ from: i, to: c.blockIndex, label: "catch" });
        }
        break;
      }

      case "catch": {
        const finallyBlock = firstChild(block.parentIndex!, "finally");
        const entry = firstChild(i);
        edges.push({ from: i, to: entry ?? finallyBlock ?? nextAfter(i), label: "next" });
        break;
      }

      case "finally":
      case "root": {
        const entry = firstChild(i);
        edges.push({ from: i, to: entry ?? nextAfter(i), label: "next" });
        break;
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------

function exitsImmediately(node: Node, d: Dialect): boolean {
  if (node.type === d.returnNode || node.type === d.throwNode) return true;
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i)!;
    if (d.isFunction(child.type)) continue;
    if (child.type === d.returnNode || child.type === d.throwNode) return true;
  }
  return false;
}

function catchParam(clause: Node): string | null {
  const p = clause.childForFieldName("parameter") ?? clause.namedChild(0);
  return p && p.type === "identifier" ? p.text : null;
}

function constructorName(node: Node | null, d: Dialect): string | null {
  if (!node) return null;
  if (node.type === "new_expression") return node.childForFieldName("constructor")?.text ?? null;
  if (node.type === d.callNode) return node.childForFieldName("function")?.text ?? null;
  if (node.type === "identifier") return node.text;
  return null;
}

function calleeName(node: Node, d: Dialect): string | null {
  if (node.type !== d.callNode) return null;
  const fn = node.childForFieldName("function");
  if (!fn) return null;
  return fn.type === "identifier" ? fn.text : fn.text.split(".").pop() ?? null;
}

/** Does this expression mention `name` as a whole identifier token? */
function referencesIdentifier(node: Node, name: string): boolean {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n.type === "identifier" && n.text === name) { found = true; return false; }
    return true;
  });
  return found;
}

/** An error-code string literal anywhere in the returned expression. */
function errorCodeIn(node: Node): string | null {
  let found: string | null = null;
  walk(node, (n) => {
    if (found) return false;
    if (n.type === "string" || n.type === "string_literal") {
      const text = literalText(n);
      // The corpus's shape: KRI40-AUTH-001, KRI51-MAIL-VALIDATE-001.
      if (/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/.test(text)) found = text;
    }
    return true;
  });
  return found;
}

/**
 * An HTTP status in `status(4xx)`, `status_code=4xx` or `statusCode: 4xx`.
 *
 * The "is this a status" test walks a few ancestors, not just the immediate
 * parent: in `reply.status(403)` the literal's parent is the argument list
 * `(403)`, which contains no such word — the call one level up does. Checking
 * only the parent silently classified every 4xx return as a success.
 */
function statusCodeIn(node: Node): number | null {
  let found: number | null = null;
  walk(node, (n) => {
    if (found !== null) return false;
    if (n.type === "number" || n.type === "integer") {
      const value = Number(n.text);
      if (Number.isInteger(value) && value >= 100 && value <= 599 && namedByStatus(n)) {
        found = value;
      }
    }
    return true;
  });
  return found;
}

/** Does an enclosing call, pair or keyword argument mention a status? */
function namedByStatus(node: Node): boolean {
  let current: Node | null = node.parent;
  for (let depth = 0; current && depth < 3; depth += 1) {
    // The callee/key text only, never the whole subtree: the subtree of an
    // outer `.send({ status_code: x })` would match for any number inside it.
    const label =
      current.childForFieldName("function")?.text ??
      current.childForFieldName("name")?.text ??
      current.childForFieldName("key")?.text ?? "";
    if (/status/i.test(label)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * The innermost block containing a line — the R77 attribution.
 *
 * Innermost by span, so a call inside `if (x) { ... }` inside `try { ... }`
 * attributes to the branch rather than the try. Returns 0 (the root) when no
 * nested block contains it, which is the correct answer for a call on the
 * function's main path.
 */
export function blockAt(blocks: CfgBlock[], line: number): number {
  let best = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const b of blocks) {
    if (b.kind === "exit" || b.startLine > line || b.endLine < line) continue;
    const span = b.endLine - b.startLine;
    if (span < bestSpan) { best = b.blockIndex; bestSpan = span; }
  }
  return best;
}

/**
 * Is every path through this block an error exit?
 *
 * Used by the failure surface: a call reachable only through a block whose
 * exits all error is a call on the error path. `unknown` blocks make the
 * answer false — an undetermined exit is not evidence of anything.
 */
export function isErrorOnly(blocks: CfgBlock[], blockIndex: number): boolean {
  const exits = blocks.filter(
    (b) => b.kind === "exit" && isDescendant(blocks, b.blockIndex, blockIndex),
  );
  return exits.length > 0 && exits.every((e) => e.outcome === "error_exit");
}

function isDescendant(blocks: CfgBlock[], child: number, ancestor: number): boolean {
  let current: number | null = child;
  const seen = new Set<number>();
  while (current !== null && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = blocks[current]?.parentIndex ?? null;
  }
  return false;
}
