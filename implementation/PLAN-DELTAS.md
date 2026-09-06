# Plan deltas — implementation vs. `code-intelligence-engine-plan-v2.md`

Every divergence from plan v2, with the evidence that forced it. The plan file
is not edited; this is the amendment register.

**Status key** — `applied` (in the code now) · `pending` (agreed, not yet built) ·
`rejected` (considered, plan stands).

---

## D1 — `syntaxKind` cannot implement R16 · applied · P0-T4/T6

**Plan says:** R16 — filter type-position occurrences out of `CALLS`, implicitly
via SCIP's `syntaxKind` discriminator.

**Measured:** `syntaxKind` is `0` (Unspecified) for all 2,288 occurrences
emitted by `scip-typescript@0.4.0`. So are `displayName` (0/407),
`enclosingSymbol` (0/407) and `relationships` (0/407).
See [`docs/measurements.md` M1](../docs/measurements.md).

**Change:** filtering runs off the SCIP *symbol grammar* instead
([`src/static/scip/symbol.ts`](../src/static/scip/symbol.ts)) — descriptor
suffixes `#`/`.`/`().`/`:` are unambiguous — plus `ROLE_IMPORT` and containment
in a definition that owns an `enclosingRange`.

**Why it matters:** written from `scip.proto` alone, the filter would have
dropped every real call edge and looked correct doing it.

---

## D2 — The call-site check, and what a false-positive number hides · applied · P0-T6/T7

**Plan says:** R70 — measure the `CALLS` false-positive rate on a sample of 50;
above ~10% the graph is untrustworthy.

**Measured:** descriptor filters alone scored **~83%** (10 of 12). The decisive
signal is not in the index: *is the identifier followed by a call?* Reading the
source forward from the occurrence took it to **0% on 50**.
[`docs/measurements.md` M3](../docs/measurements.md).

**Change:** `isCallSite()` in [`src/derive/calls.ts`](../src/derive/calls.ts) is
a required gate, not an optimisation.

**Addition to the plan's discipline:** the same pass removed an over-eager
`parameterOrMeta` filter that had been silently dropping **all 11**
frontend→backend `api.get`/`api.post` call sites — the exact edges P1-T7 needs.
R70 measures false positives only, and a filter that scores 0% by deleting the
edges you care about passes it. **Both directions are measured from here on.**

---

## D3 — Anonymous hooks are located, not renamed · applied · P0-T8

**Plan says:** P0-T8 — *"convert the 4 anonymous arrow hooks to named functions
in the fixture (~10 lines) so output is labelled."*

**Measured:** 52 and 63 anonymous chain entries across the two Node services —
68% and 89% of all entries. Four was off by an order of magnitude.
[`docs/measurements.md` M6](../docs/measurements.md).

**Change:** V8's `[[FunctionLocation]]` yields `file:line:col` for any function
object, named or not. `unlocatedChainEntries` is 0 on all three services, and
the position doubles as the join key into SCIP.

**Why it matters:** renaming labels the fixture and leaves the engine unable to
read any real repo, where `addHook('onRequest', async (req, reply) => …)` is the
dominant idiom.

---

## D4 — `fastify-overview` is opt-in, not the boot source · applied · P0-T8

**Plan says:** R21 — *"`fastify-overview` registered first and awaited; read
after `ready`."*

**Measured:** saw **0 of 23** routes on `40-kri-router`; threw during boot with
`addSource: true` against a module-scope app; stamps `Math.random()` ids that
break byte-identical re-runs (Phase 0 acceptance criterion 3).
[`docs/measurements.md` M6](../docs/measurements.md).

**Change:** hooks are read from the route's **owning Fastify instance**, captured
during `onRoute` and read after `ready()`. `fastify-overview` is behind
`--overview` and, when it under-reports, the dump says so in `warnings` rather
than presenting a partial tree as the route set.

**Why it matters:** a *partial* plugin tree is worse than none — it looks credible.

---

## D5 — `routeOptions` does not carry the inherited chain · applied · P0-T8

**Plan says:** R21 — *"emit … the full inherited hook chain in execution order"*,
with Fastify's documented per-route payload as the implied source.

**Measured:** `routeOptions` lifecycle arrays gave **31** entries on
`40-kri-router` (1.3/route — effectively handler-only) against **77** from the
owning instance's merged hooks (3.3/route). Both global hooks vanished from all
23 routes. Reading `instance[kHooks]` *during* `onRoute` is also wrong, and
wrong intermittently: avvio defers root `addHook`, so root routes report an
empty set while plugin routes report a full one.
[`docs/measurements.md` M6](../docs/measurements.md).

