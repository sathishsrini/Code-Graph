// Bottom-up summary generation (P3-T2, R66) + the remaining input builders.
//
// R66: hierarchical, bottom-up. That is about *generation order*, not about
// feeding output back in as input — this module walks leaves first (each
// function in a file, each file in a service) so a reader reaching for a
// service summary finds its modules summarised already, but it never feeds one
// summary into another. Feeding summaries to summaries would make cache
// invalidation transitive and let a stale leaf silently poison everything
// above it. Inputs are facts from the store, full stop.

import type { FactStore } from "../store/db.ts";
import {
  functionInput, summarise, type SummaryKind, type SummaryProvider, type SummaryResult,
} from "./summaries.ts";
import { endpointFlow } from "../query/endpoint-flow.ts";

export type GenerateScope = "function" | "module" | "service" | "all";

export interface PlanItem {
  nodeKey: string;
  kind: SummaryKind;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

// ---------------------------------------------------------------------------
// input builders (facts only)
// ---------------------------------------------------------------------------

/** File (module) summary input: every function in the file, its signature and calls. */
export function moduleInput(store: FactStore, fileKey: string): string | null {
  const db = store.raw();
  const repo = repoAndPath(db, fileKey);
  if (!repo) return null;

  // Symbols are keyed by their verbatim SCIP string — never by fileKey — so
  // "functions in this file" is a files→symbols join, not a key prefix match.
  const symbols = db.prepare(
    `SELECT n.key, s.display_name, s.signature, s.start_line
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       JOIN files f ON f.id = s.file_id
       JOIN repos r ON r.id = f.repo_id
      WHERE r.name = ? AND f.path = ? AND n.kind = 'symbol'
      ORDER BY s.start_line`,
  ).all(repo.name, repo.path) as Array<Record<string, string | number | null>>;

  const lines = symbols.map((s) => {
    const key = String(s["key"]);
    const deps = (db.prepare(
      `SELECT n2.key, e.confidence
         FROM edges e
         JOIN nodes n1 ON n1.id = e.src_node_id
         JOIN nodes n2 ON n2.id = e.dst_node_id
        WHERE n1.key = ? AND e.type IN ('CALLS','CALLS_EXTERNAL')
        ORDER BY n2.key LIMIT 8`,
    ).all(key) as Array<{ key: string }>)
      .map((r) => r.key.replace(/\.$/, "").replace(/^scip [a-z]+ \S+ \d+ \S+ /, "")
        .split("/").at(-1)?.replaceAll("`", "") ?? "");
    const source = s["start_line"] !== null ? ` @${s["start_line"]}` : "";
    return `  ${s["display_name"]} (${s["signature"] ?? "?"})${source} calls: ${deps.join(", ") || "—"}`;
  });

  const routes = db.prepare(
    `SELECT DISTINCT rt.method, rt.url
       FROM routes rt
       JOIN symbols s ON s.node_id = rt.handler_node_id
       JOIN files f ON f.id = s.file_id
      WHERE f.id = ?
      ORDER BY rt.method, rt.url`,
  ).all(fileIdOf(db, repo.name, repo.path)) as Array<Record<string, string>>;

  return [
    `file: ${fileKey}`,
    routes.length > 0 ? `handles:\n${routes.map((r) => `  ${r["method"]} ${r["url"]}`).join("\n")}` : "",
    `functions:\n${lines.join("\n") || "  (none resolved)"}`,
  ].filter(Boolean).join("\n");
}

/** Service summary input: routes, function count, cross-service calls, gaps. */
export function serviceInput(store: FactStore, serviceName: string): string | null {
  const db = store.raw();
  const repo = db.prepare(`SELECT id, name FROM repos WHERE name = ?`).get(serviceName) as
    | { id: number; name: string } | undefined;
  if (!repo) return null;

  const routes = (db.prepare(
    `SELECT method, url FROM routes WHERE repo_id = ? ORDER BY method, url`,
  ).all(repo.id) as Array<Record<string, string>>)
    .map((r) => `  ${r["method"]} ${r["url"]}`);
  const functions = (db.prepare(
    `SELECT COUNT(*) AS n
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.repo_id = ?`,
  ).get(repo.id) as { n: number }).n;
  const outbound = (db.prepare(
    `SELECT DISTINCT n2.key AS dest
       FROM edges e
       JOIN symbols s ON s.node_id = e.src_node_id
       JOIN files f ON f.id = s.file_id
       JOIN nodes n1 ON n1.id = e.src_node_id
       JOIN nodes n2 ON n2.id = e.dst_node_id
      WHERE f.repo_id = ? AND e.type = 'REQUESTS'
      ORDER BY dest`,
  ).all(repo.id) as Array<Record<string, string>>)
    .map((r) => r["dest"]);
  const unresolved = (db.prepare(
    `SELECT COUNT(*) AS n
       FROM unresolved_calls uc
       JOIN symbols s ON s.node_id = uc.src_node_id
       JOIN files f ON f.id = s.file_id
      WHERE f.repo_id = ?`,
  ).get(repo.id) as { n: number }).n;

  if (routes.length === 0 && functions === 0) return null;

  return [
    `service: ${serviceName}`,
    `functions: ${functions}`,
    routes.length > 0 ? `routes:\n${routes.join("\n")}` : "",
    outbound.length > 0 ? `calls out to services: ${outbound.join(", ")}` : "",
    `unresolved calls: ${unresolved}`,
  ].join("\n");
}

/** Path narration input, flattened from the deterministic endpoint-flow query. */
export function endpointPathInput(
  store: FactStore, service: string, method: string, url: string,
): string | null {
  const flow = endpointFlow(store, service, method, url, {});
  if (!flow.chain || flow.chain.length === 0) return null;
  const lines = flow.chain.map((n) =>
    `${n.name ?? n.key ?? "?"} (${n.phase}${n.confidence === "inferred" ? ", inferred" : ""})`,
  );
  return [
    `path: ${service} ${method} ${url}`,
    ...lines,
  ].join("\n");
}

type RawDb = ReturnType<FactStore["raw"]>;

function repoAndPath(db: RawDb, fileKey: string): { name: string; path: string } | null {
  const slash = fileKey.indexOf("/");
  if (slash <= 0) return null;
  const name = fileKey.slice(0, slash);
  const path = fileKey.slice(slash + 1);
  const exists = db.prepare(`SELECT id FROM repos WHERE name = ?`).get(name) as { id: number } | undefined;
  if (!exists) return null;
  const file = db.prepare(`SELECT id FROM files WHERE repo_id = ? AND path = ?`).get(exists.id, path) as
    | { id: number } | undefined;
  return file ? { name, path } : null;
}

function fileIdOf(db: RawDb, name: string, path: string): number | null {
  const repo = db.prepare(`SELECT id FROM repos WHERE name = ?`).get(name) as { id: number } | undefined;
  if (!repo) return null;
  const file = db.prepare(`SELECT id FROM files WHERE repo_id = ? AND path = ?`).get(repo.id, path) as
    | { id: number } | undefined;
  return file?.id ?? null;
}

// ---------------------------------------------------------------------------
// planning: the bottom-up order
// ---------------------------------------------------------------------------

export function planGeneration(store: FactStore, scope: GenerateScope, seed = ""): PlanItem[] {
  const db = store.raw();
  switch (scope) {
    case "function": {
      const node = nodeOf(store, seed, "symbol");
      if (!node) throw new PlanError(`no symbol with key "${seed}" — function scope needs a symbol seed`);
      return [{ nodeKey: seed, kind: "function" }];
    }
    case "module": {
      const node = nodeOf(store, seed, "file");
      if (!node) throw new PlanError(`no file with key "${seed}" — module scope needs a file key`);
      return modulePlan(store, seed);
    }
    case "service": {
      const repo = db.prepare(`SELECT id, name FROM repos WHERE name = ?`).get(seed) as { id: number; name: string } | undefined;
      if (!repo) throw new PlanError(`no repo named "${seed}" in the store`);
      return servicePlan(store, repo.name);
    }
    case "all": {
      const repos = db.prepare(`SELECT name FROM repos ORDER BY name`).all() as Array<{ name: string }>;
      const items: PlanItem[] = [];
      for (const r of repos) items.push(...servicePlan(store, r.name));
      return items;
    }
  }
}

function modulePlan(store: FactStore, fileKey: string): PlanItem[] {
  const db = store.raw();
  const repo = repoAndPath(db, fileKey);
  if (!repo) return [];
  const symbols = db.prepare(
    `SELECT n.key
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       JOIN files f ON f.id = s.file_id
       JOIN repos r ON r.id = f.repo_id
      WHERE r.name = ? AND f.path = ? AND n.kind = 'symbol'
      ORDER BY n.key`,
  ).all(repo.name, repo.path) as Array<{ key: string }>;
  return [
    ...symbols.map((s) => ({ nodeKey: s.key, kind: "function" as const })),
    { nodeKey: fileKey, kind: "module" },
  ];
}

function servicePlan(store: FactStore, serviceName: string): PlanItem[] {
  const db = store.raw();
  const repoId = db.prepare(`SELECT id FROM repos WHERE name = ?`).get(serviceName) as { id: number } | undefined;
  const files = repoId
    ? db.prepare(`SELECT DISTINCT f.path FROM files f WHERE f.repo_id = ? ORDER BY f.path`).all(repoId.id) as Array<{ path: string }>
    : [];
  const items: PlanItem[] = [];
  for (const f of files) items.push(...modulePlan(store, `${serviceName}/${f.path}`));
  items.push({ nodeKey: serviceName, kind: "service" } as PlanItem);
  return items;
}

function nodeOf(store: FactStore, key: string, kind: string): { id: number } | undefined {
  return store.raw().prepare(`SELECT id FROM nodes WHERE key = ? AND kind = ?`).get(key, kind) as { id: number } | undefined;
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

export interface GenerationReport {
  generated: SummaryResult[];
  hitCache: number;
  skipped: Array<{ nodeKey: string; reason: string }>;
  provider: string | null;
  /** True when at least one plan item missed the cache AND we had no provider. */
  needsProvider: boolean;
}

/**
 * Generate everything in the plan, bottom-up, cache-first.
 *
 * The provider is optional here for a reason: when every item is cached
 * (plan re-run, or a store whose inputs never changed), generating nothing and
 * returning the cached rows is a valid answer with zero model load.
 */
export async function generateFromPlan(
  store: FactStore, items: PlanItem[], provider?: SummaryProvider | null,
): Promise<GenerationReport> {
  const generated: SummaryResult[] = [];
  let hitCache = 0;
  const skipped: Array<{ nodeKey: string; reason: string }> = [];
  let anyMiss = false;

  for (const item of items) {
    const input = inputFor(store, item);
    if (!input) {
      skipped.push({ nodeKey: item.nodeKey, reason: "no facts in the store to summarise" });
      continue;
    }
    try {
      const result = await summarise(store, { nodeKey: item.nodeKey, kind: item.kind, input }, provider ?? undefined);
      if (result.cached) hitCache += 1; else { generated.push(result); anyMiss = anyMiss || true; }
    } catch (e) {
      if (provider) throw e;
      anyMiss = true;
      skipped.push({ nodeKey: item.nodeKey, reason: `cache miss and no provider — ${(e as Error).message}` });
    }
  }

  // If there was a real miss but no provider, nothing was written and the
  // whole run is a no-op. Report that loudly rather than as success.
  return {
    generated, hitCache, skipped,
    provider: provider?.name ?? null,
    needsProvider: anyMiss,
  };
}

function inputFor(store: FactStore, item: PlanItem): string | null {
  switch (item.kind) {
    case "function": return functionInput(store, item.nodeKey);
    case "module": return moduleInput(store, item.nodeKey);
    case "service": return serviceInput(store, item.nodeKey);
    default: return null;
  }
}