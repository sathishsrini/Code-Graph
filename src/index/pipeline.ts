// ============================================================================
// Indexing pipeline  —  tasks P1-T8, P1-T11  (requirements R27-R30)
// ============================================================================
// One repo, every channel, into the store. This is the `index` command's body
// and the only place that writes facts.
//
// Order matters and is not arbitrary:
//
//   1. hash the declared file set          -> the changed set (R27)
//   2. purge by provenance                 -> exactly what those files claimed (R28)
//   3. SCIP  -> symbols, CALLS, unresolved_calls
//   4. tree-sitter -> THROWS, READS/WRITES, READS_CONFIG
//   5. boot  -> routes, route_chain, HANDLES
//
// SCIP runs before tree-sitter because tree-sitter findings are attributed to
// the SCIP definition containing them; without the ranges every finding would
// fall back to the file node and the graph would lose its callers.
//
// Boot runs last because a route's chain joins to symbols, and the symbols
// have to exist. It is also the only channel that can be absent: a service
// that will not boot still gets a static graph, and the artifact's absence is
// reported rather than being indistinguishable from a service with no routes.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RepoConfig } from "../config/repos.ts";
import type { FactStore } from "../store/db.ts";
import { GraphWriter } from "../normalize/graph.ts";
import { ref } from "../normalize/keys.ts";
import {
  ScipProtobufReader, ROLE_DEFINITION, hasRole, type ScipIndex,
} from "../static/scip/reader.ts";
import { documentAllowed } from "../static/scip/runner.ts";
import { deriveCalls, dedupe, createFsSourceProvider } from "../derive/calls.ts";
import { buildDefinitionRanges, type DefRange } from "../query/flow.ts";
import { enumerateFiles } from "../static/treesitter/files.ts";
import { parseFile, grammarFor } from "../static/treesitter/parser.ts";
import { extract, type FileFindings } from "../static/treesitter/extract.ts";
import { ingestFindings } from "../static/treesitter/ingest.ts";
import { expandRoutes } from "../derive/routes.ts";
import { readBootDump } from "../boot/dump.ts";
import { readFastapiDump, toBootDump } from "../boot/fastapi.ts";
import {
  diffFiles, forgetDeletedFiles, hashText, planDerivations, purgeByProvenance,
  STATIC_EVIDENCE, type ChangeSet,
} from "./incremental.ts";
import { displayNameOf, symbolKind } from "../static/scip/symbol.ts";

export interface IndexOptions {
  store: FactStore;
  repo: RepoConfig;
  /** `.codeintel` root holding the scip/ and boot/ artifacts. */
  artifactDir: string;
  /** Re-run every derivation regardless of the changed set. */
  force?: boolean;
  commitSha?: string;
}

export interface IndexReport {
  repo: string;
  change: ChangeSet;
  purged: { edges: number; unresolved: number; chain: number; files: number };
  skipped: boolean;
  reason: string;
  symbols: number;
  calls: number;
  unresolvedCalls: number;
  treesitter: { throws: number; reads: number; writes: number; configs: number; fileScoped: number };
  boot: { routes: number; chainEntries: number; unjoined: number; framework: number; handles: number } | null;
  /** Channels that produced nothing because their artifact was missing. */
  missingArtifacts: string[];
}

