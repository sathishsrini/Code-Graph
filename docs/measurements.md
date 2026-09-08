# Measurements

Empirical findings, recorded as required by R70 and R71. Every number here is
reproducible with the command shown. **Do not update these from memory** — re-run.

---

## M1 — What `scip-typescript@0.4.0` actually populates

**Date**: 2026-09-06 · **Task**: P0-T4 · **Corpus**: `60-kri-next` (12 source files, ~676 LOC)

```bash
cd D:/###facilitator/dev-workspace/60-kri-next
scip-typescript index --no-global-caches --output <out>/60-kri-next.scip
node src/cli.ts scip dump --index .codeintel/scip/60-kri-next.scip --sample 0
```

| | |
|---|---|
| documents | 13 |
| symbols | 407 |
| occurrences | 2,288 (407 definitions, 1,881 references) |
| external symbols | 0 |
| index size | 190 KB |
| wall time | ~1.6 s |

### Field coverage — this is the finding that matters

| Field | Populated | Consequence |
|---|---|---|
| `symbol` | 407 / 407 | ✅ Identity works. Hierarchical and stable, exactly as R4 assumes. |
| `documentation` | 407 / 407 | ✅ **Signatures live here**, as a markdown fence: `` "```ts\n(property) api_version: \"1\"\n```" ``. This is the source for `symbols.signature`. |
| `enclosingRange` | 39 occurrences (32 multi-line) | ✅ **Present precisely on definitions that have bodies.** See M2. |
| `enclosingSymbol` | **0 / 407** | ❌ Not emitted. Containment must come from `enclosingRange` nesting instead. |
| `displayName` | **0 / 407** | ❌ Not emitted. Must be parsed out of the symbol string. |
| `relationships` | **0 / 407** | ❌ Not emitted. No implementation/type-definition links available. |
| `syntaxKind` | **0 (Unspecified) for all 2,288** | ❌ **Breaks R16 as written** — see below. |
| `language` | empty for all documents | ❌ Infer from file extension. |

### R16 cannot be implemented as specified

> R16: *filter type-position occurrences and imports/re-exports out of `CALLS`*

The plan assumed `syntaxKind` would distinguish `IdentifierType` from
`IdentifierFunction`. **It is `0` for every occurrence in this index**, so that
discriminator does not exist. Filtering must instead use:

1. **The SCIP symbol grammar.** Descriptor suffixes are unambiguous — `#` is a
   type, `.` a term, `().` a method, `:` a parameter/meta. A reference whose
   target ends in `#` is a type position, not a call.
2. **`ROLE_IMPORT`** on the occurrence — still emitted, so imports remain filterable.
3. **Containment**: a reference is only a call if it sits inside a definition
   that has an `enclosingRange` (i.e. inside a body).

This is why P0-T4 dumps the distribution rather than trusting the schema. Had the
filter been written from the proto file alone, it would have silently dropped
every real call edge.

---

## M2 — `enclosingRange` marks exactly the call-containing definitions

**Task**: P0-T4 · verified by inspecting all 39.

Definitions **with** `enclosingRange` are modules, types and **functions**:
`api.ts/request().` (L23-45), `api.ts/getToken().` (L15-18),
`auth.tsx/AuthProvider().` (L11-46), `Sidebar.tsx/Sidebar().` (L6-36),
`po/page.tsx/POPage().` (L8-126), and so on.

Definitions **without** it are type members and properties —
`ApiEnvelope#typeLiteral0:status_code.`, `ApiEnvelope#[T]` — which cannot
contain a call.

**Consequence:** the interval tree for the `CALLS` derivation (P0-T6) is built
from definition occurrences carrying an `enclosingRange`. The plan's mechanism
holds; only its input field changes, from `enclosingSymbol` to `enclosingRange`.

---

## M3 — `CALLS` false-positive rate

**Task**: P0-T7 · **Gate**: R70, ≤10% · **Date**: 2026-09-06
**Corpus**: `60-kri-next` — chosen because it is the only `strict: true`
TypeScript in the fixtures, so the number measures the derivation rather than
the fixture (plan §6 OPEN-3).

