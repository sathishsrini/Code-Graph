# CTX tracker: implementation status

**Plan:** [`claude-context-plan.md`](claude-context-plan.md) · **Goal:** [`../goal.md`](../goal.md)
**Branch:** `feat/workflow-context-slices` · **Last updated:** 2026-09-27

Update this file in the same commit as each slice: change the slice's state, fill
in its commit, and move "Current step" forward.

**States:** ✅ done · 🔄 in progress · 👀 awaiting your review · ⏳ not started · ⛔ blocked (named reason) · 🗓 later (specified, not built)

---

## Current step

**CTX-S1: Connect Claude Code** is **👀 awaiting your review**. The code is in
(`36d39cf`), it is installed on your machine, and the headless acceptance run passed.
The Jev gate escalated on low confidence rather than on any finding (details below).
The VS Code panel itself has not been checked, because only the CLI could be driven
from here.

| Step | State |
|---|---|
| 1. Failing tests first: `tests/claude-integration.test.ts` | ✅ red first, then 38/38 green (`36d39cf`) |
| 2. Hook: `src/integrations/claude-hook.ts` (I/O) + `claude-steering.ts` (logic) | ✅ SessionStart plain-text instruction; one PreToolUse `additionalContext` reminder per session; never a permission decision; every failure → exit 0, silent |
| 3. Installer: `scripts/claude-integration.ts` + `npm run claude:install\|uninstall\|status`; merge in `claude-settings.ts` | ✅ backup before change, temp-file + rename, refuses unparsable settings, idempotent |
| 4. Tests, typecheck | ✅ **565/565** on Windows, typecheck clean. That includes the new `tests/mcp-stdio.test.ts` (step 7) |
| 5. Install on your machine | ✅ `claude mcp list` → `code-intel: node D:/CodeGraph/src/cli.ts mcp --db D:/CodeGraph/.codeintel/graph.db - ✓ Connected` (user scope). `~/.claude/settings.json`: every original key kept, 2 hooks added; original backed up as `settings.json.bak-code-intel-2026-09-27T15-56-35-641Z` (434 bytes) |
| 6. Headless `claude -p` from `dev-workspace` | ✅ see "Acceptance run" |
| 7. Jev gate | 👀 escalated 3×, on low confidence, not on a finding (see "Jev gate"). The flagged rubric, test gap, got a real fix: `tests/mcp-stdio.test.ts` |
| 8. VS Code panel check | ⏳ **yours** (see "Things that need you") |

### Acceptance run (headless, 2026-09-27)

`claude -p "What runs when POST /api/v1/po is called on 40-kri-router? List the auth
checks in order."` from `D:/###facilitator/dev-workspace`, `--output-format
stream-json --include-hook-events`, the 4 `code-intel` tools allowed, `--max-budget-usd 2`.

| Measure | Result |
|---|---|
| `mcp__code-intel__*` calls | **1** (`endpoint_flow`), plus 1 `ToolSearch` to load its schema |
| Read / Grep / Glob calls | **0** |
| SessionStart instruction delivered | ✅ `hook_response` `SessionStart:startup`, exit 0, full instruction in `stdout` |
| Outcome | success · 3 turns · 24.7 s · $0.066 |
| Tokens | input 9 uncached + 9,665 cache-write + 57,374 cache-read · output 824 |
| Answer | Matched the graph: `onRequest` `server.js:36`, handler `proxyToEngine` `server.js:168`, `onResponse` `server.js:46`, inline `checkUserAuth` `server.js:169`. It named the unresolved `PROCUREMENT_BASE_URL` gap instead of guessing |

This is one run of one question. It shows that the wiring works and Claude uses it,
not a token saving. Savings are measured by S2 (deterministic) and S16 (live A/B).

### Jev gate

| Run | Evidence given | Review (safe_to_apply · test gap · composite) | Claims |
|---|---|---|---|
| 1 | Change summary, counts | 0.43 · 0.59 · 0.81 | 6 verified, 1 unsupported ("instruction delivered": only a count was shown) |
| 2 | + the 38 test titles, raw `hook_response`, full settings before/after, complete tool list | 0.49 · 0.52 · 0.84 | 8/8 verified |
| 3 | + new `tests/mcp-stdio.test.ts` and its mutation check | 0.50 · **0.78** · 0.74 (floor 0.70) | 7/7 verified (5 auto, 2 review) |

Correctness and spec match scored 1.8–1.9 of 2 in every run. The escalation comes from
the rubric *confidence* (0.31 at best), and one claim's confidence moved between runs
on the same evidence (0.95 → 0.57). A fourth run on unchanged evidence would be fishing
for a pass, so the gate stopped at 3 and the result is recorded as it came out.

**What run 3 added.** `tests/mcp-stdio.test.ts` starts the exact command the installer
registers, from a folder that is not this repo, and asserts the stdio handshake, the
tool list, and a real tool call. Mutation check: one stray `stdout` line in the `mcp`
command turns it red (restored from git afterwards).

