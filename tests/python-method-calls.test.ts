// Calls made inside Python class methods — a regression guard ported from
// CodeGraph eaeda2a ("fix(python): keep calls made inside class methods").
//
// There, every call made inside a Python class method vanished: the extractor
// recorded the caller as "Class.method", nodes were keyed by the bare method
// name, the lookup missed, and the call was dropped with no edge and no gap.
// The fix also had to resolve `self.x()` by hand and keep two classes that
// share a method name apart.
//
// code-intel does not have that bug, and this file keeps it that way. Node
// identity is the verbatim SCIP symbol (R4), which already carries the class
// (`OrderService#place_order().`); scip-python resolves `self.audit` to
// `OrderService#audit().` at index time; and deriveCalls attributes a call to
// the innermost enclosing body, which is the method, not its class.
//
// It runs the real path end to end: SCIP bytes on disk -> indexRepo ->
// ScipProtobufReader -> deriveCalls (with the on-disk call-site check) ->
// GraphWriter -> the store, plus the tree-sitter pass that turns `raise` into
// THROWS owned through SCIP definition ranges.
//
// The occurrences below are a transcript of a real `scip-python@0.6.6` run
// over SOURCES: symbols, roles and ranges exactly as emitted, including its
// quirks (import-statement names are ReadAccess, not Import; a module
// definition has no enclosing range). Regenerate with:
//
//   scip-python index --cwd <dir> --project-name pymethods \
//     --project-version 0.0.0 --environment <file containing []> --output <out>
//
// On Windows pass those paths with backslashes: the same run with
// forward-slash paths wrote a header-only index, the symptom recorded in M8.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { FactStore } from "../src/store/db.ts";
import { indexRepo } from "../src/index/pipeline.ts";
import type { RepoConfig } from "../src/config/repos.ts";
import type { ScipRange } from "../src/static/scip/reader.ts";
import { ROLE_DEFINITION, ROLE_READ_ACCESS } from "../src/static/scip/reader.ts";

// ---------------------------------------------------------------------------
// Fixture: OrderService from the original report, plus two classes that share
// a method name.
// ---------------------------------------------------------------------------

const ORDER_SERVICE_PY = "app/services/order_service.py";
const PAYMENTS_PY = "app/clients/payments.py";
const RW_PY = "app/rw.py";

const SOURCES: Record<string, string[]> = {
  [ORDER_SERVICE_PY]: [
    "from app.clients.payments import charge_card",   // 0
    "",
    "",
    "class PaymentDeclined(Exception):",              // 3
    "    pass",
    "",
    "",
    "class OrderService:",                            // 7
    "    def place_order(self, total):",              // 8
    "        self.audit(total)",                      // 9
    "        result = charge_card(total)",            // 10
    "        if not result:",                         // 11
    "            raise PaymentDeclined(\"declined\")",  // 12
    "",
    "    def audit(self, total):",                    // 14
    "        return total",                           // 15
  ],
  [PAYMENTS_PY]: [
    "def charge_card(total):",
    "    return total > 0",
  ],
  [RW_PY]: [
    "class Reader:",                                  // 0
    "    def load(self):",                            // 1
    "        return self.parse()",                    // 2
    "",
    "    def parse(self):",                           // 4
    "        return 1",
    "",
    "",
    "class Writer:",                                  // 8
    "    def load(self):",                            // 9
    "        return self.flush()",                    // 10
    "",
    "    def flush(self):",                           // 12
    "        return 2",
  ],
};

const REPO = "pymethods";
const PKG = `scip-python python ${REPO} 0.0.0 `;
const ORDERS = PKG + "`app.services.order_service`/";
const PAYMENTS = PKG + "`app.clients.payments`/";
const RW = PKG + "`app.rw`/";

const PAYMENT_DECLINED = ORDERS + "PaymentDeclined#";
const ORDER_SERVICE = ORDERS + "OrderService#";
const PLACE_ORDER = ORDERS + "OrderService#place_order().";
const AUDIT = ORDERS + "OrderService#audit().";
const CHARGE_CARD = PAYMENTS + "charge_card().";
const READER = RW + "Reader#";
const READER_LOAD = RW + "Reader#load().";
const READER_PARSE = RW + "Reader#parse().";
const WRITER = RW + "Writer#";
const WRITER_LOAD = RW + "Writer#load().";
const WRITER_FLUSH = RW + "Writer#flush().";

