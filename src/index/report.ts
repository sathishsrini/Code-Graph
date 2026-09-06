// Rendering for the `index` command (P1-T11).
//
// The numbers a reader needs are not "how many rows were written" but "what
// did each channel see, and what did it not see". A missing artifact and an
// empty result look identical in a row count and are entirely different facts,
// so both are reported by name.

import type { IndexReport } from "./pipeline.ts";

export function renderIndexReport(reports: IndexReport[]): string {
  const lines: string[] = [];

  for (const r of reports) {
    lines.push(`${r.repo}`);
    if (r.skipped) {
      lines.push(`  skipped — ${r.reason}`);
      lines.push("");
      continue;
    }

    lines.push(
      `  files      : ${r.change.changed.length} changed, ` +
      `${r.change.unchanged.length} unchanged, ${r.change.deleted.length} deleted`,
    );
    if (r.purged.files > 0) {
      lines.push(
        `  purged     : ${r.purged.edges} edges, ${r.purged.unresolved} unresolved, ` +
        `${r.purged.chain} chain rows, from ${r.purged.files} file(s)  (by provenance — no node deleted)`,
      );
    }
    lines.push(
      `  scip       : ${r.symbols} symbols, ${r.calls} calls, ` +
      `${r.unresolvedCalls} unresolved`,
    );
    lines.push(
      `  treesitter : ${r.treesitter.throws} throws, ` +
      `${r.treesitter.writes} writes, ${r.treesitter.reads} reads, ` +
      `${r.treesitter.configs} config reads` +
      (r.treesitter.fileScoped > 0
        ? `   (${r.treesitter.fileScoped} attributed to the file — no enclosing symbol)`
        : ""),
    );
    if (r.boot) {
      const gap = r.boot.unjoined > 0 ? `   <-- ${r.boot.unjoined} unjoined` : "";
      lines.push(
        `  boot       : ${r.boot.routes} routes, ${r.boot.chainEntries} chain entries, ` +
        `${r.boot.handles} HANDLES${gap}`,
      );
      if (r.boot.framework > 0) {
        lines.push(
          `               ${r.boot.framework} entries are framework code — ` +
          `no SCIP join expected`,
        );
      }
    }
    for (const missing of r.missingArtifacts) {
      // Not a warning to be scrolled past. "No boot artifact" and "this
      // service has no routes" are different facts and only one is about code.
      lines.push(`  MISSING    : ${missing}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
