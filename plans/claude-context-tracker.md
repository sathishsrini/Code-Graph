# CTX tracker: implementation status

**Plan:** [`claude-context-plan.md`](claude-context-plan.md) · **Goal:** [`../goal.md`](../goal.md)
**Branch:** `feat/workflow-context-slices` · **Last updated:** 2026-09-27

Update this file in the same commit as each slice: change the slice's state, fill
in its commit, and move "Current step" forward.

**States:** ✅ done · 🔄 in progress · ⏳ not started · ⛔ blocked (named reason) · 🗓 later (specified, not built)

---

## Current step

**CTX-S1: Connect Claude Code** has its code done and pushed. It stays 🔄 until its
acceptance runs on your machine (steps 5–6). The code was built in a cloud container,
which has no corpus, no `jev-key` and none of your Claude config, so nothing there
could stand in for your `~/.claude`.

| Step | State |
|---|---|
| 1. Write failing tests: `tests/claude-integration.test.ts` | ✅ red first (`ERR_MODULE_NOT_FOUND`), then 38/38 green. Committed; it replaces your local red copy (see "Local state") |
| 2. Hook: `src/integrations/claude-hook.ts` (entrypoint, I/O only) + `claude-steering.ts` (logic). SessionStart instruction + one PreToolUse reminder per session, only in folders listed in `config/repos.json`, never blocks | ✅ Plain-text SessionStart; PreToolUse `hookSpecificOutput.additionalContext` only, never a permission decision; every failure → exit 0, silent. Once-per-session = `wx` marker per session id in `%TEMP%/code-intel-claude-hook` |
| 3. `scripts/claude-integration.ts install\|uninstall\|status` + `npm run claude:install` (also `claude:uninstall`, `claude:status`); merge logic in `src/integrations/claude-settings.ts` | ✅ Backs up `settings.json` before any change; skips the write when nothing changes; refuses a file that does not parse; temp-file + rename. MCP: `claude mcp remove` then `add --scope user code-intel -- node <abs>/src/cli.ts mcp --db <abs>/.codeintel/graph.db` |
| 4. Tests green, `npm run typecheck`, full `npm test` | ✅ typecheck clean · 564 tests, 559 pass. The 5 failures predate S1 and happen only on Linux (see "Found during S1") |
| 5. Run the installer (changes your user-level Claude config, approved) | ⏳ **on your machine**: `npm run claude:install`, then `claude mcp list` should show `code-intel … ✓ Connected` |
| 6. Headless `claude -p` from `dev-workspace`: at least one `mcp__code-intel__*` call; record Read count and tokens | ⏳ **on your machine**, command below |
| 7. `jev_gate`, commit `feat(CTX-S1): …`, update this tracker, push | ✅ commit, tracker, push · ⏳ `jev_gate` (needs `jev-key`, which is not in the container) |

**Proven in the container, with a throwaway `HOME`** (your config was not involved):
install → `claude mcp list` showed `code-intel: node …/src/cli.ts mcp --db … - √ Connected`;
the hook command, run through bash exactly as written in `settings.json`, printed the
instruction on SessionStart, the reminder on the first Grep, and nothing on the second
Grep, on garbage stdin, or in a folder that is not indexed. It exited 0 every time.
`uninstall` restored `settings.json` exactly and removed the server.

**Measured cost** (bytes / 4): instruction **159 tokens** with the 4 corpus services,
reminder **82 tokens**, so at most ≈241 tokens per session. The tool list is unchanged
(≈1,165). Hook latency is ≈145 ms per Read/Grep/Glob call in the container, almost all
of it Node start-up.

**Step 6 command** (Git Bash, from `D:/###facilitator/dev-workspace`, after the graph
is built):

```bash
claude -p "What runs when POST /api/v1/po is called on 40-kri-router? List the auth checks in order." \
  --output-format stream-json --verbose --include-hook-events > s1-headless.jsonl
grep -o '"name":"mcp__code-intel__[a-z_]*"' s1-headless.jsonl | sort | uniq -c   # accept: ≥ 1
grep -c '"name":"Read"' s1-headless.jsonl                                       # record
grep -c 'code-intel: this folder is indexed' s1-headless.jsonl                  # instruction delivered: ≥ 1
tail -n 1 s1-headless.jsonl                                                     # usage totals: record
```

**Waiting on you:** steps 5–6 on your machine, and `jev_gate` on this commit with the
step 6 log as evidence. S2 comes next in the plan's order ("run first after S1", the
baseline before other slices), and it needs the corpus.

## All slices

| Slice | What | Wave | Depends on | State | Commit |
|---|---|---|---|---|---|
| CTX (docs) | `goal.md`, the plan, `CLAUDE.md` link and status | — | — | ✅ done, pushed | `61ecce8` |
| **CTX-S1** | Connect Claude Code: user MCP + steering + headless check | 0 | — | 🔄 code done; install + headless check on your machine | `feat(CTX-S1)` on this branch |
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

Progress: **0 of 17 slices done** (docs commit not counted) · 1 in progress (S1: code done, acceptance pending) · 1 blocked · 3 later.

---

## Things that need you

| When | What | Why |
|---|---|---|
| Now | S1 steps 5–6: `npm run claude:install`, then the headless run above; then `jev_gate` | It changes your user-level Claude config, and the corpus graph and `jev-key` are only on your machine |
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
- `tests/claude-integration.test.ts` is **now committed**. If your red local copy is
  still untracked, `git pull` will refuse to overwrite it. Delete it first; the
  committed version supersedes it.
- Your `~/.claude/settings.json` and `~/.claude.json`: **untouched so far**. S1 was built
  in a cloud container and never touched them.
- The corpus (`D:/###facilitator/dev-workspace`): **untouched so far**. The venv still
  has only `pip`, and no repo has git.
- Four old worktrees under `.claude/worktrees/` (`slice/*` at `4cf32e9`) are left as
  they are. The commits that replaced them are on this branch.

---

## Found during S1 (not fixed, outside the slice)

- **5 tests fail on Linux, so they would also fail on CI's `ubuntu-latest` runner.** `config/repos.json`
  and `tests/next-indexing.test.ts` use `D:/…` rootPaths. `path.isAbsolute` rejects those
  on POSIX, so `validateConfig` throws: `config.test.ts` › loadConfig (4 tests) and
  `next-indexing.test.ts` (1). They pass on Windows, where the tracker's "526 pass" was
  measured. This predates S1 and S1 does not touch it.
