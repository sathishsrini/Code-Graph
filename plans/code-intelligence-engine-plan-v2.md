# Code Intelligence Engine — Implementation Plan **v2**

> **Source doc:** `c:\Users\sathish\Projects\docs\code-intelligence-engine.md`
> **Prior art reviewed:** `D:\facilitator` — context-facilitator (v1/v2 schema + regex code-graph indexer)
> **Validation corpus:** `D:\###facilitator\dev-workspace` — test fixtures, not the real target repos
> **Status:** planning complete, nothing implemented. **OPEN-1, OPEN-2 and OPEN-3 (§6) block Phase 0.**
> **Version:** v2 · 2026-09-06

**Revision history**

| Ver | Change |
|---|---|
| v1 | Initial plan. 74 requirements, 41 tasks, 4 phases, 9 open decisions. |
| **v2** | **Added intra-function control flow (R75–R78; tasks P1-T17, P1-T18, P2-T12).** Green success path / red error path per function — branch structure, guard attribution, exit classification. Goes beyond the source doc, which excludes control-flow analysis (§C fn.14, §G.2, §Q.2). Motivated by the corpus throwing nothing: its live code returns error envelopes (`return envelopeError(...)`), so a `throw`-only failure surface finds ~zero. Totals now 78 requirements, 44 tasks. |

---

## Context

**Why this is being built.** `docs/code-intelligence-engine.md` is a research verdict
on a system that has already failed twice. The prior attempt lives at `D:\facilitator`
(`context-facilitator`, ~5,500 LOC TypeScript) and its code-graph layer is the thing
being replaced. Reading `D:\facilitator\src\codegraph\indexer.ts` confirms every
diagnosis in the doc's section H.2, and adds one the doc did not name:

| Defect | Evidence |
|---|---|
| Regex "parser" | `extractSymbols` matches only column-0 declarations (`/^(?:export\s+)?...`). Methods, arrow functions and nested functions are invisible. |
| Call edges are name-collision guesses | `line.matchAll(/(\w+)\s*\(/g)` matches `if (`, `for (`, `catch (`. `findSymbol` then resolves by **suffix match** across the file — the exact failure the doc attributes to code-graph-rag. |
| **No cross-file edges at all** | `symbolMap` is rebuilt per file; `extractEdges` only emits an edge when *both* ends are in that same map. The call graph is intra-file only. *(Not in the doc's critique — found in this review.)* |
| `READS`/`WRITES` are noise | Any line containing `SET`, `GET`, `FIND` or `CREATE` emits an edge; `extractTarget` returns `"unknown"` for most of them. |
| Lossy confidence | Regex matches are written as `confidence: "exact"`. |
| Unstable identity | `qualifiedName` = `service.dotted.path.Name` — the root cause the doc names in H.2.3. |

**Intended outcome.** A rebuilt engine that answers four questions deterministically,
with per-edge provenance: what executes on an endpoint, what a change breaks, what can
and did fail, and what minimum context an agent needs to edit a function.

**Decisions you already made** (2026-09-06):

1. **Fresh project**, porting the good parts out of `D:\facilitator` rather than
   building in place.
2. **Engine-focused scope**; facilitator components come in only where genuinely good.
3. **Both auth channels** — boot reflection *and* static inline-check detection —
   **rendered with colour differences** in the graph.
4. Plan output to `C:\Users\sathish\Projects\plans\`.

**Corpus.** `D:\###facilitator\dev-workspace` — four services (`40-kri-router`,
`41-kri-engine`, `51-integration`, `60-kri-next`) plus a `remediation` folder. You
confirmed these are **test fixtures, not the real target repos**. The engine is
therefore built generic and validated against them; the plan must not bake in their
shape. That said, their properties drive Phase 0 sequencing, because several of them
break the doc's stated assumptions (see **Open Decisions**).

---

## 1. Executive Summary

Build a thin custom orchestration-and-query layer over off-the-shelf extractors.
Reuse `scip-typescript` / `scip-python` for symbols and call resolution, framework
boot reflection for routes and middleware order, tree-sitter for the syntactic extras
SCIP does not model, and Semgrep for security-check classification. Own only the
normalizer, the SQLite fact store, the derivations, the query engine, the context
packer and the consumers.

- **Realistic custom surface:** 3,000–5,000 LOC, most of it query logic.
- **Stack:** TypeScript on Node 22+, `node:sqlite` (built-in, no native build),
  ESM with `--experimental-transform-types`. Python appears only as two standalone
  subprocess scripts (`scip-python` invocation, FastAPI dump). No long-lived Python
  service.
- **Four phases**, each ending in something usable. Phase 0 is timeboxed to one week
  and is a hard go/no-go gate.
- **78 requirements** — 74 from the source doc, plus your auth-channel addition
  (R26, R50) and the v2 intra-function control-flow set (R75–R78). Every one is
  mapped to a task in §4 and audited in §8.
- **44 tasks** across the four phases.
- **9 open decisions** are listed in §6. Three of them (**OPEN-1**, **OPEN-2**,
  **OPEN-3**) block Phase 0 tasks and need answers before that work starts.

**The single organising principle**, quoted from the doc because it decides most
design arguments downstream:

> Runtime traces establish the boundaries with certainty. Static analysis fills in the
> interiors with inference.

**The discipline that makes it finish** (doc §O.1): nothing enters the schema until an
extractor produces it. The v1/v2 failure was 470 lines of DDL for tables with no
producers. Expect to change a third of the section-H schema once real data lands —
that is the schema working, not failing.

---

## 2. Requirements

Extracted from `docs/code-intelligence-engine.md`. Every ID is mapped to a task in §4
and audited in §8.

### 2.1 Storage & schema (doc §H)

| ID | Requirement |
|---|---|
| R1 | SQLite single file, `journal_mode=WAL`, `foreign_keys=ON` |
| R2 | 13 tables: `repos`, `runs`, `files`, `nodes`, `symbols`, `routes`, `route_chain`, `edges`, `unresolved_calls`, `spans`, `summaries`, `schema_version`, **`function_cfg`** (v2). Plus one nullable column **`edges.cfg_block_index`** for guard attribution |
| R3 | One `nodes` table, 7 kinds (`service`, `route`, `symbol`, `file`, `external`, `datastore`, `config`); integer surrogate PK + `UNIQUE(kind,key)` |
| R4 | SCIP symbol string is the canonical symbol identity, stored verbatim as `nodes.key` |
| R5 | One `edges` table, 9 types (`CONTAINS`, `CALLS`, `HANDLES`, `REQUESTS`, `READS`, `WRITES`, `CALLS_EXTERNAL`, `THROWS`, `READS_CONFIG`) |
| R6 | `route_chain` ordered relation (not an edge) with `position`, `phase`, `check_kind`, `inherited_from` |
| R7 | `confidence` ∈ `certain\|inferred\|observed\|unresolved`. Never a numeric score, never a lossy bridge |
| R8 | `evidence_kind` ∈ `scip\|treesitter\|semgrep\|boot\|otel\|manual` |
| R9 | Cross-repo edges are ordinary rows; node identity is global, never repo-scoped |
| R10 | Three edge indexes: forward (`idx_edges_out`), reverse (`idx_edges_in`), provenance (`idx_edges_prov`) |
| R11 | `unresolved_calls` persisted and queryable — honest gaps, never silently dropped |
| R12 | Detail tables keyed **by node id**; no parallel id space (the v2 root cause) |

### 2.2 Static channel (doc §F.1, §F.2)