// ---------------------------------------------------------------------------
// The scip-python transcript. Offsets are computed from SOURCES, never
// hand-counted (derive-calls.test.ts records why).
// ---------------------------------------------------------------------------

const DEF = ROLE_DEFINITION;
/** scip-python's role for every reference, calls and imports alike. */
const READ = ROLE_READ_ACCESS;

interface Occ { symbol: string; roles: number; range: ScipRange; enclosing?: ScipRange }

function at(path: string, line: number, needle: string): ScipRange {
  const text = SOURCES[path]![line]!;
  const start = text.indexOf(needle);
  assert.notEqual(start, -1, `"${needle}" not on ${path}:${line}: ${text}`);
  return { startLine: line, startChar: start, endLine: line, endChar: start + needle.length };
}

/** A definition's body: from its keyword to the end of its last line. */
function body(path: string, from: number, to: number): ScipRange {
  const lines = SOURCES[path]!;
  return {
    startLine: from, startChar: lines[from]!.search(/\S/),
    endLine: to, endChar: lines[to]!.length,
  };
}

const MODULE_NAME: ScipRange = { startLine: 0, startChar: 0, endLine: 0, endChar: 0 };

function occurrences(): Record<string, Occ[]> {
  const os = ORDER_SERVICE_PY;
  const pay = PAYMENTS_PY;
  const rw = RW_PY;
  return {
    [os]: [
      { symbol: ORDERS + "__init__:", roles: DEF, range: MODULE_NAME },
      { symbol: PAYMENTS + "__init__:", roles: READ, range: at(os, 0, "app.clients.payments") },
      { symbol: CHARGE_CARD, roles: READ, range: at(os, 0, "charge_card") },
      { symbol: PAYMENT_DECLINED, roles: DEF, range: at(os, 3, "PaymentDeclined"), enclosing: body(os, 3, 4) },
      { symbol: "scip-python python python-stdlib 3.11 builtins/Exception#", roles: READ, range: at(os, 3, "Exception") },
      { symbol: ORDER_SERVICE, roles: DEF, range: at(os, 7, "OrderService"), enclosing: body(os, 7, 15) },
      { symbol: PLACE_ORDER, roles: DEF, range: at(os, 8, "place_order"), enclosing: body(os, 8, 12) },
      { symbol: PLACE_ORDER + "(self)", roles: DEF, range: at(os, 8, "self") },
      { symbol: PLACE_ORDER + "(total)", roles: DEF, range: at(os, 8, "total") },
      { symbol: PLACE_ORDER + "(self)", roles: READ, range: at(os, 9, "self") },
      { symbol: AUDIT, roles: READ, range: at(os, 9, "audit") },
      { symbol: PLACE_ORDER + "(total)", roles: READ, range: at(os, 9, "total") },
      { symbol: "local 0", roles: DEF, range: at(os, 10, "result") },
      { symbol: CHARGE_CARD, roles: READ, range: at(os, 10, "charge_card") },
      { symbol: PLACE_ORDER + "(total)", roles: READ, range: at(os, 10, "total") },
      { symbol: "local 0", roles: READ, range: at(os, 11, "result") },
      { symbol: PAYMENT_DECLINED, roles: READ, range: at(os, 12, "PaymentDeclined") },
      { symbol: AUDIT, roles: DEF, range: at(os, 14, "audit"), enclosing: body(os, 14, 15) },
      { symbol: AUDIT + "(self)", roles: DEF, range: at(os, 14, "self") },
      { symbol: AUDIT + "(total)", roles: DEF, range: at(os, 14, "total") },
      { symbol: AUDIT + "(total)", roles: READ, range: at(os, 15, "total") },
    ],
    [pay]: [
      { symbol: PAYMENTS + "__init__:", roles: DEF, range: MODULE_NAME },
      { symbol: CHARGE_CARD, roles: DEF, range: at(pay, 0, "charge_card"), enclosing: body(pay, 0, 1) },
      { symbol: CHARGE_CARD + "(total)", roles: DEF, range: at(pay, 0, "total") },
      { symbol: CHARGE_CARD + "(total)", roles: READ, range: at(pay, 1, "total") },
    ],
    [rw]: [
      { symbol: RW + "__init__:", roles: DEF, range: MODULE_NAME },
      { symbol: READER, roles: DEF, range: at(rw, 0, "Reader"), enclosing: body(rw, 0, 5) },
      { symbol: READER_LOAD, roles: DEF, range: at(rw, 1, "load"), enclosing: body(rw, 1, 2) },
      { symbol: READER_LOAD + "(self)", roles: DEF, range: at(rw, 1, "self") },
      { symbol: READER_LOAD + "(self)", roles: READ, range: at(rw, 2, "self") },
      { symbol: READER_PARSE, roles: READ, range: at(rw, 2, "parse") },
      { symbol: READER_PARSE, roles: DEF, range: at(rw, 4, "parse"), enclosing: body(rw, 4, 5) },
      { symbol: READER_PARSE + "(self)", roles: DEF, range: at(rw, 4, "self") },
      { symbol: WRITER, roles: DEF, range: at(rw, 8, "Writer"), enclosing: body(rw, 8, 13) },
      { symbol: WRITER_LOAD, roles: DEF, range: at(rw, 9, "load"), enclosing: body(rw, 9, 10) },
      { symbol: WRITER_LOAD + "(self)", roles: DEF, range: at(rw, 9, "self") },
      { symbol: WRITER_LOAD + "(self)", roles: READ, range: at(rw, 10, "self") },
      { symbol: WRITER_FLUSH, roles: READ, range: at(rw, 10, "flush") },
      { symbol: WRITER_FLUSH, roles: DEF, range: at(rw, 12, "flush"), enclosing: body(rw, 12, 13) },
      { symbol: WRITER_FLUSH + "(self)", roles: DEF, range: at(rw, 12, "self") },
    ],
  };
}

