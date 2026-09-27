// ============================================================================
// Build  —  slice CTX-S6  (plans/claude-context-plan.md §6, §2.5)
// ============================================================================
// `index` READS the `scip index` and `boot dump` artifacts; it never makes
// them. Run alone it yields a graph with 0 symbols, 0 calls and 0 routes, and
// making the artifacts was a separate manual step per repo, plus `search
// build`. `build` runs all of it, per repo, in the order the pipeline needs:
//
//   scip index  ->  boot dump  ->  index        (every repo, or `--repo`)
//   then, over the whole store: link  ->  search  ->  integrity
//
// Nothing is re-implemented. Each channel is the module its own command runs:
// `runScipIndex` (scip index), `runBootAdapter` (boot dump), `indexRepo` and
// `linkCrossServiceRepos` (index), `buildSearchIndex` (search build).
//
// The one rule: **a failed channel never stops the others, and is named.**
// A service whose boot fails still gets its static graph; a missing indexer is
// a failure line, not a crash. Every channel ends ok, failed (with the first
// line of its error) or skipped (with the reason), and the caller exits
// non-zero if anything failed. "Built, except these" is a truthful report;
// "built" over a silently partial graph is the failure this project exists to
// stop shipping.
//
// And reading a repo never writes into it: the generated tsconfig is removed
// (runner.ts) and the Python boot writes no bytecode (boot/run.ts).
// tests/build.test.ts snapshots each target repo, bytes included, to hold that.
// ============================================================================

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config/repos.ts";
import type { FactStore } from "../store/db.ts";
import { runScipIndex } from "../static/scip/runner.ts";
import { bootUnsupported, runBootAdapter } from "../boot/run.ts";
import { indexRepo, linkCrossServiceRepos, type IndexReport } from "./pipeline.ts";
import { buildSearchIndex } from "./search.ts";

export type ChannelName = "scip" | "boot" | "index" | "link" | "search" | "integrity";

export interface ChannelOutcome {
  channel: ChannelName;
  status: "ok" | "failed" | "skipped";
  /** ok: what it produced · failed: first line of the error · skipped: why. */
  detail: string;
}

export interface BuildReport {
  repos: Array<{ repo: string; channels: ChannelOutcome[] }>;
  /** Steps over the whole store, run once after every repo. */
  graph: ChannelOutcome[];
  /** `<repo> <channel>: <detail>` for every failed channel, in run order. */
  failures: string[];
}

/** What an artifact-producing channel returns. */
export interface ArtifactRun {
  ok: boolean;
  /** Full error output when not ok. Only its first line is reported. */
  error: string;
  /** What was produced, when ok. */
  detail: string;
}

/** The two channels that spawn external tools. Injectable for tests. */
export interface ChannelRunners {
  scip(repo: RepoConfig, outPath: string): ArtifactRun;
  boot(repo: RepoConfig, outPath: string): ArtifactRun;
}

export const DEFAULT_RUNNERS: ChannelRunners = {
  scip(repo, outPath) {
    const r = runScipIndex(repo, outPath);
    if (r.ok) return { ok: true, error: "", detail: `${r.durationMs} ms` };
    // An indexer can exit 0 and still write an index describing nothing
    // (`scip-python` on Windows, measurements M8). The exit code is not the
    // verdict; `ok` is.
    const indexer = repo.lang === "py" ? "scip-python" : "scip-typescript";
    const error = r.status === 0
      ? `${indexer} exited 0 but wrote ${existsSync(r.outputPath) ? "an EMPTY index" : "no index"}`
      : firstLine(r.stderr) || firstLine(r.stdout) ||
        `exit status ${r.status ?? "none (killed or timed out)"}`;
    return { ok: false, error, detail: "" };
  },
  boot(repo, outPath) {
    const r = runBootAdapter(repo, outPath);
    if (!r.ok || !r.dump) return { ok: false, error: r.error, detail: "" };
    return {
      ok: true, error: "",
      detail: `${r.dump.stats.routes} routes, ${r.dump.stats.chainEntries} chain entries`,
    };
  },
};

export interface BuildOptions {
  store: FactStore;
  /** The repos to build: every configured repo, or the one `--repo` named. */
  repos: RepoConfig[];
  /** Every configured repo. The linker's input is global. Default: `repos`. */
  allRepos?: RepoConfig[];
  /** `.codeintel` root. Artifacts are written here and `index` reads them here. */
  artifactDir: string;
  runners?: Partial<ChannelRunners>;
}

