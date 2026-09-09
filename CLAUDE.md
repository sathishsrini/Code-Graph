# CLAUDE.md

**Quick-start guide for Claude Code - Complete details in linked docs**

---

## Project Overview

**code-intel** — an architecture-aware code intelligence and context engine for a
multi-repo, multi-language microservice codebase (Fastify + FastAPI + Next.js).

It answers four questions deterministically, with per-edge provenance:

1. **What executes on this endpoint?** — ordered middleware/auth chain, then the call
   tree, across service boundaries.
2. **What does this change break?** — reverse call closure projected onto routes and
   services, segmented by confidence.
3. **What can and did fail here?** — static failure surface *and* real trace origins,
   presented separately, never merged.
4. **What is the minimum context to edit this function?** — budgeted graph traversal
   instead of dumping files.

**Build a thin custom layer. Reuse every extractor. Fork nothing.** Symbols and call
resolution come from SCIP indexers; routes and middleware order come from boot-time
reflection (*not* static analysis — this is the central design correction); the
SQLite store, derivations, query engine and context packer are the only custom parts.

> Runtime traces establish the boundaries with certainty.
> Static analysis fills in the interiors with inference.

**Tech Stack**: TypeScript · Node >=22.6 (native `.ts`, no build step) ·
`node:sqlite` (built in, no native compilation) · SCIP (`scip-typescript`,
`scip-python`) · tree-sitter · Semgrep · OpenTelemetry · React Flow + elkjs

**Status**: Phase 0 in progress. Nothing is implemented beyond scaffolding.
Plan of record: `plans/code-intelligence-engine-plan-v2.md` (78 requirements,
44 tasks, 4 phases). Research verdict it implements:
`docs/code-intelligence-engine.md`.

---

## Session Start Protocol ⚡

**MANDATORY** at start of each session:

```bash
# Load essential docs (~800 tokens - 2 min read)
✓ .claude/COMMON_MISTAKES.md      # ⚠️ CRITICAL - Read FIRST
✓ .claude/QUICK_START.md          # Essential commands
✓ .claude/ARCHITECTURE_MAP.md     # File locations
```

**At task completion:**
- Create completion doc in `.claude/completions/YYYY-MM-DD-task-name.md`
- Move session file to `.claude/sessions/archive/` (if created)
- **Commit with the plan task ID in the subject** (`feat(P0-T5): ...`)

**⚠️ NEVER auto-load:**
- Files in `.claude/completions/` (0 token cost)
- Files in `.claude/sessions/` (0 token cost)
- Files in `docs/archive/` (0 token cost)

---

## Quick Start Commands

```bash
npm install                 # first time only
npm run typecheck           # tsc --noEmit
npm test                    # node --test tests/
node src/cli.ts --help      # CLI (Node runs .ts natively — no flag, no build)
npm run audit:tokens        # npx claude-token-optimizer audit --json

# Summaries run on a LOCAL model (OPEN-8). First generation downloads weights.
node src/cli.ts summaries generate --scope service --seed <svc>   # bottom-up, cache-first
node src/cli.ts summaries read <nodeKey> --kind <function|module|service>
```

Full command set and engine workflow: `.claude/QUICK_START.md`

---

## Testing & Validation Policy 🔬

**Never read raw test output. Filter it.** Measured on this suite: raw
`npm test` is 2,938 bytes (~750 tokens); the filtered form below is **36 bytes**.

```bash
npm test 2>&1 | grep -E '^(ℹ (tests|pass|fail)|✖)'
```

That yields counts plus the name of every failing test, deterministically, at
~12 tokens. Only when something is red do you pull the detail for that one test:

```bash
npm test 2>&1 | grep -A 15 '✖ <failing test name>'
```

**Rules:**

| Do | Don't |
|---|---|
| Filter output to counts + failure names | Pipe full test logs into context |
| Pull detail for **one** failing test at a time | Re-read passing-test output |
| Fix the root cause | **Skip, `.only`, or suppress a test to save tokens** |

**Never suppress a failing test to reduce token usage.** A red test is
information; hiding it converts a known problem into an unknown one — exactly the
failure mode as dropping `unresolved_calls` from the graph.

> Delegating test runs to a second local model was evaluated and rejected: its
> reply still lands in this context via the shell, so it costs ~150 tokens
> against grep's 12, and it puts an LLM's interpretation between you and a
> deterministic result.

---

## Working rules for this repo

1. **No table or column without an extractor that fills it this week.** This is the
   rule that prevents a third failure — v2 was 470 lines of DDL with no producers.
2. **Symbol identity is the verbatim SCIP symbol string.** Never compose your own.
3. **The LLM may read the graph and write prose. It may never write a row another
   query treats as fact.** Enforced structurally: LLM output lands only in
   `summaries`, which no traversal joins.
4. **`confidence` is an enum, never a number**, and never merged with the
   success/error rendering axis.
5. **Store the gaps.** `unresolved_calls` is a feature. A tool that hides what it
   could not analyse turns an unknown into a false negative.
6. **One commit per completed plan task**, subject prefixed with the task ID.

Details and the failure modes behind each: `.claude/COMMON_MISTAKES.md`

---

**Last Updated**: 2026-09-06
**Optimized with**: [Claude Token Optimizer](https://github.com/nadimtuhin/claude-token-optimizer)