// ---------------------------------------------------------------------------
// Minimal protobuf writer for the SCIP subset ScipProtobufReader decodes, so
// the index reaches indexRepo as bytes on disk, as a real one does. A wrong
// encoding cannot pass quietly: the reader would yield no symbols, and every
// edge assertion below would fail.
// ---------------------------------------------------------------------------

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
const bytesField = (field: number, body: number[]): number[] =>
  [...varint((field << 3) | 2), ...varint(body.length), ...body];
const stringField = (field: number, s: string): number[] =>
  bytesField(field, [...new TextEncoder().encode(s)]);
const varintField = (field: number, n: number): number[] => [...varint(field << 3), ...varint(n)];
/** SCIP packs a single-line range as 3 ints and a multi-line one as 4. */
const rangeField = (field: number, r: ScipRange): number[] => bytesField(field, (
  r.startLine === r.endLine
    ? [r.startLine, r.startChar, r.endChar]
    : [r.startLine, r.startChar, r.endLine, r.endChar]
).flatMap(varint));

function encodeIndex(projectRoot: string, docs: Record<string, Occ[]>): Uint8Array {
  const toolInfo = [...stringField(1, "scip-python"), ...stringField(2, "0.6.6")];
  const metadata = [...bytesField(2, toolInfo), ...stringField(3, projectRoot)];
  const out = bytesField(1, metadata);
  for (const [path, occs] of Object.entries(docs)) {
    const doc = stringField(1, path);
    for (const o of occs) {
      doc.push(...bytesField(2, [
        ...rangeField(1, o.range),
        ...stringField(2, o.symbol),
        ...varintField(3, o.roles),
        ...(o.enclosing ? rangeField(7, o.enclosing) : []),
      ]));
    }
    out.push(...bytesField(2, doc));
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Index once, the way `codeintel index` does, then read the store.
// ---------------------------------------------------------------------------

let dir: string;
let store: FactStore;
let report: Awaited<ReturnType<typeof indexRepo>>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "code-intel-pymethods-"));
  const root = join(dir, "repo");
  for (const [path, lines] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), lines.join("\n") + "\n", "utf8");
  }
  const artifactDir = join(dir, ".codeintel");
  mkdirSync(join(artifactDir, "scip"), { recursive: true });
  writeFileSync(
    join(artifactDir, "scip", `${REPO}.scip`),
    encodeIndex(pathToFileURL(root).href, occurrences()),
  );

  const repo: RepoConfig = {
    name: REPO, rootPath: root, serviceName: REPO, lang: "py", framework: "none",
    entrypoint: "", include: [], exclude: [], baseUrlEnvVars: [], port: null,
    tsconfig: null, pythonBin: null,
  };
  store = new FactStore(join(dir, "graph.db"));
  report = await indexRepo({ store, repo, artifactDir, force: true });
});