| ID | Requirement |
|---|---|
| R13 | `scip-typescript index` per TS/JS service; `--infer-tsconfig` for plain JS; OOM mitigation (`--no-global-caches`, `--max-old-space-size`) |
| R14 | SCIP protobuf parser **behind an interface** so an LSP `callHierarchy` implementation can be dropped in (doc §Q.3) |
| R15 | `CALLS` derivation: per-file interval tree of definition ranges; innermost enclosing definition of each reference occurrence |
| R16 | Filter type-position-only occurrences and imports/re-exports out of `CALLS` |
| R17 | `certain` when the target resolves to a local definition; `inferred` when it resolves to an external package symbol |
| R18 | `scip-python index` for the Python service, venv active |
| R19 | tree-sitter pass: `throw new X()` → `THROWS`; `axios.*`/`fetch()`/client calls → outbound HTTP call sites; SQL literals + ORM methods → datastore candidates; `process.env.X`/`os.getenv` → `READS_CONFIG` |
| R20 | Semgrep/Opengrep rules mapping real helper names to `check_kind` values, maintained as a human-reviewed config file |

### 2.3 Boot channel (doc §F.3)

| ID | Requirement |
|---|---|
| R21 | Fastify adapter: `fastify-overview` registered first and awaited; read after `ready`; emit per-route method, url, prefix, and the full inherited hook chain in execution order |
| R22 | FastAPI adapter: walk `app.routes`; per `APIRoute` read `path`, `methods`, `endpoint.__module__`+`__qualname__`, and `route.dependant.dependencies` recursively; dump `app.openapi()` |
| R23 | Config resolution: dump resolved env/config per service per environment, **redacted** — key names and whether a value is set, never values |
| R24 | Boot facts replaced wholesale per service per run |
| R25 | Boot output is a JSON artifact produced at build/CI time; it is the route + middleware + security-chain ground truth, tagged `certain` |
| **R26** | **(Your addition)** Static inline security-check detection as a second auth channel, emitting `route_chain` rows at `phase='handler_inline'`, `confidence='inferred'` |

### 2.4 Incremental indexing (doc §F.4)

| ID | Requirement |
|---|---|
| R27 | Hash every file, compare to `files.content_sha256`, derive changed set (+added, +deleted) |
| R28 | **Delete by provenance, not by node**: `DELETE FROM edges WHERE file_id = ? AND evidence_kind IN (...)`. Never delete nodes |
| R29 | Re-run only derivations whose inputs touched the changed set |

### 2.5 Derivation layer (doc §E)

| ID | Requirement |
|---|---|
| R30 | Derivation layer is separate from facts, regenerable, never hand-edited |
| R31 | Cross-service linker: client call site → remote route. Always `inferred`. Every non-match logged to `unresolved_calls` |
| R32 | Route chain expander: hooks/deps → ordered symbol list |
| R33 | Reachability closure: route → reachable symbol set |
| R34 | Summary generator: LLM, cached by `input_sha256` |

### 2.6 Query engine (doc §I)

| ID | Requirement |
|---|---|
| R35 | `endpoint_flow`: resolve route → ordered `route_chain` → recursive CTE over `CALLS` (depth cap 12, cycle guard) → terminate at `external`/`datastore`/remote `route` → recurse into remote service → attach `unresolved_calls` as explicit unknown branches |
| R36 | `min_conf` propagation — a path is only as trustworthy as its weakest edge |
| R37 | `impact`: reverse closure; report **direct (depth 1) separately** from transitive, and separately again for non-`certain` paths |
| R38 | Impact dependency kinds: direct, indirect, runtime (`trace_id` co-occurrence), configuration (`READS_CONFIG`), data (shared `datastore`) |
| R39 | Fan-out mitigation: compute fan-in, flag high-fan-in symbols as "utility — expect broad impact" rather than listing 200 endpoints; rank affected routes by runtime traffic |
| R40 | `security_path`: ordered `route_chain` query + coverage matrix (routes × check kinds) + **the anomaly query** — routes that reach a `WRITES` edge with no `tenant` check |
| R41 | `error_paths`: static failure surface and runtime pass run as **two independent passes, presented separately**, never merged into one verdict |
| R42 | `context_pack`: budgeted BFS from a seed symbol, 9 priority tiers, stop at token budget, never raw source below priority 1 unless asked |
| R43 | `workflow`: two-stage — fuzzy FTS5/embedding seed selection, then deterministic `endpoint_flow` on top-k seeds; show which seed was chosen and let the user correct it |

### 2.7 Serialization & consumers (doc §E, §K, §O)

| ID | Requirement |
|---|---|
| R44 | Graph subset → compact JSON / TOON for LLM, budget-aware, never dumps raw source unless asked |
| R45 | Graph subset → node+edge JSON for UI |
| R46 | Mermaid emitter for PR comments, docs and LLM consumption |
| R47 | CLI (`flow`, `impact`, `context`, `security`, `errors`) |
| R48 | MCP server exposing `endpoint_flow`, `impact`, `security_path`, `context_pack` |
| R49 | Web UI: React Flow + elkjs (`layered`). 7 features in the doc's value order |
| R50 | **(Your addition)** Colour-differentiated rendering of boot-verified vs statically-inferred security checks |
| R51 | GitHub Action: PR diff → enclosing symbols → impact closure → PR comment |

### 2.8 Runtime channel (doc §J, §M)

| ID | Requirement |
|---|---|
| R52 | OTel instrumentation on services; `http.route` comes free, `code.*` attributes added manually on key functions |
| R53 | OTLP receiver → `spans` table, tail-based sampling (100% of errored traces, ~1% of successes). No Jaeger/Tempo dependency |
| R54 | Join keys: `service.name`+`http.route` → route; `code.function.name`+`code.file.path` → symbol; `db.*` → datastore; `server.address` → external/remote route; `exception.*` → error origin |
| R55 | Pin semconv version; handle both `code.filepath` and `code.file.path` spellings during migration |
| R56 | **Runtime never deletes a static edge.** It upgrades (`inferred`→`observed`) or adds (`observed`, `evidence_kind='otel'`) |
| R57 | Static edge with no runtime confirmation after 30 days → surface as "possibly dead", not as proof |
| R58 | Runtime overlay on the UI (executed vs possible paths) |
| R59 | M.2 trace root cause: build span tree via `parent_span_id`, find the **deepest** error span as origin, walk up for the propagation chain |
| R60 | M.3 correlation: `git log` on files owning symbols on the failing path, config change cross-reference, `co_changed` history |
| R61 | M.4 presentation: three labelled sections (OBSERVED / STATIC FAILURE SURFACE / CORRELATED CHANGES). The `UNKNOWN` line is mandatory — omitting what could not be analysed converts an unknown into a false negative |

### 2.9 LLM boundary (doc §L)

| ID | Requirement |
|---|---|
| R62 | Five permitted uses only: function explanation, module/service summaries, path narration, seed selection (stage 1 of R43), `check_kind` classification *suggestions* |
| R63 | Seven forbidden uses, enforced **structurally**: LLM output lands only in `summaries`, which no traversal joins against. If the LLM cannot reach `edges`, it cannot corrupt them |
| R64 | Summaries cached by `input_sha256`; regenerate only on hash change; small model |

### 2.10 Phase 3 / deferred (doc §O)

| ID | Requirement |
|---|---|
| R65 | `co_changed` from git history |
| R66 | Hierarchical LLM summaries, bottom-up |
| R67 | FTS5 + optional embeddings for user-story seeding |
| R68 | Optional Joern/Opengrep side-car for specific data-flow questions |
| R69 | Additional languages via the SCIP indexer ecosystem |

### 2.11 Process discipline (doc §O.1, §Q)

| ID | Requirement |
|---|---|
| R70 | Measure `CALLS` false-positive rate on a manual sample of 50 in Phase 0 and track it. Above ~10% the graph is untrustworthy |
| R71 | Measure the `context_pack` token delta vs. dumping files — the Phase 1 exit criterion and the number that justifies the project |
| R72 | Nothing enters the schema until an extractor produces it |
| R73 | Every phase ends in something usable |
| R74 | Timebox Phase 0 hard. If a believable tree is not produced in a week, the answer is to fork blarify and accept a Python service |

### 2.12 Intra-function control flow — **v2 addition, beyond the source doc**