```bash
node src/cli.ts derive calls --index .codeintel/scip/60-kri-next.scip --sample 50
```

| Revision | Unique edges | Sample | False positives | Rate | Verdict |
|---|---|---|---|---|---|
| Descriptor filters only | 969 | 12 | 10 | **~83%** | ❌ fails the gate |
| **+ call-site check** | **166** | **50** | **0** | **0%** | ✅ **passes** |

### What the first revision got wrong

Filtering on the SCIP symbol grammar alone let through everything that *looks*
like an identifier reference: JSX intrinsic elements (`<div>`, `<main>`), JSX
attributes (`value`, `htmlFor`), property reads (`process.env`), type members
(`Column#typeLiteral0:key`) and destructured prop names. Ten of twelve sampled
edges were not calls.

### The fix

The decisive signal is not in the index at all: **is the identifier followed by
a call?** The sources are on disk, so `isCallSite()` reads forward from the
occurrence's end and accepts `foo(`, `foo (`, `foo<T>(` and a call broken across
lines, rejecting everything else. That single check removed 1,007 references and
took the rate to zero.

### A false negative the same work uncovered

Removing an over-eager `parameterOrMeta` filter recovered **all 11
frontend→backend `api.get`/`api.post` call sites**, which had been silently
dropped. `scip-typescript` emits object-literal properties as *meta*
descriptors — `api.get(...)` resolves to ``lib/`api.ts`/get0:`` — so excluding
meta removed exactly the edges the cross-service linker (P1-T7) will depend on.
Ground truth is 11 call sites; 11 are now captured.

**Lesson worth keeping:** measure false negatives, not only false positives. A
filter that scores 0% FP by dropping the edges you care about is worse than
useless, and the FP metric alone would have called it a success.

### Known limitation, not counted as a false positive

Arrow functions inside an object literal get no `enclosingRange`, so calls made
inside them attribute to the enclosing *module* rather than the arrow. Affects 6
of 166 edges (`api.get`/`post`/`put` → `request`). The edge is real; the caller
is coarse. Revisit if `route_chain` attribution needs it.

---

## M4 — `context_pack` token delta

**Task**: P1-T15 · **Status**: ⬜ not yet measured.

**Gate**: R71 — the ratio of a packed context to dumping the repo is the number
that justifies the project. Measure and record it.

| Date | Seed symbol | Repo dump | Context pack | Ratio |
|---|---|---|---|---|
| — | — | — | — | pending Phase 1 |

---

## M5 — Test output filtering

**Task**: testing policy · **Date**: 2026-09-06

```bash
npm test 2>&1 | wc -c                                    # 2938 bytes
npm test 2>&1 | grep -E '^(ℹ (tests|pass|fail)|✖)' | wc -c   # 36 bytes
```

Filtering is ~80× cheaper than raw output and fully deterministic. Delegating the
run to a local model was measured at ~150 tokens (its reply returns through the
shell regardless), so filtering wins on both cost and trust.

---

## M6 — What Fastify boot reflection actually reports

**Task**: P0-T8 · **Date**: 2026-09-06 · **Corpus**: `40-kri-router`, `41-kri-engine`,
plus `tests/fixtures/fastify-app.cjs` (which adds the plugin nesting the corpus lacks)

```bash
node src/cli.ts boot dump --repo 40-kri-router
```

| | 40-kri-router | 41-kri-engine | fixture |
|---|---|---|---|
| routes reported | 23 | 21 | 5 |
| routes declared in source | 17 | 15 | 3 |
| chain entries | 77 | 71 | 20 |
| anonymous chain entries | 52 (68%) | 63 (89%) | 7 |
| **unlocated chain entries** | **0** | **0** | **0** |

### Boot reflection reports routes that exist in no source file

