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

---

## D17 — the generated tsconfig indexed nothing on the one repo with directory includes · applied · P1-T11

**Found while running the full pipeline**, not by a test.

`buildTsconfig` copied `repos.json`'s globs verbatim. `60-kri-next` declares
`include: ["app/**", "components/**", "lib/**", "types/**"]`, and TypeScript
rejects a specification ending in `**`:

```
error TS5010: File specification cannot end in a recursive directory wildcard ('**'): 'app/**'.
error: no files got indexed.
```

**This is [D6](#d6) from the other direction.** There, the file set was
declared and the tool indexed a *wider* one. Here it was declared and the tool
indexed *nothing* — and the `.scip` on disk was a stale artifact from an
earlier `--infer-tsconfig` run, so every downstream number looked plausible.
The three single-file repos never exposed it because `server.js` needs no
rewriting.

**Change:** `tsGlob` appends `/*` to a trailing `/**`. Two tests, one for the
rewrite and one asserting globs `tsc` already accepts are left alone.

---

## D18 — a stale boot artifact failed as a SQL bind error · applied · P1-T11

`41-kri-engine`'s checked-in boot artifact predated the adapter revision that
added `origin`, and the first full `index` run died with:

```
TypeError: Provided value cannot be bound to SQLite parameter 8.
```

Nothing in that names the artifact, the route or the field. `readBootDump` now
validates `origin` on every chain entry and reports the route, the position,
the value it found and the fix (*re-run `boot dump`*).

A boot dump is a build artifact that outlives the adapter that wrote it, so
this will happen again; the point is that it costs one line to diagnose.

---

## D19 — `scip-python` is patched at install time, on Windows · applied · P1-T3

**Plan says:** R18 — `scip-python index` for the Python service, venv active.

**Measured:** every published version crashes at import on Windows —
`new RegExp(path.sep, 'g')` where `path.sep` is `\`. Nothing avoids it, because
it is a module-level constant evaluated before any argument is read.
[`docs/measurements.md` M8](../docs/measurements.md).

**Change:** `scripts/patch-scip-python.mjs` escapes the separator in the
shipped bundle. Idempotent, verified after writing, a no-op on POSIX, wired as
`postinstall`. It refuses to modify anything if the known-broken pattern is
absent, and says why — a silent no-op there would reappear as an unexplained
crash at index time.

**Delete this** the day upstream fixes it; the script's "pattern is gone"
branch is the signal.

---

## D20 — the Python channel is wired and blocked, and says so · applied · P1-T3

Past the startup crash, `scip-python` **exits 0 having written an 88-byte index
with zero documents** — on the corpus, on a clean path, and on a synthetic
package. Neither the `###` in the corpus path nor the loose-module layout that
OPEN-5 anticipated is the cause. [M8](../docs/measurements.md).

**What shipped:** `runScipPython`, `scip index` dispatching on `repos.json`'s
`lang`, `pythonBin` declared and prepended to the child's PATH, and the shared
SCIP ingest path. It works unchanged wherever a working indexer exists.

**Two guards this exposed**, both of which outlive the blockage:

1. **`ok` checks the output size, not only the exit code.** An indexer that
   exits 0 after writing a metadata header is not a success, and calling it one
   is exactly the class of confident-wrong answer this project exists to stop.
2. **`index` names the missing artifact by path**, rather than presenting a
   Python service with zero symbols as though that were a finding.

**Consequence, stated:** `51-integration` contributes routes, chain entries and
tree-sitter findings, and **no symbols and no call edges**. Its six chain
entries report as `unjoined`. That is a missing channel, not an empty service,
and the output distinguishes the two.

**OPEN-5 is not closed.** Its real answer is "who provisions a working
indexer", and on this platform nobody yet has.

---

## D21 — R20's rule pack is a YAML-subset loader, not a Semgrep run · applied · P1-T9

**Plan says:** R20 — *"Semgrep/Opengrep rules mapping real helper names to
`check_kind` values, maintained as a human-reviewed config file."* P1-T9's
deliverable is *"`rules/check-kinds.yml` + runner."*

**Change:** the rules live in `rules/check-kinds.yml` exactly as planned, but
the loader is a small deterministic YAML-subset parser
(`src/static/security-rules.ts`) rather than an invocation of Semgrep/Opengrep.

**Why:** the requirement's substance is the reviewed config, and a Semgrep
*binary* at this layer buys nothing P1-T10 does not need. Running Semgrep adds
a heavy native dependency to a toolchain the stack deliberately keeps at
`npm install` (see D11), while P1-T10 — the inline-check *detector* — is where
a real engine's pattern language earns its keep. The loader is strict: it
rejects malformed structure, classifies exact helper names only, and writes no
facts, so the classification remains a human-reviewed map either way.

**Also corrected:** P1-T9's own acceptance criterion — *"rules classify the
corpus's real helper names"* — was not met at first. `serviceAuth`
(41-kri-engine:77) is the engine's service-verifier and was missing from the
pack; it is now classified under `auth`, and the test asserts it.

---

## D22 — P1-T7's first implementation produced zero correct edges · corrected · P1-T7

**Plan says:** R31 / P1-T7 — call sites → base-URL resolution → path-template
matching; *"every produced edge is `inferred`; every non-match logged with a
`reason`; env-conditional destinations produce two candidate edges or one
`unresolved`, never one silently-wrong edge."*

**Measured, after the first implementation was marked done:** a corpus run
reported **0 REQUESTS, 2 unresolved** — both wrong rows. The five URLs that
matter (`server.js` L127/L176×2/L216/L298) were never even examined, because
the resolver iterated **client calls** and hunted backwards for a URL. On this
shaped code the only outbound call is `axios(axiosConfig)` *one function below*
every real URL — the `forward()` wrapper — so no preceding-URL heuristic was
reachable, and the nearest-preceding fallback then bound `axios()` at L68 to
the route-registration string `'/*'` at L52. The three further defects:

1. **Base identity is the env var, not the local name.** `BASE` (frontend)
   was compared against `baseUrlEnvVars`, which declares
   `NEXT_PUBLIC_API_BASE_URL`. The binding map that translates between them
   was consulted *after* the check.
2. **Port is not identity.** `serviceFromUrl` matched port alone, so a
   non-loopback `api.stripe.com:3002` would have resolved to the engine.
3. **The canonical ternary was silent.** `(PROCUREMENT_BASE_URL && …) ? … :
   …` produced neither candidate edges nor gaps — the exact failure the plan
   names.

**Change (in P1-T7's module, no rewrite elsewhere):** the resolver now
iterates **URL expressions**, attributes each to its enclosing function, and
accepts it only when that function (or a wrapper it calls by name — the corpus
`forward()`) contains an HTTP client call. Base resolution goes through the
env-binding map first; host matching requires loopback + a declared port; bare
`/…` literals are classified as path literals (route registrations,
`startsWith` comparisons) unless they are inline arguments of a client call,
so they neither resolve nor flood the gap log.

**Re-measured on the corpus:** `40-kri-router` now yields **2 REQUESTS**
(L216/L298 → `51-integration POST /api/v1/mail/send` — the one fully
resolvable cross-service edge) and 4 honest gaps (L176's two ternary branches,
L127's dynamic path, one unconsumed CORS origin). The frontend resolves
`BASE` → router and reports its dynamic path honestly. Nine tests encode the
corpus shapes the earlier fixtures did not.

---

## D23 — P1-T10's evidence is treesitter-only, and the kind sources are split · applied · P1-T10

**Plan says:** P1-T10's task row allowed `evidence_kind='semgrep'` or
`'treesitter'`. That disjunction is false — no Semgrep process runs in this
task — and the settlement records here as a delta rather than editing the plan
(README rule 2). The plan keeps its original wording; this is the amendment.

**Decided — `'treesitter'` is the only true branch:**

- **P1-T10 always writes `evidence_kind='treesitter'`.** Writing `'semgrep'`
  would put a false value in the provenance column the confidence model and
  R28's provenance delete rest on. A future *real* Semgrep pass owns
  `evidence_kind='semgrep'`; a row written under that value early would be
  silently deleted on that pass's first incremental run — the D18 failure
  shape in provenance.
- **`'semgrep'` stays in the CHECK constraint.** R72's concern is a table that
  lies, not an unused enum value, and the value is not unused forever. Removing
  it would cost a migration now and another when the real pass lands.
- **A structural test asserts nothing currently writes `'semgrep'`**, so
  introducing a producer is a deliberate, reviewable flip.

**The detail discriminator (migration 003).** The two idioms carry different
inference strengths, both labelled `inferred`, and the R40 matrix (P1-T14) must
not read them as equal coverage:

| Idiom | Evidence | `detail` |
|---|---|---|
| JS sentinel-return | binds a **human-reviewed helper name** from P1-T9's pack | `reviewed helper checkUserAuth` |
| Python header-compare-and-early-401 | matches a **source shape**, no named helper | `header-compare-and-early-401 shape, no named helper` |

They discriminate through a new `route_chain.detail TEXT` column (migration
003), filled solely by P1-T10; boot rows keep it NULL, so a row is never
mistaken for the other channel. R72: no column without a producer.

**`check_kind` has two provenances, and says so.** The JS branch classifies
through `classifyCheckKind` from the reviewed pack; the Python branch asserts
`"auth"` from the shape — a 401 early-return is auth by definition and has no
helper name to classify. Defensible, recovered by `detail`, and now stated in
both the module and this register.

**An unguarded JS call is a weaker claim and labels itself.** A bare
`checkUserAuth(req, reply)` whose result is discarded does not stop the
request; the sentinel-return is evidence the request is stopped. The detector
emits both, but the bare call is `detail: reviewed helper X, unguarded call`,
never the sentinel-return label.

**Coverage limits, stated.** Only the boot-reported handler function is
scanned — a check inside a nested helper the handler calls is the call tree's
job (R35-R39), not R26's. The JS branch requires a reviewed-pack name, so an
unnamed inline JS guard is missed. The Python branch is 401-specific; a 403
tenant shape does not match.

**R27 boundary, stated.** `rules/check-kinds.yml` is reviewed configuration,
not a repo file, so a rule edit is invisible to R27's file-change set:
un-reviewing a helper produces no rows on a plain `index`, because nothing is
`changed`. `index --force` re-derives and clears them — `ingestInlineChecks`
now calls `deleteChain(routeNodeId, ["treesitter", "semgrep"])` before
inserting, mirroring the boot channel's `["boot"]`, so a revoked rule stops
asserting coverage in the direction that matters (D5's). Hashing the rules
file into R27's change set was considered and refused: it has no honest home
short of the `files` table, and a fake per-repo file row for a shared config
file is the same class of wrong this register exists to name.

---

## D24 — four defects the store-backed flow exposed on first run · corrected · P1-T12

All four passed `tsc` and the suite, and all four were visible the moment the
query ran against the corpus. Recorded because the pattern is now consistent:
this project's defects are not type errors, they are *plausible wrong answers*.

**1. M7's defect came back, at a different layer.** The `onRequest` hook's call
tree was the whole module again — ~60 children including `listen` and
`process.exit`. Phase 0's `flow.ts` solved this at query time with
`functionExtent`, reading source; the store-backed query cannot read source, so
it inherited the module join and expanded it whole.

Fixed by deriving the extent **once, at index time**, where the source is
already loaded, and storing it (`route_chain.end_line`, migration 004). The
query narrows depth-0 edges to that span. 60 children → 10, and the 10 are the
hook's own calls. `stats.unbounded` counts hooks whose span could not be
recovered, rather than silently widening them back to the module.

**2. Two call sites to one callee collapsed into one path key.** The CTE's path
was `/<dst>/`, so `envelopeError` calling `nowIso` at three lines produced three
rows with the same key: all three were pushed as children while the map kept
only the last, and the grandchildren attached to one arbitrary duplicate. The
rendered tree showed three identical `nowIso` children, two of them empty.
Fixed by putting the **edge id** in the path (`<dst>#<edge>/`); the cycle guard
matches on `'/<dst>#'` so a node id is never confused with a longer one sharing
its prefix.

**3. Inline security checks were reported as unjoined chain entries.** They
store a null `symbol_node_id` deliberately — an inline check is a call *site*
inside a handler, not a chain function — and the gap collector treated any null
symbol as a failed join. It manufactured a gap in R61's UNKNOWN section, which
is as dishonest as hiding a real one.

**4. `npm:typescript@5.9.3` was the largest external node in the graph, with
140 edges.** Those call sites are `Date.now()`, `.toString(36)` and
`new Date().toISOString()` — ECMAScript builtins that resolve through
TypeScript's bundled `lib.es*.d.ts`. Nothing calls the TypeScript compiler at
runtime, and `impact` would have answered *"changing typescript breaks 140
things"*.

`resolvePackageIdentity` now rewrites the package a symbol resolved *through*
into the one the code actually depends on:

| Resolved | Identity | Why |
|---|---|---|
| `typescript` | `builtin:ecmascript` | `lib.es*.d.ts` is the language, not a dependency |
| `@types/node` | `builtin:node` | the Node standard library |
| `@types/<x>` | `npm:<x>` (no version) | a declaration package; the runtime dependency is `<x>`, and the declaration's version says nothing about which `<x>` is installed |

**Renderer, separately:** boundary calls collapse to a counted summary
(`7 boundary call(s): npm:fastify@4.28.1×6, builtin:ecmascript×1`) with
`--externals` to list them. The edges stay in the graph — `impact` reads them —
but naming each one buried the four local calls that answer the question.

---

## D25 — three wrong answers `impact` gave before it gave a right one · corrected · P1-T13

Same pattern as [D24](#d24): every one passed `tsc` and the suite, and every one
was a *confident wrong answer* visible on the first corpus run.

**1. A module symbol bridged unrelated routes.** `impact checkUserAuth` reported
**23 routes**, including `/health`, `/ready`, `OPTIONS /*` and
`POST /api/v1/auth/login` — none of which call it.

A call inside an anonymous handler has no definition of its own, so SCIP
attributes it to the module; the module is `HANDLES`-ed by *every* route in the
file; and the reverse closure walked straight through it. That is the M7 defect
in a third guise, and the most dangerous form yet, because the output is a
security-relevant list that looks complete.

The closure now refuses to expand out of a `namespace` symbol. The module is
still reported as an affected *symbol* — the call is real — but it is no longer
a path to 23 routes.

**2. Stopping there would have lost a real route**, so the routes that genuinely
run the seed are recovered from `route_chain` instead
(`routesNamingSeed`): `POST /api/v1/mail/send` runs `checkUserAuth` inside an
anonymous handler, and the chain names it exactly, at that route and nowhere
else. **23 → 16**, which is the 15 routes `proxyToEngine` handles plus the mail
route, and matches the source.

**3. The merge ran after bucketing, then ranked by the wrong key.** Inserted
after the confidence split, the chain-named route was counted in `totalRoutes`
and present in no bucket — the sections summed to one less than the total.
Moving it before the split exposed the second half: ranking two ways of reaching
one route by **depth** made an `inferred` depth-1 inline row beat a `certain`
depth-2 call chain, relabelling all 15 compiler-resolved routes as inferred.

`isBetterEvidence` now ranks **confidence first, depth second**. Understating
what is known is the mirror of overstating it, and this file's other rules exist
to prevent exactly that in the opposite direction.

**Also, R38's file-attributed dependencies.** Every `READS_CONFIG`, `READS` and
`WRITES` edge in this corpus is owned by a **file** node, because the config
reads and SQL literals all sit at module scope or inside anonymous handlers and
`ownerSymbol` refuses to guess a function. So both dependency sections were
empty for every symbol seed.

They now consult the seed's owning file as well, and each shared node records
`attributedTo: "symbol" | "file"` — rendered as `[file-scope]`. Reporting them
as the symbol's own dependencies would overstate; reporting nothing hides a real
coupling. `impact 51-integration/main.py` now answers OPEN-9's question directly:
eight config nodes shared with `41-kri-engine`, and `postgres://?/mail_events`.

---

## D26 — the UI is elkjs + SVG, not React Flow · applied · P2-T1…T5, P2-T12

**Plan says:** P2-T1 — *"UI shell: React Flow + elkjs (`layered`)"*, and R49
names React Flow directly.

**Change:** elkjs does the layered layout, as planned. The rendering is plain
SVG in one HTML file, with ~25 lines of pan/zoom, instead of React Flow.

**Why:** React Flow needs a bundler, and this project has none by decision.
`package.json` has no build script and Node executes the `.ts` sources
directly — the stack was chosen twice over for that property (`node:sqlite`
over `better-sqlite3`, WASM tree-sitter over the native binding). Adding
webpack so a graph can be drawn would make `npm start` a two-stage thing for
everyone, permanently, and it is the one dependency that would spread: a
bundler in the repo eventually owns the CLI too.

elkjs is served from `node_modules`, not a CDN, so the viewer works offline and
pins the version the tests ran against.

**Cost, stated plainly:** no minimap, no drag-to-reposition, no edge routing
around nodes, and no node virtualisation — a flow of several hundred nodes will
render slowly. React Flow gives all of that free. If a flow that size becomes
routine, this is the right thing to revisit, and the payload
(`src/serializers/graph-json.ts`) is deliberately renderer-agnostic so that
swap costs nothing outside the view layer.

**What is unchanged:** R49's acceptance criterion — *"renders an endpoint flow
with elkjs layout"* — and R50's, R78's. The two visual axes are two independent
fields in the payload, the legend ships with the data, and service swim-lanes
are elkjs compound nodes.

---

## D27 — the branch view attached to chain steps only · corrected · P2-T12

Found by a test rather than by running it, which is rarer here than the
reverse.

`attachCfg` ran for chain steps and not for symbols reached in the call tree,
so **1 of 7** functions on `POST /api/v1/po` carried control flow. Clicking any
callee — `checkUserAuth`, `envelopeError`, `forward` — showed no execution
paths at all, which reads as "this function has no branches" rather than "we
did not look here".

Now attached for every `symbol` node the viewer can select. 1 → 7 on that
route, and `proxyToEngine` shows its two error exits and its success
continuation, which is the picture R78 asks for.
