// ============================================================================
// PR diff -> impact comment  —  task P2-T11  (requirement R51)
// ============================================================================
// Reads a unified diff, maps each changed line to the symbol that contains it,
// runs the impact closure, and formats a PR comment.
//
// **Line-to-symbol is the whole trick, and it has a direction.** A diff gives
// line numbers in the NEW file; `symbols.start_line`/`end_line` come from the
// index built against that same commit, so they agree — as long as the index
// is rebuilt in the same job. An index from an older commit would map lines to
// the wrong functions and the comment would be confidently about the wrong
// code. The workflow rebuilds; this module states the assumption and checks
// what it can.
//
// **The comment is segmented, never summed.** R37's three buckets survive into
// the output because "12 routes affected" is not a reviewable statement while
// "3 certain, 9 through an inferred hop" is.
// ============================================================================

import type { FactStore } from "../store/db.ts";
import { impact, type ImpactReport } from "../query/impact.ts";
import { displayNameOf } from "../static/scip/symbol.ts";

export interface ChangedRange {
  file: string;
  /** 1-based, in the NEW file. */
  startLine: number;
  endLine: number;
}

/**
 * Parse the hunks of a unified diff.
 *
 * Only added/modified ranges are returned. A pure deletion has no new lines to
 * map, and the symbol it was in may no longer exist — reporting impact for a
 * function the PR removed would be answering about the wrong revision.
 */
export function parseDiff(diff: string): ChangedRange[] {
  const out: ChangedRange[] = [];
  let file: string | null = null;

  for (const line of diff.split(/\r?\n/)) {
    const newFile = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (newFile) {
      file = newFile[1] === "/dev/null" ? null : (newFile[1] ?? null);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) out.push({ file, startLine: start, endLine: start + count - 1 });
    }
  }
  return out;
}

