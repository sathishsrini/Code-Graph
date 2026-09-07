// Terminal rendering for endpoint_flow (P1-T12).
//
// Two independent axes, kept independent (R78 makes this explicit for Phase 2's
// UI; the same discipline applies here):
//
//   confidence  line style   ── certain  ══ observed  ╌╌ inferred  ?? unresolved
//   provenance  a label      [boot] is what the framework said; [inferred] is
//                            what a parser guessed. Never merged.
//
// The two security channels are rendered as separate blocks for the same
// reason. Presenting a boot-verified hook and a statically-detected inline
// check in one undifferentiated list renders an inference as a fact (R26, R50).

import type { ChainStep, EndpointFlow, FlowNode } from "./endpoint-flow.ts";
import type { Confidence } from "../store/db.ts";

const MARKER: Record<Confidence, string> = {
  certain: "──", observed: "══", inferred: "╌╌", unresolved: "??",
};

const EDGE_LABEL: Record<string, string> = {
  CALLS: "", CALLS_EXTERNAL: "external ", REQUESTS: "HTTP ",
  READS: "reads ", WRITES: "WRITES ", READS_CONFIG: "config ", THROWS: "throws ",
};

export interface RenderOptions {
  /**
   * List every external boundary node instead of summarising them.
   *
   * Off by default because they dominate: on `POST /api/v1/po` the handler's
   * tree is 4 local calls and ~20 boundary hits, mostly `builtin:ecmascript`
   * (`Date.now`, `.toString`). Those are true and worth keeping as edges —
   * `impact` reads them — but listing each one buries the answer to the
   * question actually asked.
   */
  externals?: boolean;
}

export function renderEndpointFlow(
  flow: EndpointFlow, indent = "", options: RenderOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`${indent}${flow.method} ${flow.url}    service: ${flow.service}`);

  const boot = flow.chain.filter((c) => c.phase !== "handler_inline");
  const inline = flow.chain.filter((c) => c.phase === "handler_inline");

  lines.push("");
  lines.push(`${indent}ROUTE CHAIN  (evidence: boot · confidence: certain)`);
  if (boot.length === 0) {
    lines.push(`${indent}  (none reported)`);
  }
  for (const c of boot) {
    lines.push(`${indent}  ${renderStep(c)}`);
  }

  if (inline.length > 0) {
    lines.push("");
    lines.push(
      `${indent}INLINE SECURITY CHECKS  (evidence: treesitter · confidence: inferred)`,
    );
    // Stated every time. The boot chain above is what the framework reported;
    // these were inferred from a handler body and are a weaker claim.
    for (const c of inline) {
      const kind = c.checkKind ? `[${c.checkKind}] ` : "";
      lines.push(
        `${indent}  ${String(c.position).padStart(2)}. ${kind}` +
        `${(c.name ?? "(shape match)").padEnd(20)} ${c.key ?? ""}`,
      );
      if (c.detail) lines.push(`${indent}      ${c.detail}`);
    }
  }

  lines.push("");
  lines.push(`${indent}CALL TREE  (── certain · ══ observed · ╌╌ inferred · ?? unresolved)`);
  let printed = 0;
  for (const step of flow.chain) {
    if (!step.tree || step.tree.children.length === 0) continue;
    printed += 1;
    lines.push("");
    lines.push(`${indent}  ${step.phase}: ${step.name ?? step.key ?? ""}`);
    const sub: string[] = [];
    renderTree(step.tree, "", true, sub, indent, options);
    lines.push(...sub);
  }
  if (printed === 0) {
    lines.push(`${indent}  no chain entry resolved to a symbol with outgoing edges.`);
  }

  // R61's UNKNOWN section is mandatory. Omitting what could not be analysed is
  // what turns an unknown into a false negative.
  lines.push("");
  lines.push(`${indent}UNKNOWN`);
  if (flow.unjoined.length === 0 && flow.unknown.length === 0) {
    lines.push(`${indent}  every chain entry joined a symbol; no unresolved call sites on this path.`);
  }
  for (const c of flow.unjoined) {
    lines.push(
      `${indent}  ${c.phase} ${c.key ?? "(no position)"} — ` +
      `no definition in the index covers this line`,
    );
  }
  for (const u of flow.unknown) {
    lines.push(
      `${indent}  ${u.file ?? "?"}:${u.line ?? "?"}  ${u.srcDisplay} -> ` +
      `${u.targetHint ?? "(unnamed)"}\n${indent}      ${u.reason}`,
    );
  }

  if (flow.visitedServices.length > 1) {
    lines.push("");
    lines.push(`${indent}SERVICES ON THIS FLOW: ${flow.visitedServices.join(" -> ")}`);
  }

  return `${lines.join("\n")}\n`;
}

