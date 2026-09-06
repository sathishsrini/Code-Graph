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
| P1-T2 normalizer | — | not started |
| P1-T3 scip-python | `ec5e845` | **wired, blocked upstream** |
| P1-T4 FastAPI boot adapter | `79fb2e1` | **done** |
| P1-T5 Next.js static indexing | — | **done** |
| P1-T6 tree-sitter pass | `99cf028` | **done** |
| P1-T7 cross-service linker | — | **done** |
| P1-T8 route chain expander | `59972c5` | **done** |
| P1-T9 Semgrep check_kind pack | — | **done** |
| P1-T10 inline auth detector | — | not started |
| P1-T11 incremental indexing | `59972c5` | **done** |
| P1-T12 `endpoint_flow` | — | not started |
| P1-T13 `impact` | — | not started |
| P1-T14 `security_path` | — | not started |
| P1-T15 `context_pack` | — | not started |
| P1-T16 MCP server | — | not started |
| P1-T17 intra-function CFG | — | not started |
| P1-T18 guard attribution | — | not started |

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
