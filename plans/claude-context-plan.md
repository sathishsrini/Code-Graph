# CodeGraph as Claude's context source: plan (CTX)

**Goal:** [`goal.md`](../goal.md) (requirements G1–G13, confirmed 2026-09-27)
**Base:** `feat/workflow-context-slices` @ `5f9b525` · **Slice IDs:** `CTX-S1` … `CTX-S17`, later `CTX-L1` … `CTX-L3`
**Relation to earlier plans:** `plans/code-intelligence-engine-plan-v2.md` stays the
record of how the engine was built, and is not edited. This plan builds on what v2
shipped and does not repeat it.

---

## 0. How this plan was built, and how to read it

- **Facts first.** Every "today" statement in §2 was measured on 2026-09-27 against
  a freshly built corpus graph, and the command that produced it is named. Where a
  measurement contradicts an older record, both are shown (§2.9).
- **Jev (TypeSafe) was used three times** (§3.1): to check the Claude Code
  documentation claims this plan depends on, to rank the ways of connecting to
  Claude, and to check whether each part of the goal is feasible. A Jev verdict is
  a calibrated judgment on the evidence it was given, not proof. One verdict is
  overruled in §3.1 because the build log contradicts it.
- **Slices are thin and vertical.** One gap per slice. Each slice goes from input to
  something a user or Claude can see: extractor → store → query → MCP/UI → test →
  measurement. Each is committed on its own after a Jev gate. Slices in the same
  wave touch disjoint files, so they can run as parallel background agents (§7).
- **Deviations are measured against your goal**, not against plan v2 (§4).

---

## 1. Requirements

From [`goal.md`](../goal.md). Short labels used in the rest of this plan:

| ID | Requirement (short) |
|---|---|
| G1 | Claude Code (CLI + VS Code panel) gets context from the graph over MCP; other AI tools later |
| G2 | User-scope MCP + user-level non-blocking steering, active only in folders in `config/repos.json` |
| G3 | Three questions: endpoint flow · feature by description · edit context |
| G4 | Cut exploratory reads; Claude reads only the exact lines it edits |
| G5 | Token proof: deterministic gate (fewer tokens **and** all required facts) + live A/B 3×1 |
| G6 | OTel error tracing: code origin + correlated recent changes; askable over MCP and visible in the UI |
| G7 | UI shows service→service, frontend→backend, API→tables |
| G8 | Tables & columns from SQL migrations; SQL reads/writes linked to them; no ORM |
| G9 | API data models (Pydantic/zod), linked through the route |
| G10 | Python call tree via `scip-python` in WSL Ubuntu-24.04 |
| G11 | Infrastructure as later slices, specified not built |
| G12 | Corpus first, then `syf-*` (placeholder slice) |
| G13 | Jev is dev-time only; the engine never calls it |

---

## 2. Facts: where things stand on 2026-09-27

Corpus = `D:/###facilitator/dev-workspace` (`40-kri-router`, `41-kri-engine`,
`51-integration`, `60-kri-next`). Graph built with `scip index` + `boot dump` +
`index` into `.codeintel/graph.db`.

### 2.1 Engine health
| Fact | Evidence |
|---|---|
| 526/526 tests pass, `tsc --noEmit` clean at `5f9b525` | `npm test`, `npm run typecheck` |

### 2.2 The Claude connection
| Fact | Evidence |
|---|---|
| An MCP server exists (stdio) and exposes **4 tools**: `endpoint_flow`, `impact`, `security_path`, `context_pack`. Output is TOON text. | `src/mcp/server.ts` |
| `errors`, `search`, `co-changed`, `summaries` are **CLI-only**. | `src/cli.ts`; Jev: "errors/search reachable over MCP" → contradicted |
| Claude Code is **not configured** to use it: no `.mcp.json`, `code-intel` absent from `claude mcp list`, no hooks in `~/.claude/settings.json`. | `claude mcp list`; file read |
| The Claude Code VS Code extension and the CLI **share one MCP configuration**; servers can be added at local/project/user scope; project-scope servers need approval. | code.claude.com/docs/en/ide-integrations, /mcp (Jev-verified) |
| SessionStart hook stdout is added to Claude's context; PreToolUse supports `additionalContext`; matchers can target `Read\|Grep\|Glob` and `mcp__<server>__.*`. | code.claude.com/docs/en/hooks (Jev-verified) |
| Claude Code warns above **10,000 tokens** per MCP result and caps at **25,000** by default. | /mcp docs (Jev-verified) |
| Claude Code's edit tool **fails unless the file was read first** in the session. `Read` accepts offset/limit. | Edit tool contract; Jev: "edit without reading" → contradicted |
| Tool list cost: **~1,165 tokens** per session for the 4 tools. | `JSON.stringify(TOOLS)` / 4 |

