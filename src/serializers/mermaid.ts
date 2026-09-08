// ============================================================================
// Mermaid emitter  —  task P2-T6  (requirement R46)
// ============================================================================
// A flow as ~20 lines of Mermaid, for PR comments, docs and LLM consumption.
//
// The reason this ships before the React Flow UI, and independently of it: a
// diagram that renders in a PR comment is read by people who will never open a
// UI, and it costs a hundred lines instead of an app. Doc §Q.3 names building
// the UI first as the most common way this class of project dies.
//
// **The two axes stay separate here too.** Mermaid gives us link styles and
// node classes, which is exactly the pair R49/R78 need:
//
//   confidence  -> link style   solid / dashed / dotted / thick-red
//   outcome     -> node class   green success, red error exit, grey unknown
//
// Conflating them is the easy mistake and R78 forbids it: a `REQUESTS` edge is
// dashed because we are unsure the edge exists, while sitting on a green path
// because we are sure that branch is the success continuation. Those are
// different claims and a reader must be able to tell which is being made.
// ============================================================================

import type { EndpointFlow, FlowNode } from "../query/endpoint-flow.ts";
import type { Confidence } from "../store/db.ts";
import { displayNameOf, symbolKind } from "../static/scip/symbol.ts";

export interface MermaidOptions {
  /** Include boundary nodes (packages, builtins). Off by default — they dominate. */
  externals?: boolean;
  /** Cap on nodes emitted. A diagram nobody can read is not a diagram. */
  maxNodes?: number;
  /** Emit a legend subgraph. On by default: the two axes need explaining once. */
  legend?: boolean;
}

const DEFAULT_MAX_NODES = 40;

/** Mermaid link syntax per confidence. The `-->` arrow length sets rank spacing. */
const LINK: Record<Confidence, string> = {
  certain: "-->",
  observed: "==>",
  inferred: "-.->",
  unresolved: "-.->",
};

export function flowToMermaid(flow: EndpointFlow, options: MermaidOptions = {}): string {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const lines: string[] = ["flowchart LR"];
  const ids = new Map<string, string>();
  const emitted = new Set<string>();
  // Links are collected as records and deduped before emission. Mermaid's
  // `linkStyle` is indexed by declaration order, so a dedupe pass that ran
  // after the styles were pushed would colour the wrong edges.
  const links: Array<{ from: string; to: string; confidence: Confidence }> = [];
  let truncated = false;

  const link = (from: string, to: string, confidence: Confidence): void => {
    // Two call sites from one caller to one callee are one arrow. The tree
    // shows both; a diagram showing both is just a thicker line.
    if (from === to) return;
    if (links.some((l) => l.from === from && l.to === to)) return;
    links.push({ from, to, confidence });
  };

  const idOf = (key: string): string => {
    const existing = ids.get(key);
    if (existing) return existing;
    const id = `n${ids.size}`;
    ids.set(key, id);
    return id;
  };

  const declare = (key: string, label: string, cls: string): string => {
    const id = idOf(key);
    if (!emitted.has(id)) {
      emitted.add(id);
      lines.push(`  ${id}${shape(cls, escape(label))}`);
      if (cls) lines.push(`  class ${id} ${cls}`);
    }
    return id;
  };

  // The route itself, then the chain, then each step's tree.
  const routeId = declare(
    flow.routeKey, `${flow.method} ${flow.url}`, "route",
  );

  let previous = routeId;
  for (const step of flow.chain) {
    if (emitted.size >= maxNodes) { truncated = true; break; }
    const isInline = step.phase === "handler_inline";
    const label = isInline
      ? `${step.checkKind ?? "check"}: ${step.name ?? "(shape match)"}`
      : `${step.phase}<br/>${step.name ?? "(anonymous)"}`;
    // The security channel is its own class, so a boot-verified hook and a
    // statically-inferred check are never the same colour (R50).
    const cls = isInline ? "inlineCheck" : step.checkKind ? "bootCheck" : "chain";
    const id = declare(`${flow.routeKey}#${step.phase}#${step.position}`, label, cls);

    link(previous, id, step.confidence);
    if (!isInline) previous = id;
    // The chain step's own symbol shares this node, so a gap owned by that
    // symbol has somewhere to attach. Without it the gap renders as an orphan
    // — a red circle floating beside the diagram.
    //
    // NAMESPACE symbols are excluded. Several anonymous hooks join the same
    // module, so mapping it would attach a module-scope gap to whichever step
    // happened to be last — an arbitrary edge. Those attach to the route
    // instead, which is where a file-level gap actually belongs.
    if (step.symbolKey && symbolKind(step.symbolKey) !== "namespace") {
      ids.set(step.symbolKey, id);
    }

    if (step.tree) {
      walkTree(step.tree, id);
    }
  }

  function walkTree(node: FlowNode, parentId: string): void {
    for (const child of node.children) {
      if (emitted.size >= maxNodes) { truncated = true; return; }
      if (!options.externals && child.kind === "external" && child.children.length === 0) {
        continue;
      }
      const cls = child.kind === "route" ? "remote"
        : child.kind === "datastore" ? "datastore"
        : child.kind === "config" ? "config"
        : child.kind === "external" ? "external"
        : child.cycle ? "cycle"
        : "symbol";
      const id = declare(child.key, child.display, cls);
      link(parentId, id, child.edge);
      walkTree(child, id);
      if (child.remote) {
        // The REQUESTS edge already lands ON the remote route node, so this is
        // the same node — `declare` returns the same id and the link would be
        // a self-loop. Only draw it when the remote is genuinely another node.
        const remoteId = declare(
          child.remote.routeKey,
          `${child.remote.service}<br/>${child.remote.method} ${child.remote.url}`,
          "remote",
        );
        link(id, remoteId, "inferred");
      }
    }
  }

  // R61 has a diagram form too: gaps become explicit nodes, because a branch
  // that is simply absent reads as "this function calls nothing".
  for (const gap of flow.unknown.slice(0, 5)) {
    if (emitted.size >= maxNodes) { truncated = true; break; }
    // A gap whose owner is not in the diagram is dropped rather than drawn
    // floating: an unattached red circle says a gap exists somewhere, which is
    // less useful than the UNKNOWN section already is, and adds noise.
    // A gap owned by the module belongs to the route, not to a step.
    const owner = symbolKind(gap.srcKey) === "namespace"
      ? routeId
      : ids.get(gap.srcKey);
    if (!owner) continue;
    const id = declare(
      `gap#${gap.file}#${gap.line}`,
      // The target hint is a raw SCIP symbol. Unshortened it is wider than the
      // rest of the diagram put together.
      `?? ${shortTarget(gap.targetHint)}`,
      "gap",
    );
    link(owner, id, "unresolved");
  }

  for (const l of links) lines.push(`  ${l.from} ${LINK[l.confidence]} ${l.to}`);

  // linkStyle is indexed by declaration order, so these come after every link
  // and use the deduped index.
  links.forEach((l, i) => {
    if (l.confidence === "unresolved") {
      lines.push(`  linkStyle ${i} stroke:#c0392b,stroke-width:2px`);
    }
  });

  lines.push(...CLASS_DEFS);
  if (options.legend !== false) lines.push(...LEGEND);
  if (truncated) {
    lines.push(`  %% truncated at ${maxNodes} nodes — the full flow is larger`);
  }
  return lines.join("\n");
}

