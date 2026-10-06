// Running the SCIP indexer over exactly the declared file set (task P0-T3, R13).
//
// This exists because of a measured near-miss. `40-kri-router/tsconfig.json` is
// literally `{}`, so TypeScript's defaults take over: every `.ts` under the root,
// no `allowJs`. Running the indexer there produces a clean 52-edge graph of
// `src/**` — a non-compiling scaffold that never executes — and ZERO edges from
// `server.js`, the code that actually runs. The graph is confident, complete,
// and describes a system that does not exist.
//
// config/repos.json already declares `include: ["server.js"]` and
// `exclude: ["src/**"]` for that repo. Nothing enforced it. This does, in both
// directions: it generates the tsconfig the indexer runs against, and
// `documentAllowed` re-checks the result so a stray document cannot slip
// through if the indexer widens its own set.

import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, dirname, delimiter, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoConfig } from "../../config/repos.ts";

/** Name of the throwaway tsconfig written into the target repo. */
const GENERATED_TSCONFIG = "tsconfig.codeintel.json";

/**
 * Minimal glob matcher for the subset repos.json uses: `**`, `*` and literals.
 *
 * Deliberately not a glob library. The patterns are ours, they are declared in
 * one file, and a dependency that silently disagrees about `**` semantics would
 * reintroduce exactly the contamination this module exists to prevent.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const rx = pattern
    .split("/")
    .map((seg) => {
      if (seg === "**") return "(?:.*)";
      return seg
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    })
    .join("/")
    // `a/**` should match `a/b` and `a/b/c`, and `**/x` should match `x`.
    .replace(/\/\(\?:\.\*\)$/, "(?:/.*)?")
    .replace(/^\(\?:\.\*\)\//, "(?:.*/)?");
  return new RegExp(`^${rx}$`).test(path);
}

/**
 * Is this repo-relative path in the declared set?
 *
 * `exclude` wins over `include`, and an empty `include` means "everything not
 * excluded" — the same precedence the config loader documents.
 */
export function documentAllowed(repo: RepoConfig, relPath: string): boolean {
  const p = relPath.split("\\").join("/");
  if (repo.exclude.some((g) => matchGlob(g, p))) return false;
  if (repo.include.length === 0) return true;
  return repo.include.some((g) => matchGlob(g, p));
}

/**
 * The tsconfig the indexer is pointed at.
 *
 * `allowJs` is the load-bearing option: without it TypeScript ignores every
 * `.js` file, which is the entire live surface of the two Node services.
 */
export function buildTsconfig(repo: RepoConfig): object {
  return {
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      target: "ES2022",
      module: repo.lang === "js" ? "commonjs" : "esnext",
      moduleResolution: "node",
      resolveJsonModule: true,
      // The scaffolds do not compile. The indexer records what it can resolve
      // and leaves the rest unresolved; it must not stop at the first error.
      skipLibCheck: true,
    },
    include: repo.include.length > 0 ? repo.include.map(tsGlob) : ["**/*"],
    exclude: repo.exclude.length > 0 ? repo.exclude.map(tsGlob) : ["node_modules"],
  };
}

/**
 * Translate a `repos.json` glob into one TypeScript accepts.
 *
 * `tsc` rejects a specification that ends in `**` outright:
 *
 *   error TS5010: File specification cannot end in a recursive directory
 *   wildcard ('**'): 'app/**'.
 *
 * and on a *rejected include list* it indexes nothing at all — which surfaced
 * as `no files got indexed` on `60-kri-next`, the only repo whose includes are
 * directories rather than a single file. Appending `/*` gives the same meaning
 * in TypeScript's own glob dialect. Left alone, this is the OPEN-1 failure
 * again from the other direction: the file set is declared, and the tool
 * silently indexes a different one — here, none.
 */
export function tsGlob(pattern: string): string {
  return pattern.endsWith("/**") ? `${pattern}/*` : pattern === "**" ? "**/*" : pattern;
}