### 2.3 What an answer costs today (corpus)
| Call | ≈ tokens | For comparison |
|---|---|---|
| `endpoint_flow 40-kri-router POST /api/v1/po` | 737 | router `server.js` ≈ 3,774 |
| `impact checkUserAuth` | 482 | |
| `context_pack checkUserAuth` | 1,026 (878 without source) | |
| `security_path 41-kri-engine` | 365 | engine `server.js` ≈ 6,384 |

Tokens = bytes / 4, the same convention as `scripts/workflow-bench-score.ts`.

### 2.4 Token benchmark already in the repo (orders_app fixture, `5f9b525`)
| Question | Facts found | Graph + still-to-read vs reading files |
|---|---|---|
| checkout 402 root cause | 2/11 | **×1.20** (more expensive) |
| order.created event flow | 2/5 | **×1.73** (more expensive) |
| POST /api/orders call chain | edges 5/11 expected, 0 false | — |

**So G5 is not met today.** Where the graph misses facts, Claude reads the files anyway
and pays for both.

### 2.5 Graph content (corpus)
| Fact | Evidence |
|---|---|
| Nodes: 789 symbol · 44 route · 15 file · 14 config · 9 external · 5 datastore · 4 service | `SELECT kind, COUNT(*) FROM nodes` |
| Edges: CONTAINS 848 · CALLS_EXTERNAL 330 · HANDLES 132 · CALLS 94 · READS_CONFIG 24 · READS 13 · WRITES 5 · THROWS 3 · **REQUESTS 0** | `SELECT type, COUNT(*) FROM edges` |
| `index` alone produces **0 symbols, 0 calls, 0 routes**. It needs `scip index` and `boot dump` artifacts first, which are separate manual per-repo steps. | first `index` run: "MISSING: scip index / boot dump" |
| **`51-integration` is empty:** its venv has only `pip` (no fastapi), so `boot dump` fails (`No module named 'fastapi'`); `scip-python` writes an **empty index** ("Python was not found", code 9009). | build log; `.venv/Lib/site-packages` |
| As a result **0 cross-service `REQUESTS`** resolve. The Phase 1 record had 2 (router → `51-integration POST /api/v1/mail/send`). | build log vs `implementation/RECORD.md` |
| Frontend → backend: `60-kri-next/lib/api.ts:13` sets `BASE = process.env.NEXT_PUBLIC_API_BASE_URL \|\| "http://localhost:3001"` (3001 = router) and calls `fetch(`${BASE}${path}`)` with `path` passed in by callers. It is unresolved today. | source; 6 cross-service gaps |

### 2.6 Database and models
| Fact | Evidence |
|---|---|
| Tables exist only as 5 `datastore` nodes keyed `postgres://?/<table>` (database unknown, engine hard-coded `postgres`), created from **SQL string literals**. | `SELECT key FROM nodes WHERE kind='datastore'`; `extract.ts` |
| **No columns** anywhere. The node kinds are fixed at 7 by a `CHECK` constraint. | migration 001; Jev → contradicted "stores columns" |
| `41-kri-engine/migrations/001_init.sql` (CREATE TABLE users, purchase_orders, …) is in `repos.json` `include` but **never parsed**: the extractors handle JS/TS/Python only. | build log "files: 1"; Jev-verified |
| **25 of 41-kri-engine's SQL/config findings are attributed to the file**, not a function, because handlers are anonymous. Route → table is therefore coarse today. | build log "(25 attributed to the file)" |
| Corpus data models: exactly **one**, `MailSendRequest(BaseModel)` at `51-integration/main.py:83`. `zod` is installed but unused in live code. `routes.request_schema` / `response_schema` columns exist; FastAPI boot (`app.openapi()`) is their only producer. | grep; migration 002 |
| **No ORM** in the corpus (raw `pg`, `psycopg2`). | `package.json`, `requirements.txt` |

