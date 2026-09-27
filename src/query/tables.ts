// ============================================================================
// Tables and their columns  —  slice CTX-S9  (goal G8)
// ============================================================================
// The read path for `node src/cli.ts tables`: every datastore node, with the
// columns its migrations declare, where they were declared, how many SQL
// literals read or write it, and the gaps the DDL extractor stored.
//
// Kept thin on purpose. Columns on an endpoint's path are CTX-S10b; this is
// the listing that lets the owner check the extractor against the file.
//
// Three kinds of table appear, and the output never blurs them:
//
//   declared      a migration's CREATE TABLE listed its columns
//   gap only      a statement created or altered it and could not be modelled
//   literal only  a SQL string names it, and no indexed migration declares it
//
// A datastore node with none of the three (an orphan left by R28, which never
// deletes nodes) is not listed: it would read as a table the code uses.
// ============================================================================

import type { FactStore } from "../store/db.ts";

/** Stated in every answer, not hidden (plan v2 OPEN-9, CTX-S9 known limit). */
export const OPEN9_LIMIT =
  "LIMIT (OPEN-9): table keys carry no database identity (postgres://?/<table>, " +
  "engine assumed postgres), so same-named tables in different databases share one " +
  "node and look coupled. Each column names the migration that declared it.";

export interface TableColumnView {
  position: number;
  name: string;
  dataType: string | null;
  notNull: boolean;
  primaryKey: boolean;
  statement: "create_table" | "alter_add";
  repo: string;
  file: string;
  statementLine: number;
  line: number;
}

export interface TableGapView {
  repo: string | null;
  file: string | null;
  line: number | null;
  statement: string | null;
  reason: string;
}

export interface TableView {
  key: string;
  /** In migration order: repo, file, statement line, then position. */
  columns: TableColumnView[];
  createColumns: number;
  addedColumns: number;
  /** Where a CREATE TABLE declared it. More than one is OPEN-9 made visible. */
  declaredIn: Array<{ repo: string; file: string; line: number }>;
  reads: number;
  writes: number;
  gaps: TableGapView[];
}

export interface TablesReport {
  tables: TableView[];
  /** DDL gaps that name no table (DROP TABLE, CREATE VIEW, a DO block, …). */
  fileGaps: TableGapView[];
  limit: string;
}

export function listTables(store: FactStore): TablesReport {
  const db = store.raw();
  const nodes = db.prepare(
    "SELECT id, key FROM nodes WHERE kind = 'datastore' ORDER BY key",
  ).all() as Array<{ id: number; key: string }>;

  const columns = new Map<number, TableColumnView[]>();
  for (const r of db.prepare(
    `SELECT c.datastore_node_id AS node, c.position, c.name, c.data_type, c.not_null,
            c.primary_key, c.statement, c.statement_line, c.line, f.path, rp.name AS repo
       FROM datastore_columns c
       JOIN files f  ON f.id = c.file_id
       JOIN repos rp ON rp.id = f.repo_id
      ORDER BY rp.name, f.path, c.statement_line, c.position`,
  ).all() as Array<Record<string, string | number | null>>) {
    const list = columns.get(Number(r["node"])) ?? [];
    list.push({
      position: Number(r["position"]), name: String(r["name"]),
      dataType: (r["data_type"] as string | null) ?? null,
      notNull: r["not_null"] === 1, primaryKey: r["primary_key"] === 1,
      statement: r["statement"] as TableColumnView["statement"],
      repo: String(r["repo"]), file: String(r["path"]),
      statementLine: Number(r["statement_line"]), line: Number(r["line"]),
    });
    columns.set(Number(r["node"]), list);
  }

  const uses = new Map<number, { reads: number; writes: number }>();
  for (const r of db.prepare(
    `SELECT dst_node_id AS node, type, COUNT(*) AS n FROM edges
      WHERE type IN ('READS', 'WRITES') GROUP BY dst_node_id, type`,
  ).all() as Array<{ node: number; type: string; n: number }>) {
    const u = uses.get(r.node) ?? { reads: 0, writes: 0 };
    if (r.type === "READS") u.reads = r.n; else u.writes = r.n;
    uses.set(r.node, u);
  }

  const gaps = new Map<number, TableGapView[]>();
  const fileGaps: TableGapView[] = [];
  for (const r of db.prepare(
    `SELECT u.src_node_id AS node, n.kind, u.target_hint, u.reason, u.line,
            f.path, rp.name AS repo
       FROM unresolved_calls u
       JOIN nodes n ON n.id = u.src_node_id
       LEFT JOIN files f  ON f.id = u.file_id
       LEFT JOIN repos rp ON rp.id = f.repo_id
      WHERE u.kind = 'datastore'
      ORDER BY rp.name, f.path, u.line`,
  ).all() as Array<Record<string, string | number | null>>) {
    const gap: TableGapView = {
      repo: (r["repo"] as string | null) ?? null, file: (r["path"] as string | null) ?? null,
      line: r["line"] === null ? null : Number(r["line"]),
      statement: (r["target_hint"] as string | null) ?? null, reason: String(r["reason"]),
    };
    if (r["kind"] !== "datastore") { fileGaps.push(gap); continue; }
    const list = gaps.get(Number(r["node"])) ?? [];
    list.push(gap);
    gaps.set(Number(r["node"]), list);
  }

  const tables: TableView[] = [];
  for (const n of nodes) {
    const cols = columns.get(n.id) ?? [];
    const use = uses.get(n.id) ?? { reads: 0, writes: 0 };
    const g = gaps.get(n.id) ?? [];
    if (cols.length === 0 && g.length === 0 && use.reads + use.writes === 0) continue;

    const declared = new Map<string, { repo: string; file: string; line: number }>();
    for (const c of cols) {
      if (c.statement !== "create_table") continue;
      declared.set(`${c.repo} ${c.file} ${c.statementLine}`,
        { repo: c.repo, file: c.file, line: c.statementLine });
    }
    tables.push({
      key: n.key, columns: cols,
      createColumns: cols.filter((c) => c.statement === "create_table").length,
      addedColumns: cols.filter((c) => c.statement === "alter_add").length,
      declaredIn: [...declared.values()],
      reads: use.reads, writes: use.writes, gaps: g,
    });
  }

  return { tables, fileGaps, limit: OPEN9_LIMIT };
}