The source doc deliberately excludes this (§C fn.14 *"do not build taint analysis"*;
§G.2 *"`CATCHES` — you can't do this reliably... Skip"*; §Q.2 *"`THROWS`... ignores
`catch`"*). It is added here for two reasons: a call graph plus a flat
failure-candidate list cannot answer *"which branch succeeds and which errors"*, and
the validation corpus throws nothing at all — its live code returns error envelopes
(`return envelopeError({...})`) and guards with the sentinel idiom
`if (authErr) return authErr;`. A `throw`-only extractor finds ~zero there.

**Scope boundary, stated so it is not over-promised.** This is a *syntactic,
per-function* CFG built with tree-sitter. It answers "this call sits inside the
`if (authErr)` branch, which exits with an error". It does **not** answer "authErr is
non-null when the token is invalid" — that is interprocedural data flow, which stays
out of scope. R68 (Joern side-car) remains the escape hatch if you ever need it.

| ID | Requirement |
|---|---|
| R75 | Per-function control-flow extraction via tree-sitter: `if`/`else`, `switch`, `try`/`catch`/`finally`, loops, early returns and throw sites, with source ranges and nesting. Stored in `function_cfg`. `evidence_kind='treesitter'`, `confidence='inferred'` |
| R76 | Error-exit detection covering **both idioms**: `throw new X()` *and* the return-an-error-value form (early return of an error envelope or sentinel). Records `exit_form` and `error_name` when a constructor or error-code literal is detectable |
| R77 | Guard attribution: every `CALLS`, `READS`, `WRITES`, `CALLS_EXTERNAL` and `THROWS` edge site is attributed to its enclosing CFG block via `edges.cfg_block_index`, so a query can answer "which calls are guarded by which condition" |
| R78 | Path classification and rendering: each terminal path classified `success` / `error_exit` / `unknown` and rendered **green / red / grey** — a **distinct visual axis** from the confidence styling of R49 (solid/dashed/dotted), with a legend that states the difference |

**Proposed table.** Ships only when P1-T17 populates it (R72 — no table without a
producer):

```sql
CREATE TABLE function_cfg (
  id             INTEGER PRIMARY KEY,
  symbol_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  block_index    INTEGER NOT NULL,     -- ordinal within the function
  parent_index   INTEGER,              -- nesting; NULL = function root
  kind           TEXT NOT NULL,        -- branch|guard|try|catch|finally|loop|exit
  condition_text TEXT,                 -- verbatim source, never evaluated
  outcome        TEXT,                 -- success|error_exit|unknown (kind='exit' only)
  exit_form      TEXT,                 -- throw|return_error|return_value|implicit
  error_name     TEXT,                 -- error ctor or error-code literal, when detectable
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  run_id         INTEGER NOT NULL REFERENCES runs(id),
  UNIQUE (symbol_node_id, block_index)
);
CREATE INDEX idx_cfg_symbol ON function_cfg(symbol_node_id, block_index);
CREATE INDEX idx_cfg_prov   ON function_cfg(file_id);   -- provenance delete (R28)
CREATE INDEX idx_cfg_exit   ON function_cfg(outcome, symbol_node_id);

ALTER TABLE edges ADD COLUMN cfg_block_index INTEGER;   -- nullable: boot/otel have none
```

**What this looks like for a real function** (the corpus's `proxyToEngine`):

```
proxyToEngine()                                     [certain, scip]
├─ [guard] if (authErr)                    ──► RED   exit: return_error
│     └─ return authErr                            KRI40-AUTH-001
└─ [success continuation]                  ──► GREEN
   ├─ calls forward()                              [certain]
   │  └─ REQUESTS 41-kri-engine|GET|/api/v1/po    [inferred]
   └─ [try/catch] catch (e)                ──► RED   exit: return_error
         └─ return envelopeError(...)                KRI40-DOWNSTREAM-UNAVAILABLE-001
```

Note the two axes are independent: `REQUESTS` is **dashed** (inferred — we are unsure
the edge exists) while sitting on a **green** path (we are sure that branch is the
success continuation). Conflating them would be the easy mistake; R78 forbids it.

**Explicitly out of scope** (doc is unambiguous): CodeQL (licence prohibits private
commercial use), Kùzu or any embedded graph DB, custom taint/data-flow analysis,
forking blarify, self-hosting Sourcegraph, `CALLED_BY`/`IMPORTS`/`AFFECTS`/`CATCHES`
and the other 20 v2 relationship types with no producer, bitemporal edge validity,
the v2 "neural layer" (`entity_associations`, `navigation_events`, four embedding
levels), and `derivation_metadata`.

---

## 3. Implementation Phases

### Phase 0 — Prove the pipeline

**Objective.** Prove SCIP → `CALLS` → SQLite → CLI end-to-end on one endpoint of one
service. No UI, no cross-service linking, no schema beyond what is needed. This phase
exists to retire the single largest risk — that derived call edges are not trustworthy
— before anything is built on top of them.

**Tasks.** P0-T1 … P0-T9 (§4.1)

**Dependencies.** OPEN-1, OPEN-2, OPEN-3 answered. Node 22+. `scip-typescript` and
the `scip` CLI installed.

**Deliverables.**
- Project skeleton, `repos.json` config, minimal SQLite schema (subset of §H).
- SCIP parser behind `ScipIndexReader` interface.
- `CALLS` derivation with a written false-positive measurement.
- `fastify-overview` boot dump for one service.
- A CLI that prints the ordered chain + call tree for one real endpoint.

**Acceptance criteria.**
1. The printed tree matches what a senior developer would draw by hand for that endpoint.
2. `CALLS` false-positive rate is measured on a manual sample of 50 and **written down** (R70).
3. Re-running the indexer twice produces byte-identical query output (determinism).
4. The boot dump's hook chain for the endpoint matches known truth.

**Risks.**
- **`scip-typescript` OOM or outright failure.** Doc §O: "If it OOMs or fails, stop and fix that first." Mitigation: `--max-old-space-size=8192`, `--no-global-caches`.
- **Dead-code contamination (corpus-specific, high).** `40-kri-router/src/` and `41-kri-engine/src/` are non-compiling TypeScript scaffolds that never execute; the live code is untyped CommonJS `server.js`. SCIP will index the dead tree cleanly and the live one barely. This is **OPEN-1** and must be resolved before P0-T3.
- **False-positive rate above 10%** → the graph feels untrustworthy and adoption dies. This is the gate, not a warning.
- **Timebox breach** → fall back to forking blarify (R74).

---

### Phase 1 — Useful to humans and agents

**Objective.** All four services indexed across static + boot channels, cross-service
edges derived, full §H schema, incremental indexing, four query types, MCP server.
Ends with an agent measurably better off than dumping files.

**Tasks.** P1-T1 … P1-T16 (§4.2)

**Dependencies.** Phase 0 passed its exit criteria. OPEN-4, OPEN-5, OPEN-6 answered.

**Deliverables.**
- Full 12-table schema with migration runner.
- `scip-python` pipeline + FastAPI boot adapter.
- Cross-service linker with `unresolved_calls` logging.
- Incremental indexing by content hash + provenance delete.
- `endpoint_flow`, `impact`, `security_path`, `context_pack`.
- MCP server exposing those four.
- Semgrep `check_kind` rule pack + inline-check detector (R26).
- **(v2)** Intra-function CFG extractor + guard attribution (R75–R77).

**Acceptance criteria.**
1. An agent calls `context_pack('createZoomMeeting')`-equivalent and receives a materially smaller, materially better context than dumping files. **Token delta measured and recorded** (R71).
2. Change one file → confirm only its rows are replaced and nothing else moves (R28).
3. Every cross-service edge carries `confidence='inferred'` until OTel confirms it; every non-match appears in `unresolved_calls`.
4. The anomaly query (R40) returns a correct, hand-verifiable answer on the corpus.
5. **(v2)** For a hand-picked function every branch and every error exit is
   recovered — including the `return envelopeError(...)` idiom — verified against source.
6. All four query types answer within interactive latency on the full corpus.

**Risks.**
- **Cross-service edge accuracy** — the doc's #1 hardest problem, irreducibly probabilistic. On this corpus it is *harder* than the doc assumes: the outbound URL is one function-call indirection away from the single `axios()` site, the path is a `req.url` pass-through, and the destination forks on `PROCUREMENT_BASE_URL`. Mitigation: hand-written service-URL map as highest-priority resolution source; everything else `inferred`; log all gaps.
- **Boot channel yields little on this corpus.** Auth is not in hooks or `Depends`. R26 exists to cover this; without it the security feature cannot be validated here.
- **`scip-python` environment** — no venv, no `__init__.py`, Python 3.14 with no `psycopg2-binary` cp314 wheel. See OPEN-5.
- **Scope creep.** Doc §Q.3: if Phase 1 slips past six weeks, cut scope rather than extend.

---

### Phase 2 — Visualisation and runtime

**Objective.** Make the graph visible and confirm inferred edges against reality.

**Tasks.** P2-T1 … P2-T10 (§4.3)

**Dependencies.** Phase 1 complete. **OPEN-7 (who instruments and deploys the
services) is outside the engine team's control and must not block Phase 1.**

**Deliverables.**
- React Flow + elkjs UI with the doc's 7 features in value order.
- Colour-differentiated security-check provenance (R50).
- **(v2)** Green/red/grey execution-path rendering per function (R78).
- OTel instrumentation, OTLP receiver, `spans` table, tail sampling.
- `inferred` → `observed` promotion.
- Error backtracking (M.1 + M.2 + M.3) with the three-section presentation.
- GitHub Action: PR diff → impact comment.

**Acceptance criteria.**
1. An endpoint flow renders with service swim-lanes; solid/dashed/dotted/red edges correctly reflect the four confidence values.
2. Boot-verified and inline-inferred security checks are visually distinguishable at a glance (R50).
3. A real errored trace resolves to the deepest error span as origin, with the propagation chain above it.
4. At least one `REQUESTS` edge is promoted `inferred`→`observed` by real traffic.
5. Error analysis renders all three sections, and the `UNKNOWN` line appears whenever `unresolved_calls` intersects the path.
6. **(v2)** Opening a function shows its branches with success paths green, error exits
   red and undetermined paths grey — visually separate from the confidence axis, with a
   legend distinguishing the two.

**Risks.**
- **Building the UI too early.** The doc names this as the most common way this class of project dies. The UI is deliberately after the data is trustworthy.
- **Deployment dependency** outside the team's control (OPEN-7).
- **semconv drift** — `code.filepath` → `code.file.path` rename (R55).
- **Corpus has no real traffic**, so runtime validation needs a load script or a real deployment.

---

### Phase 3 — Depth (open-ended)

**Objective.** Add the genuinely valuable extras once the core is trusted. Nothing
here is required for the engine to be useful.

**Tasks.** P3-T1 … P3-T5 (§4.4)

**Dependencies.** Phase 2 complete.

**Deliverables.** `co_changed` from git; hierarchical cached LLM summaries; FTS5 +
optional embeddings for user-story seeding; optional Joern/Opengrep side-car;
additional languages.

**Acceptance criteria.** Each item ships independently and is individually revertible.
No item introduces an LLM-written row that a traversal treats as fact (R63).

**Risks.** Scope sprawl; embedding/ANN dependency churn (`sqlite-vec` pre-v1, SQLite's
`vec1` at v0.7). Doc §B.6: brute-force cosine over BLOBs is exact and fine to
50–100k vectors — do not take an ANN dependency until a problem is measured.

---

## 4. Tasks by Phase

### 4.1 Phase 0

| ID | Description | Depends on | Expected output | Acceptance criteria |
|---|---|---|---|---|
| **P0-T1** | Scaffold the project: Node 22+, TypeScript, ESM, `node:sqlite`, `node --test`. Mirror `D:\facilitator`'s stack choices (no native compilation). | OPEN-2 | Repo with `package.json`, `tsconfig.json`, `src/`, `tests/`, running `npm test` | `npm test` and `npm run typecheck` both pass on an empty suite |
| **P0-T2** | `repos.json` config: per service — absolute path, language, framework, tsconfig path, include/exclude globs, service name, base-URL env var. **No hardcoded layout.** | P0-T1 | `config/repos.json` + typed loader + validation | Loader rejects a missing path with a clear error; corpus paths resolve |
| **P0-T3** | Run `scip-typescript index` on one service. Handle OOM. **Apply the include/exclude decision from OPEN-1** (dead `src/` trees; `.next/**`). | P0-T2, **OPEN-1** | `index.scip` + a documented command line | Index completes; file count matches the intended include set, not the whole tree |
| **P0-T4** | Parse the SCIP protobuf behind a `ScipIndexReader` interface (R14). Dump symbol count, occurrence count, 20 random symbols. | P0-T3 | `src/static/scip/` + a `scip:dump` CLI command | 20 sampled symbols are eyeball-correct; interface has one implementation and a documented second-implementation contract |
| **P0-T5** | Minimal SQLite schema — `repos`, `runs`, `files`, `nodes`, `symbols`, `edges` only. **No table without a producer** (R72). | P0-T1 | `src/store/schema-v0.sql` + bootstrap with `foreign_key_check` and `integrity_check` | Fresh bootstrap passes both PRAGMA checks; re-run is idempotent |
| **P0-T6** | Derive `CALLS`: per-file interval tree of definition ranges; innermost enclosing definition per reference occurrence; filter type-position and import/re-export occurrences; set `certain` vs `inferred`. | P0-T4, P0-T5 | `src/derive/calls.ts` + populated `edges` rows | Edges written with correct `confidence` and `evidence_kind='scip'`; cross-file edges exist (the specific v1 failure) |
| **P0-T7** | **Measure the false-positive rate.** Manually verify 50 sampled `CALLS` edges against source. Write the number into `docs/measurements.md`. | P0-T6 | A committed measurement with date, commit SHA and method | Number recorded. **If >10%, iterate on P0-T6 filters before proceeding** (R70) |
| **P0-T8** | Fastify boot dump: register `fastify-overview` first, await it, read `app.overview()` after `ready`, emit JSON. Convert the 4 anonymous arrow hooks to named functions in the fixture (~10 lines) so output is labelled. | P0-T2 | `adapters/fastify/boot-dump.js` + `overview.json` | Hook chain for the target endpoint matches known truth; every hook has a usable name |
| **P0-T9** | CLI `flow` command: ordered `route_chain` + call tree for one endpoint, with confidence markers. | P0-T6, P0-T8 | `syfgraph flow --service X --method POST --path /...` | **Phase 0 exit criterion**: output matches a senior developer's hand-drawn tree |

### 4.2 Phase 1

| ID | Description | Depends on | Expected output | Acceptance criteria |
|---|---|---|---|---|
| **P1-T1** | Full §H schema: all 12 tables, all CHECK constraints, the three edge indexes, `schema_version` + migration runner. Adjust to what Phase 0's real data showed. | P0-T9 | `src/store/schema.sql`, migration runner | All 12 tables present; `foreign_key_check` and `integrity_check` clean; documented deltas from §H with reasons |
| **P1-T2** | Normalizer: everything → canonical node keys (SCIP symbol / route key / service / external / datastore / config). Global identity, never repo-scoped (R9). | P1-T1 | `src/normalize/` | A symbol from service A and a route from service B can be joined by an edge row with no mapping table |
| **P1-T3** | `scip-python` pipeline for the Python service. **Resolve the environment problem first** (OPEN-5). | P1-T2, **OPEN-5** | `index.scip` for the Python service + parser reuse | Third-party imports resolve (not all-external); symbols joined into the same `nodes` table |
| **P1-T4** | FastAPI boot adapter: walk `app.routes`, recurse `route.dependant.dependencies`, dump `app.openapi()`. Fall back to AST when `openapi()` yields no schemas (OPEN-6). | P1-T2 | `adapters/fastapi/dump.py` (~80 LOC) + `routes.json`, `openapi.json` | Every route enumerated with full path; dependency chain in order; schema fallback documented when empty |
| **P1-T5** | Next.js static-channel indexing (your decision: static only, no route extraction). Index with `scip-typescript`, exclude `.next/**`. | P1-T2 | Symbols + call sites for the frontend | Frontend symbols in `nodes`; no Next.js route extraction attempted |
| **P1-T6** | tree-sitter pass (R19): `THROWS`, outbound HTTP call sites, SQL/ORM datastore candidates, config reads. Both TS/JS and Python. | P1-T2 | `src/static/treesitter/` | Each extractor writes `evidence_kind='treesitter'` with correct confidence; `THROWS` documented as "declared locally, always inferred, never complete" (doc §Q.2) |
| **P1-T7** | **Cross-service linker** (R31): call sites → base-URL resolution → path-template matching. Study `api-ghost-hunter`'s matcher. Must handle a wrapper indirection and template-literal paths. Hand-written service-URL map is the highest-priority resolution source. | P1-T6, P1-T4 | `src/derive/cross-service.ts` + `unresolved_calls` rows | Every produced edge is `inferred`; every non-match logged with a `reason`; env-conditional destinations produce **two** candidate edges or one `unresolved`, never one silently-wrong edge |
| **P1-T8** | Route chain expander (R32) + `HANDLES` edges from boot output. | P1-T4, P0-T8 | Populated `route_chain` | Ordering preserved exactly as boot reported; `inherited_from` populated |
| **P1-T9** | Semgrep/Opengrep `check_kind` rule pack (R20), maintained as a reviewed config file. | P1-T8 | `rules/check-kinds.yml` + runner | Rules classify the corpus's real helper names; output is a config diff for human review, never a direct DB write |
| **P1-T10** | **Inline security-check detector (R26)** — your addition. Detect security-helper calls inside handler bodies (the sentinel-return idiom in JS, the header-compare-and-early-401 idiom in Python) and emit `route_chain` rows at `phase='handler_inline'`, `confidence='inferred'`, `evidence_kind='semgrep'` or `'treesitter'`. | P1-T9 | `src/static/inline-auth.ts` + rules | Corpus routes protected by inline checks are no longer reported as unauthenticated; rows are clearly distinguishable from boot rows by `phase` **and** `confidence` |
| **P1-T11** | Incremental indexing (R27–R29): content hash → changed set → provenance delete → re-insert → re-run affected derivations. | P1-T1 | `src/index/incremental.ts` | **Test: change one file, confirm only its rows are replaced and nothing else moves.** Nodes survive; edges into the changed file from unchanged files survive |
| **P1-T12** | `endpoint_flow` (R35, R36): recursive CTE, depth cap 12, cycle guard, `min_conf` propagation, boundary termination, cross-service recursion, `unresolved_calls` attached as explicit unknown branches. | P1-T7, P1-T8, P1-T11 | `src/query/endpoint-flow.ts` | Produces the doc §P.4 tree shape; a path crossing one `inferred` hop is never rendered as fact downstream of that hop |
| **P1-T13** | `impact` (R37–R39): reverse closure, direct vs transitive vs confidence-segmented, five dependency kinds, fan-in computation and high-fan-in flagging. | P1-T11 | `src/query/impact.ts` | Output is segmented as CERTAIN / INFERRED / UNKNOWN; a high-fan-in utility is flagged rather than listing every endpoint |
| **P1-T14** | `security_path` (R40): ordered chain query + coverage matrix + **the anomaly query** (writes without a tenant check). | P1-T8, P1-T10 | `src/query/security.ts` | Anomaly query returns a correct, hand-verifiable answer on the corpus; results distinguish boot-certain from inline-inferred |
| **P1-T15** | `context_pack` (R42): budgeted BFS, 9 priority tiers, token budget, TOON/compact-JSON output. Port the TOON encoder from `D:\facilitator\src\serializers\toon.ts` (see §5). | P1-T12, P1-T13 | `src/query/context-pack.ts` + serializers | **Token delta measured and recorded** (R71). Never emits raw source below priority 1 unless asked |
| **P1-T16** | MCP server (R48) exposing `endpoint_flow`, `impact`, `security_path`, `context_pack`. | P1-T12, P1-T13, P1-T14, P1-T15 | `src/mcp/server.ts` | **Phase 1 exit criterion**: an agent in your existing setup calls the tools and gets materially better context than dumping files |
| **P1-T17** *(v2)* | Intra-function CFG extractor (R75, R76): tree-sitter walk of each function body emitting branch / guard / try / catch / loop / exit blocks with nesting and source ranges. Classify every exit `success` / `error_exit` / `unknown` and record `exit_form`. **Must handle `return envelopeError(...)` and the `if (authErr) return authErr;` sentinel, not only `throw`.** | P1-T6 | `src/static/cfg.ts` + populated `function_cfg` | Every branch and exit of a hand-picked function recovered; the corpus's return-envelope error exits classified `error_exit`, not missed; re-run is idempotent |
| **P1-T18** *(v2)* | Guard attribution + query exposure (R77): add `edges.cfg_block_index`, attribute each edge's call site to its enclosing CFG block, extend `endpoint_flow` and the M.1 failure surface to carry branch context. | P1-T17, P1-T12 | Migration + `src/query/` updates | A query answers "which calls are reachable only through the error branch"; edges with no CFG context (boot, otel) keep NULL and are unaffected |

### 4.3 Phase 2

| ID | Description | Depends on | Expected output | Acceptance criteria |
|---|---|---|---|---|
| **P2-T1** | UI shell: React Flow + elkjs (`layered`), node+edge JSON serializer (R45). | P1-T16 | Web UI skeleton | Renders an endpoint flow with elkjs layout |
| **P2-T2** | Ordered route chain with `check_kind` badges — doc's highest value-per-hour feature. | P2-T1 | Chain band component | Chain renders in exact `position` order with badges |
| **P2-T3** | Node click → contract panel: signature, params, return type, callees, throws, source link, cached summary. | P2-T1 | Inspector panel | All fields populate from the store; source link opens the right line |
| **P2-T4** | Confidence rendering + **security-provenance colouring (R50)**: solid=certain, dashed=inferred, dotted=observed-only, red=unresolved; boot-verified vs inline-inferred checks visually distinct. | P2-T2, P2-T3 | Styling layer + legend | A viewer can tell at a glance which checks are boot-proven and which are statically guessed |
| **P2-T5** | Service-boundary grouping (elkjs compound nodes), expand/collapse by depth, filter by repo/edge type/confidence. | P2-T4 | Grouping + filter controls | Cross-service flow renders as swim-lanes |
| **P2-T6** | Mermaid emitter (R46) for PR comments, docs, LLM consumption. | P1-T12 | `src/serializers/mermaid.ts` | A flow renders as ~20 lines of valid Mermaid |
| **P2-T7** | OTel instrumentation on the services (R52). `http.route` free; add `code.*` attributes to key functions manually. | **OPEN-7** | Instrumented services | Server spans carry `http.route`; key functions carry `code.function.name` + `code.file.path` |
| **P2-T8** | OTLP receiver → `spans` table with tail-based sampling (R53). Pin semconv, handle both `code.*` spellings (R55). | P1-T1, P2-T7 | `src/runtime/otlp-receiver.ts` | 100% of errored traces retained; span→node joins resolve via R54 keys |
| **P2-T9** | Promotion + overlay (R56–R58): `inferred`→`observed`; never delete a static edge; "possibly dead" after 30 days; executed-vs-possible overlay in the UI. | P2-T8, P2-T5 | Promotion job + overlay | At least one `REQUESTS` edge promoted by real traffic; no static edge ever deleted by runtime |
| **P2-T10** | Error backtracking (R41, R59–R61): M.1 static surface, M.2 trace root cause, M.3 git/config correlation, M.4 three-section presentation with mandatory `UNKNOWN` line. | P2-T8 | `src/query/errors.ts` + UI view | Deepest error span identified as origin; three sections never merged; `UNKNOWN` line present whenever gaps intersect the path |
| **P2-T11** | GitHub Action (R51): PR diff → enclosing symbols → impact closure → PR comment. | P1-T13 | `.github/workflows/impact.yml` + script | Comment lists affected endpoints, segmented by confidence |
| **P2-T12** *(v2)* | Execution-path rendering (R78): per-function branch view — success paths **green**, error exits **red**, undetermined **grey**. Kept as a separate visual axis from confidence styling, with a legend stating the difference. | P1-T18, P2-T3 | Branch view in the node inspector + legend | A viewer distinguishes "this branch errors" from "we are unsure this edge exists"; grey is never mistaken for success |

### 4.4 Phase 3

| ID | Description | Depends on | Expected output | Acceptance criteria |
|---|---|---|---|---|
| **P3-T1** | `co_changed` from `git log` (R65) — the one v2 association type worth building. | P2-T10 | One table + one parser | Populated from real history; used only as a ranking signal |
| **P3-T2** | Hierarchical LLM summaries (R66, R62–R64), cached by `input_sha256`, bottom-up. | P1-T16 | `src/llm/summaries.ts` | **Structural enforcement verified**: `summaries` has no FK any traversal joins against |
| **P3-T3** | FTS5 + optional embeddings for user-story seeding (R43, R67). Port `rrf.ts` and `vector-store.ts` (see §5). | P3-T2 | `src/query/workflow.ts` | Seed choice is shown and user-correctable; paths remain deterministic |
| **P3-T4** | Optional Joern/Opengrep side-car for specific data-flow questions (R68). | P3-T3 | Side-car adapter | Invoked per-question only; never writes edges |
| **P3-T5** | Additional languages via the SCIP indexer ecosystem (R69). | P3-T3 | Additional adapters | New language joins the same `nodes` table with no schema change |

---

## 5. What to port from `D:\facilitator`

You asked that genuinely good facilitator components come into scope. I reviewed the
candidates:

| Component | LOC | Verdict | Reason |
|---|---|---|---|
| `src/retrieval/rrf.ts` | 121 | **Port as-is** | Clean rank-only Reciprocal Rank Fusion, preserves complementary representations, already has `tests/rrf.test.ts`. Exactly what R43 stage 1 needs. |
| `src/semantic/vector-store.ts` | 70 | **Port as-is** | Brute-force cosine behind a swap interface — precisely doc §B.6's recommendation. Needs a BLOB loader to read vectors from SQLite. |
| `src/serializers/toon.ts` | 152 | **Port the encoder, rewrite the decoder** | Format and encoder are sound and serve R44. The decoder is broken: `serializeArray` emits `N rows{…}` while the parser's regex only matches the `key[N]{…}` form, and row detection keys on `"rows{"` which the field form never emits. Round-tripping a bare array fails. An LLM-facing serializer mainly needs the encoder. |
| `src/retrieval/lexical.ts` | 143 | **Port the shape, fix deletion** | FTS5 setup is right (WAL, `porter unicode61`, 5-line chunks, `snippet()`). Two bugs: `content=''` declares external-content without `content_rowid`, and `removeFile` issues `'deleteall'` — which **wipes the entire index** instead of one file. Serves R43/R67. |
| `docs/database-bootstrap.ts` | 85 | **Reimplement the pattern** | Migration-runner + `PRAGMA foreign_key_check` + `integrity_check` verification is good practice worth keeping. Small enough to rewrite. |
| `src/codegraph/*` | 2,156 | **Do not port** | The regex indexer this project exists to replace. See Context. |
| `src/retrieval/sufficiency.ts` | 141 | **Do not port** | Thresholds are self-labelled `[initial] — must be benchmarked`. Task-orchestration policy, not engine. Out of scope. |
| `orchestration/`, `knowledge/`, `ambient/`, `tasks/`, `classifier.ts` | ~800 | **Do not port** | Orchestration layer, outside the engine boundary you set. |
| `docs/software-intelligence-schema.sql` + `-migration-v2.sql` | 70 KB | **Do not port** | Superseded by §H. Keep as a reference for what not to repeat. |

**Stack decisions worth carrying forward:** Node 22+ with `node:sqlite` (built-in, no
native compilation — avoids `better-sqlite3` build pain on Windows), `type: module`,
and direct `.ts` execution via `--experimental-transform-types`.

---

## 6. Unclear Requirements / Decisions Required

Nine items. **OPEN-1 to OPEN-3 block Phase 0 tasks.** The rest have recommended
defaults and can proceed under a stated assumption.

---

### OPEN-1 — Dead TypeScript trees vs. live JavaScript *(blocks P0-T3)*

- **Requirement:** R13 — run `scip-typescript` per service, `--infer-tsconfig` for plain JS.
- **Why unclear:** The doc assumes the router is TypeScript. In the corpus, `40-kri-router` and `41-kri-engine` run from a single CommonJS `server.js` (347 and 478 LOC), while their `src/` trees are ~1,600 LOC of **non-compiling** TypeScript that never executes — missing deps, wrong import paths, a Fastify 3 API (`fastify.use()`) that hard-throws on 4.x, and references to `fastify.axiosClient` where no `decorate()` call exists. `remediation/BASELINE.md` confirms it: *"All TypeScript `src/` trees in 40/41/51 are incomplete scaffolds, not used at runtime."* SCIP will index the dead tree cleanly and the live untyped CJS barely — the two signals are disjoint. The dead code describes a plausible but fictional architecture (repositories, DI, `preHandler` arrays) that would produce confident, wrong answers.
- **Possible interpretations:**
  1. Index only files reachable from the declared entrypoint.
  2. Index everything and mark unreachable symbols with a flag.
  3. Index only `src/`, treating it as intended architecture.
- **Recommended decision:** **(1)** — add `entrypoint` to `repos.json` and an explicit include/exclude set, with a reachability filter from the entrypoint. Interpretation (3) indexes a system that does not exist. (2) doubles index size for no query benefit at this stage.
- **Decision required:** Confirm reachability-filtered indexing, and confirm the `.next/**` exclusion for `60-kri-next` (its `tsconfig.include` pulls in generated route types).

---

### OPEN-2 — Project name, location and repo boundary *(blocks P0-T1)*

- **Requirement:** Your decision — "fresh project, port what's good."
- **Why unclear:** No target path, package name or git remote is established. `D:\facilitator` is not a git repo and neither is `dev-workspace`.
- **Possible interpretations:** A sibling of `D:\facilitator`; a subdirectory of it; somewhere under `C:\Users\sathish\Projects`.
- **Recommended decision:** A new git repo at `D:\code-intel` (sibling to `facilitator`, on the same drive as the corpus, easy relative paths). Package name `code-intel`. CLI binary name to be confirmed — the doc uses `syfgraph`, which no longer matches your naming.
- **Decision required:** Target path, package name, CLI binary name, and whether to `git init` (recommended — the doc's incremental model and the PR-diff feature both assume git).

---

### OPEN-3 — Phase 0 target endpoint *(blocks P0-T9)*

- **Requirement:** R70/R74 — Phase 0 proves the pipeline on one endpoint and is timeboxed to a week.
- **Why unclear:** The doc's example (`POST /api/v1/zoom/meeting`) does not exist. The corpus offers a trade-off with no obviously right answer:
  - `40-kri-router` `POST /api/v1/po` — has routes, hooks, the single `axios()` fan-out point, and the auth idiom. But it is untyped CJS, so SCIP fidelity will be poor.
  - `60-kri-next` — the only real TypeScript (`strict: true`), so SCIP fidelity is best, and it has 11 clean literal call sites. But it has **zero routes and zero hooks**, so it cannot exercise the boot channel at all.
- **Possible interpretations:** Pick one; or use both, splitting the exit criterion.
- **Recommended decision:** **Both, with split criteria.** Use `60-kri-next` to measure `CALLS` fidelity (P0-T7's false-positive number is only meaningful on typed code) and `40-kri-router` `POST /api/v1/po` for the boot channel and the end-to-end CLI tree. This costs perhaps a day and prevents mistaking "untyped JS" for "broken derivation" — which would trigger the §O.1 abandon-and-fork rule for the wrong reason.
- **Decision required:** Confirm the two-target split, or name a single target.

---

### OPEN-4 — `procurement-module` is outside the corpus

- **Requirement:** R31 — cross-service linker resolves client call sites to remote routes.
- **Why unclear:** `remediation/STAGES.md` (the newest file, 2026-09-06) states po/grn/bill are *currently* served by `procurement-module:3003` through the router when `PROCUREMENT_BASE_URL` is set. That service is **not in `dev-workspace`**. Meanwhile `BASELINE.md` and `DEPRECATION.md` still describe `:3002` as live, and `40-kri-router/server.js:8` defaults the var to `''`. Three documents disagree, and the truth depends on an env var, not on code.
- **Possible interpretations:** Model only the `:3002` edge; model both as env-conditional candidates; seed `procurement-module`'s routes from `BASELINE.md` §5 without source.
- **Recommended decision:** Treat it as the **canonical test case for env-conditional destinations**. Emit two candidate `REQUESTS` edges tagged with the env condition, or one `unresolved_calls` row — never one silently-wrong edge. This is exactly doc §Q.1's *"#1 source of wrong cross-service edges"*, so it is valuable to have in the fixture. Do not seed routes for a service you cannot index.
- **Decision required:** Confirm two-candidate modelling, and whether `procurement-module` will ever be indexable.

---

### OPEN-5 — `scip-python` environment

- **Requirement:** R18 — `scip-python index`, venv active.
- **Why unclear:** `51-integration` has no `.venv`, no `pyproject.toml`, no `__init__.py` anywhere, and its `__pycache__` shows **Python 3.14**. `requirements.txt` pins `psycopg2-binary==2.9.9`, which has no cp314 wheel — a source build will likely fail. Without a resolved environment, every third-party import indexes as unresolved external.
- **Possible interpretations:** Create a 3.11/3.12 venv for indexing only; index stdlib-only and accept unresolved externals; add packaging files to the fixture.
- **Recommended decision:** Create a **dedicated indexing venv on Python 3.11/3.12** and record the interpreter version in `repos.json`. The indexing environment does not have to match the runtime environment. Do not add `__init__.py` to the fixture — loose modules are a realistic case the engine should handle, and the symbol keys just root at file paths.
- **Decision required:** Confirm the separate indexing venv, and who provisions it.

---

### OPEN-6 — Route schemas are unavailable on this corpus

- **Requirement:** R22 / schema §H — `routes.request_schema` and `response_schema` from `app.openapi()` and Fastify route schemas.
- **Why unclear:** No Fastify route in either Node service declares a `schema:` option (`zod` is a dependency of both and imported by neither; validation is hand-rolled `if (!body.x)`). On the Python side `MailSendRequest` is *not* used as a route parameter annotation — the handler takes a raw `Request` and validates manually — so `app.openapi()` emits no `requestBody` and essentially empty `components.schemas`. Both schema columns will be **null across the board**.
- **Possible interpretations:** Accept null and defer; build an AST/Pydantic-discovery fallback; treat it as a fixture defect and add schemas.
- **Recommended decision:** **Accept null in Phase 1**, and record it as a known gap rather than building a fallback extractor for a fixture-specific problem. R72 applies — do not build a producer for a column nothing populates. Revisit if the real target repos declare schemas.
- **Decision required:** Confirm deferral, or fund the AST fallback now.

---

### OPEN-7 — Who owns OTel instrumentation and deployment

- **Requirement:** R52, R53 — Phase 2 runtime channel.
- **Why unclear:** The doc says this *"requires instrumented deployed services, which is a dependency outside your control"* and must not block Phase 1. The corpus runs locally via `start-all.ps1` and has no traffic, so there is nothing to observe without a load script.
- **Possible interpretations:** Engine team instruments the fixtures and generates synthetic traffic; a platform team instruments real services; defer Phase 2 entirely.
- **Recommended decision:** Engine team instruments the **fixtures** and writes a small traffic generator, purely to prove the ingest and promotion path. Real-service instrumentation is tracked as an external dependency with its own owner.
- **Decision required:** Name an owner for real-service instrumentation, and confirm the fixture traffic generator is in scope.

---

### OPEN-8 — LLM provider, model and budget

- **Requirement:** R62–R64 — five permitted uses, cached, small model, "cents per week."
- **Why unclear:** No provider, model or key management is specified anywhere. Facilitator has `@huggingface/transformers` as a dependency, implying local embeddings, but nothing for text generation.
- **Recommended decision:** Defer to Phase 3 (where the only LLM tasks live), behind a provider interface. Use a small Claude model for summaries. Keep local `@huggingface/transformers` for embeddings so no API dependency is needed for R67.
- **Decision required:** Provider and model, before P3-T2. Not blocking Phases 0–2.

---

### OPEN-9 — Shared-database coupling is invisible to code indexers

- **Requirement:** R5 — `READS`/`WRITES` edges to `datastore` nodes.
- **Why unclear:** `51-integration` writes to `mail_events`, a table created and owned by `41-kri-engine/migrations/001_init.sql`. This is a real cross-service coupling that **no code indexer will surface** — the services share a database, not a call. The doc's model supports it (both services get `WRITES`/`READS` edges to the same `datastore` node) but nothing in the doc's pipeline *derives* the coupling as a service-to-service relationship.
- **Possible interpretations:** Leave it implicit (two edges to one node, discoverable by query); add an explicit derived service-coupling edge; ignore it.
- **Recommended decision:** **Leave it implicit and make it a query.** Two services writing the same `datastore` node is already the doc's "data dependency" in R38. Adding a stored edge would violate R72 and duplicate what a join answers. Surface it in `impact` output as a data dependency.
- **Decision required:** Confirm — or say if you want it visualised as a first-class edge in the UI.

---

## 7. Dependencies & Recommended Implementation Order

### 7.1 Phase-level

```
OPEN-1,2,3 ──► Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
                  │            │           │
                  │            │           └── OPEN-7 (external, must not block P1)
                  │            └── OPEN-4, OPEN-5, OPEN-6
                  └── hard timebox: 1 week, else fork blarify (R74)
```

### 7.2 Task-level critical path

```
P0-T1 ─► P0-T2 ─► P0-T3 ─► P0-T4 ─► P0-T6 ─► P0-T7 ─► P0-T9  [GATE]
           │                  ▲        ▲                 ▲
           │        P0-T5 ────┴────────┘                 │
           └──────► P0-T8 ────────────────────────────────┘

P0-T9 ─► P1-T1 ─► P1-T2 ─┬─► P1-T3 ──┐
                          ├─► P1-T4 ──┼─► P1-T8 ─► P1-T9 ─► P1-T10
                          ├─► P1-T5   │              │
                          └─► P1-T6 ──┴─► P1-T7      │
                                            │        │
                          P1-T1 ─► P1-T11 ──┤        │
                                            ▼        ▼
                                  P1-T12 ─┬─────► P1-T14
                                  P1-T13 ─┤
                                          └─► P1-T15 ─► P1-T16  [GATE]

P1-T16 ─► P2-T1 ─► P2-T2 ─► P2-T3 ─► P2-T4 ─► P2-T5 ─► P2-T9
P1-T12 ─► P2-T6                              OPEN-7 ─► P2-T7 ─► P2-T8 ─► P2-T10
P1-T13 ─► P2-T11

v2 control-flow track (additive — nothing above blocks on it):

P1-T6 ─► P1-T17 ─► P1-T18 ─► P2-T12
                ▲            ▲
        P1-T12 ─┘    P2-T3 ──┘
                             └─► enriches P2-T10 (M.1 failure surface)
```

### 7.3 Ordering rationale

1. **Schema last within each phase, not first.** The v1/v2 failure was DDL written before extractors existed. P0-T5 is a deliberately minimal 6-table subset; the full §H schema (P1-T1) lands only after Phase 0's real data has shown its shape.
2. **Measurement before construction.** P0-T7 sits between the derivation and the CLI because a >10% false-positive rate invalidates everything downstream.
3. **Boot channel early.** P0-T8 has no dependency on the SCIP path and can run in parallel with P0-T3–T6.
4. **Cross-service linking after both channels exist.** P1-T7 needs tree-sitter call sites (P1-T6) *and* the remote route table (P1-T4).
5. **UI last.** Doc §Q.3 names building the UI first as the most common way this project dies.
6. **Runtime independent of UI.** P2-T7/T8 depend only on P1-T1 and the external instrumentation owner, so they can proceed in parallel with P2-T1–T5.
7. **(v2) The control-flow track is additive and late-bindable.** P1-T17 needs only the
   tree-sitter pass (P1-T6), and nothing on the Phase 1 critical path waits on it. If it
   slips, `endpoint_flow`, `impact`, `security_path` and `context_pack` all still ship —
   they simply carry no branch context. That is deliberate: it is a new capability beyond
   the source doc, so it must not be able to delay the P1-T16 gate.

### 7.4 Parallelisable work

- P0-T5 and P0-T8 alongside P0-T3/T4.
- P1-T3, P1-T4, P1-T5, P1-T6 are independent once P1-T2 lands.
- P1-T12 and P1-T13 are independent of each other.
- P2-T6 and P2-T11 are independent of the whole UI track.
- **(v2)** P1-T17 can run in parallel with P1-T7–T11; only P1-T18 needs P1-T12.

---

## 8. Completeness Check

**Every requirement mapped to a task.**

| Requirements | Covered by |
|---|---|
| R1–R12 (schema) | P0-T5, P1-T1, P1-T2 |
| R13–R17 (SCIP TS/JS) | P0-T3, P0-T4, P0-T6, P0-T7 |
| R18 (SCIP Python) | P1-T3 |
| R19 (tree-sitter) | P1-T6 |
| R20 (Semgrep check_kind) | P1-T9 |
| R21, R24, R25 (Fastify boot) | P0-T8, P1-T8 |
| R22 (FastAPI boot) | P1-T4 |
| R23 (config dump, redacted) | P1-T4, P1-T6 |
| R26 (inline auth channel — yours) | P1-T10 |
| R27–R29 (incremental) | P1-T11 |
| R30 (derivation separation) | P1-T2, P1-T7, P1-T8 |
| R31 (cross-service linker) | P1-T7 |
| R32, R33 (chain expander, closure) | P1-T8, P1-T12 |
| R34 (summaries) | P3-T2 |
| R35, R36 (endpoint_flow) | P1-T12 |
| R37–R39 (impact) | P1-T13 |
| R40 (security_path + anomaly) | P1-T14 |
| R41 (error_paths) | P2-T10 |
| R42 (context_pack) | P1-T15 |
| R43 (workflow) | P3-T3 |
| R44 (TOON/compact JSON) | P1-T15 |
| R45 (UI JSON) | P2-T1 |
| R46 (Mermaid) | P2-T6 |
| R47 (CLI) | P0-T9, extended through P1 |
| R48 (MCP) | P1-T16 |
| R49 (React Flow UI) | P2-T1 … P2-T5 |
| R50 (auth colouring — yours) | P2-T4 |
| R51 (GitHub Action) | P2-T11 |
| R52–R55 (OTel ingest) | P2-T7, P2-T8 |
| R56–R58 (promotion, overlay) | P2-T9 |
| R59–R61 (error backtracking) | P2-T10 |
| R62–R64 (LLM boundary) | P3-T2 |
| R65–R69 (Phase 3) | P3-T1 … P3-T5 |
| R70 (FP rate) | P0-T7 |
| R71 (token delta) | P1-T15 |
| R72–R74 (discipline) | Enforced in every phase's acceptance criteria |
| **R75, R76 (CFG extraction — v2)** | **P1-T17** |
| **R77 (guard attribution — v2)** | **P1-T18** |
| **R78 (green/red path rendering — v2)** | **P2-T12** |

**Dependencies logically ordered.** Yes — see §7.2. No task depends on a
later-numbered task. The three gates (P0-T9, P1-T16, and the OPEN-1/2/3 block) are
explicit.

**No major requirement missing.** All 78 requirements are mapped. Deliberate
exclusions (CodeQL, Kùzu, taint analysis, forking blarify, the v2 neural layer, 20
producerless relationship types, bitemporal edges) are listed at the end of §2 with
the doc's reasoning.

**All unresolved decisions listed.** Nine, in §6. Three block Phase 0.

**Known coverage caveats, stated rather than hidden:**
- R22's Next.js clause is **descoped by your decision** (static channel only). Recorded, not silently dropped.
- R40's security feature cannot be fully validated on this corpus without R26, which is why your addition is on the critical path rather than optional.
- R52–R61 depend on OPEN-7, which is outside the engine team's control.

---

## 9. Verification

**Phase 0 gate.**
```
npm test && npm run typecheck
node --experimental-transform-types src/cli.ts index --config config/repos.json
node --experimental-transform-types src/cli.ts flow \
  --service 40-kri-router --method POST --path /api/v1/po
```
Compare the printed tree against a hand-drawn one. Confirm the recorded false-positive
number in `docs/measurements.md` is ≤10%. Run `index` twice and diff the `flow` output —
it must be identical.

**Phase 1 gate.**
```
# incremental correctness
sha256sum before.db.dump ; touch one file ; re-index ; diff the row sets
# token delta
node ... src/cli.ts context <symbol> --budget 4000   # vs. wc -c on the raw files
# anomaly query
node ... src/cli.ts security --anomaly writes-without-tenant
# MCP smoke test from your agent setup
```
Success is the measured token delta (R71) plus a hand-verifiable anomaly result.

**Phase 2 gate.** Drive traffic at the instrumented fixtures, confirm at least one
`REQUESTS` edge flips `inferred`→`observed`, confirm no static edge was deleted, and
force a 500 to check that the deepest error span is named as origin with its
propagation chain above it.

**Standing invariants to assert in tests:**
- `summaries` is joined by no traversal query (R63, structural LLM containment).
- Runtime writes never `DELETE` from `edges` (R56).
- `confidence` is never stored as a number (R7).
- Every derivation is re-runnable from facts alone (R30).

---

## 10. Answers to "any doubt in requirements"

Beyond the nine open decisions, three things in the source doc are worth naming
explicitly because they set expectations that the corpus will not meet:

1. **The doc's central premise is corpus-dependent.** §A argues routes/middleware/auth
   ordering is "a runtime-reflection problem wearing a static-analysis costume."
   That is correct for idiomatic Fastify and FastAPI. It is **false for this fixture**,
   where auth is inline in handler bodies. Your decision to build both channels is the
   right resolution; I am flagging it because the doc reads as if boot reflection alone
   is sufficient, and it is not, in general.
2. **`THROWS` is weaker than §9-style function cards imply.** Doc §Q.2 already concedes
   this: TypeScript has no checked exceptions, the transitive union explodes within two
   or three levels, it ignores `catch`, and it misses everything thrown by libraries.
   On this corpus it is weaker still — the live code **throws nothing**; errors are
   plain data envelopes returned from builder functions. Expect `THROWS` to be nearly
   empty here. **v2 mitigates this**: R76 detects the return-an-error-value form as an
   `error_exit`, so the failure surface is populated from the idiom the corpus actually
   uses rather than from `throw` statements that do not exist.
3. **Authorization correctness is explicitly out of scope** (§Q.3). The tool can say
   which checks run in what order. It cannot say whether `requireRole('admin')` should
   have been `requireRole('owner')`. The flagship query must be *"routes that write data
   with no tenant check"*, not *"this endpoint is secure."* On this corpus that query
   will return **every write route**, since no tenant scoping exists anywhere — a
   correct and useful result, but one worth expecting rather than debugging.
