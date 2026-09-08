// ============================================================================
// Fact store  —  task P0-T5  (requirements R1-R11)
// ============================================================================
// SQLite via node:sqlite — built into Node, so no native compilation and no
// better-sqlite3 build step on Windows.
//
// This wrapper is deliberately thin. It owns identity (upsert node, upsert
// edge) and provenance (runs, files, delete-by-provenance). It owns no query
// logic; that lives in src/query/ from Phase 1.
// ============================================================================

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrate, latestVersion, type MigrationReport } from "./migrate.ts";

/** The migration a fully-migrated database ends at. Derived, never hand-typed. */
export const SCHEMA_VERSION = latestVersion();

export type NodeKind =
  | "service" | "route" | "symbol" | "file" | "external" | "datastore" | "config";

export type EdgeType =
  | "CONTAINS" | "CALLS" | "HANDLES" | "REQUESTS" | "READS" | "WRITES"
  | "CALLS_EXTERNAL" | "THROWS" | "READS_CONFIG";

export type Confidence = "certain" | "inferred" | "observed" | "unresolved";

export type EvidenceKind = "scip" | "treesitter" | "semgrep" | "boot" | "otel" | "manual";

export type Channel = "static" | "boot" | "runtime";

/** Framework lifecycle phase, plus the synthetic `handler` and `handler_inline`. */
export type ChainPhase = string;

/** Which channel claimed a route exists. Boot and static are not the same claim. */
export type RouteSource = "boot" | "static";

export type ChainOrigin = "scope" | "route" | "framework" | "handler";

export type UnresolvedKind = "call" | "cross_service" | "datastore";

export interface EdgeInput {
  srcNodeId: number;
  dstNodeId: number;
  type: EdgeType;
  confidence: Confidence;
  evidenceKind: EvidenceKind;
  runId: number;
  fileId?: number | null;
  line?: number | null;
  detail?: string | null;
}

export interface SymbolInput {
  nodeId: number;
  fileId: number | null;
  displayName: string;
  symbolKind?: string | null;
  signature?: string | null;
  doc?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  enclosingNodeId?: number | null;
  isExported?: boolean;
  isTest?: boolean;
}

export interface RouteInput {
  nodeId: number;
  repoId: number | null;
  serviceName: string;
  method: string;
  url: string;
  prefix?: string;
  handlerNodeId?: number | null;
  requestSchema?: string | null;
  responseSchema?: string | null;
  hasSchema?: boolean;
  source: RouteSource;
  runId: number;
}

export interface ChainInput {
  routeNodeId: number;
  position: number;
  phase: ChainPhase;
  symbolNodeId?: number | null;
  key?: string | null;
  name?: string | null;
  checkKind?: string | null;
  origin: ChainOrigin;
  inheritedFrom?: string | null;
  confidence: Confidence;
  evidenceKind: EvidenceKind;
  fileId?: number | null;
  line?: number | null;
  /**
   * Last line of an anonymous hook's body (P1-T12, migration 004).
   *
   * Set only when the symbol join landed on a module. NULL means "no narrowing
   * needed", never "unknown".
   */
  endLine?: number | null;
  /** P1-T10's reviewed-helper-vs-shape discriminator. Boot rows leave it null. */
  detail?: string | null;
  runId: number;
}

export interface CfgBlockInput {
  symbolNodeId: number;
  blockIndex: number;
  parentIndex: number | null;
  kind: string;
  conditionText?: string | null;
  outcome?: string | null;
  exitForm?: string | null;
  errorName?: string | null;
  startLine: number;
  endLine: number;
  fileId: number;
  runId: number;
}

export interface UnresolvedInput {
  srcNodeId: number;
  kind: UnresolvedKind;
  targetHint?: string | null;
  reason: string;
  fileId?: number | null;
  line?: number | null;
  col?: number | null;
  runId: number;
}

export interface IntegrityReport {
  ok: boolean;
  foreignKeyViolations: number;
  integrityCheck: string;
  tables: number;
  indexes: number;
}

export class FactStore {
  private db: DatabaseSync;
  readonly path: string;
  /** What this connection applied. An empty `applied` means it was current. */
  readonly migrations: MigrationReport;