/**
 * Quote one shell argument. Paths here are repo roots and output paths, which
 * routinely contain spaces on Windows — and `###` in this corpus.
 */

function quote(value: string): string {
  if (value === "") return '""';
  if (!/[\s"'`$&|;<>()[\]{}*?#!~]/.test(value)) return value;
  // A backslash escapes in a POSIX shell and is a LITERAL inside double quotes
  // in cmd.exe. Doubling one on Windows therefore does not escape it - it
  // produces a path with doubled separators, which is how this repo's
  // D:\###facilitator\... root reached scip-python doubled and came back as an
  // index with no documents. See `scipPythonCommand` for the measurement.
  const pattern = sep === "\\" ? /["$`]/g : /["\$`]/g;
  return `"${value.replace(pattern, "\$&")}"`;
}

export interface IndexResult {
  ok: boolean;
  outputPath: string;
  tsconfigPath: string;
  /** The generated tsconfig, so the run is reproducible from the log alone. */
  tsconfig: object;
  stdout: string;
  stderr: string;
  status: number | null;
  durationMs: number;
}

/**
 * Run `scip-typescript` over one repo's declared file set.
 *
 * The generated tsconfig is written into the target repo because the indexer
 * resolves `include` relative to the config's own directory, and is removed
 * again in a `finally` — the repo is left as it was found.
 */
export function runScipTypescript(
  repo: RepoConfig,
  outputPath: string,
  options: { maxOldSpaceMb?: number } = {},
): IndexResult {
  const tsconfig = buildTsconfig(repo);
  const tsconfigPath = join(repo.rootPath, GENERATED_TSCONFIG);
  const out = resolve(outputPath);
  mkdirSync(dirname(out), { recursive: true });

  const started = Date.now();
  try {
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n", "utf8");

    const env = { ...process.env };
    if (options.maxOldSpaceMb) {
      // R13's OOM mitigation. scip-typescript holds the whole program in
      // memory; the doc's guidance is to raise the heap before giving up.
      env.NODE_OPTIONS =
        `${env.NODE_OPTIONS ?? ""} --max-old-space-size=${options.maxOldSpaceMb}`.trim();
    }

    // `shell: true` is needed on Windows, where `scip-typescript` is a .cmd
    // shim rather than an executable. Node deprecates passing an argv array
    // alongside it (DEP0190) because the parts are concatenated unescaped, so
    // the command is assembled here with the two variable parts quoted.
    const command =
      `scip-typescript index --no-global-caches ` +
      `--output ${quote(out)} ${quote(GENERATED_TSCONFIG)}`;
    const r = spawnSync(command, {
      cwd: repo.rootPath, encoding: "utf8", env, shell: true, timeout: 600_000,
    });

    return {
      ok: r.status === 0 && existsSync(out),
      outputPath: out,
      tsconfigPath,
      tsconfig,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? (r.error ? r.error.message : ""),
      status: r.status,
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(tsconfigPath, { force: true });
  }
}

/**
 * Run `scip-python` over one repo (P1-T3, R18, OPEN-5).
 *
 * Unlike `scip-typescript` there is no config file to generate: the indexer
 * walks the workspace and its `--target-only` takes a single path. So the
 * declared file set is enforced by the SECOND gate only — `documentAllowed`,
 * applied to every document at ingest — which is the same defence that catches
 * a TypeScript indexer widening its own set (delta D6).
 *
 * `pythonBin` is passed through rather than discovered. OPEN-5's decision is
 * that the indexing interpreter is declared and need not match the one the
 * service runs in production; the directory containing it is prepended to the
 * child's PATH because the indexer shells out to a bare `python`.
 *
 * KNOWN BROKEN ON WINDOWS at 0.6.6 — see docs/measurements.md M8. This runner
 * is correct and the channel is wired end to end; the indexer emits an empty
 * index on this platform. `index` reports the missing artifact by name rather
 * than showing a Python service with zero symbols as if that were a finding.
 */
/**
 * The `scip-python index` command line.
 *
 * Extracted so the separator rule below is testable without the indexer
 * installed — the bug it fixes was invisible for two phases precisely because
 * the failing path still exits 0.
 *
 * **`--cwd` must use NATIVE separators.** Given `D:/a/b` on Windows,
 * `scip-python` logs "Total Project Files 3" and "Sucessfully wrote SCIP
 * index", exits 0, and emits an 88-byte metadata header with zero documents.
 * Given `D:\a\b` it emits 37KB for the same repo. Measured on
 * `51-integration`, which is why that service had routes and a datastore but
 * not one symbol or CALLS edge.
 *
 * `--cwd` was the only path in this command passed through verbatim: `--output`
 * goes through `resolve()` and `--target-only` through `join()`, and both of
 * those already normalise. That is why the symptom looked like an environment
 * problem (OPEN-5) rather than a string problem.
 */
export function scipPythonCommand(
  repo: RepoConfig, outputPath: string, targetOnly: string, projectVersion?: string,
): string {
  return `scip-python index --cwd ${quote(resolve(repo.rootPath))}` +
    ` --project-name ${quote(repo.serviceName)}` +
    ` --project-version ${quote(projectVersion ?? "0.0.0")}` +
    `${targetOnly} --output ${quote(outputPath)}`;
}

export function runScipPython(
  repo: RepoConfig,
  outputPath: string,
  options: { projectVersion?: string } = {},
): IndexResult {
  const out = resolve(outputPath);
  mkdirSync(dirname(out), { recursive: true });

  const env = indexerEnv(repo);

  const started = Date.now();
  // `--target-only` is passed only when the repo declares exactly one include
  // that is a directory: given a single .py file it yields an empty index,
  // which is worse than indexing the workspace and filtering afterwards.
  const targetOnly = repo.include.length === 1 && !repo.include[0]!.includes(".")
    ? ` --target-only ${quote(join(repo.rootPath, repo.include[0]!.replace(/\/\*+$/, "")))}`
    : "";

  const command = scipPythonCommand(repo, out, targetOnly, options.projectVersion);

  const r = spawnSync(command, {
    cwd: repo.rootPath, encoding: "utf8", env, shell: true, timeout: 600_000,
  });

  return {
    ok: r.status === 0 && existsSync(out) && statSync(out).size > EMPTY_INDEX_BYTES,
    outputPath: out,
    tsconfigPath: "",
    tsconfig: {},
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? r.error.message : ""),
    status: r.status,
    durationMs: Date.now() - started,
  };
}

/**
 * Environment for spawning an indexer, with PATH augmented.
 *
 * This repo's own `node_modules/.bin` is only on PATH when invoked through an
 * npm script, and `scip-python` additionally shells out to a bare `python`.
 * Both are prepended so a plain `node src/cli.ts` works.
 *
 * Exported because P3-T5's availability probe has to look for the binary on the
 * SAME path the runner will use. A probe that searched a narrower PATH reported
 * every indexer as missing, which is a worse failure than the one it is meant
 * to catch: it turns a working toolchain into a refusal.
 */
export function indexerEnv(repo?: RepoConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const extraPath = [
    repo?.pythonBin ? dirname(resolve(repo.pythonBin)) : null,
    localBinDir(),
  ].filter((p): p is string => p !== null);
  if (extraPath.length > 0) {
    env.PATH = `${extraPath.join(delimiter)}${delimiter}${env.PATH ?? ""}`;
  }
  return env;
}

/** This project's own `node_modules/.bin`, for spawns that run in another cwd. */
function localBinDir(): string | null {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/.bin");
  return existsSync(dir) ? dir : null;
}

/**
 * A SCIP index containing only its metadata header is ~88 bytes.
 *
 * `ok` checks the size because `scip-python` exits 0 after writing one of
 * these. An exit code alone would report success on an index describing
 * nothing, which is the failure mode this project exists to stop shipping.
 */
const EMPTY_INDEX_BYTES = 256;
