// ============================================================================
// DDL findings -> graph rows  —  slice CTX-S9  (goal G8; requirements R11, R12, R28)
// ============================================================================
// The only producer of `datastore_columns` (migration 011), and of the
// `unresolved_calls` rows with kind = 'datastore'.
//
// **The table node is the SQL-literal extractor's node.** It is composed by
// `ref.datastore` with the same engine the literal extractor hard-codes
// (`postgres`), through the same GraphWriter, so a migration's `users` and a
// `SELECT … FROM users` in server.js land on one `datastore` node. Composing a
// second key shape here would give every table two nodes and make OPEN-9's
// coupling — two services, one table — a join that never matches.
//
// **Gaps are rows.** A statement the extractor could not model is stored with
// its file:line (R11). It hangs off the table node when the statement names
// the table it creates or alters (the table exists; its columns are what is
// unknown), and off the migration's file node otherwise — a DROP TABLE must
// not create a node for a table that no longer exists.
//
// Every row carries the migration's `files.id`, so the pipeline's purge by
// provenance removes exactly what this file claimed (R28).
// ============================================================================

import type { FactStore } from "../store/db.ts";
import type { GraphWriter } from "../normalize/graph.ts";
import { ref } from "../normalize/keys.ts";
import type { DdlFindings } from "./ddl.ts";

/** The literal extractor's engine (extract.ts), so both resolve to one key. */
const ENGINE = "postgres";

export interface DdlIngestContext {
  writer: GraphWriter;
  store: FactStore;
  repoName: string;
  /** `files.id` of the migration — the provenance key for R28. */
  fileId: number;
  runId: number;
}

export interface DdlCounts {
  tables: number;
  /** Declared by CREATE TABLE. */
  columns: number;
  /** Added by ALTER TABLE … ADD COLUMN. */
  added: number;
  gaps: number;
  skipped: number;
}

/** Write one migration's findings. Counts are returned, not logged. */
export function ingestDdl(ctx: DdlIngestContext, f: DdlFindings): DdlCounts {
  const counts: DdlCounts = {
    tables: f.tables.length, columns: 0, added: 0, gaps: 0, skipped: f.skipped,
  };
  // A declared table gets its node even when no literal ever names it.
  const table = (name: string) => ctx.writer.node(ref.datastore({ engine: ENGINE, table: name }));

  for (const c of f.columns) {
    ctx.store.insertDatastoreColumn({
      datastoreNodeId: table(c.table), name: c.name, dataType: c.dataType,
      position: c.position, notNull: c.notNull, primaryKey: c.primaryKey,
      statement: c.statement, statementLine: c.statementLine,
      fileId: ctx.fileId, line: c.line, runId: ctx.runId,
    });
    if (c.statement === "alter_add") counts.added += 1; else counts.columns += 1;
  }

  for (const g of f.gaps) {
    ctx.store.insertUnresolved({
      srcNodeId: g.table ? table(g.table) : ctx.writer.node(ref.file(ctx.repoName, f.path)),
      kind: "datastore", targetHint: g.statement, reason: g.reason,
      fileId: ctx.fileId, line: g.line, runId: ctx.runId,
    });
    counts.gaps += 1;
  }

  return counts;
}
