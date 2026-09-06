// endpoint_flow, Phase 0 subset (task P0-T9, R35, R36).
//
// Answers "what executes on this endpoint?" by joining the two channels that
// see different halves of the answer:
//
//   boot   the ordered hook chain. Certain, and the only source for it —
//          middleware order is not recoverable from source text.
//   scip   the call tree under each of those functions. Inferred at the
//          boundaries, certain inside the repo.
//
// Neither is sufficient. On `POST /api/v1/po` the boot chain contains no auth
// check, because there is no auth *hook*: `checkUserAuth` is the handler's
// first statement, and only the call tree finds it. Equally, the call tree
// cannot know that the correlation-id hook runs before the handler.
//
// The Phase 1 version adds cross-service recursion and unresolved_calls
// branches. This one stops at the service boundary and says so.

import type { BootDump, BootRoute, ChainEntry } from "../boot/dump.ts";
import type {
  DerivedCall, SourceProvider, UnresolvedCall,
} from "../derive/calls.ts";
import type { ScipIndex } from "../static/scip/reader.ts";
import { ROLE_DEFINITION, hasRole } from "../static/scip/reader.ts";
import { displayNameOf, packageOf, symbolKind } from "../static/scip/symbol.ts";

/**
 * Confidence, as an enum and never a number (R7).
 *
 * `unresolved` is a first-class value, not an error: a call site whose target
 * could not be resolved is a known gap, and hiding it would turn an unknown
 * into a false negative.
 */
export type Confidence = "certain" | "inferred" | "observed" | "unresolved";

const RANK: Record<Confidence, number> = {
  certain: 3, observed: 2, inferred: 1, unresolved: 0,
};

