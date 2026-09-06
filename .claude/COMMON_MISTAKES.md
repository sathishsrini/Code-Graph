# Common Mistakes

**⚠️ CRITICAL - Read at session start**

This project has already failed twice (v1, v2 — see `plans/code-intelligence-engine-plan-v2.md` §Context).
Every mistake below is one that actually happened, or one the research doc
(`docs/code-intelligence-engine.md`) explicitly warns about. They are ordered by how
much damage they cause.

---

## Top 5 Critical Mistakes

### 1. Adding a table or column before an extractor populates it

**Symptom**: Schema grows faster than the code. DDL describes a system nobody has
proved can be populated. v2 shipped ~470 lines of DDL for tables with no producers,
plus 28 relationship types of which **zero** had an extractor.

**Check**: Before writing DDL, answer out loud: *which task writes the first row, and
does it run this week?* If you cannot name it, stop.

**Fix**: Requirement **R72** — nothing enters the schema until an extractor produces
it. Phase 0 deliberately ships a 6-table subset; the full 13-table schema lands only
in P1-T1, after real data has shown its shape. Expect to change a third of the
planned schema on contact with real extractor output. That is the schema working.

---

### 2. Inventing a symbol identity instead of using the SCIP symbol string

**Symptom**: `qualifiedName` built as `service.dotted.path.Name`. It is not unique
across repos, not stable across refactors, and cannot join a TypeScript symbol to a
Python one. This was **the single root cause** of the v2 failure — everything else was
downstream of it.

**Check**: `SELECT key FROM nodes WHERE kind='symbol' LIMIT 5` — the values must be
verbatim SCIP symbol strings, not something the indexer composed.

**Fix**: Requirement **R4**. Store the SCIP symbol string verbatim as `nodes.key`.
It survives reindexing, is comparable across repos for shared packages, and makes
cross-repo edges ordinary rows (**R9**) instead of requiring a mapping table.

---

### 3. Deriving edges by name matching, or only within one file

**Symptom**: The v1 indexer used `line.matchAll(/(\w+)\s*\(/g)` — which matches
`if (`, `for (`, `catch (` — then resolved targets by **suffix match** across the
file. Worse: it built `symbolMap` per file and only emitted an edge when *both* ends
were in it, so **cross-file call edges did not exist at all**.

**Check**: After indexing, assert at least one `CALLS` edge whose source and target
live in different `file_id`s. If that count is zero, the graph is intra-file only and
useless.

**Fix**: Requirements **R15–R17**. Derive `CALLS` from SCIP occurrences via an
interval tree of definition ranges — innermost enclosing definition of each reference.
Filter type-position occurrences and imports/re-exports. Then **measure the
false-positive rate on a manual sample of 50** (**R70**, task P0-T7) and write the
number down. Above ~10% the graph feels untrustworthy and adoption dies.

---

### 4. Letting an LLM write a row that a query treats as fact

**Symptom**: A hallucinated `CALLS` edge is indistinguishable from a real one and
poisons every downstream query permanently. There is no way to detect it later.

**Check**: `summaries` must be the only table an LLM writes, and no traversal query
may join against it. Grep the query layer for `summaries` — a hit inside a recursive
CTE is a bug.

**Fix**: Requirements **R62–R64**. Enforce structurally, not by discipline: LLM output
lands only in `summaries`, which has no foreign key any traversal uses. If the LLM
cannot reach `edges`, it cannot corrupt them. Permitted uses are exactly five
(explanation, summaries, narration, seed selection, `check_kind` *suggestions* for
human review). Everything else is forbidden.

---

### 5. Conflating the two visual/confidence axes

**Symptom**: Two separate mistakes that look similar.
(a) Collapsing confidence into a number — v2 had a REAL column and a TEXT enum bridged
by `>= 0.9 → 'exact'`. A 0.91 heuristic guess is **not** exact; that mapping destroys
the distinction the column exists for.
(b) Rendering "inferred" as if it meant "error path". They are orthogonal.

**Check**: `confidence` is never numeric (**R7**). In the UI, an edge can be
**dashed** (inferred — unsure the edge exists) while sitting on a **green** path
(sure that branch is the success continuation). Both must render correctly at once.

**Fix**: Two independent axes, always.
- **Line style = confidence** (R49): solid `certain` · dashed `inferred` · dotted `observed` · red `unresolved`
- **Colour = execution outcome** (R78): green `success` · red `error_exit` · grey `unknown`

The legend must state the difference (task P2-T12).

---

## Also worth remembering

- **Delete by provenance, never by node** (**R28**). Incremental update is
  `DELETE FROM edges WHERE file_id = ? AND evidence_kind IN (...)`. Nodes survive, so
  edges *into* a changed file from unchanged files survive too.
- **Runtime never deletes a static edge** (**R56**). It upgrades `inferred`→`observed`
  or adds a new `observed` row. Nothing else.
- **Store the gaps** (**R11**). `unresolved_calls` is not failure bookkeeping — a tool
  that silently omits what it could not analyse converts an unknown into a false
  negative. Render it explicitly.
- **Do not index the fixtures' dead `src/` trees.** In `40-kri-router` and
  `41-kri-engine` the `src/` TypeScript is non-compiling scaffolding that never runs;
  the live code is untyped CommonJS `server.js`. Indexing it yields a confident,
  fictional architecture. See OPEN-1.
- **Do not build taint analysis.** Doc §C fn.14 — it is a multi-year project. Shell
  out to Joern or Opengrep for a specific question if it ever becomes necessary.

---

**Last Updated**: 2026-09-06
