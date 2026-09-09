# Implementation record

One entry per plan task. Written at task completion, before the commit whose
subject carries the task ID.

Format: **what shipped** · **where it lives** · **how it was verified** ·
**what it does not do**. The last line is not optional — a task with no stated
limit has not been thought about.

Plan: [`plans/code-intelligence-engine-plan-v2.md`](../plans/code-intelligence-engine-plan-v2.md) ·
Deltas: [`PLAN-DELTAS.md`](PLAN-DELTAS.md) ·
Numbers: [`docs/measurements.md`](../docs/measurements.md)

---

# Phase 0 — prove the pipeline ✅ GATE PASSED (2026-09-07)

| Task | Commit | State |
|---|---|---|
| P0-T1 scaffold | `0cf936c` | done |
| P0-T2 repos.json + loader | `c070fbc`, `a884a79` | done |
| P0-T3 scip-typescript run | `eedc118` | done |
| P0-T4 SCIP reader | `eedc118` | done |
| P0-T5 minimal schema | `c070fbc` | done |
| P0-T6 CALLS derivation | `778e860` | done |
| P0-T7 false-positive measurement | `778e860` | done — 0% on 50 (M3) |
| P0-T8 Fastify boot dump | `8ba444b` | done |
| P0-T9 `flow` command | `ec547be` | done — **gate** |

## Phase 0 outcome

The pipeline works end to end and the printed tree for
`POST /api/v1/po` matches source line by line (M7). Two full
index → boot → flow cycles are byte-identical at 15,332 bytes.

**Three silent defects, found only by running it.** Each is written up in
`PLAN-DELTAS.md` because each changed the plan:

1. **The engine indexed a system that does not exist** ([D6](PLAN-DELTAS.md)).
   52 clean, confident edges describing a non-compiling scaffold; zero from the
   file that runs. Config had declared the file set since P0-T2 and nothing
   enforced it.
2. **`routeOptions` does not carry inherited hooks** ([D5](PLAN-DELTAS.md)).
   31 entries instead of 77 — handler-only, which renders as *"this route has no
   middleware"* and, on a security query, as *"every route is unauthenticated"*.
3. **The single most valuable edge was discarded unexamined**
   ([D7](PLAN-DELTAS.md)). `return axios(axiosConfig)` — the outbound call to the
   engine — rejected by the container filter before the call-site check ran.

**Two plan corrections:** anonymous hooks are *located*, not renamed
([D3](PLAN-DELTAS.md)); `fastify-overview` is opt-in, not the boot source
([D4](PLAN-DELTAS.md)).

**What the gate does not establish** is listed in
[`OPEN-DECISIONS.md`](OPEN-DECISIONS.md) — the indexer was never stressed, the
corpus has no plugins or `preHandler` hooks, and untyped CJS drops 86 references
as unnamed locals.

---

# Phase 1 — useful to humans and agents

| Task | Commit | State |
|---|---|---|
| P1-T1 full schema + migrations | `887cfcc` | **done** |
| P1-T2 normalizer | `59972c5` | **done** |
| P1-T3 scip-python | `ec5e845` | **wired, blocked upstream** |
| P1-T4 FastAPI boot adapter | `79fb2e1` | **done** |
| P1-T5 Next.js static indexing | — | **done** |
| P1-T6 tree-sitter pass | `99cf028` | **done** |
| P1-T7 cross-service linker | — | **done** |
| P1-T8 route chain expander | `59972c5` | **done** |
| P1-T9 Semgrep check_kind pack | — | **done** |
| P1-T10 inline auth detector | `1e5084d` | **done** · review fixes in `fix(P1-T10)` (pending) |
| P1-T11 incremental indexing | `59972c5` | **done** |
| P1-T12 `endpoint_flow` | `6e3a5a4` | **done** |
| P1-T13 `impact` | `8d050ec` | **done** |
| P1-T14 `security_path` | `180ca9b` | **done** |
| P1-T15 `context_pack` | `9dac246` | **done** |
| P1-T16 MCP server | `27b82e9` | **done — PHASE 1 GATE** |
| P1-T17 intra-function CFG | `649d861` | **done** |
| P1-T18 guard attribution | `649d861` | **done** |

## P1-T1 — full schema + migration runner

**Shipped.** A migration runner (`src/store/migrate.ts`) that applies numbered
SQL files in order, records each in `schema_version`, and runs each in its own
transaction so a failure in 003 leaves 001 and 002 applied rather than rolling
the database back to nothing. `SCHEMA_VERSION` is derived from the last file on
disk, never hand-typed.

Two migrations:

| File | Tables | Producer |
|---|---|---|
| `001_phase0_core.sql` | repos, runs, files, nodes, symbols, edges | P0-T3…T8 (frozen as shipped) |
| `002_phase1_routes.sql` | routes, route_chain, unresolved_calls | P1-T4/T8/T10/T11 |

`FactStore` gained `upsertRoute`, `insertChainEntry`, `deleteChain`,
`insertUnresolved`, `deleteUnresolvedByProvenance` and `routeNodeIds`.
`db bootstrap` now prints the version and what it applied.

**Verified.** 149 tests pass, `tsc --noEmit` clean. The migration-specific ones
assert the properties a re-run of a schema file does not have: applied-once,
ordered, recorded, and rolled back per file on failure. Two more assert
behaviour the DDL alone would not give — that re-running the boot channel
cannot delete the inline-auth channel's chain rows (the property R26 rests on),
and that `unresolved_calls` deduplicates across re-runs despite its NULL
columns.