/** Node shape per class. Shape carries kind; colour carries outcome. */
function shape(cls: string, label: string): string {
  switch (cls) {
    case "route":
    case "remote": return `[/"${label}"/]`;
    case "datastore": return `[("${label}")]`;
    case "config": return `>"${label}"]`;
    case "external": return `{{"${label}"}}`;
    case "gap": return `(("${label}"))`;
    default: return `["${label}"]`;
  }
}

/** A readable label for an unresolved target, which is usually a SCIP symbol. */
function shortTarget(hint: string | null): string {
  if (!hint) return "unresolved";
  if (!hint.includes(" ")) return hint;
  const name = displayNameOf(hint);
  const parts = hint.split(" ");
  // `scip-typescript npm axios 1.7.2 ...` -> `axios@1.7.2`
  return parts.length >= 4 ? `${parts[2]}@${parts[3]}` : name;
}

function escape(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/[[\]{}()]/g, "");
}

const CLASS_DEFS = [
  "  classDef route fill:#1f6feb,stroke:#1f6feb,color:#fff",
  "  classDef remote fill:#8250df,stroke:#8250df,color:#fff",
  "  classDef chain fill:#f6f8fa,stroke:#57606a,color:#24292f",
  // R50: boot-verified and statically-inferred checks must be distinguishable
  // at a glance. Filled vs outlined, not two shades of the same colour.
  "  classDef bootCheck fill:#1a7f37,stroke:#1a7f37,color:#fff",
  "  classDef inlineCheck fill:#fff,stroke:#1a7f37,stroke-width:2px,stroke-dasharray:4 3,color:#1a7f37",
  "  classDef symbol fill:#fff,stroke:#57606a,color:#24292f",
  "  classDef datastore fill:#fff8c5,stroke:#9a6700,color:#24292f",
  "  classDef config fill:#fff,stroke:#9a6700,stroke-dasharray:3 2,color:#9a6700",
  "  classDef external fill:#eaeef2,stroke:#8c959f,color:#57606a",
  "  classDef cycle fill:#fff,stroke:#8c959f,stroke-dasharray:2 2,color:#8c959f",
  "  classDef gap fill:#fff,stroke:#c0392b,stroke-width:2px,color:#c0392b",
];

const LEGEND = [
  "  subgraph legend[\" \"]",
  "    direction LR",
  "    l1[\"solid = certain\"] --> l2[\"dashed = inferred\"]",
  "    l2 -.-> l3[\"red = unresolved gap\"]",
  "    l4[\"filled green = boot-verified check\"] --> l5[\"outlined green = statically inferred\"]",
  "  end",
  "  class l1,l2,l3,l4,l5 chain",
  "  class legend chain",
];