/** R36: a path is only as trustworthy as its weakest edge. */
export function weakest(a: Confidence, b: Confidence): Confidence {
  return RANK[a] <= RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Joining a boot hook to its SCIP symbol
// ---------------------------------------------------------------------------

export interface DefRange {
  symbol: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Lines spanned; used to pick the innermost of several containing defs. */
  size: number;
}

/**
 * Index every definition that owns a body, so a `file:line` from the boot dump
 * can be resolved to the SCIP symbol that contains it.
 *
 * This is the join that makes the two channels one graph, and it is why the
 * boot adapter reports positions rather than names: 68% and 89% of chain
 * entries in the two Node services are anonymous, so names would join nothing.
 */
export function buildDefinitionRanges(index: ScipIndex): DefRange[] {
  const out: DefRange[] = [];
  for (const doc of index.documents) {
    for (const occ of doc.occurrences) {
      if (!hasRole(occ.symbolRoles, ROLE_DEFINITION)) continue;
      if (!occ.enclosingRange) continue;
      out.push({
        symbol: occ.symbol,
        file: doc.relativePath.split("\\").join("/"),
        startLine: occ.enclosingRange.startLine + 1,   // SCIP is 0-based
        endLine: occ.enclosingRange.endLine + 1,
        size: occ.enclosingRange.endLine - occ.enclosingRange.startLine,
      });
    }
  }
  return out;
}

/** The innermost definition containing `file:line`, or undefined. */
export function symbolAt(
  ranges: DefRange[], file: string, line: number,
): string | undefined {
  const f = file.split("\\").join("/");
  let best: DefRange | undefined;
  for (const r of ranges) {
    if (r.file !== f) continue;
    if (line < r.startLine || line > r.endLine) continue;
    if (!best || r.size < best.size) best = r;
  }
  return best?.symbol;
}

/**
 * Line span of the function starting at `line:col`.
 *
 * Needed because an arrow function passed straight to `addHook` gets no SCIP
 * definition of its own, so `symbolAt` resolves it to the enclosing MODULE.
 * Rooting the hook's call tree at the module is not a near miss — it attributes
 * every call in the file to the hook, including `listen` and `process.exit`.
 *
 * The boot dump gives the function's exact start, so its extent is recoverable
 * from the source by matching delimiters: skip the parameter list, then either
 * brace-match a block body or run to the end of an expression body.
 */
export function functionExtent(
  lines: string[], line: number, col: number,
): { startLine: number; endLine: number } | null {
  if (line < 1 || line > lines.length) return null;

  let depth = 0;              // (), [] and {} nesting
  let bodyStarted = false;
  let quote: string | null = null;
  let i = line - 1;
  let j = col;

  for (let guard = 0; i < lines.length && guard < 200_000; guard += 1) {
    const text = lines[i] ?? "";
    if (j >= text.length) { i += 1; j = 0; continue; }
    const ch = text[j]!;
    const next = text[j + 1];

    if (quote) {
      if (ch === "\\") { j += 2; continue; }
      if (ch === quote) quote = null;
      j += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; j += 1; continue; }
    if (ch === "/" && next === "/") { i += 1; j = 0; continue; }

    if (ch === "(" || ch === "[") { depth += 1; j += 1; continue; }
    if (ch === "{") {
      // The first `{` at depth 0 opens a block body; a `{` inside the
      // parameter list is destructuring and does not.
      if (depth === 0) bodyStarted = true;
      depth += 1;
      j += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0 && bodyStarted && ch === "}") return { startLine: line, endLine: i + 1 };
      if (depth < 0) return { startLine: line, endLine: i + 1 };  // expression body
      j += 1;
      continue;
    }
    // An expression-bodied arrow ends at the first top-level `;` or `,`.
    if (depth === 0 && !bodyStarted && (ch === ";" || ch === ",")) {
      return { startLine: line, endLine: i + 1 };
    }
    j += 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Call tree
// ---------------------------------------------------------------------------

export interface CallNode {
  symbol: string;
  display: string;
  /** Confidence of the edge that reached this node. */
  edge: Confidence;
  /** Weakest edge on the whole path from the root (R36). */
  pathConfidence: Confidence;
  file: string | null;
  line: number | null;
  depth: number;
  /** Outside any local package — the traversal stops here (R35 boundary). */
  external: boolean;
  /** Already expanded higher in this path; not expanded again. */
  cycle: boolean;
  /** True when children were withheld because the depth cap was reached. */
  truncated: boolean;
  children: CallNode[];
}

export interface CallTreeOptions {
  maxDepth?: number;
  localPackages?: Set<string>;
  /**
   * Restrict the ROOT's outgoing calls to a line span, and relabel it.
   *
   * Used for an anonymous hook, whose calls are attributed to the module
   * because it has no definition of its own. Only the root is scoped —
   * everything below it is a real symbol and traverses normally.
   */
  /**
   * Call sites whose target could not be named (R11). Rendered as explicit
   * unknown branches rather than omitted -- an absent branch reads as "nothing
   * is called here", which is a different and false claim.
   */
  unresolved?: UnresolvedCall[];
  rootScope?: {
    startLine: number;
    /** 0-based column the function starts at, on `startLine`. */
    startCol: number;
    endLine: number;
    display: string;
  };
}

/** R35: depth-capped, cycle-guarded traversal that terminates at boundaries. */
export function buildCallTree(
  calls: DerivedCall[], rootSymbol: string, options: CallTreeOptions = {},
): CallNode {
  const maxDepth = options.maxDepth ?? 12;
  const local = options.localPackages;
  const scope = options.rootScope;

  const unknownOut = new Map<string, UnresolvedCall[]>();
  for (const u of options.unresolved ?? []) {
    const list = unknownOut.get(u.srcSymbol);
    if (list) list.push(u); else unknownOut.set(u.srcSymbol, [u]);
  }

  const out = new Map<string, DerivedCall[]>();
  for (const c of calls) {
    const list = out.get(c.srcSymbol);
    if (list) list.push(c); else out.set(c.srcSymbol, [c]);
  }

  const isExternal = (symbol: string) =>
    local !== undefined && !local.has(packageOf(symbol));

  const visit = (
    symbol: string, edge: Confidence, inherited: Confidence,
    depth: number, ancestors: Set<string>,
    file: string | null, line: number | null,
  ): CallNode => {
    const pathConfidence = weakest(inherited, edge);
    const external = isExternal(symbol);
    const node: CallNode = {
      symbol,
      display: depth === 0 && scope ? scope.display : displayNameOf(symbol),
      edge, pathConfidence, file, line, depth, external,
      cycle: ancestors.has(symbol),
      truncated: false,
      children: [],
    };
    // Stop at a boundary, a cycle, or the cap — and record which, so the
    // reader can tell "nothing below" from "not explored".
    if (node.cycle || external) return node;
    if (depth >= maxDepth) {
      node.truncated = (out.get(symbol)?.length ?? 0) > 0;
      return node;
    }

    const next = new Set(ancestors).add(symbol);
    const seen = new Set<string>();
    const outgoing = (out.get(symbol) ?? []).filter((c) => {
      if (depth > 0 || !scope) return true;
      if (c.line < scope.startLine || c.line > scope.endLine) return false;
      // On the opening line, anything left of the function's own start belongs
      // to the expression that registers it, not to its body.
      return c.line > scope.startLine || c.col >= scope.startCol;
    });
    for (const c of outgoing.slice().sort((a, b) => a.line - b.line)) {
      if (seen.has(c.dstSymbol)) continue;    // one edge per callee per caller
      seen.add(c.dstSymbol);
      node.children.push(
        visit(c.dstSymbol, c.confidence, pathConfidence, depth + 1, next,
          c.filePath, c.line),
      );
    }

    for (const u of unknownOut.get(symbol) ?? []) {
      if (depth === 0 && scope) {
        if (u.line < scope.startLine || u.line > scope.endLine) continue;
        if (u.line === scope.startLine && u.col < scope.startCol) continue;
      }
      node.children.push({
        symbol: u.target,
        display: `${packageOf(u.target) || u.target}  — ${u.reason}`,
        edge: "unresolved",
        pathConfidence: "unresolved",
        file: u.filePath,
        line: u.line,
        depth: depth + 1,
        external: true,
        cycle: false,
        truncated: false,
        children: [],
      });
    }
    node.children.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    return node;
  };

  return visit(rootSymbol, "certain", "certain", 0, new Set(), null, null);
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export interface FlowStep {
  chain: ChainEntry;
  /** SCIP symbol the hook resolved to, or null when the join failed. */
  symbol: string | null;
  tree: CallNode | null;
}

export interface Flow {
  service: string;
  method: string;
  url: string;
  routeKey: string;
  steps: FlowStep[];
  /** Chain entries that could not be joined to a symbol — gaps, not zeroes. */
  unjoined: ChainEntry[];
}

export function buildFlow(
  dump: BootDump, route: BootRoute, calls: DerivedCall[], index: ScipIndex,
  options: CallTreeOptions & { sources?: SourceProvider | null } = {},
): Flow {
  const ranges = buildDefinitionRanges(index);
  const sources = options.sources;
  const steps: FlowStep[] = [];
  const unjoined: ChainEntry[] = [];

  for (const entry of route.chain) {
    const symbol = entry.file && entry.line
      ? symbolAt(ranges, entry.file, entry.line) ?? null
      : null;
    if (!symbol && entry.origin !== "framework") unjoined.push(entry);

    // A namespace symbol means the join landed on the module, not on the hook:
    // the hook is an anonymous function with no definition of its own. Scope
    // the root to the hook's own line span rather than reporting the module's
    // entire call list as this hook's behaviour.
    let rootScope: CallTreeOptions["rootScope"];
    if (symbol && symbolKind(symbol) === "namespace" && entry.line && sources) {
      const text = entry.file ? sources.text(entry.file) : null;
      const extent = text
        ? functionExtent(text.split(/\r?\n/), entry.line, entry.col ?? 0)
        : null;
      if (extent) {
        rootScope = {
          ...extent,
          startCol: entry.col ?? 0,
          display: `${entry.name ?? "(anonymous)"} @ ${entry.key}`,
        };
      } else {
        // Could not bound it. Say so instead of silently widening to the file.
        unjoined.push(entry);
      }
    }

    steps.push({
      chain: entry,
      symbol,
      tree: symbol && (!rootScope || rootScope.endLine >= rootScope.startLine)
        ? buildCallTree(calls, symbol, { ...options, rootScope })
        : null,
    });
  }

  return {
    service: dump.service,
    method: route.method,
    url: route.url,
    routeKey: route.routeKey,
    steps,
    unjoined,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Confidence marker.
 *
 * The plan renders confidence as line style and execution outcome as colour,
 * on two independent axes. In a terminal only the first axis exists, so this
 * is line style: solid for certain, dashed for inferred, `?` for unresolved.
 */
const MARKER: Record<Confidence, string> = {
  certain: "──", observed: "══", inferred: "╌╌", unresolved: "??",
};

function renderTree(node: CallNode, prefix: string, isLast: boolean, lines: string[]): void {
  const branch = prefix === "" ? "" : `${isLast ? "└" : "├"}${MARKER[node.edge]} `;
  const tag = node.depth === 0
    ? ""
    : ` [${node.edge}]${node.pathConfidence !== node.edge ? ` path=${node.pathConfidence}` : ""}`;
  const where = node.line !== null ? `  ${node.file}:${node.line}` : "";
  const note = node.cycle ? "  (cycle)"
    : node.edge === "unresolved" ? ""
    : node.external ? "  (external — boundary)"
    : node.truncated ? "  (depth cap — not expanded)"
    : "";
  lines.push(`${prefix}${branch}${node.display}${tag}${where}${note}`);

  const childPrefix = prefix === "" ? "   " : `${prefix}${isLast ? "    " : "│   "}`;
  node.children.forEach((c, i) =>
    renderTree(c, childPrefix, i === node.children.length - 1, lines));
}

export function renderFlow(flow: Flow): string {
  const lines: string[] = [];
  lines.push(`${flow.method} ${flow.url}    service: ${flow.service}`);
  lines.push("");
  lines.push("ROUTE CHAIN  (evidence: boot · confidence: certain)");
  lines.push("");

  for (const step of flow.steps) {
    const c = step.chain;
    const name = c.name ?? "(anonymous)";
    const from = c.inheritedFrom ? `  inherited from ${c.inheritedFrom}` : "";
    const fw = c.origin === "framework" ? "  [fastify]" : "";
    lines.push(
      `  ${String(c.position).padStart(2)}. ${c.phase.padEnd(11)}` +
      `${name.padEnd(22)}${c.key}${fw}${from}`,
    );
  }

  lines.push("");
  lines.push("CALL TREE  (evidence: scip · ── certain · ╌╌ inferred)");

  for (const step of flow.steps) {
    if (!step.tree) continue;
    const hasChildren = step.tree.children.length > 0;
    lines.push("");
    lines.push(`  ${step.chain.phase}:`);
    if (!hasChildren) {
      lines.push(`   ${step.tree.display}   (calls nothing resolvable)`);
      continue;
    }
    const sub: string[] = [];
    renderTree(step.tree, "", true, sub);
    for (const l of sub) lines.push(`  ${l}`);
  }

  // R61's mandatory UNKNOWN line, in its Phase 0 form. Omitting what could not
  // be analysed is what turns an unknown into a false negative.
  lines.push("");
  lines.push("UNKNOWN");
  if (flow.unjoined.length === 0) {
    lines.push("  every chain entry joined to a symbol in the index.");
  } else {
    for (const c of flow.unjoined) {
      lines.push(`  ${c.phase} ${c.key} — no definition in the index covers this line`);
    }
  }

  const unresolvedOnPath = new Map<string, { file: string | null; line: number | null }>();
  const collect = (n: CallNode): void => {
    if (n.edge === "unresolved") {
      unresolvedOnPath.set(`${n.display}|${n.file}:${n.line}`, { file: n.file, line: n.line });
    }
    n.children.forEach(collect);
  };
  for (const s of flow.steps) if (s.tree) collect(s.tree);

  for (const [label, at] of unresolvedOnPath) {
    lines.push(`  ${at.file}:${at.line} — ${label.split("|")[0]}`);
  }
  lines.push(
    "  cross-service calls are not followed in Phase 0; " +
    "an outbound HTTP call shows as an unresolved or external boundary.",
  );

  return lines.join("\n") + "\n";
}
