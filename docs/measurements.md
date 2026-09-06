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

**Last Updated**: 2026-09-06