  constructor(dbPath: string) {
    this.path = resolve(dbPath);
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.path);
    // Both pragmas are connection state, not schema, so they live here rather
    // than in a migration file: journal_mode is a silent no-op inside the
    // transaction a migration runs in, and foreign_keys defaults to OFF on
    // every new connection regardless of how the file was created.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrations = migrate(this.db);
  }

  /** Delete an existing database file and its WAL sidecars, then recreate. */
  static reset(dbPath: string): FactStore {
    const abs = resolve(dbPath);
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${abs}${suffix}`;
      if (existsSync(f)) rmSync(f, { force: true });
    }
    return new FactStore(abs);
  }

  close(): void {
    this.db.close();
  }

  // -- transactions ---------------------------------------------------------

  /** Run `fn` in a transaction, rolling back on any throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // -- repos ----------------------------------------------------------------

  upsertRepo(name: string, rootPath: string, serviceName: string | null): number {
    const existing = this.db.prepare("SELECT id FROM repos WHERE name = ?").get(name) as
      | { id: number } | undefined;
    if (existing) {
      this.db.prepare("UPDATE repos SET root_path = ?, service_name = ? WHERE id = ?")
        .run(rootPath, serviceName, existing.id);
      return existing.id;
    }
    const r = this.db.prepare(
      "INSERT INTO repos (name, root_path, service_name) VALUES (?, ?, ?)",
    ).run(name, rootPath, serviceName);
    return Number(r.lastInsertRowid);
  }

  // -- runs -----------------------------------------------------------------

  startRun(repoId: number, channel: Channel, tool: string, commitSha: string): number {
    const r = this.db.prepare(
      `INSERT INTO runs (repo_id, commit_sha, channel, tool, started_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(repoId, commitSha, channel, tool);
    return Number(r.lastInsertRowid);
  }

  finishRun(runId: number): void {
    this.db.prepare("UPDATE runs SET finished_at = datetime('now') WHERE id = ?").run(runId);
  }

  // -- files ----------------------------------------------------------------

  upsertFile(
    repoId: number,
    path: string,
    lang: string,
    contentSha256: string,
    runId: number | null,
  ): number {
    const existing = this.db.prepare(
      "SELECT id FROM files WHERE repo_id = ? AND path = ?",
    ).get(repoId, path) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE files SET lang = ?, content_sha256 = ?, last_run_id = ? WHERE id = ?",
      ).run(lang, contentSha256, runId, existing.id);
      return existing.id;
    }
    const r = this.db.prepare(
      `INSERT INTO files (repo_id, path, lang, content_sha256, last_run_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(repoId, path, lang, contentSha256, runId);
    return Number(r.lastInsertRowid);
  }

  getFile(repoId: number, path: string):
    { id: number; contentSha256: string } | undefined {
    const row = this.db.prepare(
      "SELECT id, content_sha256 FROM files WHERE repo_id = ? AND path = ?",
    ).get(repoId, path) as { id: number; content_sha256: string } | undefined;
    return row ? { id: row.id, contentSha256: row.content_sha256 } : undefined;
  }

  /** Files whose stored hash differs from `hashes`, plus files no longer present. */
  changedFiles(repoId: number, hashes: Map<string, string>): {
    changed: string[];
    deleted: string[];
  } {
    const rows = this.db.prepare(
      "SELECT path, content_sha256 FROM files WHERE repo_id = ?",
    ).all(repoId) as Array<{ path: string; content_sha256: string }>;

    const stored = new Map(rows.map((r) => [r.path, r.content_sha256]));
    const changed: string[] = [];
    for (const [path, hash] of hashes) {
      if (stored.get(path) !== hash) changed.push(path);
    }
    const deleted = rows.filter((r) => !hashes.has(r.path)).map((r) => r.path);
    return { changed, deleted };
  }

  // -- nodes ----------------------------------------------------------------

  /**
   * Insert a node or return the existing id.
   *
   * R4: for kind='symbol', `key` MUST be the verbatim SCIP symbol string.
   * Identity is (kind, key) and is global — never scoped by repo (R9).
   */
  upsertNode(kind: NodeKind, key: string, repoId: number | null): number {
    const existing = this.db.prepare(
      "SELECT id FROM nodes WHERE kind = ? AND key = ?",
    ).get(kind, key) as { id: number } | undefined;
    if (existing) return existing.id;

    const r = this.db.prepare(
      "INSERT INTO nodes (kind, key, repo_id) VALUES (?, ?, ?)",
    ).run(kind, key, repoId);
    return Number(r.lastInsertRowid);
  }

  findNode(kind: NodeKind, key: string): number | undefined {
    const row = this.db.prepare(
      "SELECT id FROM nodes WHERE kind = ? AND key = ?",
    ).get(kind, key) as { id: number } | undefined;
    return row?.id;
  }

  // -- symbols --------------------------------------------------------------

  upsertSymbol(s: SymbolInput): void {
    this.db.prepare(
      `INSERT INTO symbols
         (node_id, file_id, display_name, symbol_kind, signature, doc,
          start_line, end_line, enclosing_node_id, is_exported, is_test)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         file_id           = excluded.file_id,
         display_name      = excluded.display_name,
         symbol_kind       = excluded.symbol_kind,
         signature         = excluded.signature,
         doc               = excluded.doc,
         start_line        = excluded.start_line,
         end_line          = excluded.end_line,
         enclosing_node_id = excluded.enclosing_node_id,
         is_exported       = excluded.is_exported,
         is_test           = excluded.is_test`,
    ).run(
      s.nodeId, s.fileId, s.displayName, s.symbolKind ?? null, s.signature ?? null,
      s.doc ?? null, s.startLine ?? null, s.endLine ?? null, s.enclosingNodeId ?? null,
      s.isExported ? 1 : 0, s.isTest ? 1 : 0,
    );
  }

  // -- edges ----------------------------------------------------------------

  /**
   * Insert an edge, ignoring exact duplicates.
   *
   * Identity is enforced by ux_edges_identity, which COALESCEs the nullable
   * file_id and line so boot- and otel-sourced edges deduplicate correctly.
   */
  insertEdge(e: EdgeInput): void {
    this.db.prepare(
      `INSERT INTO edges
         (src_node_id, dst_node_id, type, confidence, evidence_kind,
          file_id, line, detail, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(
      e.srcNodeId, e.dstNodeId, e.type, e.confidence, e.evidenceKind,
      e.fileId ?? null, e.line ?? null, e.detail ?? null, e.runId,
    );
  }

  /**
   * Incremental update, R28: delete by PROVENANCE, never by node.
   *
   * Nodes survive, so edges *into* a changed file from unchanged files survive
   * too — they are owned by the source file's provenance, not the target's.
   */
  deleteEdgesByProvenance(fileId: number, evidenceKinds: EvidenceKind[]): number {
    if (evidenceKinds.length === 0) return 0;
    const placeholders = evidenceKinds.map(() => "?").join(", ");
    const r = this.db.prepare(
      `DELETE FROM edges WHERE file_id = ? AND evidence_kind IN (${placeholders})`,
    ).run(fileId, ...evidenceKinds);
    return Number(r.changes);
  }

  /** Delete only selected edge types owned by one file. */
  deleteEdgesByTypeAndProvenance(
    fileId: number, types: EdgeType[], evidenceKinds: EvidenceKind[],
  ): number {
    if (types.length === 0 || evidenceKinds.length === 0) return 0;
    const typeQ = types.map(() => "?").join(", ");
    const evidenceQ = evidenceKinds.map(() => "?").join(", ");
    const r = this.db.prepare(
      `DELETE FROM edges WHERE file_id = ? AND type IN (${typeQ})
       AND evidence_kind IN (${evidenceQ})`,
    ).run(fileId, ...types, ...evidenceKinds);
    return Number(r.changes);
  }

  // -- routes ---------------------------------------------------------------

  /**
   * Insert or replace the detail row for a `route` node.
   *
   * R24: boot facts are replaced wholesale per service per run. Merging would
   * let a *removed* hook survive, and the chain would then be wrong in the one
   * direction that matters for a security question.
   */
  upsertRoute(r: RouteInput): void {
    this.db.prepare(
      `INSERT INTO routes
         (node_id, repo_id, service_name, method, url, prefix, handler_node_id,
          request_schema, response_schema, has_schema, source, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         repo_id         = excluded.repo_id,
         service_name    = excluded.service_name,
         method          = excluded.method,
         url             = excluded.url,
         prefix          = excluded.prefix,
         handler_node_id = excluded.handler_node_id,
         request_schema  = excluded.request_schema,
         response_schema = excluded.response_schema,
         has_schema      = excluded.has_schema,
         source          = excluded.source,
         run_id          = excluded.run_id`,
    ).run(
      r.nodeId, r.repoId, r.serviceName, r.method.toUpperCase(), r.url,
      r.prefix ?? "", r.handlerNodeId ?? null, r.requestSchema ?? null,
      r.responseSchema ?? null, r.hasSchema ? 1 : 0, r.source, r.runId,
    );
  }

  /** Route node ids for one service, in a stable order. */
  routeNodeIds(serviceName: string): number[] {
    return (this.db.prepare(
      "SELECT node_id FROM routes WHERE service_name = ? ORDER BY url, method",
    ).all(serviceName) as Array<{ node_id: number }>).map((r) => r.node_id);
  }

  // -- route_chain ----------------------------------------------------------

  insertChainEntry(c: ChainInput): void {
    this.db.prepare(
      `INSERT INTO route_chain
         (route_node_id, position, phase, symbol_node_id, key, name, check_kind,
          origin, inherited_from, confidence, evidence_kind, file_id, line,
          end_line, detail, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route_node_id, phase, position) DO UPDATE SET
         symbol_node_id = excluded.symbol_node_id,
         key            = excluded.key,
         name           = excluded.name,
         check_kind     = excluded.check_kind,
         origin         = excluded.origin,
         inherited_from = excluded.inherited_from,
         confidence     = excluded.confidence,
         evidence_kind  = excluded.evidence_kind,
         file_id        = excluded.file_id,
         line           = excluded.line,
         end_line       = excluded.end_line,
         detail         = excluded.detail,
         run_id         = excluded.run_id`,
    ).run(
      c.routeNodeId, c.position, c.phase, c.symbolNodeId ?? null, c.key ?? null,
      c.name ?? null, c.checkKind ?? null, c.origin, c.inheritedFrom ?? null,
      c.confidence, c.evidenceKind, c.fileId ?? null, c.line ?? null,
      c.endLine ?? null, c.detail ?? null, c.runId,
    );
  }

  /**
   * Drop one channel's chain rows for a route (R24).
   *
   * Scoped by `evidence_kind` so re-running the boot dump cannot delete the
   * inline-auth rows P1-T10 derived, and vice versa. The two channels answer
   * the same question from different evidence; neither owns the other.
   */
  deleteChain(routeNodeId: number, evidenceKinds: EvidenceKind[]): number {
    if (evidenceKinds.length === 0) return 0;
    const q = evidenceKinds.map(() => "?").join(", ");
    const r = this.db.prepare(
      `DELETE FROM route_chain WHERE route_node_id = ? AND evidence_kind IN (${q})`,
    ).run(routeNodeId, ...evidenceKinds);
    return Number(r.changes);
  }

  // -- unresolved_calls -----------------------------------------------------

  /** R11. Stored, never dropped — see the note in 002_phase1_routes.sql. */
  insertUnresolved(u: UnresolvedInput): void {
    this.db.prepare(
      `INSERT INTO unresolved_calls
         (src_node_id, kind, target_hint, reason, file_id, line, col, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(
      u.srcNodeId, u.kind, u.targetHint ?? null, u.reason,
      u.fileId ?? null, u.line ?? null, u.col ?? null, u.runId,
    );
  }

  deleteUnresolvedByProvenance(fileId: number): number {
    const r = this.db.prepare("DELETE FROM unresolved_calls WHERE file_id = ?").run(fileId);
    return Number(r.changes);
  }

  /** Delete one unresolved channel without touching call/datastore gaps. */
  deleteUnresolvedByProvenanceAndKind(fileId: number, kind: UnresolvedKind): number {
    const r = this.db.prepare(
      "DELETE FROM unresolved_calls WHERE file_id = ? AND kind = ?",
    ).run(fileId, kind);
    return Number(r.changes);
  }

  /**
   * Chain rows a file's evidence produced (R28).
   *
   * Scoped by `evidence_kind` for the same reason `deleteChain` is: an
   * inline-auth row inferred from a handler body and a boot row reported by
   * the framework are different claims about the same route, and re-indexing
   * one channel must not silently erase the other's finding.
   */
  deleteChainByProvenance(fileId: number, evidenceKinds: EvidenceKind[]): number {
    if (evidenceKinds.length === 0) return 0;
    const q = evidenceKinds.map(() => "?").join(", ");
    const r = this.db.prepare(
      `DELETE FROM route_chain WHERE file_id = ? AND evidence_kind IN (${q})`,
    ).run(fileId, ...evidenceKinds);
    return Number(r.changes);
  }

  // -- function_cfg (P1-T17, P1-T18) ----------------------------------------

  /** Replace one function's CFG. R24's discipline: wholesale, never merged. */
  replaceCfg(symbolNodeId: number, blocks: CfgBlockInput[]): void {
    this.db.prepare("DELETE FROM function_cfg WHERE symbol_node_id = ?").run(symbolNodeId);
    const insert = this.db.prepare(
      `INSERT INTO function_cfg
         (symbol_node_id, block_index, parent_index, kind, condition_text,
          outcome, exit_form, error_name, start_line, end_line, file_id, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of blocks) {
      insert.run(
        b.symbolNodeId, b.blockIndex, b.parentIndex, b.kind, b.conditionText ?? null,
        b.outcome ?? null, b.exitForm ?? null, b.errorName ?? null,
        b.startLine, b.endLine, b.fileId, b.runId,
      );
    }
  }

  deleteCfgByProvenance(fileId: number): number {
    const r = this.db.prepare("DELETE FROM function_cfg WHERE file_id = ?").run(fileId);
    return Number(r.changes);
  }

  /**
   * R77: attribute an edge's call site to its enclosing CFG block.
   *
   * Matched on (src, file, line) rather than an edge id, because the CFG is
   * built after the edges and the caller does not hold their ids. Only edges
   * the static channel placed at a line inside a parsed function get a value;
   * boot and otel edges keep NULL, which is correct rather than missing.
   */
  attributeEdgeToBlock(
    srcNodeId: number, fileId: number, line: number, blockIndex: number,
  ): number {
    const r = this.db.prepare(
      `UPDATE edges SET cfg_block_index = ?
        WHERE src_node_id = ? AND file_id = ? AND line = ?`,
    ).run(blockIndex, srcNodeId, fileId, line);
    return Number(r.changes);
  }

  // -- introspection --------------------------------------------------------

  countRows(table: string): number {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table name: ${table}`);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  edgeTypeCounts(): Array<{ type: string; confidence: string; n: number }> {
    return this.db.prepare(
      `SELECT type, confidence, COUNT(*) AS n FROM edges
       GROUP BY type, confidence ORDER BY n DESC`,
    ).all() as Array<{ type: string; confidence: string; n: number }>;
  }

  /** Cross-file CALLS edge count. Zero here means the graph is intra-file only. */
  crossFileCallCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n
         FROM edges e
         JOIN symbols s_src ON s_src.node_id = e.src_node_id
         JOIN symbols s_dst ON s_dst.node_id = e.dst_node_id
        WHERE e.type = 'CALLS'
          AND s_src.file_id IS NOT NULL
          AND s_dst.file_id IS NOT NULL
          AND s_src.file_id <> s_dst.file_id`,
    ).get() as { n: number };
    return row.n;
  }

  verifyIntegrity(): IntegrityReport {
    const fk = this.db.prepare("PRAGMA foreign_key_check").all();
    const integrity = this.db.prepare("PRAGMA integrity_check").get() as
      { integrity_check: string };
    const tables = this.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view')",
    ).get() as { n: number };
    const indexes = this.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'",
    ).get() as { n: number };

    return {
      ok: fk.length === 0 && integrity.integrity_check === "ok",
      foreignKeyViolations: fk.length,
      integrityCheck: integrity.integrity_check,
      tables: tables.n,
      indexes: indexes.n,
    };
  }

  /** Escape hatch for read-only queries during Phase 0 bring-up. */
  raw(): DatabaseSync {
    return this.db;
  }
}
