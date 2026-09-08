// M.4's presentation (P2-T10, R41 / R61).
//
// Three headed sections in a fixed order, never merged, plus a mandatory
// UNKNOWN. The headings carry the epistemology, because a reader who skims
// will take whatever is at the top as the answer:
//
//   OBSERVED               what a trace says happened. About the past.
//   STATIC FAILURE SURFACE what the code can do. About the possible.
//   CORRELATED CHANGES     a ranking signal. Never a cause.
//   UNKNOWN                why this report may be incomplete.

import type { ErrorReport, RootCause, StaticFailure } from "./errors.ts";

export function renderErrorReport(r: ErrorReport): string {
  const out: string[] = [];
  out.push(`FAILURE ANALYSIS  ${r.method} ${r.url}    service: ${r.service}`);

  // -- 1. OBSERVED --------------------------------------------------------
  out.push("");
  out.push("OBSERVED  (evidence: otel · what actually failed)");
  if (!r.observedAvailable) {
    // Not "no failures". The distinction is the entire point of the section.
    out.push("  no spans in the store — nothing was recorded, which is not the");
    out.push("  same as nothing having failed. Run: node src/cli.ts otlp serve");
  } else if (r.observed.length === 0) {
    out.push("  no errored trace recorded for this route.");
  }
  for (const trace of r.observed) {
    out.push("");
    out.push(`  trace ${trace.traceId}`);
    renderRootCause(out, trace);
  }

  // -- 2. STATIC FAILURE SURFACE -----------------------------------------
  out.push("");
  out.push("STATIC FAILURE SURFACE  (evidence: treesitter · what CAN fail)");
  out.push("  Independent of the section above. A failure listed here may never");
  out.push("  have happened; one that happened may not be listed.");
  if (r.staticSurface.length === 0) {
    out.push("  nothing detected — see UNKNOWN below before reading that as 'nothing'.");
  }
  for (const f of byFile(r.staticSurface)) {
    out.push(`  ${f.file ?? "?"}:${f.line ?? "?"}  ${f.display}`);
    out.push(
      `      ${f.form.padEnd(13)} ${f.errorName ?? "(unnamed)"}` +
      `${f.guardedBy ? `   when: ${f.guardedBy}` : ""}` +
      `   [${f.evidence}]`,
    );
  }

  // -- 3. CORRELATED CHANGES ---------------------------------------------
  out.push("");
  out.push("CORRELATED CHANGES  (a ranking signal — never a cause)");
  if (r.correlation.unavailable) {
    out.push(`  unavailable: ${r.correlation.unavailable}`);
  } else if (r.correlation.changes.length === 0) {
    out.push("  no commits touching these files in the window.");
  }
  for (const c of r.correlation.changes) {
    out.push(`  ${c.lastDate}  ${c.lastCommit}  ${c.file}`);
    out.push(`      ${c.subject}   — ${c.lastAuthor}`);
  }

  // -- 4. UNKNOWN, mandatory (R61) ---------------------------------------
  out.push("");
  out.push("UNKNOWN  (why this report may be incomplete)");
  if (r.unknowns.length === 0) {
    out.push("  every chain entry resolved, every reachable symbol has control flow,");
    out.push("  and no unresolved call sites intersect this path.");
  }
  for (const u of r.unknowns) out.push(`  - ${u}`);

  return `${out.join("\n")}\n`;
}

function renderRootCause(out: string[], trace: RootCause): void {
  if (!trace.origin) {
    out.push("    no errored span in this trace.");
    return;
  }
  // R59: the DEEPEST error span, named as the origin. Every level above it also
  // errored, and reporting the shallowest would just restate the status code.
  out.push(
    `    ORIGIN  depth ${trace.origin.depth}  ${trace.origin.service}  ` +
    `${trace.origin.name}`,
  );
  if (trace.origin.exceptionType) {
    out.push(`            ${trace.origin.exceptionType}: ${trace.origin.exceptionMessage ?? ""}`);
  }
  out.push("    propagated up through:");
  for (const span of trace.propagation.slice(1)) {
    out.push(
      `      d${String(span.depth).padEnd(2)} ${span.service.padEnd(16)} ` +
      `${span.name}${span.httpStatus ? `  -> ${span.httpStatus}` : ""}`,
    );
  }
}

function byFile(surface: StaticFailure[]): StaticFailure[] {
  return [...surface].sort((a, b) =>
    (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
}