export async function indexRepo(options: IndexOptions): Promise<IndexReport> {
  const { store, repo, artifactDir } = options;
  const missingArtifacts: string[] = [];

  const repoId = store.upsertRepo(repo.name, repo.rootPath, repo.serviceName);
  const runId = store.startRun(repoId, "static", "code-intel/P1", options.commitSha ?? "");

  // --- 1. hash the declared file set (R27) --------------------------------
  const files = enumerateFiles(repo);
  const hashes = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const f of files) {
    const text = readFileSync(f.absolutePath, "utf8");
    sources.set(f.relativePath, text);
    hashes.set(f.relativePath, hashText(text));
  }

  const change = diffFiles(store, repoId, hashes);
  const plan = planDerivations(change, options.force);

  if (!plan.scip) {
    store.finishRun(runId);
    return {
      repo: repo.name, change, skipped: true, reason: plan.reason,
      purged: { edges: 0, unresolved: 0, chain: 0, files: 0 },
      symbols: 0, calls: 0, unresolvedCalls: 0,
      treesitter: { throws: 0, reads: 0, writes: 0, configs: 0, fileScoped: 0 },
      boot: null, missingArtifacts: [],
    };
  }

  // --- 2. purge by provenance (R28) ---------------------------------------
  // Nodes are never touched. Edges INTO a changed file from unchanged files
  // survive, because they are owned by the caller's provenance.
  const purged = purgeByProvenance(
    store, repoId, [...change.changed, ...change.deleted], STATIC_EVIDENCE,
  );

  // Register the current file set. Deleted files are forgotten after their
  // rows are gone, so the next diff stops reporting them.
  const fileIds = new Map<string, number>();
  for (const [path, hash] of hashes) {
    const lang = repo.lang === "py" ? "py" : path.endsWith(".py") ? "py" : langOf(path);
    fileIds.set(path, store.upsertFile(repoId, path, lang, hash, runId));
  }
  forgetDeletedFiles(store, repoId, change.deleted);

  const writer = new GraphWriter(store, runId, repoId, {
    localPackages: new Set([repo.name, repo.serviceName]),
  });

  // Files belong to their service, so "which files does this service own" is
  // a graph question rather than a path prefix match.
  const serviceNode = writer.node(ref.service(repo.serviceName));
  for (const path of hashes.keys()) {
    writer.edgeById(
      serviceNode, writer.node(ref.file(repo.name, path)),
      "CONTAINS", "certain", "manual", { fileId: fileIds.get(path) ?? null },
    );
  }

  // --- 3. SCIP -------------------------------------------------------------
  const scipPath = resolve(join(artifactDir, "scip", `${repo.name}.scip`));
  let index: ScipIndex | null = null;
  let ranges: DefRange[] = [];
  let symbols = 0;
  let calls = 0;
  let unresolvedCalls = 0;

  if (existsSync(scipPath)) {
    index = new ScipProtobufReader().read(scipPath);
    ranges = buildDefinitionRanges(index).filter((r) => documentAllowed(repo, r.file));
    ({ symbols, calls, unresolvedCalls } = ingestScip(
      index, { store, writer, repo, repoId, runId, fileIds },
    ));
  } else {
    missingArtifacts.push(`scip index (${scipPath})`);
  }

  // --- 4. tree-sitter ------------------------------------------------------
  const treesitter = { throws: 0, reads: 0, writes: 0, configs: 0, fileScoped: 0 };
  for (const [path, text] of sources) {
    if (!grammarFor(path)) continue;
    const parsed = await parseFile(path, text);
    if (!parsed) continue;
    const findings: FileFindings = extract(parsed);
    const counts = ingestFindings({
      writer, store, repoName: repo.name, ranges, fileId: fileIds.get(path)!,
    }, findings);
    treesitter.throws += counts.throws;
    treesitter.reads += counts.reads;
    treesitter.writes += counts.writes;
    treesitter.configs += counts.configs;
    treesitter.fileScoped += counts.fileScoped;
  }

  // --- 5. boot -------------------------------------------------------------
  let boot: IndexReport["boot"] = null;
  const bootPath = resolve(join(artifactDir, "boot", `${repo.name}.json`));
  if (repo.framework === "fastify" || repo.framework === "fastapi") {
    if (existsSync(bootPath)) {
      const dump = repo.framework === "fastapi"
        ? toBootDump(readFastapiDump(bootPath))
        : readBootDump(bootPath);
      const stats = expandRoutes(dump, { store, writer, repoId, ranges, fileIds, runId });
      boot = {
        routes: stats.routes, chainEntries: stats.chainEntries,
        unjoined: stats.unjoined, framework: stats.framework,
        handles: stats.handlesEdges,
      };
    } else {
      // Named, not silently skipped: "no boot artifact" and "this service has
      // no routes" are different facts and only one of them is about the code.
      missingArtifacts.push(`boot dump (${bootPath})`);
    }
  }

  store.finishRun(runId);
  return {
    repo: repo.name, change, purged, skipped: false, reason: plan.reason,
    symbols, calls, unresolvedCalls, treesitter, boot, missingArtifacts,
  };
}