Every service reports more routes than its source declares: Fastify synthesises a
HEAD route per GET (`exposeHeadRoute`, on by default) and gives it an extra
`onSend` hook from `fastify/lib/headRoute.js`. Six such routes in the router, six
in the engine. No static reader of the source would find them. This is the
clearest evidence for the doc's central correction — routes and middleware order
are a runtime-reflection problem.

### `routeOptions` does not carry the inherited chain

The first implementation read hook arrays from the `routeOptions` argument of an
`onRoute` hook. That is Fastify's documented per-route payload, and it carries
**only route-level hooks**:

| Chain source | Entries, 40-kri-router | Per route |
|---|---|---|
| `routeOptions` lifecycle arrays | 31 | 1.3 — effectively handler-only |
| **owning instance's merged hooks** | **77** | **3.3** |

A handler-only chain is not an error. It renders as *"this route has no
middleware"*, so both global hooks — the correlation-id middleware and the
response logger — silently vanished from all 23 routes. On a security query
(R40) the same defect reports every route as unauthenticated.

### …and the merged set is not readable when `onRoute` fires

The obvious fix — read `instance[kHooks]` inside `onRoute` — is also wrong, and
wrong intermittently, which is worse:

```
onRoute GET  /health   instanceHooks={}                      <- root route: empty
onRoute GET  /c/child  instanceHooks={onRequest,onResponse}  <- plugin route: full
```

`addHook` on the root instance is deferred through avvio, so at `onRoute` time
the root's hook set is still empty; a child plugin's set is already populated
because it was cloned later. Root routes lose their hooks, plugin routes keep
theirs. **The owning instance is captured during `onRoute` and read after
`ready()`**, which is the only point at which it is final.

### `fastify-overview` is opt-in, not the default

R21 names `fastify-overview` as the boot source. It is `--overview` here, off by
default, for three measured reasons:

| Observed | Consequence |
|---|---|
| Saw **0 of 23** routes on `40-kri-router`, 2 of 5 on the fixture | Its instrumentation installs when its own plugin body runs — during `ready()` — and a service that registers at module scope has already finished. A *partial* tree is worse than none: it looks credible. |
| **Threw during boot** with `addSource: true` when a plugin is registered at module scope (`index.js:90`, `.find(...)` returns undefined) | Takes the whole dump with it |
| Stamps `Math.random()` tracking ids into its tree | Two runs differ, breaking Phase 0 acceptance criterion 3 (byte-identical re-runs) |

Nothing in the chain depends on it — hooks come from Fastify directly — so the
default path loses no information. When `--overview` is passed and it
under-reports, the dump says so in `warnings` rather than presenting the tree as
the route set.

### Anonymous hooks: located, not renamed

The plan's P0-T8 said to *"convert the 4 anonymous arrow hooks to named functions
in the fixture (~10 lines) so output is labelled."* Measured, the fixtures have
**52 and 63** anonymous chain entries, not 4 — and renaming them would label the
fixture while leaving the engine unable to read any real repo, where
`addHook('onRequest', async (req, reply) => …)` is the dominant idiom.

Instead the V8 inspector's `[[FunctionLocation]]` yields `file:line:col` for any
function object, named or not. Every reported position was verified to land on
the function it names:

```
server.js:36:29 -> "async (req, reply) => {"      onRequest, correlation id
server.js:46:30 -> "async (req, reply) => {"      onResponse, request logger
server.js:168:28 -> "(req, reply) {"              proxyToEngine
```

`unlocatedChainEntries` is 0 across all three services. The position is also the
join key to SCIP: a hook at `server.js:36` falls inside exactly one definition's
`enclosingRange`. (For a *named* function expression V8 reports the column of the
parameter list, so the name precedes the reported column.)

### The chain is correct and still not the whole security story

`POST /api/v1/po` reflects as:

```
0. onRequest   (anonymous)     server.js:36:29
1. handler     proxyToEngine   server.js:168:28
2. onResponse  (anonymous)     server.js:46:30
```

