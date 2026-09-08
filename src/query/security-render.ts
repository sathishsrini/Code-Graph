// Terminal rendering for security_path (P1-T14, R40 / R50).
//
// R50 asks for boot-verified and statically-inferred checks to be visually
// distinguishable at a glance. In a terminal that is a glyph, not a colour:
//
//   ●  boot    the framework reported this hook. It runs.
//   ○  inline  a parser found it in the handler body. It probably runs.
//
// One symbol per channel, in the same cell, so a matrix row can be read across
// without a legend lookup — and so a route protected only by inference can
// never be mistaken for one the framework confirmed.

import type { RouteSecurity, SecurityReport } from "./security.ts";

const BOOT = "●";
const INLINE = "○";
const ABSENT = "·";

export function renderSecurity(r: SecurityReport, anomalyKind = "tenant"): string {
  const out: string[] = [];
  const kinds = r.kinds;

  out.push("SECURITY COVERAGE");
  out.push(`  ${BOOT} boot-verified (certain)   ${INLINE} statically inferred   ${ABSENT} absent`);
  out.push("");

  const width = Math.max(...r.routes.map((x) => `${x.method} ${x.url}`.length), 24);
  out.push(
    `  ${"ROUTE".padEnd(width)}  ${kinds.map((k) => k.slice(0, 9).padEnd(9)).join("")} SERVICE`,
  );
  for (const route of r.routes) {
    const cells = kinds.map((k) => {
      const channels = route.coverage[k];
      if (!channels || channels.length === 0) return ABSENT.padEnd(9);
      const glyph = channels.includes("boot") ? BOOT : INLINE;
      return `${glyph}${channels.includes("boot") && channels.includes("inline") ? INLINE : ""}`
        .padEnd(9);
    });
    out.push(`  ${`${route.method} ${route.url}`.padEnd(width)}  ${cells.join("")} ${route.service}`);
  }

  out.push("");
  out.push(`ROUTES WITH NO CHECK OF ANY KIND — ${r.unprotected.length}`);
  for (const route of r.unprotected) {
    out.push(`  ${route.service}  ${route.method} ${route.url}`);
  }
  if (r.unprotected.length > 0) {
    // Said plainly, because "unprotected" is not the same claim as "public".
    out.push("");
    out.push("  Read as 'no check this engine can see'. A public health route and a");
    out.push("  route whose guard nothing detected look identical here.");
  }

  out.push("");
  out.push(`ANOMALY — writes with no '${anomalyKind}' check — ${r.anomalies.length}`);
  if (r.anomalies.length === 0) {
    out.push("  none");
  }
  for (const a of r.anomalies) {
    out.push(
      `  ${a.route.service}  ${a.route.method} ${a.route.url}` +
      `${a.has.length > 0 ? `   has: ${a.has.join(", ")}` : "   has: nothing"}`,
    );
    for (const w of a.route.writes) {
      out.push(`      writes ${w.datastore}${w.via === "file" ? "  [file-scope]" : ""}`);
    }
  }
  if (r.anomalies.length > 0) {
    out.push("");
    out.push("  This is R40's flagship query, and it answers 'writes without a tenant");
    out.push("  check', NOT 'insecure'. Whether a check is CORRECT is out of scope");
    out.push("  (doc §Q.3) — this engine can only say which checks run, and in what order.");
  }

  // R61's mandatory unknown line, in its security form.
  out.push("");
  out.push("BLIND SPOTS");
  if (r.blindSpots.length === 0) {
    out.push("  every non-framework chain entry resolved to a symbol.");
  } else {
    out.push(
      `  ${r.blindSpots.length} chain entr(ies) could not be resolved to a symbol.`,
    );
    out.push("  A route below may run a check this query cannot see:");
    for (const b of r.blindSpots.slice(0, 20)) {
      out.push(`    ${b.routeKey}   ${b.phase}  ${b.key ?? "(no position)"}`);
    }
    if (r.blindSpots.length > 20) out.push(`    … ${r.blindSpots.length - 20} more`);
  }

  return `${out.join("\n")}\n`;
}

/** The ordered security chain for one route, with provenance per entry. */
export function renderRouteSecurity(route: RouteSecurity): string {
  const out: string[] = [];
  out.push(`${route.method} ${route.url}    service: ${route.service}`);
  out.push("");
  out.push("SECURITY CHAIN");
  if (route.checks.length === 0) out.push("  no check of any kind detected");
  for (const c of route.checks) {
    const glyph = c.channel === "boot" ? BOOT : INLINE;
    out.push(
      `  ${glyph} ${String(c.position).padStart(2)}. ${c.checkKind.padEnd(10)} ` +
      `${(c.name ?? "(shape match)").padEnd(20)} ${c.confidence.padEnd(9)} ` +
      `${c.file ?? ""}${c.line ? `:${c.line}` : ""}`,
    );
    if (c.detail) out.push(`       ${c.detail}`);
  }

  out.push("");
  out.push(`DATASTORE WRITES REACHABLE — ${route.writes.length}`);
  for (const w of route.writes) {
    out.push(`  ${w.datastore}${w.via === "file" ? "  [file-scope]" : ""}`);
  }
  return `${out.join("\n")}\n`;
}