after(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

type EdgeRow = { dst: string; dstKind: string; confidence: string; line: number | null };

/** Edges of one type leaving the node keyed by `src`, ordered by line. */
function edgesFrom(src: string, type: string): EdgeRow[] {
  return store.raw().prepare(
    `SELECT d.key AS dst, d.kind AS dstKind, e.confidence AS confidence, e.line AS line
       FROM edges e
       JOIN nodes s ON s.id = e.src_node_id
       JOIN nodes d ON d.id = e.dst_node_id
      WHERE e.type = ? AND s.key = ?
      ORDER BY e.line, d.key`,
  ).all(type, src) as EdgeRow[];
}

const callees = (src: string): string[] => edgesFrom(src, "CALLS").map((e) => e.dst);

describe("Python calls made inside class methods (CodeGraph eaeda2a)", () => {
  test("the index reached the store: symbols were written and calls derived", () => {
    // Guards the guard. If the SCIP bytes stopped decoding, every assertion
    // below would fail for a reason that has nothing to do with methods.
    assert.deepEqual(report.missingArtifacts, []);
    assert.ok(report.symbols > 0, "symbols were ingested");
    assert.ok(report.calls > 0, "calls were derived");
  });

  test("calls made inside a method are kept, and owned by the method", () => {
    assert.deepEqual(callees(PLACE_ORDER), [AUDIT, CHARGE_CARD]);
    for (const e of edgesFrom(PLACE_ORDER, "CALLS")) {
      assert.equal(e.confidence, "certain", `${e.dst} was resolved by the indexer`);
    }

    // The class body also encloses these lines. The innermost body wins, so
    // nothing is attributed to the class instead of its method.
    assert.deepEqual(edgesFrom(ORDER_SERVICE, "CALLS"), []);
    assert.deepEqual(edgesFrom(ORDER_SERVICE, "THROWS"), []);

    // `raise PaymentDeclined(...)` is a THROWS finding (R19), not a CALLS
    // edge, and its owner comes from the same SCIP definition ranges.
    const throws = edgesFrom(PLACE_ORDER, "THROWS");
    assert.deepEqual(throws.map((t) => [t.dst, t.line]), [["error:PaymentDeclined", 13]]);
  });

  test("an imported function called in a method resolves to its definition in the other file", () => {
    const row = store.raw().prepare(
      `SELECT f.path AS path
         FROM nodes n
         JOIN symbols sy ON sy.node_id = n.id
         JOIN files f ON f.id = sy.file_id
        WHERE n.kind = 'symbol' AND n.key = ?`,
    ).get(CHARGE_CARD) as { path: string } | undefined;
    assert.equal(row?.path, PAYMENTS_PY);
    assert.ok(store.crossFileCallCount() >= 1, "place_order -> charge_card crosses files");
  });

  test("self.audit() resolves to the same class's method", () => {
    const call = edgesFrom(PLACE_ORDER, "CALLS").find((e) => e.line === 10);
    assert.ok(call, "the self.audit() call on line 10 has an edge");
    assert.equal(call.dst, AUDIT);
    assert.equal(call.dstKind, "symbol", "a local method node, not an external boundary");
  });

  test("two classes that share a method name keep their calls apart", () => {
    const loads = store.raw().prepare(
      `SELECT n.key AS key
         FROM nodes n JOIN symbols sy ON sy.node_id = n.id
        WHERE sy.display_name = 'load'
        ORDER BY n.key`,
    ).all() as Array<{ key: string }>;
    assert.deepEqual(loads.map((r) => r.key), [READER_LOAD, WRITER_LOAD], "two nodes, not one");

    assert.deepEqual(callees(READER_LOAD), [READER_PARSE]);
    assert.deepEqual(callees(WRITER_LOAD), [WRITER_FLUSH]);
    assert.deepEqual(edgesFrom(READER, "CALLS"), []);
    assert.deepEqual(edgesFrom(WRITER, "CALLS"), []);
  });
});