That matches the source exactly — and contains **no auth check**, because there
is no auth *hook*. `proxyToEngine` calls `checkUserAuth(req, reply)` as its first
statement. Boot reflection is complete and correct here and still cannot see it;
only R26's inline detector (P1-T10) can. Read this dump as *"no auth hook"*,
never as *"no auth"*.

---

## M7 — The Phase 0 gate: `flow` on `POST /api/v1/po`

**Task**: P0-T9 · **Date**: 2026-09-07 · **Gate**: the printed tree must match
what a senior developer would draw by hand.

```bash
node src/cli.ts scip index --repo 40-kri-router
node src/cli.ts boot dump  --repo 40-kri-router
node src/cli.ts flow       --repo 40-kri-router --method POST --path /api/v1/po
```

### Indexing the wrong tree, twice over

`40-kri-router/tsconfig.json` is literally `{}`. TypeScript's defaults then take
over — every `.ts` under the root, no `allowJs` — and the first index of this
service produced:

| | Documents | CALLS | From the code that runs |
|---|---|---|---|
| `--infer-tsconfig`, repo defaults | `src/index.ts`, `src/server.ts`, `src/middleware/auth.ts` | 52 | **0** |
| **generated tsconfig from `repos.json`** | `server.js` | **90** | **90** |

The first graph is clean, internally consistent, and describes a **non-compiling
scaffold that never executes**. `config/repos.json` had declared
`include: ["server.js"]` and `exclude: ["src/**"]` since P0-T2; nothing enforced
it. `src/static/scip/runner.ts` now generates the tsconfig from that declaration
and `deriveCalls` re-checks each document against it, so the wrong tree cannot be
indexed by accident or slip through if the indexer widens its own set.

**This is the failure mode the plan calls OPEN-1, and it is the most dangerous
one available: not a missing answer, a confident wrong one.**

### An anonymous hook's call tree was the whole module

The boot dump locates the `onRequest` hook at `server.js:36:29`. No SCIP
definition starts there — an arrow passed straight to `addHook` gets no
`enclosingRange` — so the join resolved to the enclosing *module*, whose range
is the file. The hook's "call tree" became every call in `server.js`:

| Root for the onRequest hook | Children |
|---|---|
| module (`server.js`) | **31**, including `listen`, `setErrorHandler`, `process.exit` |
| **scoped by `functionExtent`** | **3** — `Date.now`, `ulid`, `reply.header` |

`functionExtent` re-derives the function's line span from the source, starting
at the position the boot dump reported. Column precision matters too: the
registering call `fastify.addHook(...)` sits on the *same line* as the arrow it
registers, so by line alone the hook appears to call `addHook` itself. `col` was
added to `DerivedCall` for that one comparison.

### The most valuable edge was being discarded unexamined

`forward` is the single outbound HTTP point in the router, and its tree was
empty. Line 68 is `return axios(axiosConfig)`; in untyped CommonJS
`const axios = require('axios')` gives SCIP nothing better than the package
namespace ``scip-typescript npm axios 1.7.2 `index.d.ts`/``, which the container
filter rejected — **before the call-site check ever ran**, so it vanished into a
`container` tally.

The ordering is now reversed: a namespace symbol that survives the call-site
check is not noise, it is a call whose target could not be named. Two such edges
exist in this service and both are real:

```
L14  server.js  -> fastify@4.28.1
L68  forward()  -> axios@1.7.2      <- the outbound call to the engine
```

They render as explicit `??` branches. **An omitted branch reads as "this
function calls nothing", which is a different and false claim from "we could not
name what it calls."**

### The gate output

```
POST /api/v1/po    service: 40-kri-router

ROUTE CHAIN  (evidence: boot · confidence: certain)
   0. onRequest  (anonymous)     server.js:36:29
   1. handler    proxyToEngine   server.js:168:28
   2. onResponse (anonymous)     server.js:46:30

CALL TREE  (evidence: scip · ── certain · ╌╌ inferred)
  handler:
  proxyToEngine
     ├── checkUserAuth [certain]  server.js:169
     │   ├── isPublicAuthPath [certain]
     │   └── envelopeError [certain] -> nowIso [certain]
     ├── forward [certain]  server.js:178
     │   └?? axios — callee resolved to a package, not to a function
     └── envelopeError [certain]  server.js:265
```