export function renderTables(report: TablesReport): string {
  const out: string[] = [];
  const declared = report.tables.filter((t) => t.columns.length > 0);
  const literalOnly = report.tables.filter((t) => t.columns.length === 0 && t.gaps.length === 0);
  const gapCount = report.fileGaps.length + report.tables.reduce((n, t) => n + t.gaps.length, 0);
  const sum = (pick: (t: TableView) => number) => declared.reduce((n, t) => n + pick(t), 0);

  out.push(
    `TABLES  ${declared.length} declared by a migration ` +
    `(${sum((t) => t.createColumns)} columns, +${sum((t) => t.addedColumns)} added by ALTER TABLE)` +
    ` · ${literalOnly.length} named only by SQL literals · ${gapCount} gap(s)`,
  );
  if (report.tables.length === 0) {
    out.push("", "  no tables in the store. Run: node src/cli.ts index");
  }

  for (const t of report.tables) {
    out.push("");
    const use = `code: ${t.reads} read(s), ${t.writes} write(s)`;
    if (t.columns.length === 0) {
      out.push(`${t.key}   ${t.gaps.length > 0 ? "columns unknown" :
        "no CREATE TABLE in any indexed migration"}   ${use}`);
    } else {
      const split = t.addedColumns > 0
        ? ` (${t.createColumns} CREATE TABLE + ${t.addedColumns} ALTER TABLE)` : "";
      out.push(`${t.key}   ${t.columns.length} columns${split}   ${use}`);
    }

    const nameW = Math.max(0, ...t.columns.map((c) => c.name.length));
    const typeW = Math.max(0, ...t.columns.map((c) => (c.dataType ?? "?").length));
    let block = "";
    for (const c of t.columns) {
      const at = `${c.repo}/${c.file}:${c.statementLine}`;
      if (`${at} ${c.statement}` !== block) {
        block = `${at} ${c.statement}`;
        out.push(`  ${at}  ${c.statement === "create_table" ? "CREATE TABLE" : "ALTER TABLE … ADD COLUMN"}`);
      }
      const flags = [c.primaryKey ? "PK" : "", c.notNull ? "NOT NULL" : ""].filter(Boolean).join(" ");
      out.push(
        `    ${String(c.position).padStart(3)}  ${c.name.padEnd(nameW)}  ` +
        `${(c.dataType ?? "?").padEnd(typeW)}  ${flags}`.trimEnd(),
      );
    }
    for (const g of t.gaps) out.push(...renderGap(g));
  }

  if (report.fileGaps.length > 0) {
    out.push("", "GAPS NOT TIED TO A TABLE");
    for (const g of report.fileGaps) out.push(...renderGap(g));
  }

  out.push("", report.limit);
  return out.join("\n") + "\n";
}

function renderGap(g: TableGapView): string[] {
  const at = g.file ? `${g.repo ? `${g.repo}/` : ""}${g.file}:${g.line ?? "?"}` : "(no file)";
  return [`  GAP ${at}  ${g.statement ?? ""}`.trimEnd(), `        ${g.reason}`];
}
