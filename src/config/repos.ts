// ============================================================================
// Repo configuration  —  task P0-T2  (requirement R13, OPEN-1, OPEN-2)
// ============================================================================
// The engine never assumes a directory layout. Every service it indexes is
// declared here: where it lives, what language it is, which framework serves
// its routes, and — critically — which files are actually part of the running
// program.
//
// The include/exclude pair is how OPEN-1 is resolved. Two of the validation
// fixtures carry ~1,600 LOC of non-compiling TypeScript in src/ that never
// executes; the live code is a single CommonJS server.js. Indexing the dead
// tree yields a confident, fictional architecture. So reachability is declared,
// not guessed.
// ============================================================================

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

export type Lang = "ts" | "js" | "py";
export type Framework = "fastify" | "fastapi" | "nextjs" | "none";

const LANGS: readonly Lang[] = ["ts", "js", "py"];
const FRAMEWORKS: readonly Framework[] = ["fastify", "fastapi", "nextjs", "none"];

export interface RepoConfig {
  /** Stable identifier. Becomes `repos.name` and the `service` node key. */
  name: string;
  /** Absolute path to the repository root. */
  rootPath: string;
  /** Service name if it differs from the repo name. */
  serviceName: string;
  lang: Lang;
  framework: Framework;
  /**
   * Repo-relative entrypoint of the running program. Anchors reachability and
   * tells the boot adapter what to load. Empty string when not applicable.
   */
  entrypoint: string;
  /** Repo-relative globs to index. Empty means "everything not excluded". */
  include: string[];
  /** Repo-relative globs to skip. Applied after include. */
  exclude: string[];
  /** Env var names holding base URLs of other services (cross-service linking). */
  baseUrlEnvVars: string[];
  /** Listening port, when known. Used to resolve localhost URLs to services. */
  port: number | null;
  /** Path to tsconfig.json relative to rootPath, when the indexer needs it. */
  tsconfig: string | null;
  /** Python interpreter to index with. See OPEN-5. */
  pythonBin: string | null;
}

export interface Config {
  repos: RepoConfig[];
}

export interface LoadOptions {
  /**
   * Verify every rootPath exists on disk. Default true. Tests set it false so
   * fixture configs validate on machines without the corpus mounted.
   */
  checkPaths?: boolean;
}

export class ConfigError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ConfigError";
    this.path = path;
  }
}

function fail(message: string, where: string): never {
  throw new ConfigError(message, where);
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`expected an object, got ${describe(value)}`, where);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`expected a string, got ${describe(value)}`, where);
  return value;
}

function asNonEmptyString(value: unknown, where: string): string {
  const s = asString(value, where);
  if (s.trim() === "") fail("must not be empty", where);
  return s;
}

function asStringArray(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`expected an array of strings, got ${describe(value)}`, where);
  return value.map((v, i) => asString(v, `${where}[${i}]`));
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const s = asString(value, where);
  if (!allowed.includes(s as T)) {
    fail(`expected one of ${allowed.join(" | ")}, got ${JSON.stringify(s)}`, where);
  }
  return s as T;
}

function asOptionalNumber(value: unknown, where: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`expected a number, got ${describe(value)}`, where);
  }
  return value;
}

function asOptionalString(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  return asString(value, where);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Validate a parsed configuration object.
 *
 * Every failure names the exact JSON path, because a config typo that silently
 * indexes the wrong tree is expensive to discover later.
 */
export function validateConfig(raw: unknown, options: LoadOptions = {}): Config {
  const checkPaths = options.checkPaths ?? true;
  const root = asObject(raw, "");

  const reposRaw = root["repos"];
  if (!Array.isArray(reposRaw)) fail("expected an array", "repos");
  if (reposRaw.length === 0) fail("must declare at least one repo", "repos");

  const seenNames = new Set<string>();
  const repos: RepoConfig[] = reposRaw.map((entry, i) => {
    const where = `repos[${i}]`;
    const o = asObject(entry, where);

    const name = asNonEmptyString(o["name"], `${where}.name`);
    if (seenNames.has(name)) fail(`duplicate repo name ${JSON.stringify(name)}`, `${where}.name`);
    seenNames.add(name);

    const rootPath = asNonEmptyString(o["rootPath"], `${where}.rootPath`);
    if (!isAbsolute(rootPath)) {
      fail(`rootPath must be absolute, got ${JSON.stringify(rootPath)}`, `${where}.rootPath`);
    }
    if (checkPaths) {
      if (!existsSync(rootPath)) fail(`rootPath does not exist: ${rootPath}`, `${where}.rootPath`);
      if (!statSync(rootPath).isDirectory()) {
        fail(`rootPath is not a directory: ${rootPath}`, `${where}.rootPath`);
      }
    }

    return {
      name,
      rootPath: resolve(rootPath),
      serviceName: o["serviceName"] === undefined
        ? name
        : asNonEmptyString(o["serviceName"], `${where}.serviceName`),
      lang: asEnum(o["lang"], LANGS, `${where}.lang`),
      framework: asEnum(o["framework"], FRAMEWORKS, `${where}.framework`),
      entrypoint: o["entrypoint"] === undefined ? "" : asString(o["entrypoint"], `${where}.entrypoint`),
      include: asStringArray(o["include"], `${where}.include`),
      exclude: asStringArray(o["exclude"], `${where}.exclude`),
      baseUrlEnvVars: asStringArray(o["baseUrlEnvVars"], `${where}.baseUrlEnvVars`),
      port: asOptionalNumber(o["port"], `${where}.port`),
      tsconfig: asOptionalString(o["tsconfig"], `${where}.tsconfig`),
      pythonBin: asOptionalString(o["pythonBin"], `${where}.pythonBin`),
    };
  });

  return { repos };
}

/** Read and validate a config file. */
export function loadConfig(configPath: string, options: LoadOptions = {}): Config {
  const abs = resolve(configPath);
  if (!existsSync(abs)) {
    throw new ConfigError(`config file not found: ${abs}`, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ConfigError(`invalid JSON — ${(e as Error).message}`, abs);
  }

  try {
    return validateConfig(parsed, options);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(e.message, abs);
    throw e;
  }
}

/** Look up one repo by name. */
export function repoByName(config: Config, name: string): RepoConfig | undefined {
  return config.repos.find((r) => r.name === name);
}