function renderStep(c: ChainStep): string {
  const from = c.inheritedFrom ? `  inherited from ${c.inheritedFrom}` : "";
  const fw = c.origin === "framework" ? "  [framework]" : "";
  const kind = c.checkKind ? `  [${c.checkKind}]` : "";
  return (
    `${String(c.position).padStart(2)}. ${c.phase.padEnd(11)}` +
    `${(c.name ?? "(anonymous)").padEnd(22)}${c.key ?? ""}${fw}${from}${kind}`
  );
}

/**
 * Split a node's children into the ones worth naming and the boundary hits.
 *
 * Kept as a count rather than dropped. "4 calls" and "4 calls plus 20 boundary
 * hits we chose not to list" are different pictures, and the second one is the
 * truth.
 */
function partition(children: FlowNode[]): { shown: FlowNode[]; collapsed: FlowNode[] } {
  const shown: FlowNode[] = [];
  const collapsed: FlowNode[] = [];
  for (const c of children) {
    if (c.kind === "external" && c.children.length === 0 && !c.remote) collapsed.push(c);
    else shown.push(c);
  }
  return { shown, collapsed };
}

function renderTree(
  node: FlowNode, prefix: string, isLast: boolean, out: string[], indent: string,
  options: RenderOptions,
): void {
  const branch = prefix === "" ? "" : `${isLast ? "└" : "├"}${MARKER[node.edge]} `;
  const label = node.edgeType ? (EDGE_LABEL[node.edgeType] ?? `${node.edgeType} `) : "";
  const conf = node.depth === 0
    ? ""
    : ` [${node.edge}]${node.pathConfidence !== node.edge ? ` path=${node.pathConfidence}` : ""}`;
  const where = node.line !== null ? `  ${node.file}:${node.line}` : "";
  const note = node.cycle ? "  (cycle)"
    : node.truncated ? "  (depth cap — not expanded)"
    : node.boundary && node.kind !== "route" ? "  (boundary)"
    : "";

  out.push(`${indent}  ${prefix}${branch}${label}${node.display}${conf}${where}${note}`);

  const childPrefix = prefix === "" ? "   " : `${prefix}${isLast ? "    " : "│   "}`;
  const { shown, collapsed } = options.externals
    ? { shown: node.children, collapsed: [] as FlowNode[] }
    : partition(node.children);

  const total = shown.length + (collapsed.length > 0 ? 1 : 0);
  shown.forEach((c, i) => renderTree(c, childPrefix, i === total - 1, out, indent, options));

  if (collapsed.length > 0) {
    // Named, with counts per destination, so the reader can see WHICH
    // boundaries were reached without reading one line per hit.
    const byKey = new Map<string, number>();
    for (const c of collapsed) byKey.set(c.key, (byKey.get(c.key) ?? 0) + 1);
    const summary = [...byKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    out.push(
      `${indent}  ${childPrefix}└╌╌ ${collapsed.length} boundary call(s): ` +
      `${summary}   (--externals to list)`,
    );
  }

  if (node.remote) {
    out.push("");
    out.push(`${indent}  ${childPrefix}┌─ crosses into ${node.remote.service} ─────`);
    out.push(renderEndpointFlow(node.remote, `${indent}  ${childPrefix}│ `, options).trimEnd());
  }
}
