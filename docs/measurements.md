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

**Task**: P0-T7 · **Status**: ⬜ not yet measured — P0-T6 must land first.

**Gate**: R70 — manually verify 50 sampled `CALLS` edges against source. Above
~10% the graph is untrustworthy and the project should stop and fix the filters
rather than build on it.

> ⚠️ Measure this on `60-kri-next` (real, `strict: true` TypeScript), **not** on
> `40-kri-router`. The router's live code is untyped CommonJS, where SCIP
> resolution is inherently weaker; a bad number there would say more about the
> fixture than about the derivation, and could trigger the plan's
> abandon-and-fork rule for the wrong reason. See plan §6 OPEN-3.

| Date | Sample | False positives | Rate | Notes |
|---|---|---|---|---|
| — | — | — | — | pending P0-T6 |

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

**Last Updated**: 2026-09-06