export interface ChangedSymbol {
  key: string;
  display: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface SymbolMapping {
  symbols: ChangedSymbol[];
  /** Ranges that mapped to no symbol. A gap, reported in the comment. */
  unmapped: ChangedRange[];
  /** Files the diff touched that the index has never seen. */
  unindexedFiles: string[];
}

/**
 * Map changed ranges to the symbols containing them.
 *
 * A range that overlaps no symbol is kept as `unmapped` rather than dropped:
 * a change to module-scope code, a config file or a new file the index has not
 * seen is a real change whose impact this tool cannot compute, and a comment
 * that omitted it would imply the PR touches nothing else.
 */
export function symbolsForRanges(
  store: FactStore, ranges: ChangedRange[],
): SymbolMapping {
  const symbols = new Map<string, ChangedSymbol>();
  const unmapped: ChangedRange[] = [];
  const unindexedFiles = new Set<string>();

  const known = store.raw().prepare(
    "SELECT 1 FROM files WHERE path = ? OR path LIKE '%/' || ? LIMIT 1",
  );
  const containing = store.raw().prepare(
    `SELECT n.key, s.display_name, f.path, s.start_line, s.end_line, s.symbol_kind
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       JOIN files f ON f.id = s.file_id
      WHERE (f.path = ? OR f.path LIKE '%/' || ?)
        AND s.start_line IS NOT NULL AND s.end_line IS NOT NULL
        AND s.start_line <= ? AND s.end_line >= ?
        -- Parameters and object-literal keys are symbols with a range but are
        -- never CONTAINERS. Without excluding them, a hunk on a function's
        -- signature line maps to its first parameter — smallest span wins —
        -- and the comment reports the impact of changing \`req\`.
        AND s.symbol_kind NOT IN ('parameter', 'meta', 'typeParameter')
      -- A function first, then the tightest span. A module-scope const has no
      -- enclosing function and is still a real change, so it is reached by the
      -- second clause rather than excluded by the first.
      ORDER BY (s.symbol_kind <> 'method'), (s.end_line - s.start_line)`,
  );

  for (const range of ranges) {
    if (!known.get(range.file, range.file)) {
      unindexedFiles.add(range.file);
      continue;
    }
    // The innermost symbol overlapping the hunk. `ORDER BY span` puts it first;
    // taking the outermost would attribute every hunk to the module.
    const rows = containing.all(
      range.file, range.file, range.endLine, range.startLine,
    ) as Array<Record<string, string | number>>;

    const inner = rows.filter((r) => !String(r["key"]).endsWith("/"));
    if (inner.length === 0) { unmapped.push(range); continue; }

    const row = inner[0]!;
    symbols.set(String(row["key"]), {
      key: String(row["key"]),
      display: String(row["display_name"] ?? displayNameOf(String(row["key"]))),
      file: String(row["path"]),
      startLine: Number(row["start_line"]),
      endLine: Number(row["end_line"]),
    });
  }

  return {
    symbols: [...symbols.values()].sort((a, b) =>
      a.file.localeCompare(b.file) || a.startLine - b.startLine),
    unmapped,
    unindexedFiles: [...unindexedFiles].sort(),
  };
}

// ---------------------------------------------------------------------------

export interface PrImpact {
  mapping: SymbolMapping;
  reports: ImpactReport[];
  /** Route keys reached, deduplicated across every changed symbol. */
  routes: { certain: Set<string>; inferred: Set<string>; unknown: Set<string> };
  utilities: string[];
}

export function analysePr(
  store: FactStore, diff: string, options: { routeLimit?: number } = {},
): PrImpact {
  const mapping = symbolsForRanges(store, parseDiff(diff));
  const reports: ImpactReport[] = [];
  const routes = {
    certain: new Set<string>(), inferred: new Set<string>(), unknown: new Set<string>(),
  };
  const utilities: string[] = [];

  for (const symbol of mapping.symbols) {
    let report: ImpactReport;
    try {
      report = impact(store, symbol.key, { routeLimit: options.routeLimit ?? 1000 });
    } catch {
      continue;   // a symbol the store cannot seed on adds nothing to the comment
    }
    reports.push(report);
    if (report.isUtility) utilities.push(report.seed.display);
    for (const bucket of ["certain", "inferred", "unknown"] as const) {
      for (const r of report.routes[bucket]) {
        routes[bucket].add(`${r.service} ${r.method} ${r.url}`);
      }
    }
  }

  // A route reached certainly through one symbol is a certain dependency,
  // whatever a weaker path through another symbol says.
  for (const key of routes.certain) { routes.inferred.delete(key); routes.unknown.delete(key); }
  for (const key of routes.inferred) routes.unknown.delete(key);

  return { mapping, reports, routes, utilities };
}

/** Marker so the workflow can update its own comment rather than adding one. */
export const COMMENT_MARKER = "<!-- code-intel:impact -->";

export function renderPrComment(result: PrImpact): string {
  const out: string[] = [COMMENT_MARKER, "## Impact of this change", ""];
  const total = result.routes.certain.size + result.routes.inferred.size +
    result.routes.unknown.size;

  if (result.mapping.symbols.length === 0) {
    out.push("No indexed symbol contains the changed lines.");
    renderGaps(out, result);
    return out.join("\n");
  }

  out.push(
    `**${result.mapping.symbols.length} changed symbol(s)** reach ` +
    `**${total} route(s)**.`,
  );

  if (result.utilities.length > 0) {
    // R39. Listing 200 endpoints for a utility is how this comment becomes
    // something people mute.
    out.push("");
    out.push(
      `> **Utility touched:** \`${result.utilities.join("`, `")}\`. High fan-in — ` +
      `treat the route list as "most of the service", not as a review list.`,
    );
  }

  out.push("");
  out.push("<details><summary>Changed symbols</summary>", "");
  for (const s of result.mapping.symbols) {
    out.push(`- \`${s.display}\` — ${s.file}:${s.startLine}-${s.endLine}`);
  }
  out.push("", "</details>", "");

  // The three buckets stay separate. "12 routes" is not reviewable; "3 certain,
  // 9 through an inferred hop" is.
  bucket(out, "Certain", "every edge on the path is compiler-resolved", result.routes.certain);
  bucket(out, "Inferred", "at least one hop is a guess — may not break", result.routes.inferred);
  bucket(out, "Unknown", "the path crosses something unresolved", result.routes.unknown);

  renderGaps(out, result);
  return out.join("\n");
}

function bucket(out: string[], title: string, why: string, routes: Set<string>): void {
  out.push(`### ${title} — ${routes.size}`);
  out.push(`_${why}_`);
  if (routes.size === 0) { out.push("", "None.", ""); return; }
  out.push("");
  const list = [...routes].sort();
  for (const r of list.slice(0, 20)) out.push(`- \`${r}\``);
  if (list.length > 20) out.push(`- _…and ${list.length - 20} more_`);
  out.push("");
}

/**
 * R61 in a PR comment.
 *
 * A reviewer reads this as "these are the consequences". Anything the tool
 * could not analyse has to appear, or the comment implies a completeness it
 * does not have.
 */
function renderGaps(out: string[], result: PrImpact): void {
  const gaps: string[] = [];
  if (result.mapping.unindexedFiles.length > 0) {
    gaps.push(
      `${result.mapping.unindexedFiles.length} changed file(s) are not indexed: ` +
      result.mapping.unindexedFiles.map((f) => `\`${f}\``).join(", "),
    );
  }
  if (result.mapping.unmapped.length > 0) {
    gaps.push(
      `${result.mapping.unmapped.length} changed hunk(s) sit outside any function ` +
      "(module scope, config, or a new file) — their impact is not computed",
    );
  }
  const unresolved = result.reports.flatMap((r) => r.unknownEdges);
  if (unresolved.length > 0) {
    gaps.push(
      `${unresolved.length} unresolved call site(s) inside the affected set — ` +
      "anything they reach is outside this analysis",
    );
  }

  out.push("### Not analysed");
  if (gaps.length === 0) {
    out.push("", "Nothing — every changed hunk mapped to an indexed symbol.", "");
  } else {
    out.push("");
    for (const g of gaps) out.push(`- ${g}`);
    out.push("");
  }
  out.push(
    "_Confidence values: `certain` the compiler resolved it, `inferred` a parser " +
    "guessed it. A path is only as trustworthy as its weakest edge._",
  );
}
