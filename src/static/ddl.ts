// ============================================================================
// SQL DDL extractor  —  slice CTX-S9  (goal G8; requirements R11, R19, R72)
// ============================================================================
// Tables and columns, read from the `.sql` migrations in a repo's declared
// file set. Before this, `41-kri-engine/migrations/001_init.sql` was inside
// `include` and never read: every extractor handled JS/TS/Python only, so a
// table existed only where a SQL string literal happened to name it, and no
// column existed anywhere (plan §2.6).
//
// Two statements are modelled, and only two:
//
//   CREATE TABLE [IF NOT EXISTS] name ( column, …, table-constraint, … )
//   ALTER TABLE name ADD [COLUMN] column [, …]
//
// Everything else falls into one of two buckets, and the difference matters:
//
//   skipped   cannot add, remove, rename or retype a column (CREATE INDEX,
//             CREATE EXTENSION, GRANT, a function body, DML, …). Counted,
//             so the reader sees how much was passed over.
//   gap       might change the table/column set and is not modelled
//             (CREATE TABLE … AS, DROP TABLE, ALTER … DROP COLUMN,
//             CREATE VIEW, a DO block, anything unrecognised). Returned with
//             file:line and stored by the ingest (R11) — an unknown, never a
//             silent omission.
//
// **Deliberately shallow, like `readSql`.** This is not a SQL parser: it
// splits statements (respecting quotes, comments and dollar quotes), then
// reads the head of each with a regex and the column list by top-level
// commas. tree-sitter-wasms ships no SQL grammar, and a real Postgres parser
// is a dependency for two statement shapes. Dialect is Postgres, the corpus's.
//
// Table names are unquoted and lower-cased exactly as `readSql` does for a
// literal, so the key `datastoreKey` composes from either one is the same
// string and the migration's `users` is the literal's `users` — one node.
// ============================================================================

export interface DdlTable {
  /** Unquoted, lower-cased; `schema.table` kept qualified, as `readSql` does. */
  name: string;
  /** 1-based line of the CREATE TABLE. */
  line: number;
}

export interface DdlColumn {
  table: string;
  /** Unquoted, lower-cased — the same rule as the table name. */
  name: string;
  /** Declared type, verbatim with whitespace collapsed. Null when none is declared. */
  dataType: string | null;
  /** 1-based ordinal among the column definitions of the declaring statement. */
  position: number;
  notNull: boolean;
  /** Column-level PRIMARY KEY, or named by a table-level PRIMARY KEY (…). */
  primaryKey: boolean;
  statement: "create_table" | "alter_add";
  /** Line of the statement that declared the column. */
  statementLine: number;
  /** Line of the column definition itself. */
  line: number;
}

export interface DdlGap {
  /** The table the statement creates or alters; null when it names none (file-level). */
  table: string | null;
  line: number;
  /** The statement (or the element of it) that was not modelled, on one line. */
  statement: string;
  reason: string;
}

export interface DdlFindings {
  path: string;
  tables: DdlTable[];
  columns: DdlColumn[];
  gaps: DdlGap[];
  /** Statements that cannot change a column, passed over on purpose. */
  skipped: number;
}

/** A `.sql` file is read by this extractor, and by nothing else. */
export function isDdlFile(path: string): boolean {
  return path.toLowerCase().endsWith(".sql");
}

// ---------------------------------------------------------------------------
// Statement vocabulary
// ---------------------------------------------------------------------------

const CREATE_TABLE =
  /^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i;

const ALTER_TABLE = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/i;

/** Table-level constraints inside CREATE TABLE ( … ). Not columns. */
const TABLE_CONSTRAINT = /^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b/i;

/** The keyword that ends a column's declared type. */
const COLUMN_CONSTRAINT =
  /\b(?:CONSTRAINT|NOT|NULL|PRIMARY|UNIQUE|REFERENCES|DEFAULT|CHECK|GENERATED|COLLATE)\b/i;

