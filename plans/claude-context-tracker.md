# CTX tracker: implementation status

**Plan:** [`claude-context-plan.md`](claude-context-plan.md) · **Goal:** [`../goal.md`](../goal.md)
**Branch:** `feat/workflow-context-slices` · **Last updated:** 2026-09-27

Update this file in the same commit as each slice: change the slice's state, fill
in its commit, and move "Current step" forward.

**States:** ✅ done · 🔄 in progress · ⏳ not started · ⛔ blocked (named reason) · 🗓 later (specified, not built)

---

## Current step

**CTX-S1: Connect Claude Code** is in progress.

| Step | State |
|---|---|
| 1. Write failing tests: `tests/claude-integration.test.ts` | ✅ written, red as intended (`ERR_MODULE_NOT_FOUND`). **Local only, not committed**, because a red test would break the branch's suite |
| 2. `src/integrations/claude-hook.ts`: SessionStart instruction + one PreToolUse reminder per session, only in folders listed in `config/repos.json`, never blocks | ⏳ next |
| 3. `scripts/claude-integration.ts install\|uninstall\|status` + `npm run claude:install`: backs up and merges `~/.claude/settings.json`, runs `claude mcp add --scope user code-intel …` | ⏳ |
| 4. Tests green, `npm run typecheck`, full `npm test` | ⏳ |
| 5. Run the installer (changes your user-level Claude config, approved) | ⏳ |
| 6. Headless `claude -p` from `dev-workspace`: at least one `mcp__code-intel__*` call; record Read count and tokens | ⏳ |
| 7. `jev_gate`, commit `feat(CTX-S1): …`, update this tracker, push | ⏳ |

**Waiting on you:** a go-ahead to continue S1 (asked 2026-09-27).

---

## All slices

| Slice | What | Wave | Depends on | State | Commit |
|---|---|---|---|---|---|
| CTX (docs) | `goal.md`, the plan, `CLAUDE.md` link and status | — | — | ✅ done, pushed | `61ecce8` |
| **CTX-S1** | Connect Claude Code: user MCP + steering + headless check | 0 | — | 🔄 in progress | — |
| CTX-S2 | Corpus benchmark and gate (baseline before other slices) | 1 | — | ⏳ | — |
| CTX-S3 | Restore the Python service's routes (install venv requirements, boot) | 1 | — | ⏳ | — |
| CTX-S4 | Python call tree through WSL Ubuntu-24.04 | 2 | your `sudo apt install` | ⏳ | — |
| CTX-S5 | Git history for the corpus (`git init`, no `.env` tracked) | 1 | — | ⏳ | — |
| CTX-S6 | One-command build + staleness line in every answer | 1 | — | ⏳ | — |
| CTX-S7 | Edit context returns read ranges | 1 | — | ⏳ | — |
| CTX-S8 | Feature by description over MCP (`find_workflow`) | 2 | — | ⏳ | — |
| CTX-S9 | Migrations → tables and columns | 1 | — | ⏳ | — |
| CTX-S10 | SQL → columns; route-accurate table access | 2 | S9 | ⏳ | — |
| CTX-S11 | API data models, route-level (Pydantic/zod) | 2 | S3 | ⏳ | — |
| CTX-S12 | Frontend → backend calls | 1 | — | ⏳ | — |
| CTX-S13 | Errors over MCP (`error_trace`: origin + correlated changes) | 2 | — | ⏳ | — |
| CTX-S14 | OTel end to end on the corpus | 3 | S3, S5, S13 | ⏳ | — |
| CTX-S15 | Web UI: errors, tables, frontend lane | 3 | S10, S12, S13 | ⏳ | — |
| CTX-S16 | Live A/B, 3 questions × 1 run | 4 | S1, S2, lanes A–D | ⏳ | — |
| CTX-S17 | Onboard the first `syf-*` service | 4 | S1–S16 | ⛔ needs the `syf-*` path | — |
| CTX-L1 | Containers and deploy (Docker, compose, k8s) | later | — | 🗓 | — |
| CTX-L2 | Cloud IaC (Terraform) | later | — | 🗓 | — |
| CTX-L3 | Messaging (producer → topic → consumer) | later | — | 🗓 | — |

Progress: **0 of 17 slices done** (docs commit not counted) · 1 in progress · 1 blocked · 3 later.

---

## Things that need you

| When | What | Why |
|---|---|---|
| Now | Go-ahead to continue S1 | It changes your user-level Claude config |
| At S4 | Run once in Ubuntu-24.04: `sudo apt install -y python3-pip python3-venv nodejs npm` | `sudo` needs your password |
| At S4, step 0 | Possibly a decision: keep WSL, or use a Windows-only fix if the diagnostic finds one | `5f9b525` got Python symbols on Windows while today's corpus run failed. The route won't be switched without asking |
| At S17 | The path to the `syf-*` repos, and which service to start with | Unknown today |

---

## Baseline (2026-09-27), the numbers the slices must move

| Measure | Baseline | Moved by |
|---|---|---|
| Tests | 526 pass, 0 fail | every slice |
| Claude Code sees `code-intel` | no | S1 |
| Cross-service `REQUESTS` edges | 0 (6 unresolved) | S3, S12 |
| `51-integration` symbols / routes | 0 / 0 | S4 / S3 |
| Database columns in graph | 0 (5 table nodes) | S9, S10 |
| SQL findings attributed to a file, not a function (41-kri-engine) | 25 | S10 |
| Search phrases matched | 1 of 3 | S8 |
| Benchmark, graph + still-to-read vs reading files (orders_app) | ×1.20, ×1.73 (not met) | S2 gate, then all |
| Tool list per session | ≈1,165 tokens | kept under 2,000 |
| `spans` rows | 0 | S14 |
| Corpus repos with git history | 0 of 4 | S5 |

---

## Local state not in git

- `.codeintel/graph.db`: the corpus graph built 2026-09-27 (gitignored). `scip index`
  ran for 3 repos; `boot dump` for 2 (`51-integration` failed); the search index is
  built (848 rows).
- `tests/claude-integration.test.ts`: S1's tests, written and red, not committed.
- Your `~/.claude/settings.json` and `~/.claude.json`: **untouched so far**.
- The corpus (`D:/###facilitator/dev-workspace`): **untouched so far**. The venv still
  has only `pip`, and no repo has git.
- Four old worktrees under `.claude/worktrees/` (`slice/*` at `4cf32e9`) are left as
  they are. The commits that replaced them are on this branch.