### 2.7 Errors and runtime
| Fact | Evidence |
|---|---|
| `errors` exists (P2-T10) with OBSERVED / STATIC FAILURE SURFACE / CORRELATED CHANGES, and has resolved a real trace to its deepest error span (Phase 2 criterion 3). | `src/query/errors.ts`; RECORD Phase 2 |
| **CLI only**; the web UI serves `/api/routes`, `/api/graph`, `/api/security`, and **no error view**. | `src/ui/server.ts` |
| `spans` is empty in the fresh graph. The corpus services are not running (ports 3000–3002/8000 free). Postgres 18 runs on 5432. | port check |
| **None of the 4 corpus repos is a git repository**, so CORRELATED CHANGES can produce nothing there. | `git rev-parse` in each |
| Promotion of a `REQUESTS` edge to `observed` was never demonstrated (Phase 2 criterion 4). | RECORD Phase 2 |

### 2.8 Search ("feature by description")
| Fact | Evidence |
|---|---|
| FTS5 index builds (848 rows, **0 vectors**). Phrases: "send mail" → `POST /api/v1/mail/send` ✔; "purchase order" → nothing (routes say `po`); "user login" → nothing (every token must match). **1 of 3.** | `search build`, `search <phrase>` |

### 2.9 Environment for the Python channel
| Fact | Evidence |
|---|---|
| WSL: default distro **`docker-desktop`** (Docker's internal VM; no Python/apt/git; not suitable). **`Ubuntu-24.04`**: Python 3.12.3, apt, git, corpus at `/mnt/d`; **no pip, no Linux Node.js**; `sudo` needs a password. | `wsl -l -v`; checks per distro |
| **Conflicting record:** the `5f9b525` benchmark reports `scip-python` produced 75 symbols **on Windows** for `orders_app/api`, while today's corpus run wrote an empty index. M8 says it does not work on this platform. The cause of the difference is not yet known. | commit `5f9b525` message vs build log vs `docs/measurements.md` M8 |

---

## 3. Gap analysis

### 3.1 How TypeSafe/Jev was used

| Call | Question | Result |
|---|---|---|
| `jev_verify` | 8 documentation/code claims this plan depends on | 7 verified; 1 contradicted ("errors/search reachable over MCP"), which matches the code |
| `jev_decide` | How to connect to Claude in VS Code (5 candidates, 3 checks) | `user_mcp_plus_steering` **0.97**; plugin 0.02; project `.mcp.json` 0.00 (fails "other repos"); enforcing hook 0.00 (blocks reads on gaps); own extension 0.00 (fails "works in Claude's panel") |
| `jev_verify` | 10 feasibility claims, one per goal part | verified: MCP connection (0.94), endpoint_flow smaller than the file (1.0), OTel tracing on corpus (0.99), migration exists but unparsed (0.96); contradicted: edit without read (1.0), whole workflow today (0.96), fewer tokens on every question (0.82), `syf-*` tracing without instrumentation (1.0), columns stored (0.88) |
| **Overruled** | "UI shows at least one API connection today" | Jev said verified at 0.71 (flagged for review). The build log shows **0 REQUESTS**, so it is **false today**. |

### 3.2 Gap table

| Req | Works today | Gap | Slice |
|---|---|---|---|
| G1/G2 | MCP server runs on stdio | Not registered with Claude Code; no steering | **S1** |
| G5 | Scorer + bench on orders_app | No corpus golden questions; no gate; baseline not met (×1.20, ×1.73) | S2, S16 |
| G3 endpoint flow | `endpoint_flow` over MCP | Python service empty; 0 REQUESTS; frontend calls unresolved; no tables/columns on the path | S3, S4, S12, S9, S10 |
| G3 feature by description | `search` CLI (lexical, AND-only) | Not on MCP; 1/3 phrases match | S8 |
| G3 edit context / G4 | `context_pack` over MCP | Returns start lines only, no read ranges; no staleness signal; the graph must be built by hand | S7, S6 |
| G6 | `errors` CLI, proven once on corpus | Not on MCP; no UI view; no git history on corpus; no spans in current graph | S5, S13, S14, S15 |
| G7 | UI with swim-lanes and REQUESTS edges | 0 REQUESTS; no frontend lane; no tables/columns in the view | S3, S12, S15 |
| G8 | Table names from SQL literals | Migrations unparsed; no columns; SQL attributed to files | S9, S10 |
| G9 | `routes.request_schema` column (unfilled) | No producer running (51 boot fails); no Pydantic/zod extraction | S11 |
| G10 | `scip-python` wired, patched for Windows | Empty index; Linux route not set up | S4 |
| G11 | — | Nothing extracted for Docker/k8s/Terraform/queues | L1–L3 (later) |
| G12 | Corpus configured | `syf-*` path unknown | S17 |

---

## 4. Deviations from your goal, stated plainly

### 4.1 Scope you chose to narrow
These are your decisions, recorded so the plan does not look like it silently dropped them.

| Goal wording | What this plan does | Decided by |
|---|---|---|
| "infrastructure … covered too" | Specified as later slices L1–L3, **not built** | you (round 1) |
| "database/**model** parts" | Tables, columns and API data models; **ORM dropped** | you (round 2) |
| "Claude and **other AI tools**" | Claude Code only; others later, unnamed. MCP is an open protocol, but no other client is configured or tested here. | you |
| Model ↔ table | Linked **through the route** only, with no field-to-column matching | you |

### 4.2 Limits the facts impose
The plan cannot remove these. It keeps them visible instead.

| Goal wording | The limit | Why (fact) | Size of the effect |
|---|---|---|---|
| "instead of reading files" | Reads are **reduced**, not eliminated | Claude Code's edit tool requires a prior read | Claude still reads the edited range; exploratory reads are what shrink |
| "they should ask the graph" | Graph use is **likely, not guaranteed** | Claude picks its tools; the steering is deliberately non-blocking because the graph has gaps | Measured in S1 and S16, not assumed |
| "use fewer tokens" | True **per measured question**, not in general | orders_app today: ×1.20 and ×1.73 (more expensive) where facts were missed | S2 sets the baseline; the gate is per question |
| "whole workflow" | The Python service's **internal call tree may stay missing** | `scip-python` empty index today; M8; conflicting `5f9b525` record | Depends on S4; if S4 fails, answers keep saying "no call tree here" |
| "trace API errors" (on `syf-*`) | Works only where services are **instrumented** | OPEN-7 is outside the engine | Corpus: yes. `syf-*`: needs their owners |
| "correlated recent changes" (corpus) | Proven on **synthetic** history | the corpus has no git; you approved `git init` + a comment-only test commit | Shows the mechanism works, not that it is useful on real history |
| "API data models" (corpus) | Corpus has **1** Pydantic model, 0 zod | grep | zod proven only on in-repo fixtures until `syf-*` |
| "real code like syf-*" | Only a placeholder | path unknown | S17 needs the path |

### 4.3 Things that already work (so the gaps above are not overstated)
Boot-verified route chains (certain) for the two Fastify services · 94 certain call
edges · inline auth checks · incremental indexing · a working MCP server with
confidence and gap sections in every answer · error backtracking proven once on the
corpus · the web UI with confidence and outcome axes · a scorer for token/fact
benchmarks.

---

## 5. How Claude connects (design for S1)

```
VS Code ─ Claude Code panel ─┐                       ┌─ config/repos.json (which folders are indexed)
CLI (claude, claude -p) ─────┤ same user MCP config ──┤
                             ▼                       │
               node D:/CodeGraph/src/cli.ts mcp --db D:/CodeGraph/.codeintel/graph.db
                             ▲
   ~/.claude/settings.json hooks ─ node D:/CodeGraph/src/integrations/claude-hook.ts
     SessionStart  → prints the "query the graph first" instruction if cwd is indexed, else nothing
     PreToolUse(Read|Grep|Glob) → one reminder per session via additionalContext if indexed; never denies
```

- **Registration:** `claude mcp add --scope user code-intel -- node <abs>/src/cli.ts mcp --db <abs>/.codeintel/graph.db`.
  User scope, so it is available when Claude is opened on the corpus or on `syf-*`
  folders. Absolute paths, because the working directory is the target repo, not
  this one.
- **"Indexed" test:** the session's `cwd` is inside a `repos.json` `rootPath`, **or**
  contains one (so opening the parent `dev-workspace` folder counts). Comparison is
  case-insensitive and slash-normalised on Windows.
- **Never blocks:** the hook emits no `permissionDecision`, and any internal error
  exits 0 silently.
- **Token overhead is bounded:** one instruction per session plus at most one
  reminder per session, both measured in S1.
- **Installer:** `node scripts/claude-integration.ts install|uninstall|status` is
  idempotent. It merges into `~/.claude/settings.json` without touching other keys,
  and registers MCP through the `claude` CLI. The same command later onboards
  `syf-*` (S17).

---

## 6. Slices

Template: **Gap** (fact) · **Change** · **Test first** · **Accept** (measured) ·
**Gate** (Jev claims). Every slice also ends with typecheck, the filtered test run,
`bench` rerun (after S2 exists), `jev_gate`, and a local commit `feat(CTX-Sn): …`.

### Lane A: Claude connection and context shape

**CTX-S1: Connect Claude Code (user MCP + steering)** · G1 G2 · depends: — · **built in this task**
- Gap: nothing registers the server or steers Claude (§2.2).
- Change: `src/integrations/claude-hook.ts` (the SessionStart and PreToolUse hook,
  indexed-folder check); `scripts/claude-integration.ts` (install/uninstall/status);
  `npm run claude:install`; unit tests for path matching, settings merge and hook
  output.
- Test first: the hook prints nothing for a non-indexed cwd; prints the instruction
  for an indexed one; the reminder appears once per session; the settings merge
  keeps existing keys and is idempotent.
- Accept:
  - `claude mcp list` shows `code-intel … ✓ Connected`.
  - A headless `claude -p` run from `dev-workspace` calls at least one
    `mcp__code-intel__*` tool.
  - Hook events show the instruction delivered.
  - Record the Read count and token totals of that run.
- Gate: the claims above, with the stream-json log as evidence.

**CTX-S6: One-command build + staleness signal** · G3 G4 · depends: —
- Gap: `index` alone yields an empty graph; answers can be silently stale after edits.
- Change: `build` command (`scip index` + `boot dump` + `index` + `search build` for
  every repo, reporting each channel's failure honestly); every MCP answer carries a
  `freshness` line (built-at, number of indexed files whose hash changed since).
- Test first: a changed file makes `freshness` report 1 stale file; `build` on a repo
  with a failing boot still indexes the static channel and names the failure.
- Accept: one command rebuilds the corpus graph; editing `server.js` shows up as stale
  in the next `endpoint_flow`.

**CTX-S7: Edit context returns read ranges** · G3 G4 · depends: —
- Gap: `context_pack` gives start lines only, so Claude reads whole files before editing.
- Change: `readRanges[] {file, start, end}` for the seed and its direct callees and
  callers; the tool description tells Claude to use Read offset/limit on them.
- Test first: the pack for `checkUserAuth` contains the exact `start-end` range from
  `symbols`.
- Accept: tokens of Read(ranges) vs Read(files) recorded for 3 corpus functions.

**CTX-S8: Feature by description over MCP** · G3 · depends: —
- Gap: search is CLI-only and matches 1/3 plain phrases (§2.8).
- Change: `find_workflow` MCP tool (phrase → candidates → `endpoint_flow` of the chosen
  seed, candidates shown so Claude can correct it). Lexical fallback from AND to OR
  with ranking; route path segments indexed as words; the local embedding option
  (R67, existing code) evaluated. **No Jev at runtime** (G13).
- Test first: a golden phrase set (at least 10 phrases, written before the change,
  with expected routes).
- Accept: the hit rate on the golden set is reported before and after; the tool list
  stays under 2,000 tokens.

### Lane B: Environment and acquisition

**CTX-S3: Restore the Python service's routes** · G3 G7 · depends: —
- Gap: `51-integration` venv has only `pip`; boot fails; 0 REQUESTS (§2.5).
- Change: the venv's `pip install -r requirements.txt` (approved); `boot dump` and
  `index`; a regression test asserting the 2 known REQUESTS on a built corpus graph
  (skipped with a stated reason when the corpus is absent, never silently).
- Accept: `51-integration` routes > 0; REQUESTS = 2, both hand-checked against source.

**CTX-S4: Python call tree through WSL Ubuntu-24.04** · G10 · depends: —
- Gap: the empty `scip-python` index (§2.5), plus the conflicting record (§2.9).
- Step 0 (diagnostic, read-only): find why the corpus run failed ("Python was not
  found") while `5f9b525` got symbols on Windows. **If a Windows-only fix exists, stop
  and ask you** whether to keep the WSL route you chose. It is not switched silently.
- Change: you run one command in Ubuntu-24.04
  (`sudo apt install -y python3-pip python3-venv nodejs npm`). Then, without sudo: a
  Linux venv with the requirements, `scip-python` in a user prefix, a
  `repos.json` field for a WSL indexer, and the runner mapping `/mnt/d/…` ↔ `D:/…`.
- Accept: `51-integration` symbols > 0 and CALLS > 0 in the graph. If Ubuntu's Node
  is too old for `scip-python`, stop and ask before installing another Node.

**CTX-S5: Git history for the corpus** · G6 · depends: —
- Change: `git init` in the 4 corpus repos; `.gitignore` excluding `.env*`,
  `node_modules`, `.venv`, `__pycache__`, `.next`, logs; baseline commit; `git
  status` checked to prove no `.env` is tracked.
- Accept: `git log` works in each repo; `git ls-files | grep -c '\.env'` = 0.

### Lane C: Database and models

**CTX-S9: Migrations → tables and columns** · G8 · depends: —
- Gap: the migration is unparsed; no columns (§2.6).
- Change: a SQL DDL extractor (`CREATE TABLE` / `ALTER TABLE ADD COLUMN`) for files in
  `include`; table nodes use the existing `datastore` key so they join the SQL-literal
  tables. Column storage is decided in the slice with `jev_decide` on measured data,
  from two options: **(a)** a new `column` node kind (needs a nodes-table rebuild
  migration because SQLite cannot alter a `CHECK`), or **(b)** a detail table keyed by
  the datastore node id (R12). The table and its producer ship in the same commit
  (R72).
- Test first: from `001_init.sql`, `users` has columns `id, name, email,
  password_hash, role, created_at, updated_at`.
- Accept: every `CREATE TABLE` in the corpus migration appears with its column count
  matching the file.
- Known limit: table keys carry no database identity (`postgres://?/…`), so two
  services with same-named tables in different databases would look coupled (plan v2
  OPEN-9). Stated in answers, not hidden.

**CTX-S10: SQL → columns, and route-accurate table access** · G7 G8 · depends: S9
- Gap: SQL findings sit on the file (25 in the engine), so route → table is coarse.
- Change: attribute SQL findings inside a boot-located anonymous handler's range
  (`route_chain` line/end_line) to that route; parse column lists from
  INSERT/UPDATE/SELECT literals (`SELECT *` recorded as "all columns",
  `inferred`); `endpoint_flow` and `context_pack` show tables and columns on the path.
- Test first: `POST /api/v1/po` in the engine writes `purchase_orders` with named
  columns, attributed to the route, not the file.
- Accept: file-scope SQL attributions in 41-kri-engine drop from 25 to a measured
  number, with each remaining one explained.

**CTX-S11: API data models, route-level** · G9 · depends: S3 (FastAPI boot)
- Change: FastAPI boot fills `routes.request_schema`/`response_schema` from
  `app.openapi()` (certain); tree-sitter finds Pydantic `BaseModel` and zod
  `z.object` definitions and the handler that uses them (inferred); route → model
  shown in `endpoint_flow`. New in-repo fixtures: `tests/fixtures/models/` with small
  Pydantic and zod cases.
- Test first: `POST /api/v1/mail/send` → `MailSendRequest` with its fields; zod
  fixture route → its schema.
- Accept: the corpus model is linked (certain from boot); fixture models are linked;
  no field-to-column link exists anywhere (asserted).

### Lane D: Connections and errors

**CTX-S12: Frontend → backend** · G7 · depends: —
- Gap: `lib/api.ts` wrapper with a dynamic `path` (§2.5).
- Change: trace the wrapper's `path` parameter back to literal arguments at its call
  sites; resolve the base through the loopback fallback `localhost:3001` → router
  (`inferred`, as the env var may point elsewhere at runtime).
- Test first: a Next.js call `apiFetch("/api/v1/po")` → `REQUESTS` to router `POST
  /api/v1/po`.
- Accept: the frontend's resolved-vs-unresolved counts are reported; 0 false edges on
  a hand-check.

**CTX-S13: Errors over MCP** · G6 · depends: — (corpus proof in S14)
- Change: an `error_trace` MCP tool over `errorPaths`: code origin (service, function,
  file:line, error type/message, path from route to origin), STATIC FAILURE SURFACE,
  CORRELATED CHANGES, and the mandatory UNKNOWN line. The sections are never merged
  (R41).
- Test first: fixture spans → origin at the deepest error span; correlated changes
  from a temp git repo created by the test.
- Accept: output under the 10,000-token warning for the corpus's largest route.

**CTX-S14: OTel end to end on the corpus** · G6 G7 · depends: S3, S5, S13
- Change: start the 4 services under `adapters/otel/preload.mjs`, the OTLP receiver,
  `traffic`, and one deliberate failure path. Run `promote`.
- Accept:
  - `error_trace` names the origin function and line of a real error.
  - Correlated changes lists the comment-only test commit.
  - At least one `REQUESTS` edge is promoted to `observed`, which also closes plan v2
    Phase 2's criterion 4.

**CTX-S15: Web UI: errors, tables, frontend lane** · G6 G7 · depends: S10, S12, S13
- Change: a UI error view (the three sections); datastore/column nodes on flows; a
  frontend swim-lane with its REQUESTS edges.
- Accept: `tests/ui.test.ts` covers the new JSON; a manual check of `POST /api/v1/po`
  shows frontend → router → engine → `purchase_orders`.

### Lane E: Proof

**CTX-S2: Corpus benchmark and gate** · G5 · depends: — · **run first after S1**
- Change: `tests/fixtures/corpus.golden.json` with at least 5 questions: an endpoint
  flow, a feature by description, an edit context, an error origin, and API → tables,
  each with the facts and file ranges that answer it. The `workflow-bench` driver gets
  a corpus mode; a `--gate` flag fails when, for any question, graph + still-to-read ≥
  reading the files **or** a required fact is missing.
- Accept: the baseline is recorded in `docs/measurements.md` **before** the other
  slices; the rerun after every slice shows its delta. The gate is expected to fail
  at first (§2.4). That is the baseline, not a defect.

**CTX-S16: Live A/B, 3 questions × 1 run** · G5 · depends: S1, S2 and the Lane A–D slices
- Change: 3 questions (endpoint flow, error, edit context); each runs once through
  headless `claude -p` with the graph and once without it. The "without" run uses
  `--strict-mcp-config` with no `--mcp-config`, so no MCP servers load, and
  `--setting-sources project,local`, so the user-level steering hooks do not load.
  Both flags were checked in `claude --help` (2.1.119). Record total tokens, Read
  calls, and whether the answer holds the golden facts.
- Accept: a table in `docs/measurements.md`. With n=1 per arm it is a sanity check
  and is labelled as such, not as a statistical result.

### Lane F: Later

**CTX-S17: Onboard the first `syf-*` service (placeholder)** · G12 · depends: S1–S16, a path from you
- Add it to `repos.json`, `build`, and rerun S2's gate with golden questions written
  for that service. Error tracing there needs its instrumentation (OPEN-7).

**Specified, not built (G11):**

| ID | Scope | Fixture that exercises it | First producer to write |
|---|---|---|---|
| CTX-L1 | Containers and deploy: Dockerfile, docker-compose, k8s. Which service runs where, ports, env wiring. | `tests/fixtures/orders_app` (`docker-compose.yml`, `k8s/api-deployment.yaml`, `api/Dockerfile`) | YAML/Dockerfile reader → service nodes' ports and env keys, never values (R23) |
| CTX-L2 | Cloud IaC: Terraform resources services depend on | `orders_app/infra/main.tf` | HCL resource reader → `external`/`datastore` nodes |
| CTX-L3 | Messaging: producer → topic → consumer | `orders_app/api/app/events.py`, `worker/consumers.py` (Kafka) | tree-sitter producer/consumer calls → topic edges |

Each will follow R72: no node kind or table until its extractor lands in the same slice.

---

## 7. Order and parallel lanes

```
Wave 0   S1 ─────────────────────────────────────────────── (this task)
Wave 1   S2   S3   S5   S6   S7   S9   S12        ← file-disjoint, parallel agents
Wave 2   S4*  S8   S10  S11  S13                  (* needs your one sudo command)
Wave 3   S14  S15
Wave 4   S16  → S17 when a syf-* path is given     L1–L3 whenever scheduled
```

- **Shared files:** `src/mcp/server.ts` (S7, S8, S13 add or extend tools) and
  `src/cli.ts` (S6). These slices commit separately and rebase in wave order. Each one
  re-measures the tool-list token cost.
- **Per-agent isolation:** one git worktree per slice, and each agent runs its own
  typecheck, tests and Jev gate. Integration is by cherry-pick onto
  `feat/workflow-context-slices`, in the wave order above.
- **Critical path to "Claude gets the whole workflow cheaply":**
  S1 → S2 → S3 → S10 → S12 → S16.

---

## 8. Verification and gates

| Level | Gate |
|---|---|
| Every slice | failing test written first · `npm run typecheck` clean · `npm test` filtered, 0 fail · `jev_gate` on the diff with test output and measurements as evidence · one local commit `feat(CTX-Sn): …` |
| Every slice after S2 | benchmark rerun, with the delta appended to `docs/measurements.md` |
| Goal G5 | S2 `--gate` passes on every corpus question: graph + still-to-read < reading the files **and** all facts present |
| Goal G1/G2 | S1 headless run shows `mcp__code-intel__*` calls; S16 compares with and without the graph |
| Repo rules | no table without its producer (R72); SCIP symbol identity (R4); no LLM-written facts (R63); confidence stays an enum; gaps are stored and shown |

Jev gate escalations are fixed, not overridden. Where Jev and a measurement
disagree, the measurement wins and the disagreement is written down (as in §3.1).

---

## 9. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Claude skips the graph despite the steering | Token goal not reached in practice | S1/S16 measure it; the instruction and tool descriptions are the lever |
| Tool list grows with each new tool | Fixed cost per session (≈1,165 tokens today) | Budget of 2,000 tokens checked each time a tool is added |
| Stale graph after edits | Confident wrong answers | S6 freshness line; incremental `index` |
| The WSL route fails (old Node, `scip-python` behaviour) | Python stays call-tree-less | S4 stops and asks; answers keep reporting the gap |
| Corpus unrepresentative (ARCHITECTURE_MAP) | Green on the corpus ≠ works on `syf-*` | S17 reruns the gate on a real service |
| Synthetic git history | Correlated changes look better than on real history | Labelled as mechanism-only in §4.2 |

---

## 10. Decision log (2026-09-27)

| Decision | Choice |
|---|---|
| Deliver now | Plan + slice 1 |
| Claude connection | User-scope MCP + steering (Jev 0.97) |
| Steering location | User-level, active only in indexed folders |
| Targets | Corpus first, then `syf-*` (placeholder) |
| Infrastructure | Later slices, specified not built |
| DB scope | Tables and columns; ORM dropped |
| API data models | In scope now, route-level; tested on corpus + in-repo Pydantic/zod cases |
| Error source | OTel traces; code origin + correlated changes required; askable over MCP and in UI |
| Visualisation | Existing web UI |
| Connections | Service → service, frontend → backend, API → tables |
| Token proof | Deterministic gate (fewer tokens + all facts) and live A/B 3×1 |
| Python call tree | WSL Ubuntu-24.04; you run one sudo command |
| Jev | Dev-time only |
| Git history for corpus | `git init` the corpus |
| Stale docs | CLAUDE.md status corrected; QUICK_START and ARCHITECTURE_MAP left as they are |
| Base | `feat/workflow-context-slices` @ `5f9b525`; local commits, no push |