**Change:** capture the owning instance in `onRoute`, read its merged hooks after
`ready()` — the only point at which the set is final.

**Why it matters:** a handler-only chain renders as *"this route has no
middleware"*. On R40's security query the same defect reports every route as
unauthenticated.

---

## D6 — OPEN-1 is enforced by a generated tsconfig, not by config alone · applied · P0-T3/T9

**Plan says:** OPEN-1 recommends reachability-filtered indexing via
`repos.json` include/exclude.

**Measured:** `40-kri-router/tsconfig.json` is literally `{}`. TypeScript's
defaults took over and the first index produced **52 clean, confident CALLS
edges describing `src/**`** — a non-compiling scaffold that never executes — and
**zero** from the live `server.js`. `repos.json` had declared the include/exclude
since P0-T2; nothing enforced it.
[`docs/measurements.md` M7](../docs/measurements.md).

**Change:** [`src/static/scip/runner.ts`](../src/static/scip/runner.ts) generates
the tsconfig from the declaration, and `deriveCalls` re-checks every document
against it. 90 edges, all from the live file.

**Why it matters:** this is the worst class of failure available — not a missing
answer, a confident wrong one. Declaring the file set is not the same as
enforcing it, and only the second one is a defence.

---

## D7 — Namespace targets are unresolved calls, not noise · applied · P0-T9

**Plan says:** R16 — filter containers out of `CALLS`.

**Measured:** `forward()` is the single outbound HTTP point in the router and its
call tree was empty. Line 68 is `return axios(axiosConfig)`; untyped CJS resolves
the callee to the axios *package namespace*, which the container filter rejected
**before the call-site check ran**, so the most valuable edge in the corpus
vanished into a tally. [`docs/measurements.md` M7](../docs/measurements.md).

**Change:** the two checks are reordered. A namespace symbol that *survives* the
call-site check is not noise — it is a call whose target cannot be named, and it
is written to `unresolved_calls` (R11) and rendered as an explicit `??` branch.

**Why it matters:** an omitted branch reads as *"this function calls nothing"*,
which is a different and false claim from *"we could not name what it calls."*

---

## D8 — `edges` identity needs COALESCE, not a plain UNIQUE · applied · P0-T5

**Plan says:** §H — `UNIQUE (src, dst, type, evidence_kind, file_id, line)`.

**Problem:** in SQLite two NULLs are distinct, so that constraint does not
deduplicate boot- or otel-sourced edges, which legitimately carry NULL
`file_id` and `line`. Every boot re-run would insert fresh duplicates.

**Change:** a unique *expression* index COALESCEing both nullable columns to a
sentinel. Documented inline in `schema-v0.sql`.

---

*Deltas D9 onward are appended as Phase 1 work lands.*

---

## D9 — `spans` and `summaries` ship with their producers, not with P1-T1 · applied · P1-T1

**Plan says:** R2 lists 13 tables; P1-T1's acceptance criterion is *"All 12
tables present"*. (The plan is internally inconsistent about the count.)

**Change:** the Phase 1 migration creates `routes`, `route_chain` and
`unresolved_calls` — the three with producers landing this phase. `spans`
arrives with the OTLP receiver (P2-T8) and `summaries` with the LLM layer
(P3-T2), each in its own migration.

**Why:** R72, and `CLAUDE.md`'s first working rule — *no table or column
without an extractor that fills it this week*. Both previous attempts died with
470 lines of DDL and no producers. A structurally-empty table is worse than a
missing one: a query joining it returns *"no evidence"* when the truth is *"no
producer"*, and nothing in the output distinguishes those.

A regression test asserts their **absence**, so shipping them early fails the
suite rather than passing unnoticed.

---

## D10 — pragmas are connection state, migrations are schema · applied · P1-T1

**Problem found while building the runner:** `PRAGMA journal_mode = WAL` was in
the P0 schema file. A migration runs inside a transaction, and `journal_mode` is
a **no-op inside one** — so a database created through the runner would silently
have been in `delete` mode, not WAL, with nothing reporting it. `foreign_keys`
has the same shape of problem from the other direction: it defaults to OFF on
every new connection regardless of how the file was created, so putting it in
DDL guarantees nothing at query time.

**Change:** both pragmas moved to `FactStore`'s constructor, and `migrate()`
throws if any migration file contains `PRAGMA journal_mode`. Asserted by test.

---

## D11 — tree-sitter runs as WebAssembly, not the native binding · applied · P1-T6

**Plan says:** R19 — "tree-sitter pass". No binding named.

**Change:** `web-tree-sitter` + `tree-sitter-wasms` (prebuilt grammars for
javascript, typescript, tsx and python), loaded lazily and cached per grammar.

