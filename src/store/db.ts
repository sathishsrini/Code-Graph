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
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "v0-phase0";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, "schema-v0.sql");

export type NodeKind =
  | "service" | "route" | "symbol" | "file" | "external" | "datastore" | "config";

export type EdgeType =
  | "CONTAINS" | "CALLS" | "HANDLES" | "REQUESTS" | "READS" | "WRITES"
  | "CALLS_EXTERNAL" | "THROWS" | "READS_CONFIG";

export type Confidence = "certain" | "inferred" | "observed" | "unresolved";

export type EvidenceKind = "scip" | "treesitter" | "semgrep" | "boot" | "otel" | "manual";

export type Channel = "static" | "boot" | "runtime";

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

  constructor(dbPath: string) {
    this.path = resolve(dbPath);
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.path);
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
    this.db.prepare(
      "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
    ).run(SCHEMA_VERSION);
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
