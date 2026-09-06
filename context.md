# Project Context — code-intel

Durable context for any agent or developer picking this up cold.
Companion to `CLAUDE.md` (session protocol) and
`plans/code-intelligence-engine-plan-v2.md` (plan of record).

---

## What this is

An **architecture-aware code intelligence and context engine** for a multi-repo,
multi-language microservice codebase (Fastify + FastAPI + Next.js).

It answers four questions deterministically, with per-edge provenance:

1. **What executes on this endpoint?** — the ordered middleware/auth chain, then the
   call tree, across service boundaries.
2. **What does this change break?** — reverse call closure projected onto routes and
   services, segmented by confidence.
3. **What can and did fail here?** — the static failure surface *and* real trace
   origins, presented separately and never merged into one verdict.
4. **What is the minimum context to edit this function?** — a budgeted graph
   traversal instead of dumping files.

**Core strategy:** build a thin custom layer, reuse every extractor, fork nothing.
SCIP indexers give symbols and call resolution. Framework **boot reflection** gives
routes and middleware order — this is the central design correction, because that
information is a runtime-reflection problem wearing a static-analysis costume. The
SQLite store, derivations, query engine and context packer are the only custom parts
(~3,000–5,000 LOC).

> Runtime traces establish the boundaries with certainty.
> Static analysis fills in the interiors with inference.

---

## Testing & Validation Policy

**Delegate routine test execution to the local OpenCode free model.** Claude tokens
are for analysis, not for watching a test runner.

```
Claude
  ↓  asks local OpenCode to run tests
Local OpenCode  →  npm test / pytest / tsc --noEmit
  ↓  returns a CONCISE result
Claude  →  analyses only the failures, only if needed
```

**Invocation** (`opencode` is at `C:/ProgramData/chocolatey/bin/opencode`):

```bash
opencode run "Run: npm test && npm run typecheck in C:/Users/sathish/Projects.
Reply with ONLY: total/passed/failed counts, and for each failure the test name
plus the assertion or error message. No stack traces. No passing-test names."
```

**Rules**

- Return **only** counts plus failure names and error messages.
- Do **not** send full test logs to Claude unless they are needed for debugging.
- Use Claude for deeper analysis, debugging, implementation decisions, or when the
  local model cannot resolve the issue.
- **Never skip, `.only`, or suppress a failing test to reduce token usage.** A red
  test is information; hiding it turns a known problem into an unknown one.

---

## Current state

| | |
|---|---|
| **Phase** | 0 — Prove the pipeline (timeboxed to one week) |
| **Done** | Repo scaffold · `.claude` session docs · CI · P0-T1 · P0-T2 · P0-T5 |
| **Next** | P0-T3 (run `scip-typescript`) → P0-T4 (parse SCIP) → P0-T6 (derive `CALLS`) → **P0-T7 (measure false-positive rate)** → P0-T8 (Fastify boot dump) → P0-T9 (CLI `flow`) |
| **Tests** | 33 passing, typecheck clean |
| **Gate** | P0-T9: the printed tree must match what a senior developer would draw by hand |

## Stack

TypeScript · Node >= 22.6 (currently v25.6.1, runs `.ts` natively — **no build step,
no loader flag**) · `node:sqlite` built in (no native compilation on Windows) ·
`erasableSyntaxOnly` so source stays directly runnable · `node --test`.

Planned extractors: `scip-typescript`, `scip-python`, tree-sitter, Semgrep,
OpenTelemetry. UI: React Flow + elkjs.

## Prerequisites — status

| Requirement | Status |
|---|---|
| Node >= 22.6 | ✅ v25.6.1 |
| npm | ✅ 11.9.0 |
| git + identity | ✅ 2.45.1, configured |
| `node:sqlite` | ✅ works (experimental warning is expected) |
| TypeScript | ✅ 5.9.3 |
| `opencode` | ✅ on PATH |
| **`python3`** | ❌ **only `python` (3.14). All `.claude/hooks/*.sh` invoke `python3` and silently no-op.** |
| **Python 3.11/3.12** | ❌ needed for `scip-python`; `psycopg2-binary` has no cp314 wheel (OPEN-5) |
| `scip-typescript` | ❌ not installed — blocks P0-T3 |
| `scip`, `scip-python`, `semgrep` | ❌ not installed — Phase 0/1 |
| `.claude/hooks/` wired | ❌ hooks exist as files but no `settings.json` registers them — dormant |

No special file permissions are required. Everything lives under the user profile and
the corpus is read-only to this engine.

---

## The five mistakes that killed v1 and v2

Full detail with symptom/check/fix: `.claude/COMMON_MISTAKES.md`.

1. **Schema before extractor.** v2 shipped ~470 lines of DDL and 28 relationship
   types, of which **zero** had a producer. Rule: no table until something fills it
   this week.
