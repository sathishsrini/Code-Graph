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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { parseFile, grammarFor, type ParsedFile } from "../static/treesitter/parser.ts";
import { extract, type FileFindings } from "../static/treesitter/extract.ts";
import { ingestFindings } from "../static/treesitter/ingest.ts";
import { ingestInlineChecks } from "../static/inline-auth.ts";
import { loadCheckKindRules, type CheckKindRules } from "../static/security-rules.ts";
import { expandRoutes } from "../derive/routes.ts";
import { readBootDump } from "../boot/dump.ts";
import { readFastapiDump, toBootDump } from "../boot/fastapi.ts";
import {
  diffFiles, forgetDeletedFiles, hashText, planDerivations, purgeByProvenance,
  STATIC_EVIDENCE, type ChangeSet,
} from "./incremental.ts";
import { displayNameOf, symbolKind } from "../static/scip/symbol.ts";
import { resolveCrossService, type RouteTarget } from "../derive/cross-service.ts";
import { callSiteOwner } from "../static/treesitter/ingest.ts";

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
  boot: {
    routes: number; chainEntries: number; unjoined: number; framework: number;
    handles: number; inline: number;
  } | null;
  /** Channels that produced nothing because their artifact was missing. */
  missingArtifacts: string[];
}

export interface CrossServiceReport {
  repos: number;
  files: number;
  requests: number;
  unresolved: number;
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
  // P1-T10's inline step re-reads handler bodies, so parse trees and findings
  // are retained by path rather than re-parsed after boot runs.
  const parsedByPath = new Map<string, ParsedFile>();
  const findingsByPath = new Map<string, FileFindings>();
  for (const [path, text] of sources) {
    if (!grammarFor(path)) continue;
    const parsed = await parseFile(path, text);
    if (!parsed) continue;
    parsedByPath.set(path, parsed);
    const findings: FileFindings = extract(parsed);
    findingsByPath.set(path, findings);
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
      const stats = expandRoutes(dump, {
        store, writer, repoId, ranges, fileIds, sources, runId,
      });

      // R26: inline security checks, from the same boot dump's handler lines.
      // The rule pack is reviewed configuration (P1-T9); loading it here, at
      // the one place that writes facts, keeps detection out of the extractors.
      const rules: CheckKindRules = loadCheckKindRules(
        resolve(join(dirname(fileURLToPath(import.meta.url)), "../../rules/check-kinds.yml")),
      );
      const inline = ingestInlineChecks(dump.routes, {
        store, writer, service: dump.service, repoId, fileIds, runId,
        rules, parsedByPath, findingsByPath,
      });

      boot = {
        routes: stats.routes, chainEntries: stats.chainEntries,
        unjoined: stats.unjoined, framework: stats.framework,
        handles: stats.handlesEdges, inline,
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

/**
 * Rebuild cross-service evidence after all repo-local routes exist.
 *
 * This is a separate pass because the linker input is global: indexing the
 * router before the engine would otherwise make a valid target look absent.
 * Only REQUESTS rows and cross_service gaps are replaced; CALLS, datastore,
 * config, and boot evidence remain untouched.
 */
export async function linkCrossServiceRepos(options: {
  store: FactStore;
  repos: RepoConfig[];
  artifactDir: string;
}): Promise<CrossServiceReport> {
  const targets = (options.store.raw().prepare(
    `SELECT n.id AS node_id, r.service_name, r.method, r.url
       FROM routes r JOIN nodes n ON n.id = r.node_id
      ORDER BY r.service_name, r.method, r.url`,
  ).all() as Array<{ node_id: number; service_name: string; method: string; url: string }>)
    .map((r): RouteTarget => ({
      nodeId: r.node_id, service: r.service_name, method: r.method, url: r.url,
    }));

  const report: CrossServiceReport = { repos: 0, files: 0, requests: 0, unresolved: 0 };

  for (const repo of options.repos) {
    const repoId = options.store.upsertRepo(repo.name, repo.rootPath, repo.serviceName);
    const runId = options.store.startRun(repoId, "static", "code-intel/P1-T7", "");
    const writer = new GraphWriter(options.store, runId, repoId, {
      localPackages: new Set([repo.name, repo.serviceName]),
    });
    const scipPath = resolve(join(options.artifactDir, "scip", `${repo.name}.scip`));
    const index = existsSync(scipPath) ? new ScipProtobufReader().read(scipPath) : null;
    const ranges = index ? buildDefinitionRanges(index) : [];

    for (const file of enumerateFiles(repo)) {
      if (!grammarFor(file.relativePath)) continue;
      const fileRow = options.store.getFile(repoId, file.relativePath);
      if (!fileRow) continue;
      report.files += 1;
      options.store.deleteEdgesByTypeAndProvenance(fileRow.id, ["REQUESTS"], ["treesitter"]);
      options.store.deleteUnresolvedByProvenanceAndKind(fileRow.id, "cross_service");

      const text = readFileSync(file.absolutePath, "utf8");
      const parsed = await parseFile(file.relativePath, text);
      if (!parsed) continue;
      const findings = extract(parsed);
      const resolved = resolveCrossService({
        repo, findings, targets, repos: options.repos, source: text,
      });

      for (const link of resolved.requests) {
        const owner = callSiteOwner(ranges, findings.functions, file.relativePath, link.line);
        const source = owner.symbol
          ? writer.symbolNode(owner.symbol).id
          : writer.node(ref.file(repo.name, file.relativePath));
        writer.edgeById(source, link.routeNodeId, "REQUESTS", "inferred", "treesitter", {
          fileId: fileRow.id, line: link.line, detail: link.detail,
        });
        report.requests += 1;
      }

      for (const gap of resolved.unresolved) {
        const owner = callSiteOwner(ranges, findings.functions, file.relativePath, gap.line);
        const source = owner.symbol
          ? writer.symbolNode(owner.symbol).id
          : writer.node(ref.file(repo.name, file.relativePath));
        options.store.insertUnresolved({
          srcNodeId: source, kind: "cross_service", targetHint: gap.targetHint,
          reason: gap.reason, fileId: fileRow.id, line: gap.line, runId,
        });
        report.unresolved += 1;
      }
    }
    options.store.finishRun(runId);
    report.repos += 1;
  }

  return report;
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