**Deviations.** [D9](PLAN-DELTAS.md) — `spans` and `summaries` ship with their
producers, and a test asserts their absence. [D10](PLAN-DELTAS.md) —
`journal_mode` in a migration is a silent no-op; both pragmas moved to the
connection and the runner now rejects the mistake.

**Does not do.** No down-migrations: a schema change that needs one is a new
file that undoes the old shape, because a reversible migration that has never
been reversed is untested code. No cross-database consistency check — nothing
verifies that two engineers' databases are at the same version before their
outputs are compared.

## P1-T2 — normalizer

**Shipped.** `src/normalize/keys.ts` (canonical keys for all seven node kinds)
and `src/normalize/graph.ts` (`GraphWriter`, the single door between "an
extractor found something" and "a row exists").

**Verified.** A symbol in `60-kri-next` joins a route in `40-kri-router` through
one plain `edges` row, with no mapping table and no repo qualifier. Two
services writing `mail_events` from different languages land on one
`datastore` node.

**Does not do.** No key migration path: changing a key format orphans existing
rows, and nothing detects that. Acceptable while the store is rebuilt per run;
it stops being acceptable the moment `spans` carries history worth keeping.

## P1-T6 — tree-sitter pass

**Shipped.** `src/static/treesitter/` — `parser.ts` (WASM grammars, lazy and
cached), `extract.ts` (the four R19 extractors plus URL expressions, env
bindings and function ranges), `files.ts` (enumeration through the same
include/exclude the SCIP indexer uses), `ingest.ts` (findings → edges) and
`report.ts` (the `scan` command).

**Verified.** All four corpus repos scan with zero parse errors:

| Repo | files | THROWS | READS/WRITES | config | http |
|---|---|---|---|---|---|
| `40-kri-router` | 1 | 0 | 0 | 7 | 1 |
| `41-kri-engine` | 1 | 0 | 17 | 8 | 0 |
| `51-integration` | 1 | 0 | 1 | 8 | 0 |
| `60-kri-next` | 12 | 3 | 0 | 1 | 1 |

The two findings that matter for the next task are both present and both
correctly shaped: `axios(axiosConfig)` records the config identifier rather
than an empty call, and the `PROCUREMENT_BASE_URL` ternary yields two
destination candidates rather than one.

**Deviations.** [D11](PLAN-DELTAS.md) WASM not native ·
[D12](PLAN-DELTAS.md) THROWS is 0 on every backend ·
[D13](PLAN-DELTAS.md) an HTTP call site is not an edge until P1-T7 resolves it.

**Does not do.** SQL comes from string literals only — a query assembled from
fragments or issued through an ORM is invisible, and a multi-table join reports
the first table. `.sql` files have no grammar loaded, so
`41-kri-engine/migrations/001_init.sql` creating `mail_events` is not seen;
the OPEN-9 coupling is therefore currently one-sided in the graph (the Python
writer is present, the owning migration is not). Attribution falls back to the
*file* node when SCIP has no definition covering the line, never to the nearest
symbol — a `WRITES` edge on a guessed function would be read as fact by R40's
anomaly query.

## P1-T4 — FastAPI boot adapter

**Shipped.** `adapters/fastapi/boot_dump.py` (~290 LOC — the plan estimated
~80; the extra is location resolution, the dependency recursion and the
warnings channel) and `src/boot/fastapi.ts`, which narrows the artifact onto
the same `BootDump` the Fastify channel produces. `boot dump` now dispatches on
`repos.json`'s `framework` and runs the declared `pythonBin`.

**Verified on `51-integration`:** 3 routes, 9 chain entries, **0 anonymous, 0
unlocated**, 4 non-API routes counted and skipped. Every chain entry resolves
to `file:line`. The dependency-recursion half of R22 is verified against
`tests/fixtures/fastapi-dump.json`, because the corpus has zero `Depends` —
so without a fixture that code would have shipped unexercised.

**Deviations.** [D14](PLAN-DELTAS.md) Starlette middleware order is the reverse
of source order · [D15](PLAN-DELTAS.md) one downstream shape without flattening
the frameworks · [D16](PLAN-DELTAS.md) `generatedAt` is empty for determinism.

**Does not do.** No `include_router(prefix=...)` case in the corpus, so prefix
composition is taken from `route.path` (which FastAPI has already composed) and
never re-derived — correct, but untested against a nested router. OPEN-6 holds:
`app.openapi()` produces no component schemas because the handler takes a raw
`Request`, so `routes.request_schema` stays null and the artifact says so in
`warnings` rather than leaving an unexplained column of nulls. Security
dependencies are reported and are **zero on this corpus** — `51-integration`
compares a bearer token inside the handler, so it is authenticated and reports
no security dependency, exactly as `POST /api/v1/po` does on the router.

## P1-T8 + P1-T11 — route chain expander, and the indexing pipeline

Shipped together because neither is usable alone: the expander needs symbols in
the store, and the pipeline has nothing to write without it.

**Shipped.** `src/derive/routes.ts` (boot artifact -> `routes`, `route_chain`,
`HANDLES`), `src/index/incremental.ts` (hash, changed set, provenance delete)
and `src/index/pipeline.ts` (`index` command: hash -> purge -> SCIP ->
tree-sitter -> boot, in that order and for stated reasons).

**Verified — full corpus, fresh database:**

| Repo | symbols | calls | routes | chain | HANDLES | unjoined |
|---|---|---|---|---|---|---|
| `40-kri-router` | 171 | 89 | 23 | 77 | 69 | 0 |
| `41-kri-engine` | 443 | 257 | 21 | 71 | 63 | 0 |
| `51-integration` | 0 | 0 | 3 | 9 | 0 | **6** |
| `60-kri-next` | 175 | 150 | — | — | — | — |

1,452 edges, 883 nodes, `foreign_key_check` and `integrity_check` clean.
A second `index` with nothing changed does no work and says so per repo.

`51-integration`'s six unjoined entries are correct and are the visible shape
of a missing channel: `scip-python` is P1-T3, so no symbols exist to join to.
The report names the missing artifact by path rather than showing a zero.

**Deviations.** [D17](PLAN-DELTAS.md) the generated tsconfig indexed *nothing*
on `60-kri-next` — D6 from the other direction, and invisible because a stale
`.scip` made every downstream number look plausible.
[D18](PLAN-DELTAS.md) a stale boot artifact surfaced as an unattributed SQL
bind error; `readBootDump` now validates and names the route.

**Does not do.** R29 is coarse: any changed file re-runs the whole repo's
derivations, because `CALLS` comes from a whole-index interval walk and SCIP
emits no per-file index. Re-indexing does not re-run `scip index` or
`boot dump` — artifacts are read, not built, so indexing a service never
requires booting it. There is no reverse migration for a node whose key format
changes.

## P1-T3 — scip-python pipeline

**Shipped.** `runScipPython` in `src/static/scip/runner.ts`, `scip index`
dispatching on `repos.json`'s `lang`, `pythonBin` declared for
`51-integration`, and `scripts/patch-scip-python.mjs` wired as `postinstall`.
Ingest is the shared SCIP path — both indexers emit SCIP, so nothing downstream
knows which language it came from.

**Blocked, not done.** `@sourcegraph/scip-python@0.6.6` crashes at import on
Windows, and once patched past that it exits 0 having written an 88-byte index
with zero documents — on the corpus, on a clean path, and on a synthetic
package. Full evidence in [`docs/measurements.md` M8](../docs/measurements.md);
decisions in [D19](PLAN-DELTAS.md) and [D20](PLAN-DELTAS.md).

**What that leaves.** `51-integration` contributes 3 routes, 9 chain entries and
its tree-sitter findings, and **no symbols and no call edges**. Six chain
entries report `unjoined` and `index` names the missing artifact by path. A
missing channel, not an empty service — and the output says which.

**Two guards worth keeping regardless of the blockage.** `ok` now checks output
size rather than exit code alone, and a missing artifact is reported by name.
An indexer that exits 0 after writing a metadata header is not a success, and
reporting it as one is the confident-wrong-answer failure this project exists
to stop.

**Does not do.** OPEN-5 stays open — its real question was who provisions a
working indexer, and on this platform nobody has. The venv decision is
implemented (`pythonBin` is declared, not discovered) but unexercised.

## P1-T5 — Next.js static indexing

**Shipped.** Formal coverage of the Next.js framework variant through reuse of
the shared SCIP runner. `config/repos.json` declares `framework: "nextjs"` with
static includes (`app/**`, `lib/**`) and generated-content exclusion (`.next/**`,
`node_modules/**`). `src/static/scip/runner.ts` generates a temporary tsconfig
with `erasableSyntaxOnly` and applies `documentAllowed` to filter by include/exclude.
`src/cli.ts` intentionally rejects `boot dump` for Next.js.

**Verified.** Typecheck clean, all 225 tests pass. Dedicated tests in
`tests/next-indexing.test.ts` assert: static-only configuration, generated
content exclusion, include/exclude behavior, and that the declared file set is
not accidentally broadened. Existing `tests/scip-runner.test.ts` confirms glob
matching and exclusion invariants for Next.js repos.

**Does not do.** No route extraction for Next.js — boot reflection is scoped to
Fastify and FastAPI. The live `scip-typescript` run against external fixtures
depends on those fixtures being mounted and the indexer being installed.

## P1-T7 — cross-service linker

**Shipped.** A pure resolver (`src/derive/cross-service.ts`) that converts
tree-sitter HTTP call sites into provenance-backed cross-service edges.
Resolved after an independent review caught that the first implementation
produced **zero correct edges** on the corpus (see [D22](PLAN-DELTAS.md)).
The corrected design iterates **URL expressions**, attributes each to its
enclosing function, and accepts it only when that function — or a wrapper it
calls by name, such as the corpus `forward()` — contains an HTTP client call.
Base URL resolution goes through the env-binding map (env var identity, not
local variable name); host matching requires a loopback host plus a declared
port; the env-conditional ternary produces two candidate edges or honest gaps,
never one silently-wrong edge; bare `/…` literals are path literals, not URLs.

Store/pipeline integration wired: `src/index/pipeline.ts` now exports
`linkCrossServiceRepos`, which runs after all repo-local indexing and writes
`REQUESTS` edges via `GraphWriter` and cross-service gaps via
`deleteEdgesByTypeAndProvenance` / `deleteUnresolvedByProvenanceAndKind`.
`FactStore` gained `deleteEdgesByTypeAndProvenance` and
`deleteUnresolvedByProvenanceAndKind` to scope incremental deletion to only
cross-service evidence.

**Verified.** Typecheck clean, all 230 tests pass. Corpus run: `40-kri-router`
yields **2 REQUESTS** (L216/L298 → `51-integration POST /api/v1/mail/send`)
and 4 honest gaps (L176's two ternary branches, L127's dynamic path, one
unconsumed CORS origin); engine 0, integration and frontend report their base
URLs and dynamic paths honestly. Nine corpus-shaped tests encode these shapes.

**Deviations.** [D13](PLAN-DELTAS.md) an HTTP call site is not an edge until
P1-T7 resolves it (deferred from P1-T6). [D22](PLAN-DELTAS.md) records the
zero-edges correction above.

**Does not do.** No semantic URL normalization beyond the canonical route key.
No resolution of calls to services outside the declared `repos.json` set. No
bearer-token or OAuth inference — that is P1-T10's scope.

## P1-T9 — security check-kind rule pack

**Shipped.** A reviewed, deterministic rule pack for classifying security
helper calls. `rules/check-kinds.yml` contains the reviewed vocabulary. A
deterministic YAML parser in `src/static/security-rules.ts` loads and classifies
exact helper names. The parser rejects malformed rule structure, skips comments,
and the classifier only matches exact helper names (no partial matches).

**Verified.** Typecheck clean, all 230 tests pass. Dedicated tests in
`tests/security-rules.test.ts` cover: valid YAML loading, exact match
classification, unknown helpers returning null, and malformed structure
rejection. The corpus's real helper names are classified — including
`serviceAuth` (41-kri-engine:77, the engine's service verifier) under `auth`.

**Does not do.** The initial helper list is based on the validation corpus and
must be reviewed against production helper implementations before P1-T10 inline
security detection uses it. No evidence or database writes from this module —
that is the inline detector's job. See [D21](PLAN-DELTAS.md): the pack ships as
a deterministic YAML-subset loader, not a Semgrep/Opengrep invocation.

## P1-T10 — inline security-check detector

**Shipped.** `src/static/inline-auth.ts` — the detector and its boot wiring.
Scans only the boot dump's `phase="handler"` entry per route (a middleware that
does auth is already a boot row, not inline) and resolves FastAPI's
decorator-leading handler with a line / line+1 probe. Two idioms, two inference
strengths, both `inferred`/`treesitter`, discriminated by a new
`route_chain.detail TEXT` column (migration 003, filled only here; boot rows
keep it NULL):

- **JS sentinel-return** — `const authErr = checkUserAuth(req, reply); if (authErr) return authErr;`
  binds a reviewed helper name from P1-T9's pack →
  `detail: reviewed helper checkUserAuth`. A bare call with no guard is emitted
  too, as `detail: reviewed helper X, unguarded call` — a discarded result does
  not stop the request, and the label says so. Nested closures are pruned.
- **Python header-compare-and-early-401** — a header read traced through local
  bindings (fixpoint over assigned names) or read inline in the guard
  condition, with a 401 early return →
  `detail: header-compare-and-early-401 shape, no named helper`. `check_kind`
  is asserted `"auth"` here (a 401 is auth by definition), not read from the
  pack — [D23](PLAN-DELTAS.md) records that second provenance.

`ingestInlineChecks` calls `store.deleteChain(routeNodeId, ["treesitter",
"semgrep"])` before inserting, mirroring the boot channel's `["boot"]` — so
**un-reviewing a helper removes its rows** instead of leaving a revoked rule
asserting coverage (the D5 direction). Wired in `src/index/pipeline.ts` (step 5,
rules loaded from `rules/check-kinds.yml` once); `IndexReport.boot.inline`.
Stale rows are also covered by provenance delete (R28) when the handler file
itself changes.

**Verified.** Typecheck clean, **247/247** tests pass (17 in
`tests/inline-auth.test.ts`, including the no-producer-writes-`semgrep`
structural scan and an un-review-empties-rows regression). Fresh corpus index:

| Service | inline | evidence | lines |
|---|---|---|---|
| `40-kri-router` | 16 | `checkUserAuth` | 169 (via `proxyToEngine`), 292 (mail handler) |
| `41-kri-engine` | 15 | `serviceAuth` | 196/238/263/282/333/355/374/433/455 |
| `51-integration` | 2 | shape match | 122 (token), 125 (integration key) |

Zero `'semgrep'` rows. No false positives: the public paths (`auth/login`,
`auth/register`, `OPTIONS /*`, `health`, `ready`) correctly have no inline row.
`POST /api/v1/po` now reports authenticated — the point of R26. Un-review
round-trip measured on the corpus: removing `serviceAuth` and `index --force`
drops 15→0 engine rows; restoring returns them.

**Deviations.** [D23](PLAN-DELTAS.md) — the evidence decision (`'semgrep'`
never), the `detail` discriminator, split `check_kind` provenance, the
unguarded-call label, coverage limits, and the R27 boundary (a rule-file edit
needs `index --force`; hashing the config into the change set was considered
and refused there).

**Does not do.** Only the first handler function is scanned — a check inside a
nested helper the handler calls is the call tree's job (R35–R39), not R26's.
The JS branch requires a reviewed-pack name, so an unnamed inline JS guard is
missed. The Python branch is 401-specific; a 403 tenant shape does not match.
No Semgrep process runs; `'semgrep'` is a reserved future value.

---

# Current status — 2026-09-07 (session end)

## Completed

**Phase 0 gate passed.** P0-T1…T9 all done (`0cf936c`…`ec547be`). Pipeline works
end to end; two full index → boot → flow cycles byte-identical at 15,332 bytes.

**Phase 1, done: P1-T1, P1-T4, P1-T5, P1-T6, P1-T7, P1-T8, P1-T9, P1-T10,
P1-T11.** Engine spans boot reflection, tree-sitter static evidence, the
cross-service linker, the rule pack, inline security detection and incremental
indexing. `51-integration` remains symbol-less because `scip-python` is
blocked upstream (P1-T3, [D19/D20](PLAN-DELTAS.md)) — routes, chain entries
and treesitter findings still land.

## Pending

- **Commit the review-fix set** for P1-T10 as `fix(P1-T10)`: the plan-file
  restore (staged), `src/static/inline-auth.ts` (delete-before-insert,
  unguarded-call label, dead fallback removed), `tests/inline-auth.test.ts`
  (two new regression tests), and this record's new entries with
  [D23](PLAN-DELTAS.md).
- **P1-T12 `endpoint_flow` · P1-T13 `impact` · P1-T14 `security_path` ·
  P1-T15 `context_pack` · P1-T16 MCP · P1-T17 CFG · P1-T18 guard attribution**
  — all `not started`.
- **P1-T3 `scip-python`** — wired, blocked upstream (OPEN-5: who provisions a
  working indexer). `P1-T2` normalizer row reconciled (done in `59972c5`).
- **OPEN items** — see [`implementation/OPEN-DECISIONS.md`](OPEN-DECISIONS.md).

## Plan changes made during development

The plan file itself is never edited
([`implementation/README.md`](README.md) rule 2); every divergence is the
amendment register [`implementation/PLAN-DELTAS.md`](PLAN-DELTAS.md), currently
**D1–D23**:

| # | In one line | Task |
|---|---|---|
| D1 | `syntaxKind` can't filter type positions → symbol-grammar filter | P0-T4/T6 |
| D2 | the call-site check is a required gate, measured in both directions | P0-T6/T7 |
| D3 | anonymous hooks are *located*, not renamed | P0-T8 |
| D4 | `fastify-overview` is opt-in, not the boot source | P0-T8 |
| D5 | `routeOptions` lacks inherited hooks → owning-instance capture | P0-T8 |
| D6 | OPEN-1 enforced by a generated tsconfig, not config alone | P0-T3/T9 |
| D7 | namespace targets are `unresolved_calls`, not noise | P0-T9 |
| D8 | `edges` identity needs COALESCE, not a plain UNIQUE | P0-T5 |
| D9 | `spans`/`summaries` ship with their producers | P1-T1 |
| D10 | pragmas are connection state; migrations are schema | P1-T1 |
| D11 | tree-sitter runs as WebAssembly, not native | P1-T6 |
| D12 | THROWS is 0 on every backend — that is the finding | P1-T6 |
| D13 | an outbound call site is not an edge yet | P1-T6 |
| D14 | Starlette middleware order is the reverse of source order | P1-T4 |
| D15 | one downstream shape, two frameworks, unflattened | P1-T4 |
| D16 | `generatedAt` is empty on purpose (determinism) | P1-T4 |
| D17 | a trailing `**` tsconfig glob indexed nothing | P1-T11 |
| D18 | a stale boot artifact surfaces as a named bind error now | P1-T11 |
| D19 | `scip-python` is patched at install time, on Windows | P1-T3 |
| D20 | the Python channel is wired and blocked, and says so | P1-T3 |
| D21 | R20's pack is a YAML-subset loader, not a Semgrep run | P1-T9 |
| D22 | P1-T7 v1 produced zero correct edges → URL-first resolver | P1-T7 |
| D23 | P1-T10 evidence is treesitter-only; kind sources are split | P1-T10 |

## P1-T12 — `endpoint_flow`

**Shipped.** `src/query/endpoint-flow.ts` (recursive CTE closure, depth cap,
cycle guard, `min_conf` folded in SQL, boundary termination by node kind,
cross-service recursion with a visited-route guard, `unresolved_calls` attached
as explicit unknown branches) and `src/query/endpoint-flow-render.ts`.
Migration 004 adds `route_chain.end_line`.

The Phase 0 artifact-reading `flow` is kept behind `--artifacts`. It is the only
way to check a service's flow *without* trusting the store, which is exactly
what you want when the question is whether the store is right.

**Verified on `POST /api/v1/po`.** Chain of 3 boot entries plus 1 inline auth
check; `proxyToEngine` calls `checkUserAuth` → `isPublicAuthPath` /
`envelopeError` → `nowIso`, `forward` twice, then crosses a `REQUESTS` edge into
`51-integration POST /api/v1/mail/send` and renders that service's own chain and
its two shape-matched inline checks in place. UNKNOWN carries the `axios` gap,
the fastify module gap, and OPEN-4's two `PROCUREMENT_BASE_URL` /
`41-kri-engine` candidates. 263 tests pass.

**Deviations.** [D24](PLAN-DELTAS.md) — four defects found by running it, none
of which failed a type check or a test first: M7's module-scope regression, a
path-key collision that duplicated children, inline checks reported as false
gaps, and `npm:typescript@5.9.3` as the graph's largest external node.

**Does not do.** `min_conf` folds edge confidence only; a path that intersects
an `unresolved_calls` gap is reported in UNKNOWN but does not downgrade the
tree's own confidence, because the gap is not on an edge. Remote recursion is
breadth-unbounded — a service calling twenty others expands all twenty. No
result cache, so a repeated query re-walks; immeasurable at corpus size and it
will not be at real size.

---

# Phase 1 outcome — gate passed (2026-09-09)

17 of 18 tasks done; **P1-T3 is wired and blocked upstream**
([M8](../docs/measurements.md)).

## What the engine does now

```
node src/cli.ts index                                    # all channels -> store
node src/cli.ts flow --repo X --method POST --path /p    # what executes here
node src/cli.ts impact <symbol>                          # what breaks
node src/cli.ts security --repo X                        # coverage + anomaly
node src/cli.ts context <symbol> --measure               # minimum edit context
node src/cli.ts mcp                                      # all four over MCP
```

339 tests, `tsc --noEmit` clean, `foreign_key_check` and `integrity_check`
clean, a second `index` with nothing changed does no work and says so.

## The numbers

| | |
|---|---|
| nodes / edges | 883 / 1,452 |
| routes / chain rows | 47 / 157 |
| inline security checks | 33 across three services |
| CFG functions / blocks | 94 / 256 |
| CFG exits | **7 error, 25 success** — against **3** `THROWS` edges total |
| cross-service `REQUESTS` | 2, both hand-verified |
| `context_pack` vs file dump | 4–26% signatures-only (M9) |

## The gate

R71's number is measured and recorded, and the finding is not the headline: the
pack's value is the **structure**, not the source. With tier-1 source it ranges
23–109%; without, 4–26%. On a single-file service the file dump is already
close to minimal, so these are the corpus's worst case.

## What Phase 1 does not establish

1. **`scip-python` does not run here**, so `51-integration` contributes routes,
   chain rows and tree-sitter findings and **no symbols, no call edges**. Six
   chain entries report unjoined. OPEN-5 is open.
2. **Attribution is coarse where the corpus is anonymous.** Every config read
   and SQL literal lands on a *file* node, because they sit at module scope or
   inside anonymous handlers and `ownerSymbol` refuses to guess a function.
   Reported, and labelled `[file-scope]` everywhere it surfaces.
3. **27 functions have no symbol to key a CFG on**, for the same reason.
4. **No runtime channel.** `spans` has no producer until P2-T8, and every query
   that would use it says "no producer", never "no evidence".
5. **The corpus is not representative.** One to twelve small files per service,
   zero plugins, zero `preHandler` hooks, no tenant scoping anywhere. The
   anomaly query returning every write route is correct *and* is what plan §10
   note 3 predicted.

## The pattern worth carrying into Phase 2

Every defect found in Phase 1 passed `tsc` and the suite, and every one was a
**confident wrong answer** visible on the first real run:

| | |
|---|---|
| D17 | the generated tsconfig indexed *nothing* on the one repo with directory includes |
| D18 | a stale boot artifact failed as an unattributed SQL bind error |
| D22 | the cross-service linker produced zero correct edges |
| D24 | M7's module-scope defect returned; a path-key collision duplicated tree children; `npm:typescript` was the graph's largest external node |
| D25 | `impact` reported `/health` as affected by `checkUserAuth`; a route counted but in no bucket; certain evidence relabelled inferred |
| — | `if (authErr) return authErr;` produced a guard with no exit, and the corpus's dominant error shape classified as **success** |

None of these were type errors. **Run it against real data before believing it.**

---

# Phase 2 — visualisation and runtime

| Task | Commit | State |
|---|---|---|
| P2-T1 UI shell (elkjs + SVG) | `d5df0ee` | **done** (D26) |
| P2-T2 ordered chain band | `d5df0ee` | **done** |
| P2-T3 node inspector | `d5df0ee` | **done** |
| P2-T4 confidence + security-provenance colouring | `d5df0ee` | **done** |
| P2-T5 service grouping and filters | `d5df0ee` | **done** |
| **P2-T6 Mermaid emitter** | `a5ac611` | **done** |
| P2-T7 OTel instrumentation | `d8c838f` | **done for fixtures** (OPEN-7: real services still external) |
| P2-T8 OTLP receiver → `spans` | `30324e7` | **done** |
| P2-T9 promotion + overlay | `30324e7` | **done (overlay is P2-T5)** |
| P2-T10 error backtracking | `b3bf145` | **done** |
| P2-T11 GitHub Action | `c5b1505` | **done** |
| P2-T12 execution-path rendering | `d5df0ee` | **done** |

## P2-T6 — Mermaid emitter

**Shipped.** `src/serializers/mermaid.ts`, behind `flow --mermaid`. Ships before
the UI and independently of it: a diagram that renders in a PR comment is read
by people who will never open a UI, and it costs a hundred lines rather than an
app. Doc §Q.3 names building the UI first as the most common way this class of
project dies.

**The two axes stay separate.** Confidence is the *link* style
(solid / dashed / thick-red); kind and outcome are the *node* class. R50's two
security channels are filled green vs outlined-dashed green — not two shades of
one colour.

**Four defects from the first real render**, every one of them drawing something
the data does not support: a self-loop where a `REQUESTS` edge already lands on
the remote route node; duplicate arrows for two call sites to one callee;
orphaned gap nodes floating attached to nothing; and raw SCIP symbols as labels,
wider than the rest of the diagram together. Plus one arbitrary edge — several
anonymous hooks join the same module symbol, so a module-scope gap attached to
whichever chain step happened to be last. Those now attach to the route.

**Does not do.** No `function_cfg` overlay yet — R78's green/red execution paths
are P2-T12, and this emitter carries kind and confidence only. Node cap is 40,
above which it truncates and says so; a genuinely large flow needs the UI.

---

# Phase 2 outcome — all 12 tasks (2026-09-09)

```
node src/cli.ts otlp serve        # OTLP/HTTP receiver -> spans
node src/cli.ts traffic           # drive the instrumented fixtures
node src/cli.ts promote           # confirm inferred edges against traces
node src/cli.ts errors  --repo X --method POST --path /p
node src/cli.ts flow    --repo X --method POST --path /p --mermaid
node src/cli.ts ui                # the viewer
git diff main...HEAD | node src/cli.ts pr-impact
```

407 tests, `tsc --noEmit` clean.

## Phase 2's acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Flow renders with swim-lanes; line styles reflect confidence | ✅ 20 nodes, 2 lanes, 24 edges on `POST /api/v1/po` |
| 2 | Boot-verified vs inline-inferred visually distinguishable | ✅ filled vs outlined-dashed, and in the route picker before opening |
| 3 | A real errored trace resolves to the deepest error span | ✅ `ECONNREFUSED` at depth 1, propagating to a 502 |
| 4 | At least one `REQUESTS` edge promoted `inferred`→`observed` | ⚠️ **not demonstrated** — see below |
| 5 | Three sections render; `UNKNOWN` appears whenever gaps intersect | ✅ |
| 6 | Branches green/red/grey, separate from the confidence axis | ✅ 7 control-flow views on that route |

**Criterion 4 is the honest gap.** Promotion is implemented and tested, and a
cross-service `REQUESTS` edge needs a *client* span whose callee resolves — the
router's outbound calls go to `41-kri-engine` and `51-integration`, and running
those under the preload was not done here. What the corpus produced instead was
**`ECONNREFUSED` to a service that was down**, which is a real trace and a real
error path but not a promotion. Five routes were confirmed by template match;
zero `REQUESTS` edges were promoted.

## The finding worth carrying

[M10](../docs/measurements.md): **`http.route` does not come free.** R52 says it
does and R54 makes it the primary join key; 19 spans arrived with it NULL on
every one. It is set by *framework* instrumentation, not HTTP instrumentation —
only the router knows which template a concrete path matched.

Two queries joined on it and both silently found nothing. The worse one:
`errors --path /api/v1/auth/login` reported *"no errored trace recorded"* for a
route that had just returned three 502s.

## Two independent passes, agreeing

The strongest thing the corpus produced:

```
STATIC   server.js:161  proxyAuth  return_error  KRI40-DOWNSTREAM-TIMEOUT-001  when: e
OBSERVED trace b01dac3b…  ORIGIN depth 1  ECONNREFUSED  ->  502
```

The static surface predicted `proxyAuth` returns a downstream-timeout error
from its `catch`; three real traces show exactly that. Neither pass read the
other's result. That is R41 working rather than a coincidence — and it is the
first time in this project that the two channels have confirmed each other
rather than covering for each other.

## What Phase 2 does not establish

1. **No `code.*` spans**, so the span→symbol join (R54's second key) is wired
   and unexercised — 0 symbols matched. Manual spans per function are required
   and `preload.mjs` deliberately does not add them wholesale, because wrapping
   every function changes the shape of the thing being measured.
2. **One service instrumented**, so nothing cross-service was observed.
3. **"Possibly dead" reports 1,260 edges** against 19 spans. Correct and
   useless in equal measure, which is why it prints the span count beside it.
4. **The UI is untested by a human.** Its payload is asserted; its usability is
   not, and no amount of test coverage substitutes for someone opening it.

---

# Phase 3 — depth (open-ended)

| Task | Commit | State |
|---|---|---|
| **P3-T1 `co_changed` from git** | `a1d409b` | **done** |
| P3-T2 hierarchical LLM summaries | — | blocked on OPEN-8 (provider not chosen) |
| **P3-T3 FTS5 + embeddings for seeding** | `d33c8cc` | **done — lexical only; OPEN-8 blocks vectors** |
| P3-T4 Joern/Opengrep side-car | — | not started |
| P3-T5 additional languages | — | not started |

## P3-T1 — `co_changed`

**Shipped.** Migration 008, `src/derive/co-changed.ts`, `co-changed` command
(derive with no argument, query a file with one).

**Why this one survived the v2 cull:** it is derived from *evidence* — two files
appeared in N of the same commits, checkable by anyone with `git`. The other 20
v2 association types were dropped because nothing produced them.

**Verified on this repository's own history:** 47 commits, 125 files, 919 pairs.
The top results are correct and recognisable —
`implementation/RECORD.md ↔ src/cli.ts` (16 commits; every task adds a command
and a record entry) and `package-lock.json ↔ package.json` (7).

**Two exclusions that decide whether the table is usable.** Merge commits are
excluded: a merge touches the union of both branches and pairs every file in one
with every file in the other. Wide commits are excluded for the same reason at a
smaller scale — a 400-file reformat contributes 79,800 pairs of pure noise. The
cap is declared and adjustable, not tuned into a constant.

**Does not do.** No renames followed (`--follow` is per-path and does not
compose with `--name-only`), so a moved file starts a new history. Nothing
joins this table in a traversal — it is a ranking signal and treating a high
score as a dependency is exactly the mistake it must not enable. The corpus is
not a git repo, so on that data the command correctly reports *unavailable*
rather than zero pairs.

## P3-T3 — FTS5 + embeddings for seeding

**Shipped.** Migration 009 (`search`, `search_meta`, `search_vectors`),
`src/index/search.ts` (the index build), `src/query/workflow.ts` (stage-1 seed
resolution), `src/retrieval/{rrf,vector-store}.ts`, and `search` / `search build`
CLI commands (P3-T3; R43 stage 1, R66, R67).

**What it is.** Stage-1 seeding only. A search result never becomes an answer;
it becomes the *starting node* of one. A phrase is matched three ways against
the FTS5 table (`name`, `qualified`, `signature`, `doc`, `path`): every token
AND-ed, the phrase fused into one token (so `checkUserAuth`, one FTS5 token,
matches "check user auth"), and that fused token as a prefix. An optional
`EmbeddingProvider` additionally indexes rows into `search_vectors` (R67), and
the lexical/vector signals are merged by RRF (`src/retrieval/rrf.ts`) — ranked,
never score-averaged, so one signal's magnitude cannot bury another's. Neutral
cosine (≤ 0) is excluded: "no evidence" is not corroboration.

**The correction is the protocol.** The CLI prints the candidate list and the
chosen seed; `--seed <key>` overrides it and every deterministic query below
(flow / impact) then runs on the *corrected* seed, matching the stage-2+3 flow
a person does in their head (R43 §3.2).

**Verified.** 21 new tests (`tests/search.test.ts`), 437 total ✓. Premise proven
in-suite: `checkUserAuth` indexes as one FTS5 token, so the spaced phrase hits
only via the fused signal. End-to-end on the live store:
`node src/cli.ts search "POST po"` seeds `POST /api/v1/po` and renders the full
cross-service flow — and "user auth" seeds a Next.tsx Ctx `user` type (bm25
exact-token win), which is corrected with one `--seed` flag.

**Ports from `D:acilitator`, against plan §5's verdicts.**

| Module | §5 said | What happened |
|---|---|---|
| `rrf.ts` | port as-is | Ported. `score` made **optional** — a source with no meaningful score should not invent one to take part, and fusion reads rank anyway. `retrievalCount` exposed, because "two signals agreed" is the number worth reading. |
| `vector-store.ts` | port as-is | Ported behind a swap interface, per doc §B.6: brute-force cosine is exact and fine to 50–100k vectors; this corpus has ~900. No ANN dependency taken. |
| `lexical.ts` | port the shape, fix deletion | **Not ported.** Both its bugs are structural: `content=''` without `content_rowid` makes the table contentless, so `snippet()` silently returns nothing; and `removeFile` issued `'deleteall'`, wiping the entire index to remove one file. A plain FTS5 table rebuilt wholesale has neither failure mode and costs milliseconds here. |

**Rank only, never raw scores.** BM25 is negative, unbounded and
corpus-dependent; cosine is bounded 0–1 and higher-is-better. Putting them on
one scale means inventing a conversion, and the conversion is exactly where a
fusion starts quietly preferring whichever source emits larger numbers.

**Does not do.** No linguistic expansion: only the FTS5 tokenizer's own tokens
are ever searched, so sibling spellings you must know. No `content_rowid`, no
incremental updates — the table is rebuilt wholesale per run (a design note in
the migration explains why; incremental FTS5 deletes silently go stale). Vectors
are candidate-only: no ANN index or provider shipped — an
`EmbeddingProvider` is the seam (`src/retrieval/vector-store.ts`), and with none
configured the build honestly reports 0 vectors. Impact/flow stages of serving
still describe `impact`/`endpoint-flow` reach; the search dials into them.

---

# P3-T2 — summarisation over a local model (OPEN-8 decided)

**What shipped.** THE open decision is closed with a decision, not a stub:
summaries are generated by a **local** instruct model on this machine
(`@huggingface/transformers`, ± the same library the plan already named for
the R67 embeddings side), default `onnx-community/Qwen2.5-0.5B-Instruct`,
overridable via `CODE_INTEL_LLM_MODEL` / `CODE_INTEL_LLM_DEVICE`. Nothing
leaves the box, no key management exists, R62/R63 are preserved, and OPEN-8's
CLI stage-1 is real: `summaries generate --scope <function|module|service|all>
--seed <key>` then `summaries read <key> --kind <…>`.

**Where it lives.** The core boundary was already in place
(`src/llm/summaries.ts`, P3-T1). Added: `src/llm/local.ts` (local provider,
lazy singleton — a model load happens ONLY on a real cache miss), and
`src/llm/orchestrate.ts` (R66 bottom-up planning — functions→modules→service,
never summary-into-summary — plus the module/service/path input builders; all
join through `files`/`symbols`/`routes`, because symbol keys are verbatim SCIP
strings, never `fileKey/%` prefixes, a mistake the tests caught).

**Verified.** 457 tests, 0 fail (`tests/orchestrate.test.ts`, 10 new; the
`nodeOf` drop-the-kind bug and the `needsProvider` catch-path bug were both
found by them). Typecheck clean. CLI smoke-tested end-to-end against a throwaway
DB: read-miss exit 1 with guidance, empty-store generate exit 0 with zero model
load, bad scope exit 2. First real generation downloads weights and is slow on
CPU; that is the local trade, stated in `local.ts`.

**What it does not do.** Token counts stay NULL, honestly — a local model has
no per-token cost, so R64's counting columns would have been a costume. Path
summaries (`--scope path`) and multi-model routing are not exposed yet. The
containment test in `summaries.test.ts` still guards the boundary this entry
sits behind.
