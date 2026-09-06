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
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
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
    include: repo.include.length > 0 ? repo.include : ["**/*"],
    exclude: repo.exclude.length > 0 ? repo.exclude : ["node_modules"],
  };
}

/**
 * Quote one shell argument. Paths here are repo roots and output paths, which
 * routinely contain spaces on Windows — and `###` in this corpus.
 */
function quote(value: string): string {
  if (value === "") return '""';
  if (!/[\s"'`$&|;<>()[\]{}*?#!~]/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
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