Verified line by line against `server.js`. It matches.

### Determinism

Phase 0 acceptance criterion 3. Two full `scip index` → `boot dump` → `flow`
cycles produce byte-identical JSON (15,332 bytes). The one source of
non-determinism found was `fastify-overview`'s random tracking ids, which is
part of why it is opt-in (M6).

### What the gate does NOT establish

Stated because the corpus is unrepresentative and the plan says so (§6 OPEN-3):

1. **`scip-typescript` was never stressed.** 347 LOC. R74's "if it OOMs, stop
   and fix that first" cannot be exercised here.
2. **Inherited hook chains are not in this corpus.** Zero plugins, zero
   `preHandler` hooks. Inheritance is verified against
   `tests/fixtures/fastify-app.cjs`, which was written to supply it.
3. **Untyped CommonJS resolves badly.** 86 of 306 skipped references are
   `local N` symbols with no stable identity. The false-positive number in M3
   was measured on `60-kri-next` for exactly this reason.
4. **The chain contains no auth check, and the endpoint is still authenticated.**
   `checkUserAuth` is the handler's first statement. Boot reflection is
   complete and correct and cannot see it; the call tree finds it. Neither
   channel alone answers the question — which is the design working, not a gap.

---

## M8 — `scip-python` does not work on this platform

**Date**: 2026-09-07 · **Task**: P1-T3 · **Gate**: OPEN-5 · **Version**: `@sourcegraph/scip-python@0.6.6` (latest)

Two independent failures, in order.

### 1. It will not start on Windows

```
src/virtualenv/PythonEnvironment.ts:4
  const pathSepRegex = new RegExp(path.sep, 'g');
SyntaxError: Invalid regular expression: /\/g: \ at end of pattern
```

`path.sep` is `\` on Windows and a lone backslash is not a valid pattern. It
is a module-level constant, so this throws at **import** time — before any
argument is read. No flag, environment or project layout avoids it, and every
published version (0.1.3 through 0.6.6) carries it.

`scripts/patch-scip-python.mjs` escapes the separator in the shipped bundle.
Idempotent, verified after writing, and a no-op on POSIX. Wired as
`postinstall`. Delta D19.

### 2. Past that, it emits an empty index

| Target | Result |
|---|---|
| `51-integration` (as configured) | 88-byte index — metadata header only, **0 documents** |
| `51-integration` with `--target-only main.py` | 0 documents |
| `main.py` copied to a path with no `###` | 0 documents |
| A synthetic package (`__init__.py`, one import, two functions) | 0 documents |

So it is neither the `###` in the corpus path nor the loose-module layout that
OPEN-5 anticipated. It exits **0** while writing an index describing nothing.

A secondary failure appears in its log and is probably related:

```
Python script failed with code 9009: Python was not found
Warning: Package discovery failed - pip show timed out after 1 minute.
```

`python` resolves correctly from `cmd` on this machine (`C:\Python314\python.exe`),
so the indexer is not inheriting a usable environment. Prepending the declared
`pythonBin` directory to the child's PATH did not change the document count.

### What was shipped anyway

The channel is wired end to end — `runScipPython`, `scip index --repo` dispatch
on `lang`, and the ingest path is shared with TypeScript because both produce
SCIP. It will work unchanged wherever a working indexer exists (Linux, CI, WSL).

Two guards were added because of what this exposed:

1. **`ok` checks the output size, not just the exit code.** An indexer that
   exits 0 having written 88 bytes is not a success, and reporting it as one is
   the exact failure this project exists to stop shipping.
2. **`index` names the missing artifact by path** rather than showing a Python
   service with zero symbols as though that were a finding.

### Consequence for the graph, stated plainly

