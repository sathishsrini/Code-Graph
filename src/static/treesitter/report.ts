// ============================================================================
// tree-sitter pass — run + render  —  task P1-T6
// ============================================================================
// The `scan` command's body. Lives here rather than in cli.ts because this is
// the surface the four R19 extractors are tuned against: they are all
// `inferred`, and the only way to keep them honest is to read what they found
// next to the source that produced it.
// ============================================================================

import { readFileSync } from "node:fs";
import type { RepoConfig } from "../../config/repos.ts";
import { enumerateFiles } from "./files.ts";
import { extract, type FileFindings } from "./extract.ts";
import { parseFile } from "./parser.ts";

export interface ScanResult {
  repo: string;
  files: FileFindings[];
  /** Files matched by the config whose extension has no grammar. */
  unsupported: number;
  totals: {
    throws: number;
    configs: number;
    datastores: number;
    https: number;
    urls: number;
    envBindings: number;
    functions: number;
    parseErrors: number;
  };
}

export async function scanRepo(repo: RepoConfig): Promise<ScanResult> {
  const files: FileFindings[] = [];
  let unsupported = 0;

  for (const f of enumerateFiles(repo)) {
    const parsed = await parseFile(f.relativePath, readFileSync(f.absolutePath, "utf8"));
    if (!parsed) { unsupported += 1; continue; }
    files.push(extract(parsed));
  }

  const sum = (pick: (f: FileFindings) => unknown[]) =>
    files.reduce((n, f) => n + pick(f).length, 0);

  return {
    repo: repo.name,
    files,
    unsupported,
    totals: {
      throws: sum((f) => f.throws),
      configs: sum((f) => f.configs),
      datastores: sum((f) => f.datastores),
      https: sum((f) => f.https),
      urls: sum((f) => f.urls),
      envBindings: sum((f) => f.envBindings),
      functions: sum((f) => f.functions),
      parseErrors: files.reduce((n, f) => n + f.parseErrors, 0),
    },
  };
}

export function renderScan(result: ScanResult): string {
  const t = result.totals;
  const lines: string[] = [
    `repo       : ${result.repo}`,
    `files      : ${result.files.length} parsed${result.unsupported ? `, ${result.unsupported} unsupported` : ""}`,
    `parseErrors: ${t.parseErrors}`,
    "",
    "FINDINGS  (evidence: treesitter · confidence: inferred, all of them)",
    "",
    `  THROWS          : ${t.throws}`,
    `  READS_CONFIG    : ${t.configs}`,
    `  READS / WRITES  : ${t.datastores}`,
    `  http call sites : ${t.https}`,
    `  url expressions : ${t.urls}`,
    `  env bindings    : ${t.envBindings}`,
    `  functions       : ${t.functions}`,
    "",
  ];

  for (const f of result.files) {
    if (f.datastores.length + f.https.length + f.throws.length + f.configs.length === 0) continue;
    lines.push(f.path);
    for (const d of f.datastores) {
      lines.push(
        `  L${String(d.line).padStart(4)}  ${d.operation === "write" ? "WRITES" : "READS "}  ` +
        `${d.engine}://?/${d.table}   ${d.verb}`,
      );
    }
    for (const h of f.https) {
      const dest = h.urls.length > 0
        ? h.urls.map(describeUrl).join(", ")
        : h.configVar
          ? `via ${h.configVar} — url built elsewhere`
          : "no url in this call";
      lines.push(
        `  L${String(h.line).padStart(4)}  HTTP    ` +
        `${h.client}${h.method ? `.${h.method}` : ""}   ${dest}`,
      );
    }
    for (const th of f.throws) {
      lines.push(`  L${String(th.line).padStart(4)}  THROWS  ${th.errorName ?? "(rethrow)"}`);
    }
    for (const c of f.configs) {
      lines.push(`  L${String(c.line).padStart(4)}  CONFIG  ${c.varName}`);
    }
    lines.push("");
  }

  // The base-URL half of P1-T7's input. Printed because a missing binding is
  // the difference between a resolvable destination and an unresolved row.
  const bindings = result.files.flatMap((f) => f.envBindings.filter((b) => b.urlShaped || /BASE_URL|_URL|_HOST/.test(b.envVar ?? "")));
  if (bindings.length > 0) {
    lines.push("BASE-URL CANDIDATES  (which of these count is declared in repos.json)");
    for (const b of bindings) {
      lines.push(`  ${b.name.padEnd(24)} env:${b.envVar}   default=${JSON.stringify(b.defaultUrl)}`);
    }
    lines.push("");
  }

  if (t.throws === 0) {
    // Saying this matters. An empty THROWS section reads as "nothing can fail
    // here"; on code that returns error envelopes the truth is that nothing
    // is thrown, which is a different claim (doc §Q.2, plan §2.12).
    lines.push(
      "note: no THROWS found. On code that returns error envelopes instead of",
      "      throwing, that is the expected result and not an empty failure",
      "      surface. The return-an-error-value form is P1-T17's territory.",
    );
  }

  return lines.join("\n") + "\n";
}

function describeUrl(u: { baseVar: string | null; literalPath: string; dynamic: boolean }): string {
  const base = u.baseVar ? `\${${u.baseVar}}` : "";
  return `${base}${u.literalPath}${u.dynamic ? "<dynamic>" : ""}`;
}
