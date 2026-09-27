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
        `${r.purged.chain} chain rows` +
        (r.purged.columns > 0 ? `, ${r.purged.columns} columns` : "") +
        `, from ${r.purged.files} file(s)  (by provenance — no node deleted)`,
      );
    }
    lines.push(
      `  scip       : ${r.symbols} symbols, ${r.calls} calls, ` +
      `${r.unresolvedCalls} unresolved`,
    );
    // CTX-S10a: with boot's handler ranges, the file-scope count is what is
    // left after crediting routes, so it is the number the queries show.
    const h = r.handlerScope;
    const fileScoped = h ? h.findings.fileScope : r.treesitter.fileScoped;
    lines.push(
      `  treesitter : ${r.treesitter.throws} throws, ` +
      `${r.treesitter.writes} writes, ${r.treesitter.reads} reads, ` +
      `${r.treesitter.configs} config reads` +
      (fileScoped > 0
        ? `   (${fileScoped} attributed to the file — no enclosing symbol` +
          `${h ? " or route handler" : ""})`
        : ""),
    );
    if (r.ddl.files > 0) {
      // CTX-S9. Gaps are counted here and listed by `tables`, never dropped.
      lines.push(
        `  ddl        : ${r.ddl.tables} tables, ${r.ddl.columns} columns ` +
        `(+${r.ddl.added} added by ALTER TABLE), ${r.ddl.gaps} gap${r.ddl.gaps === 1 ? "" : "s"}, ` +
        `${r.ddl.skipped} statement(s) skipped as not table/column DDL, ` +
        `from ${r.ddl.files} .sql file(s)`,
      );
    }
    if (r.cfg.functions > 0 || r.cfg.unkeyed > 0) {
      lines.push(
        `  cfg        : ${r.cfg.functions} functions, ${r.cfg.blocks} blocks, ` +
        `${r.cfg.errorExits} error exits, ${r.cfg.attributed} edges attributed` +
        (r.cfg.unkeyed > 0
          ? `   (${r.cfg.unkeyed} function(s) had no symbol to key on)`
          : ""),
      );
    }
    if (r.boot) {
      const gap = r.boot.unjoined > 0 ? `   <-- ${r.boot.unjoined} unjoined` : "";
      lines.push(
        `  boot       : ${r.boot.routes} routes, ${r.boot.chainEntries} chain entries, ` +
        `${r.boot.handles} HANDLES` +
        (r.boot.inline > 0 ? `, ${r.boot.inline} inline auth checks (inferred)` : "") +
        gap,
      );
      if (r.boot.framework > 0) {
        lines.push(
          `               ${r.boot.framework} entries are framework code — ` +
          `no SCIP join expected`,
        );
      }
    }
    if (h) {
      // Both halves, never only the credit: what is left at file scope is the
      // gap, and a gap that is not shown reads as zero (R11).
      lines.push(
        `  handlers   : ${h.calls.credited} calls, ${h.findings.credited} findings ` +
        `credited to anonymous route handlers by range; ` +
        `${h.calls.moduleScope} calls, ${h.findings.fileScope} findings left at file scope`,
      );
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
