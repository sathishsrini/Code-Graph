// Running a boot adapter  —  task P0-T8, moved out of the CLI for CTX-S6.
//
// `boot dump` and `build` both produce the boot artifact, so the spawn lives
// here once. The CLI's command and `src/index/build.ts` call it; neither
// re-implements it.
//
// Both adapters run as a CHILD PROCESS on purpose: they import and boot a
// foreign application, which can throw, hang, open handles or call exit, and
// none of that should be able to take the caller with it.

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { RepoConfig } from "../config/repos.ts";
import { readBootDump, type BootDump } from "./dump.ts";
import { readFastapiDump, toBootDump } from "./fastapi.ts";

/**
 * Why this repo has no boot channel, or null when it has one.
 *
 * Next.js route extraction is descoped by decision (plan P1-T5), so there is
 * deliberately no adapter. The reason is returned rather than an empty dump,
 * which would read as "this service has no routes".
 */
export function bootUnsupported(repo: RepoConfig): string | null {
  if (repo.framework !== "fastify" && repo.framework !== "fastapi") {
    return `no adapter for framework "${repo.framework}" (repo ${repo.name}). Fastify and FastAPI only.`;
  }
  if (!repo.entrypoint) return `repo ${repo.name} declares no entrypoint`;
  return null;
}

export interface BootRun {
  ok: boolean;
  /** The adapter's exit status; null when it could not be spawned or timed out. */
  status: number | null;
  /** stderr of a failed run, or the spawn error. Empty on success. */
  error: string;
  /** One shape downstream, whichever framework produced it. Null on failure. */
  dump: BootDump | null;
}

/** Boot `repo` through its adapter and write the artifact to `outPath`. */
export function runBootAdapter(repo: RepoConfig, outPath: string): BootRun {
  const python = repo.framework === "fastapi";
  const adapter = resolve(
    import.meta.dirname,
    python ? "../../adapters/fastapi/boot_dump.py" : "../../adapters/fastify/boot-dump.cjs",
  );
  // OPEN-5: the indexing/boot interpreter is declared, not discovered. It does
  // not have to match the one the service runs in production.
  const runner = python ? (repo.pythonBin || "python") : process.execPath;
  // CTX-S6: reading a repo must not write into it. The adapter imports the
  // entry with the repo on sys.path, so without this every module it loads
  // is compiled into the repo's own __pycache__/ (measured: main and helpers).
  const env = python ? { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } : process.env;
  const result = spawnSync(runner, [
    adapter,
    "--entry", join(repo.rootPath, repo.entrypoint),
    "--cwd", repo.rootPath,
    "--service", repo.serviceName,
    "--out", resolve(outPath),
  ], { encoding: "utf8", timeout: 120_000, env });

  if (result.error) {
    return { ok: false, status: null, error: `boot dump: ${result.error.message}`, dump: null };
  }
  if (result.status !== 0) {
    return {
      ok: false, status: result.status,
      error: result.stderr || "boot dump: adapter failed", dump: null,
    };
  }

  // One shape downstream. The frameworks differ — Fastify hooks are per-route
  // and inheritable, Starlette middleware is app-wide — and `fastapi.ts`
  // preserves that difference in `origin` and `inheritedFrom` rather than
  // flattening it into "hooks".
  const dump = python
    ? toBootDump(readFastapiDump(resolve(outPath)))
    : readBootDump(resolve(outPath));
  return { ok: true, status: 0, error: "", dump };
}