---

## All slices

| Slice | What | Wave | Depends on | State | Commit |
|---|---|---|---|---|---|
| CTX (docs) | `goal.md`, the plan, `CLAUDE.md` link and status | — | — | ✅ done, pushed | `61ecce8`, `3791e92` |
| **CTX-S1** | Connect Claude Code: user MCP + steering + headless check | 0 | — | 👀 installed and accepted headless; gate escalated; panel check pending | `36d39cf`, `test(CTX-S1)` |
| CTX-S2 | Corpus benchmark and gate (baseline before other slices) | 1 | — | ⏳ next | — |
| CTX-S3 | Restore the Python service's routes (install venv requirements, boot) | 1 | — | ⏳ | — |
| CTX-S4 | Python call tree through WSL Ubuntu-24.04 | 2 | your `sudo apt install` | ⏳ | — |
| CTX-S5 | Git history for the corpus (`git init`, no `.env` tracked) | 1 | — | ⏳ | — |
| CTX-S6 | One-command build + staleness line in every answer | 1 | — | ✅ built: `node src/cli.ts build` reports every channel per repo (ok / failed with its error / skipped); every MCP answer ends with a `freshness` line (≈20 tokens, 0.25 ms). A test proves target repos are byte-identical after a build (no generated tsconfig, no `__pycache__`). Corpus acceptance yours (commands in the commit body) | `ce5bfeb` |
| CTX-S7 | Edit context returns read ranges | 1 | — | ✅ built; corpus measurement yours (`context checkUserAuth --measure --no-source`). orders_app: Read(ranges) 54–60% of Read(files). Gap: one-line ranges where SCIP has no enclosing range → S7b (draft plan) | `f063ae8` |
| CTX-S8 | Feature by description over MCP (`find_workflow`) | 2 | — | ⏳ | — |
| CTX-S9 | Migrations → tables and columns | 1 | — | ⏳ | — |
| CTX-S10a | Calls and SQL inside anonymous handlers credited to the route, not the file (A/B finding M11 #1) | 1 | — | ⏳ | — |
| CTX-S10b | SQL → columns on the path | 2 | S9, S10a | ⏳ | — |
| CTX-S11 | API data models, route-level (Pydantic/zod) | 2 | S3 | ⏳ | — |
| CTX-S12 | Frontend → backend calls | 1 | — | ⏳ | — |
| CTX-S13 | Errors over MCP (`error_trace`: origin + correlated changes) | 2 | — | ✅ built; the 4 sections never merged; largest synthetic route 5,443 tokens. From uninstrumented traces the origin has no function or line → S19 (draft plan) | `246743e` |
| CTX-S14 | OTel end to end on the corpus | 3 | S3, S5, S13 | ⏳ | — |
| CTX-S15 | Web UI: errors, tables, frontend lane | 3 | S10b, S12, S13 | ⏳ | — |
| CTX-S16 | Live A/B, 3 questions × 1 run | 4 | S1, S2, lanes A–D | 🔄 kit ready (`docs/ab-token-check.md`). First answers compared on your machine; findings recorded as M11, answer key corrected (error-handler note, live-config scoring). Token numbers not transferred yet | `2b45cde`, `docs(CTX-S16)` |
| CTX-F1 | Tests green on Linux: `D:/…` rootPaths rejected on POSIX (5 tests) | fix | — | ✅ 595/595 on Linux | `ec7099a` |
| CTX-F2 | `.env` Read deny rule: installer command + both A/B arms (A/B finding M11 #5) | fix | — | ✅ built (`npm run claude:deny-env`, `Read(//**/.env)` + `Read(//**/.env.*)`, from the permissions docs); running it on your machine is yours. Open: it also blocks `.env.example` (draft plan Q4) | `c164cab` |
| CTX-S17 | Onboard the first `syf-*` service | 4 | S1–S16 | ⛔ needs the `syf-*` path | — |
| CTX-L1 | Containers and deploy (Docker, compose, k8s) | later | — | 🗓 | — |
| CTX-L2 | Cloud IaC (Terraform) | later | — | 🗓 | — |
| CTX-L3 | Messaging (producer → topic → consumer) | later | — | 🗓 | — |

Progress: **0 of 17 slices done** · 1 awaiting your review (S1) · 14 not started · 1 blocked · 3 later.

---

## Things that need you

| When | What | Why |
|---|---|---|
| **Now** | **S1 panel check:** in VS Code, open the folder `D:/###facilitator/dev-workspace`, start a **new** Claude conversation, and ask *"What runs when POST /api/v1/po is called on 40-kri-router? List the auth checks in order."* Expect a `code-intel` tool call in the transcript and no file reads. | G1 names the VS Code panel. The extension shares the CLI's MCP config and hooks (per the docs), but that has not been observed in the panel |
| **Now** | **S1 sign-off:** accept S1 with the gate result above, or name what else should be tested | The gate escalated on confidence, not on a finding |
| **Now** | **`main` branch:** keep it tracking `codegraph-upstream/main` (the Rust CodeGraph project), or repoint it to `origin/main` (`4cf32e9`, this project) | The two histories share no commits, so repointing replaces the branch. Not done without your word |
| **Now** | **A/B numbers:** run `node docs/ab/summarize.mjs D:/CodeGraph/.codeintel/ab/q*-*.jsonl` and paste the table into M11 | The comparison was done in another session; its numbers are only in your logs |
| **Now** | **Draft plan v2:** answer its questions 6–8 (§9) and approve it: [`claude-context-remaining.md`](claude-context-remaining.md) | No new slice starts before your approval |
| **Now** | **Merge decision:** S2 (`974d0e5`), S9 (`d6d207e`), S10a (`949335f`) are done in agent worktrees; cherry-picking them was blocked by the session's permission check | Allow `git cherry-pick`, or merge them yourself |
| When ready | **Python packages** for S3 and S22 (commands in the draft plan, §3 S22) | You said you will install them |
| At S4 | Run once in Ubuntu-24.04: `sudo apt install -y python3-pip python3-venv nodejs npm` | `sudo` needs your password |
| At S4, step 0 | Possibly a decision: keep WSL, or use a Windows-only fix if the diagnostic finds one | `5f9b525` got Python symbols on Windows while today's corpus run failed. The route won't be switched without asking |
| At S17 | The path to the `syf-*` repos, and which service to start with | Unknown today |

---

## Baseline (2026-09-27), the numbers the slices must move

| Measure | Baseline | Now | Moved by |
|---|---|---|---|
| Tests | 526 pass, 0 fail | 612 pass, 0 fail (Linux, after F1, F2, S6, S7, S13) | every slice |
| Claude Code sees `code-intel` | no | **yes**: user scope, Connected; used in the headless run | S1 |
| Cross-service `REQUESTS` edges | 0 (6 unresolved) | = | S3, S12 |
| `51-integration` symbols / routes | 0 / 0 | = | S4 / S3 |
| Database columns in graph | 0 (5 table nodes) | = | S9, S10 |
| SQL findings attributed to a file, not a function (41-kri-engine) | 25 | = | S10 |
| Search phrases matched | 1 of 3 | = | S8 |
| Benchmark, graph + still-to-read vs reading files (orders_app) | ×1.20, ×1.73 (not met) | = | S2 gate, then all |
| Tool list | ≈1,165 tokens | 1,449 tokens with `error_trace` and the read-range note; loaded on demand via `ToolSearch` | kept under 2,000 |
| `spans` rows | 0 | = | S14 |
| Corpus repos with git history | 0 of 4 | = | S5 |

---

## Local state not in git

- `.codeintel/graph.db`: the corpus graph built 2026-09-27 (gitignored). `scip index`
  ran for 3 repos; `boot dump` for 2 (`51-integration` failed); the search index is
  built (848 rows). The registered MCP server reads this file.
- **Your user-level Claude config is now changed, as approved.**
  - `~/.claude/settings.json` has the SessionStart and PreToolUse(`Read|Grep|Glob`)
    hooks. The original is backed up next to it.
  - `~/.claude.json` has `code-intel` registered at user scope.
  - Undo both with `npm run claude:uninstall`.
- The corpus (`D:/###facilitator/dev-workspace`) is **untouched**. The venv still has
  only `pip`, and no repo has git.
- The pre-S1 red draft of `tests/claude-integration.test.ts` was moved out of the repo
  before the fast-forward, because the committed version supersedes it.
- The old `slice/*` worktrees and branches are gone. `git worktree list` shows only the
  main checkout.

---

## Findings (not fixed, outside the slices)

- **`scip-python` works on Linux.** S6's fixture build indexed `orders_app/api` with 75 symbols in this Linux container, the same count `5f9b525` recorded. That supports S4's WSL route; it does not explain the corpus's empty Windows index (S4 step 0).
- **Fixed (CTX-F1):** the 5 Linux-only test failures (`D:/…` rootPaths). The suite is 595/595 on Linux.
- **Claude Code loads MCP tool schemas on demand.** In the headless run (CLI 2.1.119)
  the `code-intel` tools sat behind `ToolSearch`: one extra call loaded
  `endpoint_flow`'s schema before it was used. So the ≈1,165-token tool list is not paid
  up front in every session. The plan's "tool list per session" risk is smaller than
  written, and the tool *descriptions* matter more, because they are what `ToolSearch`
  matches on.
- **Local `main` tracks the wrong project.** It follows `codegraph-upstream/main` (Rust
  CodeGraph, now `64f4f30`), not `origin/main` (`4cf32e9`). See "Things that need you".