/**
 * Statements that cannot add, remove, rename or retype a table column.
 *
 * A list of what is safe to pass over, not of what is understood: a statement
 * absent from it becomes a gap. `DROP TYPE` and `DROP EXTENSION` are absent on
 * purpose — with CASCADE they drop the columns that use them.
 */
const SKIPPED = new RegExp("^(?:" + [
  "CREATE\\s+(?:UNIQUE\\s+)?INDEX", "CREATE\\s+EXTENSION", "CREATE\\s+SCHEMA",
  "CREATE\\s+SEQUENCE", "ALTER\\s+SEQUENCE", "CREATE\\s+TYPE",
  "CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE|TRIGGER)",
  "DROP\\s+(?:INDEX|TRIGGER|FUNCTION|PROCEDURE)",
  "COMMENT\\s+ON", "GRANT", "REVOKE",
  "BEGIN", "COMMIT", "END", "ROLLBACK", "START\\s+TRANSACTION", "SET", "RESET",
  "SELECT", "INSERT", "UPDATE", "DELETE", "ANALYZE", "VACUUM",
].join("|") + ")\\b", "i");

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Read one `.sql` file. Pure: text in, findings out; the ingest writes rows. */
export function extractDdl(path: string, text: string): DdlFindings {
  const out: DdlFindings = { path, tables: [], columns: [], gaps: [], skipped: 0 };
  const { masked, statements } = scanStatements(text);
  const lineAt = lineIndex(text);

  for (const [from, to] of statements) {
    const raw = masked.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const stmt = raw.trim();
    if (stmt === "") continue;
    readStatement(stmt, from + lead, lineAt, out);
  }
  return out;
}

function readStatement(
  s: string, base: number, lineAt: (offset: number) => number, out: DdlFindings,
): void {
  const line = lineAt(base);
  const gap = (table: string | null, reason: string, statement = oneLine(s)) =>
    out.gaps.push({ table, line, statement, reason });

  const create = CREATE_TABLE.exec(s);
  if (create) {
    const name = readQualifiedIdent(s, create[0].length);
    if (!name) return void gap(null, "CREATE TABLE whose table name was not understood");
    if (create[1] && /^TEMP/i.test(create[1])) {
      return void gap(null, "temporary table: it exists only in the session that creates it");
    }
    const open = skipSpace(s, name.end);
    if (s[open] !== "(") {
      const next = /^\w+(?:\s+OF)?/i.exec(s.slice(open))?.[0].toUpperCase() ?? "";
      return void gap(name.name, next === "AS"
        ? "CREATE TABLE … AS: the columns come from a query, not a declared column list"
        : next.endsWith("OF")
          ? `CREATE TABLE … ${next}: the columns come from another table or type`
          : "no column list after the table name");
    }
    const close = matchParen(s, open);
    if (close < 0) return void gap(name.name, "unbalanced parentheses in the column list");
    const rest = s.slice(close + 1).trim();
    if (/^AS\b/i.test(rest)) {
      return void gap(name.name,
        "CREATE TABLE … AS: the columns come from a query, not a declared column list");
    }
    readCreateBody(s, open + 1, close, name.name, base, lineAt, out);
    if (/\bINHERITS\b/i.test(rest)) {
      gap(name.name, "INHERITS: the parent table's columns are not listed here");
    }
    return;
  }

  const alter = ALTER_TABLE.exec(s);
  if (alter) {
    const name = readQualifiedIdent(s, alter[0].length);
    if (!name) return void gap(null, "ALTER TABLE whose table name was not understood");
    readAlterActions(s, name.end, name.name, line, base, lineAt, out);
    return;
  }

  if (SKIPPED.test(s)) { out.skipped += 1; return; }

  if (/^DROP\s+TABLE\b/i.test(s)) {
    return void gap(null, "DROP TABLE is not modelled: columns stored for the table may outlive it");
  }
  gap(null, "not table/column DDL the extractor models; its effect on tables is unknown");
}