2. **Invented symbol identity.** `service.dotted.path.Name` is not a key — not unique
   across repos, not stable across refactors. **This was the root cause**; everything
   else was downstream. Fix: the verbatim SCIP symbol string.
3. **Name-matched, intra-file-only edges.** v1 matched `/(\w+)\s*\(/` (which catches
   `if (`, `for (`), resolved by suffix, and built `symbolMap` per file — so
   **cross-file call edges did not exist at all**. Guarded now by
   `crossFileCallCount()` and a test.
4. **LLM writing facts.** A hallucinated edge is indistinguishable from a real one and
   poisons every query permanently. Enforced structurally: LLM output lands only in
   `summaries`, which no traversal joins.
5. **Merged confidence axes.** v2 bridged a REAL column to a TEXT enum with
   `>= 0.9 → 'exact'`. A 0.91 guess is not exact. Confidence is an enum, and it is a
   *different axis* from success/error rendering.

## Data model

**7 node kinds** — `service` `route` `symbol` `file` `external` `datastore` `config`.
One `nodes` table, integer PK, `UNIQUE(kind, key)`. Identity is **global**, never
repo-scoped, which is what makes a cross-service edge an ordinary row.

**9 edge types** — `CONTAINS` `CALLS` `HANDLES` `REQUESTS` `READS` `WRITES`
`CALLS_EXTERNAL` `THROWS` `READS_CONFIG`.

**Plus one ordered relation that is not an edge**: `route_chain(route_node_id,
position, symbol_node_id, phase, check_kind)`. Ordering is the whole point of a
security-flow graph, and an edge cannot carry it.

**Two enums that must never merge:**

```
confidence    ∈ certain | inferred | observed | unresolved     (never a number)
evidence_kind ∈ scip | treesitter | semgrep | boot | otel | manual
```

## Validation corpus — read this before trusting a green run

`D:/###facilitator/dev-workspace/` — `40-kri-router` (Fastify/JS), `41-kri-engine`
(Fastify/JS), `51-integration` (FastAPI), `60-kri-next` (Next.js/TS).

⚠️ **These are test fixtures, not the live `syf-*` services, and they are inverted
from reality on almost every axis:**

| Real system needs | Fixture has |
|---|---|
| Plugin nesting, inherited hook chains | **zero** `register()` calls |
| `preHandler` / `preValidation` hooks | none — 2 global hooks only |
| Ajv route schemas | none (`zod` installed, unused) |
| FastAPI `Depends()` | **zero** |
| `APIRouter` + prefixes | none — flat `@app.post` |
| TypeScript source | dead TS + live untyped CommonJS |
| `throw new X()` | none — returns error envelopes |
| Scale (OOM risk) | ~2,700 LOC total |

**Consequence:** passing on the fixtures does not prove the engine works on real code.
In particular the fixture cannot exercise inherited hook chains — the single mechanism
that justifies boot reflection — and `scip-typescript` will never OOM on 2,700 LOC, so
the Phase 0 OOM gate cannot fail. Validate against one real service before trusting
Phase 0's exit criterion. See plan §6 OPEN-3.

Two places the fixture is *harder* than reality, worth keeping: the cross-service
linker faces a wrapper indirection, a `req.url` pass-through **and** an env-conditional
destination fork; and auth is inline in handler bodies rather than in hooks.

## Open decisions

Nine in plan §6. Resolved so far:

- **OPEN-1** → reachability declared via `include`/`exclude` in `config/repos.json`;
  the dead `src/` trees are excluded.
- **OPEN-2** → project root `C:/Users/sathish/Projects`, package `code-intel`.
- **OPEN-3** → two-target split (`60-kri-next` for call fidelity, `40-kri-router` for
  boot). **Recommended revision: add one real service before the Phase 0 gate.**

Still open: OPEN-4 (`procurement-module` outside corpus) · OPEN-5 (Python env) ·
OPEN-6 (no route schemas) · OPEN-7 (who instruments for OTel) · OPEN-8 (LLM provider)
· OPEN-9 (shared-DB coupling).

## Git convention

One commit per completed plan task, task ID in the subject:

```
feat(P0-T5): minimal SQLite schema + fact store
```

Prefixes: `feat` `fix` `chore` `docs` `test` `refactor`. History maps 1:1 onto plan §4.

## Deliberately out of scope

CodeQL (licence forbids private commercial use) · Kùzu / any embedded graph DB
(archived Oct 2025) · custom taint or data-flow analysis (multi-year project; shell out
to Joern/Opengrep if ever needed) · forking blarify · self-hosting Sourcegraph ·
bitemporal edge validity (git already stores history) · the v2 "neural layer" ·
`CALLED_BY` / `IMPORTS` / `AFFECTS` / `CATCHES` and the other producerless relationship
types.

---

**Last Updated**: 2026-09-06