**Why:** the `tree-sitter` npm package compiles C at install time, which is the
exact dependency the stack picked `node:sqlite` to avoid — plan §5, *"no native
compilation — avoids better-sqlite3 build pain on Windows"*. Adopting it for
the parser would have reintroduced the problem one layer down. The WASM build
is the same parser and keeps the whole toolchain at `npm install` with no
compiler on the machine.

**Cost, stated:** grammar load is ~30 ms once per language per process, and
parsing is somewhat slower than native. Neither is measurable against
`scip-typescript`'s runtime.

---

## D12 — `THROWS` is empty on the corpus, and that is the finding · measured · P1-T6

Not a change to the plan — a confirmation of what §2.12 predicted, recorded
because the number is the justification for P1-T17 existing at all.

| Repo | THROWS | READS/WRITES | config reads | http call sites |
|---|---|---|---|---|
| `40-kri-router` | **0** | 0 | 7 | 1 |
| `41-kri-engine` | **0** | 17 | 8 | 0 |
| `51-integration` | **0** | 1 | 8 | 0 |
| `60-kri-next` | 3 | 0 | 1 | 1 |

Every backend service throws nothing. Failures are `return envelopeError({…})`,
and a `throw`-only failure surface finds zero on all three. `scan` prints a note
saying so, because an empty THROWS section otherwise reads as *"nothing can
fail here"* — which is a different and false claim from *"nothing is thrown."*

---

## D13 — an outbound call site is not an edge yet · applied · P1-T6

`40-kri-router`'s only outbound HTTP call is `axios(axiosConfig)` at
`server.js:68`, and the URL is built by its *caller*, one indirection away.
Its destination also forks on an env var: `PROCUREMENT_BASE_URL && isProcurementPath`
selects between two base URLs in a single ternary.

So the tree-sitter pass records **URL expressions independently of call sites**,
and records the identifier when a client is called with a config object. The
ternary yields **two** `UrlExpr` rows rather than one silently-chosen winner —
which is OPEN-4's requirement and doc §Q.1's *"#1 source of wrong cross-service
edges"* — and neither becomes an edge until P1-T7 resolves a destination.
`ingest.ts` deliberately writes no `CALLS_EXTERNAL` row for an HTTP site, so the
same call cannot be counted twice.

---

## D14 — Starlette middleware order is the reverse of source order · measured · P1-T4

**Measured on `51-integration`.** Source declares `CORSMiddleware` at line 28
and `@app.middleware("http") correlation_middleware` at line 67. Reflection
reports **correlation_middleware first**.

That is correct, and it is the Python analogue of [D5](#d5). Starlette's
`add_middleware` **inserts at index 0**, and `build_middleware_stack` wraps
`reversed(user_middleware)` — so `user_middleware[0]` is wrapped last, ends up
outermost, and runs first. List order *is* execution order while being the
reverse of the order the source declares.

Reading the source top-to-bottom gives the wrong answer, silently, and inverts
the answer to *"what runs first"* — the exact class of defect D5 was.

The adapter reports list order and `boot/fastapi.ts` documents why.

---

## D15 — one downstream shape, two frameworks, without flattening them · applied · P1-T4

Fastify hooks are **per route** and inheritable through plugin scopes.
Starlette middleware is **app-wide**: it wraps the router, so every route in
the app carries the same prefix.

`src/boot/fastapi.ts` narrows the FastAPI artifact onto the same `BootDump`, so
P1-T8's ingester, R40's queries and P2-T4's rendering contain no branch on
framework. Where the frameworks genuinely differ the difference is *moved*, not
lost:

| FastAPI concept | Shared field | Why |
|---|---|---|
| `middleware`, `dependency` | `phase: "preHandler"` | "when does it run relative to the handler" is the question every query asks |
| app-wide middleware | `inheritedFrom: <service>` | null would read as *"declared on this route"*, which is false |
| Starlette's own classes | `origin: "framework"` | no SCIP index of this repo contains them, so the join is not expected to succeed |
| `Depends` nesting depth | `depth` on the artifact entry | a flat list loses that `get_db` runs inside `get_current_user` |

Collapsing middleware and hooks into one word would have been convenient and
would have made an inherited-hook query silently wrong on every Python service.

---

## D16 — `generatedAt` is empty on purpose · applied · P1-T4

Both boot adapters emit `"generatedAt": ""`. A timestamp defeats Phase 0
acceptance criterion 3 — two runs producing byte-identical output — for no
gain: the run that produced an artifact is already recorded in `runs`, with a
real timestamp, in the database.
