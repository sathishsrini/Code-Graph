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
```

Full command set and engine workflow: `.claude/QUICK_START.md`

---

## Testing & Validation Policy 🔬

**Delegate routine test execution to the local OpenCode free model. Do not spend
Claude tokens running or reading test output that a local model can summarise.**

```
Claude
  ↓  asks local OpenCode to run tests
Local OpenCode  →  npm test / pytest / tsc --noEmit
  ↓  returns a CONCISE result
Claude  →  analyses only the failures, only if needed
```

**Delegate to OpenCode:**

```bash
opencode run "Run: npm test && npm run typecheck in C:/Users/sathish/Projects.
Reply with ONLY: total/passed/failed counts, and for each failure the test name
plus the assertion or error message. No stack traces. No passing-test names."
```

`opencode` is installed at `C:/ProgramData/chocolatey/bin/opencode`.
`opencode run <message>` is the non-interactive form.

**Rules:**

| Do | Don't |
|---|---|
| Ask OpenCode to run the suite and report counts + failure messages | Pipe full test logs into Claude |
| Bring Claude in for **debugging, root cause, design decisions** | Use Claude as a test runner |
| Escalate to Claude when the local model cannot resolve it | Ask Claude to re-read passing output |
| Keep every failing test failing until genuinely fixed | **Skip, `.only`, or suppress a test to save tokens** |

**Never suppress a failing test to reduce token usage.** A red test is
information; hiding it converts a known problem into an unknown one — the same
failure mode as dropping `unresolved_calls` from the graph.

Claude is for: root-cause analysis, implementation decisions, schema and API
design, and anything the local model gets wrong or cannot resolve.

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
