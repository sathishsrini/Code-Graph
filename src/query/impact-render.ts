// Terminal rendering for impact (P1-T13).
//
// The layout is the requirement. R37 says direct, transitive and
// confidence-segmented results are three different answers, so they get three
// headings and are never summed into one number. R39 says a utility gets a
// verdict instead of a list.

import type { AffectedRoute, ImpactReport, SharedNode } from "./impact.ts";

export function renderImpact(r: ImpactReport): string {
  const out: string[] = [];

  out.push(`IMPACT OF CHANGING  ${r.seed.display}`);
  out.push(`  ${r.seed.key}`);
  if (r.seed.file) out.push(`  ${r.seed.file}`);
  out.push("");

  if (r.isUtility) {
    // R39. The doc names listing 200 endpoints as how this feature dies: an
    // answer of "everything" is indistinguishable from no answer. The verdict
    // comes first so it is read before the list it qualifies.
    out.push(
      `⚠ UTILITY — expect broad impact. ${r.fanIn} distinct direct callers ` +
      `(threshold ${r.utilityThreshold}).`,
    );
    out.push(
      "  Treat the route list below as 'most of the service', not as a review list.",
    );
    out.push("");
  } else {
    out.push(`fan-in: ${r.fanIn} direct caller(s)`);
    out.push("");
  }

  out.push(`DIRECT CALLERS  (depth 1) — ${r.direct.length}`);
  if (r.direct.length === 0) out.push("  none");
  for (const s of r.direct) {
    out.push(`  ${s.display.padEnd(28)} ${s.file ?? "?"}:${s.line ?? "?"}  [${s.pathConfidence}]`);
  }

  out.push("");
  out.push(`TRANSITIVE  (depth 2+) — ${r.transitive.length}`);
  if (r.transitive.length === 0) out.push("  none");
  for (const s of r.transitive.slice(0, 30)) {
    out.push(
      `  d${String(s.depth).padEnd(2)} ${s.display.padEnd(26)} ` +
      `${s.file ?? "?"}:${s.line ?? "?"}  [${s.pathConfidence}]`,
    );
  }
  if (r.transitive.length > 30) {
    out.push(`  … ${r.transitive.length - 30} more`);
  }

  out.push("");
  out.push(`AFFECTED ROUTES — ${r.totalRoutes}${r.routesTruncated ? " (list trimmed, count exact)" : ""}`);
  renderRouteBucket(out, "CERTAIN   — every edge on the path is compiler-resolved", r.routes.certain);
  renderRouteBucket(out, "INFERRED  — at least one hop is a guess; may not break", r.routes.inferred);
  renderRouteBucket(out, "UNKNOWN   — the path crosses something unresolved", r.routes.unknown);

  out.push("");
  out.push("OTHER DEPENDENCY KINDS  (R38)");
  renderShared(out, "configuration", r.configuration, "reads the same config");
  renderShared(out, "data", r.data, "touches the same datastore");
  out.push(`  runtime      : ${r.runtime.available ? `${r.runtime.routes.length} route(s)` : "unavailable"}`);
  if (!r.runtime.available) out.push(`                 ${r.runtime.reason}`);

  // R61 again: the change may reach further than this closure shows, and
  // saying so is the difference between a bounded answer and a false one.
  out.push("");
  out.push("UNKNOWN");
  if (r.unknownEdges.length === 0) {
    out.push("  no unresolved call sites inside the affected set.");
  }
  for (const u of r.unknownEdges) {
    out.push(`  ${u.file ?? "?"}:${u.line ?? "?"}  ${u.srcKey} — ${u.reason}`);
  }

  return `${out.join("\n")}\n`;
}

function renderRouteBucket(out: string[], heading: string, routes: AffectedRoute[]): void {
  out.push("");
  out.push(`  ${heading}  — ${routes.length}`);
  if (routes.length === 0) { out.push("    none"); return; }
  for (const r of routes) {
    out.push(
      `    d${String(r.depth).padEnd(2)} ${r.service.padEnd(16)} ` +
      `${r.method.padEnd(7)} ${r.url.padEnd(24)} via ${r.viaSymbol}`,
    );
  }
}

function renderShared(
  out: string[], label: string, nodes: SharedNode[], phrase: string,
): void {
  if (nodes.length === 0) {
    out.push(`  ${label.padEnd(13)}: none`);
    return;
  }
  out.push(`  ${label.padEnd(13)}: ${nodes.length} shared node(s)`);
  for (const n of nodes) {
    const services = [...new Set(n.alsoUsedBy.map((u) => u.service).filter(Boolean))];
    // `[file]` is not decoration. It says the edge was attributed to the file
    // rather than to this symbol, so the coupling is real but the attribution
    // is coarser than the seed you asked about.
    const via = n.attributedTo === "file" ? " [file-scope]" : "";
    out.push(
      `    ${n.key}${via}` +
      (n.alsoUsedBy.length === 0
        ? "   (only this symbol)"
        : `   ${n.alsoUsedBy.length} other symbol(s) ${phrase}` +
          (services.length > 0 ? ` across ${services.join(", ")}` : "")),
    );
  }
}