`51-integration` currently contributes routes, chain entries and tree-sitter
findings, and **no symbols and no call edges**. Its six chain entries are
reported `unjoined`. That is a missing channel, not an empty service.


---

## M9 — Cross-service linkage on the corpus (P1-T7, post-review)

**Date**: 2026-09-07 · **Task**: P1-T7 · **Gate**: review feedback items 1–2

```bash
node src/cli.ts index --db .codeintel/graph.db --config config/repos.json --force
```

| Repo | REQUESTS | unresolved |
|---|---|---|
| 40-kri-router | 2 | 3 |
| 51-integration | 0 | 0 |
| 60-kri-next | 0 | 1 |
| **total** | **2** | **4** |

The reviewer's run (pre-fix) reported **2 REQUESTS, 7 unresolved across 15
files**. The three rows removed by item 1 were all config strings, never calls:
`main.py:30` ×2 (FastAPI `allow_origins`) and `server.js:41`
(`Access-Control-Allow-Origin` header default). `unresolved_calls` is for call
sites whose target could not be named, so a string no HTTP client consumes is
not that and is no longer written. The remaining four are honest gaps: a
dynamic path (L127), an env-conditional ternary with two candidates (L176 ×2),
and a dynamic template in `60-kri-next` (`lib/api.ts:31`).

Item 2 changed no counts and changed one edge's source. With the module symbol
refused as an owner, the `POST /api/v1/mail/send` REQUESTS edge at
`server.js:298` sources from the **file node** (`40-kri-router/server.js`), not
the module symbol; `server.js:216` continues to source from the named function
symbol `proxyToEngine()`. Verified in the store: `src_kind='file'` vs
`src_kind='symbol'`.

---

## M9 — `context_pack` token delta

**Date**: 2026-09-08 · **Task**: P1-T15 · **Gate**: R71 — *the number that justifies the project*

```bash
node src/cli.ts context <symbol> --measure
node src/cli.ts context <symbol> --measure --no-source
```

Baseline: every file containing anything in the pack, dumped whole. That is
what an agent does when it has no graph.

| Seed | Service | with tier-1 source | signatures only |
|---|---|---|---|
| `proxyToEngine` | 40-kri-router | 66.5% | **25.8%** |
| `checkUserAuth` | 40-kri-router | 26.9% | **23.0%** |
| `forward` | 40-kri-router | 22.9% | — |
| `POPage` | 60-kri-next | **100.9%** | **4.1%** |
| `Sidebar` | 60-kri-next | **109.3%** | **17.7%** |

### The finding is not the win, it is where the win comes from

**The pack's value is the structure, not the source.** With tier-1 source
included the pack ranges 23%–109% and on two seeds is *larger than dumping the
file*. Without it, 4%–26%.

That is not a defect in the packer. It is arithmetic: `POPage` is 126 of the
~150 lines of `po/page.tsx`, so "the seed's body" and "the file" are nearly the
same text, and everything else the pack adds is overhead. R42's tier 1 is
specified to carry source, so the default keeps it — but the mode that delivers
R71's win is `--no-source`, and an agent editing a function usually has that
file open already.

**Recommendation, not yet applied:** flip the default to signatures-only and
make source opt-in. It changes P1-T15's spec, so it is recorded here rather
than done unilaterally.

### What this corpus cannot show

The ratio is measured on services of **1 to 12 small files**. A pack's real
advantage is not dumping the *other* files, and here there are almost none —
`40-kri-router` is a single 347-line file, so the baseline is already close to
minimal. On a repo where a function's context spans fifteen files across three
packages, the dump grows and the pack does not. **That number is unmeasured**,
and the numbers above are the corpus's worst case rather than a representative
one.

### Not counted

`measureTokenDelta` counts only files it can resolve through the `files` table.
A pack item whose `where` is a service name (routes) or `[file-scope]` (config)
contributes no file to the baseline, which makes the baseline **conservative** —
the true dump is larger, so the true ratio is better than reported.

---

**Last Updated**: 2026-09-08