export async function buildGraph(options: BuildOptions): Promise<BuildReport> {
  const { store, artifactDir } = options;
  const runners: ChannelRunners = { ...DEFAULT_RUNNERS, ...options.runners };
  const report: BuildReport = { repos: [], graph: [], failures: [] };

  for (const repo of options.repos) {
    const channels: ChannelOutcome[] = [];
    report.repos.push({ repo: repo.name, channels });

    if (!existsSync(repo.rootPath)) {
      // Not indexed. An absent root enumerates to zero files, which `index`
      // would read as "every file deleted" and purge the repo from the graph.
      channels.push(
        { channel: "scip", status: "failed", detail: `root not on disk: ${repo.rootPath}` },
        { channel: "boot", status: "skipped", detail: "root not on disk" },
        { channel: "index", status: "skipped", detail: "root not on disk; its graph rows are left as they were" },
      );
      continue;
    }

    const scipPath = join(artifactDir, "scip", `${repo.name}.scip`);
    channels.push(artifact("scip", scipPath, () => runners.scip(repo, scipPath)));

    const bootPath = join(artifactDir, "boot", `${repo.name}.json`);
    const unsupported = bootUnsupported(repo);
    channels.push(unsupported
      ? { channel: "boot", status: "skipped", detail: unsupported }
      : artifact("boot", bootPath, () => runners.boot(repo, bootPath)));

    // `force`: the artifacts were just rebuilt even where no source file
    // changed, and an incremental `index` would skip the repo and never read
    // them.
    channels.push(await attempt("index", async () =>
      describeIndex(await indexRepo({ store, repo, artifactDir, force: true }))));
  }

  report.graph.push(await attempt("link", async () => {
    const c = await linkCrossServiceRepos({
      store, repos: options.allRepos ?? options.repos, artifactDir,
    });
    return `${c.requests} REQUESTS, ${c.unresolved} unresolved across ${c.files} files`;
  }));
  report.graph.push(await attempt("search", () => {
    const s = buildSearchIndex(store);
    return Promise.resolve(`${s.rows} rows, ${s.vectors} vectors`);
  }));
  const integrity = store.verifyIntegrity();
  report.graph.push({
    channel: "integrity",
    status: integrity.ok ? "ok" : "failed",
    detail: `${integrity.foreignKeyViolations} foreign-key violations, ` +
      `integrity_check ${integrity.integrityCheck}`,
  });

  for (const r of report.repos) {
    for (const c of r.channels) {
      if (c.status === "failed") report.failures.push(`${r.repo} ${c.channel}: ${c.detail}`);
    }
  }
  for (const c of report.graph) {
    if (c.status === "failed") report.failures.push(`graph ${c.channel}: ${c.detail}`);
  }
  return report;
}

/**
 * Run an artifact channel, never letting it throw.
 *
 * When it fails but an OLDER artifact is still on disk, `index` reads that one
 * — so the report says so, with its date, rather than letting a stale route
 * list pass as this build's.
 */
function artifact(channel: ChannelName, path: string, run: () => ArtifactRun): ChannelOutcome {
  const before = mtimeOf(path);
  let r: ArtifactRun;
  try {
    r = run();
  } catch (e) {
    r = { ok: false, error: (e as Error).message, detail: "" };
  }
  if (r.ok) return { channel, status: "ok", detail: r.detail };

  let detail = firstLine(r.error) || "failed with no error output";
  if (before !== null && mtimeOf(path) === before) {
    detail += ` (index read the previous artifact, from ${new Date(before).toISOString()})`;
  }
  return { channel, status: "failed", detail };
}

async function attempt(channel: ChannelName, run: () => Promise<string>): Promise<ChannelOutcome> {
  try {
    return { channel, status: "ok", detail: await run() };
  } catch (e) {
    return { channel, status: "failed", detail: firstLine((e as Error).message) || "threw" };
  }
}

function describeIndex(r: IndexReport): string {
  const files = r.change.changed.length + r.change.unchanged.length;
  const routes = r.boot ? `, ${r.boot.routes} routes` : "";
  // "scip index (<path>)" -> "scip index": the path is the artifact dir's.
  const missing = r.missingArtifacts.length > 0
    ? `; missing: ${r.missingArtifacts.map((m) => m.replace(/ \(.*\)$/, "")).join(", ")}`
    : "";
  return `${files} files, ${r.symbols} symbols, ${r.calls} calls${routes}${missing}`;
}

function mtimeOf(path: string): number | null {
  return existsSync(path) ? statSync(path).mtimeMs : null;
}

/** First non-blank line, trimmed. A stack trace is not a summary. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
}

/** Per-repo channel table, then the failures, named. */
export function renderBuildReport(report: BuildReport): string {
  const lines: string[] = [];
  const row = (c: ChannelOutcome) =>
    `  ${c.channel.padEnd(10)} ${c.status.padEnd(8)} ${c.detail}`;

  for (const r of report.repos) {
    lines.push(r.repo, ...r.channels.map(row), "");
  }
  lines.push("graph", ...report.graph.map(row), "");

  const total = report.repos.reduce((n, r) => n + r.channels.length, 0) + report.graph.length;
  if (report.failures.length === 0) {
    lines.push(`built: all ${total} channels ok or skipped`);
  } else {
    lines.push(`FAILED ${report.failures.length} of ${total} channels:`);
    for (const f of report.failures) lines.push(`  ${f}`);
  }
  return `${lines.join("\n")}\n`;
}
