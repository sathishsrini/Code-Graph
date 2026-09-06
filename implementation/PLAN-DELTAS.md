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