function langOf(path: string): string {
  const g = grammarFor(path);
  if (g === "python") return "py";
  if (g === "typescript" || g === "tsx") return "ts";
  if (g === "javascript") return "js";
  return "other";
}

interface ScipContext {
  store: FactStore;
  writer: GraphWriter;
  repo: RepoConfig;
  repoId: number;
  runId: number;
  fileIds: Map<string, number>;
}

/**
 * Symbols, CALLS and unresolved_calls from one SCIP index.
 *
 * `allowDocument` is passed to `deriveCalls` for the reason M7 records: the
 * indexer was pointed at a generated tsconfig covering exactly the declared
 * file set, and this is the second gate in case it widens its own set.
 * Declaring the file set and enforcing it are different things.
 */
function ingestScip(
  index: ScipIndex, ctx: ScipContext,
): { symbols: number; calls: number; unresolvedCalls: number } {
  const { store, writer, repo, fileIds, runId } = ctx;
  let symbols = 0;

  for (const doc of index.documents) {
    const path = doc.relativePath.split("\\").join("/");
    if (!documentAllowed(repo, path)) continue;
    const fileId = fileIds.get(path) ?? null;

    for (const occ of doc.occurrences) {
      // Definitions only: a reference does not tell us where a symbol lives.
      if (!hasRole(occ.symbolRoles, ROLE_DEFINITION)) continue;
      if (occ.symbol === "" || occ.symbol.startsWith("local ")) continue;
      if (!writer.isLocalSymbol(occ.symbol)) continue;

      const nodeId = writer.node(ref.symbol(occ.symbol));
      const info = doc.symbols.find((s) => s.symbol === occ.symbol);
      store.upsertSymbol({
        nodeId,
        fileId,
        // M1: displayName is 0/407 on this indexer, so it is derived from the
        // symbol grammar rather than read from a field that is always empty.
        displayName: info?.displayName || displayNameOf(occ.symbol),
        symbolKind: symbolKind(occ.symbol),
        // M1: signatures live in `documentation`, as a markdown fence.
        signature: info?.documentation?.[0] ?? null,
        doc: info?.documentation?.slice(1).join("\n") || null,
        startLine: (occ.enclosingRange?.startLine ?? occ.range.startLine) + 1,
        endLine: (occ.enclosingRange?.endLine ?? occ.range.endLine) + 1,
        enclosingNodeId: null,
        isExported: false,
        isTest: /\.(test|spec)\.[jt]sx?$/.test(path),
      });
      if (fileId !== null) {
        writer.edgeById(
          writer.node(ref.file(repo.name, path)), nodeId,
          "CONTAINS", "certain", "scip", { fileId },
        );
      }
      symbols += 1;
    }
  }

  const derived = deriveCalls(index, {
    allowDocument: (rel) => documentAllowed(repo, rel),
    localPackages: new Set([repo.name, repo.serviceName]),
    sources: createFsSourceProvider(index.projectRoot || repo.rootPath),
  });

  for (const call of dedupe(derived.calls)) {
    const path = call.filePath.split("\\").join("/");
    const src = writer.symbolNode(call.srcSymbol);
    const dst = writer.symbolNode(call.dstSymbol);
    writer.edgeById(
      src.id, dst.id,
      // A call whose target is outside every local package is a boundary, not
      // an internal call. Typing it differently is what lets `endpoint_flow`
      // terminate at R35's boundary without a special case per package.
      dst.external ? "CALLS_EXTERNAL" : "CALLS",
      call.confidence, "scip",
      { fileId: fileIds.get(path) ?? null, line: call.line },
    );
  }

  for (const u of derived.unresolved) {
    const path = u.filePath.split("\\").join("/");
    store.insertUnresolved({
      srcNodeId: writer.symbolNode(u.srcSymbol).id,
      kind: "call",
      targetHint: u.target,
      reason: u.reason,
      fileId: fileIds.get(path) ?? null,
      line: u.line,
      col: u.col,
      runId,
    });
  }

  return {
    symbols,
    calls: dedupe(derived.calls).length,
    unresolvedCalls: derived.unresolved.length,
  };
}