function readCreateBody(
  s: string, from: number, to: number, table: string, base: number,
  lineAt: (offset: number) => number, out: DdlFindings,
): void {
  const statementLine = lineAt(base);
  const primary = new Set<string>();
  const columns: DdlColumn[] = [];
  let position = 0;

  for (const [a, b] of splitTopLevel(s, from, to)) {
    const raw = s.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const element = raw.trim();
    if (element === "") continue;
    const line = lineAt(base + a + lead);

    if (TABLE_CONSTRAINT.test(element)) {
      // Not a column. A table-level PRIMARY KEY still names its columns.
      const pk = /\bPRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(element);
      for (const c of pk?.[1]?.split(",") ?? []) primary.add(unquote(c.trim()));
      continue;
    }
    if (/^LIKE\b/i.test(element)) {
      out.gaps.push({
        table, line, statement: `CREATE TABLE ${table} (… ${oneLine(element)} …)`,
        reason: "LIKE copies another table's columns; they are not listed here",
      });
      continue;
    }

    position += 1;
    const col = readColumn(element);
    if (!col) {
      out.gaps.push({
        table, line, statement: `CREATE TABLE ${table} (… ${oneLine(element)} …)`,
        reason: "column definition not understood",
      });
      continue;
    }
    columns.push({ table, ...col, position, statement: "create_table", statementLine, line });
  }

  if (columns.length === 0) {
    out.gaps.push({
      table, line: statementLine, statement: oneLine(s),
      reason: "CREATE TABLE with no column definition the extractor could read",
    });
    return;
  }
  for (const c of columns) if (primary.has(c.name)) c.primaryKey = true;
  out.tables.push({ name: table, line: statementLine });
  out.columns.push(...columns);
}

function readAlterActions(
  s: string, from: number, table: string, statementLine: number, base: number,
  lineAt: (offset: number) => number, out: DdlFindings,
): void {
  let position = 0;
  for (const [a, b] of splitTopLevel(s, from, s.length)) {
    const raw = s.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const action = raw.trim();
    if (action === "") continue;
    const line = lineAt(base + a + lead);
    const statement = `ALTER TABLE ${table} ${oneLine(action)}`;

    const add = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(action);
    if (add && /^ADD\s+(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b/i.test(action)) {
      continue;   // a constraint, not a column
    }
    if (add) {
      position += 1;
      const col = readColumn(action.slice(add[0].length));
      if (col) {
        out.columns.push({ table, ...col, position, statement: "alter_add", statementLine, line });
      } else {
        out.gaps.push({ table, line, statement, reason: "added column definition not understood" });
      }
      continue;
    }
    const head = action.split(/\s+/).slice(0, 2).join(" ").toUpperCase();
    out.gaps.push({
      table, line, statement,
      reason: `ALTER TABLE ${head} is not modelled; the stored columns may be stale`,
    });
  }
}

/** `name type [constraints…]`, or null when the element does not start with a name. */
function readColumn(element: string):
  { name: string; dataType: string | null; notNull: boolean; primaryKey: boolean } | null {
  const ident = readIdent(element, 0);
  if (!ident) return null;
  const rest = element.slice(ident.end);
  // Parenthesised groups and strings blanked, offsets kept: `CHECK (x IS NOT
  // NULL)` and `DEFAULT 'NOT NULL'` must not read as a NOT NULL constraint.
  const flat = maskGroups(rest);
  const stop = COLUMN_CONSTRAINT.exec(flat);
  const type = oneLine(rest.slice(0, stop ? stop.index : rest.length));
  return {
    name: ident.name,
    dataType: type === "" ? null : type,
    notNull: /\bNOT\s+NULL\b/i.test(flat),
    primaryKey: /\bPRIMARY\s+KEY\b/i.test(flat),
  };
}

// ---------------------------------------------------------------------------
// Lexing helpers
// ---------------------------------------------------------------------------

/**
 * Split on top-level `;`, and blank out comments.
 *
 * `masked` is `text` with every comment replaced by spaces (newlines kept), so
 * offsets into it are offsets into the file and line numbers stay exact.
 * Quotes, quoted identifiers and `$tag$` bodies are passed over whole: a `;`
 * inside a function body or a string does not end a statement.
 */
function scanStatements(text: string): { masked: string; statements: Array<[number, number]> } {
  const chars = text.split("");
  const statements: Array<[number, number]> = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
  };
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      let depth = 1;
      let k = i + 2;
      while (k < text.length && depth > 0) {
        if (text[k] === "/" && text[k + 1] === "*") { depth += 1; k += 2; }
        else if (text[k] === "*" && text[k + 1] === "/") { depth -= 1; k += 2; }
        else k += 1;
      }
      blank(i, k);
      i = k;
    } else if (c === "'" || c === '"' || c === "`") {
      i = skipQuoted(text, i);
    } else if (c === "$" && !/[\w$]/.test(text[i - 1] ?? "")) {
      const tag = /^\$[A-Za-z_]?\w*\$/.exec(text.slice(i, i + 64))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end < 0 ? text.length : end + tag.length;
      } else {
        i += 1;
      }
    } else if (c === ";") {
      statements.push([start, i]);
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (start < text.length) statements.push([start, text.length]);
  return { masked: chars.join(""), statements };
}

/** Index just past a quoted run starting at `i`; a doubled quote is an escape. */
function skipQuoted(s: string, i: number): number {
  const q = s[i]!;
  let k = i + 1;
  while (k < s.length) {
    if (s[k] === q) {
      if (s[k + 1] === q) { k += 2; continue; }
      return k + 1;
    }
    k += 1;
  }
  return s.length;
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k += 1) {
    const c = s[k]!;
    if (c === "'" || c === '"') { k = skipQuoted(s, k) - 1; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") { depth -= 1; if (depth === 0) return k; }
  }
  return -1;
}

/** `[from, to)` split on commas outside parentheses and quotes. */
function splitTopLevel(s: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k += 1) {
    const c = s[k]!;
    if (c === "'" || c === '"') { k = skipQuoted(s, k) - 1; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) { out.push([start, k]); start = k + 1; }
  }
  out.push([start, to]);
  return out;
}

/** Blank the inside of parentheses and quotes, keeping every offset. */
function maskGroups(s: string): string {
  const chars = s.split("");
  let depth = 0;
  for (let k = 0; k < s.length; k += 1) {
    const c = s[k]!;
    if (c === "'" || c === '"') {
      const end = skipQuoted(s, k);
      for (let j = k; j < end; j += 1) chars[j] = " ";
      k = end - 1;
    } else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth > 0) chars[k] = " ";
  }
  return chars.join("");
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i += 1;
  return i;
}

/** One identifier at `i` (after whitespace): quoted, bracketed or bare. */
function readIdent(s: string, i: number): { name: string; end: number } | null {
  const at = skipSpace(s, i);
  const c = s[at];
  if (c === '"' || c === "`") {
    const end = skipQuoted(s, at);
    const inner = s.slice(at + 1, end - 1).split(c + c).join(c);
    return inner === "" ? null : { name: inner.toLowerCase(), end };
  }
  if (c === "[") {
    const end = s.indexOf("]", at);
    return end < 0 ? null : { name: s.slice(at + 1, end).toLowerCase(), end: end + 1 };
  }
  const m = /^[A-Za-z_][\w$]*/.exec(s.slice(at));
  return m ? { name: m[0].toLowerCase(), end: at + m[0].length } : null;
}

/** `schema.table` or `table`, each part unquoted and lower-cased. */
function readQualifiedIdent(s: string, i: number): { name: string; end: number } | null {
  const first = readIdent(s, i);
  if (!first) return null;
  const parts = [first.name];
  let end = first.end;
  while (s[skipSpace(s, end)] === ".") {
    const next = readIdent(s, skipSpace(s, end) + 1);
    if (!next) break;
    parts.push(next.name);
    end = next.end;
  }
  return { name: parts.join("."), end };
}

function unquote(name: string): string {
  return (readIdent(name, 0)?.name ?? name).toLowerCase();
}

/** Offset -> 1-based line, by binary search over line starts. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let k = 0; k < text.length; k += 1) if (text[k] === "\n") starts.push(k + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
