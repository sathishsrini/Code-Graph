# CTX: plan for the remaining work (draft, awaiting approval)

**Goal:** [`../goal.md`](../goal.md) · **Plan of record:** [`claude-context-plan.md`](claude-context-plan.md) · **Status:** [`claude-context-tracker.md`](claude-context-tracker.md)
**Date:** 2026-09-27 · **State:** DRAFT. No slice defined here is implemented before you approve it.

This document does **not** re-plan what is already planned or started. Slices S1–S17,
S10a/S10b, L1–L3 and the fixes F1/F2 keep their definitions in the plan of record.
This adds only:

- new slices for gaps that no existing slice covers (§3);
- deltas to existing slices where the gap analysis found a missing dependency or
  missing evidence (§4);
- the requirement trace and outcome checks (§6–§8);
- the questions that block approval (§9).

The five outcomes map onto the goal's requirements as follows:

| Outcome | Requirements |
|---|---|
| 1. Whole-workflow context + fewer tokens | G1, G2, G3, G4, G5, G10 |
| 2. API error → root cause | G6 |
| 3. API connections in the existing UI | G7 |
| 4. Database + API model context | G8, G9 |
| 5. Real `syf-*` code | G12 |
| Infrastructure (later only) | G11 |
| Jev is dev-time only | G13 (applies to every slice) |

---

## 1. Work already planned or started (kept as is)

| Slice | State on 2026-09-27 |
|---|---|
| S1 | Code in, installed on your machine, headless acceptance passed. Open: VS Code panel check and your sign-off |
| S16 | Kit in `docs/ab-token-check.md`. First answers recorded as M11; the token numbers are not transferred yet |
| F1, F2 | Done in an agent worktree (`5d7ff5f`, `a8329c6`), awaiting integration. F2 raises a question (§9, Q4) |
| S7, S13 | Done in agent worktrees (`5f29795`, `60a0972`), awaiting integration. Their reports found gaps L, M and N below |
| S2 (gate code), S6, S9, S10a, S12 | Running as parallel agents in worktrees; they will be integrated by cherry-pick |
| S3, S4, S5, S8, S10b, S11, S14, S15, S17, L1–L3 | Planned, not started |

---

## 2. Gaps no existing slice covers (evidence first)

| # | Gap | Evidence | Outcome hit | Covered by |
|---|---|---|---|---|
| A | **The main hop of `POST /api/v1/po` (router → engine) is unresolved.** `proxyToEngine` serves 9 routes and picks its base with an env-conditional ternary. S12 covers the frontend wrapper and S3 the router → integration call; nothing covers this hop | M9: the remaining router gaps are "a dynamic path (L127), an env-conditional ternary with two candidates (L176 ×2)". Answer key Q1 fact 4 (`server.js:176–186`) | 1, 3 | **S18** (new) |
| B | **One candidate of that fork, procurement-module, is not in the corpus.** If `PROCUREMENT_BASE_URL` is set, the live path goes to a service the graph does not index | `config/repos.json` has 4 repos; M11 #2 and #4 | 1, 2, 3 | §9 Q1 |
| C | **An observed error origin does not name a function and line.** The origin is the deepest error span: service, route, status and exception type/message. `code.function.name`/`code.file.path` need manual spans, and `exception.stacktrace` is not kept. S14's acceptance ("names the origin function and line") therefore depends on a capability that does not exist | M10 "Still unmeasured"; `src/runtime/otlp.ts` extracts only `exception.type`/`exception.message`; `src/query/errors.ts` `traceRootCause` | 2 | **S19** (new) |
| D | **The Python service cannot be traced.** `adapters/otel/preload.mjs` is a Node `--import` preload. There is no Python instrumentation path, and the approved actions allow only `pip install -r requirements.txt` in that venv | `adapters/otel/`; goal.md "Approved actions" | 2 (and 5 if the `syf-*` service is FastAPI) | §9 Q2 → **S22** (conditional) |
| E | **Tables are not exposed to Claude in reverse.** After S9/S10a/S10b, a route's tables are on its path, but "what reads or writes `purchase_orders.status`?" has no MCP answer. S9's `tables` command is CLI-only | plan §6 S9 and S10b | 4 | **S20** (new) |
| F | **Nothing handles a gate question that still fails** after lanes A–D. The plan assumes filling the gaps makes every question cheaper, but that is not proven | §2.4 baseline ×1.20 / ×1.73 | 1 | **S21** (new) |
| G | **Indexing touches target repos.** The SCIP runner writes `tsconfig.codeintel.json` into the repo root and deletes it afterwards (`src/static/scip/runner.ts:141–179`). The FastAPI boot imports the app, which can write `__pycache__`. Boot runs service code, so it may open DB connections. On `syf-*` any leftover file is a modification | runner.ts; `adapters/fastapi/boot_dump.py` | 5 | Delta to **S6** (sent to the running agent) and **S17** |
| H | **The UI slice lacks the router → engine data.** S15 depends on S10b, S12 and S13, but frontend → router → **engine** → table needs S18 too | Gap A | 3 | Delta to **S15** |
| I | **The WSL venv location is unspecified.** S4 says "a Linux venv with the requirements"; inside the target repo it would modify it | plan §6 S4 | 1 | Delta to **S4** |
| J | **Jev gates cannot run where the code is built.** There is no `jev-key` in this container and `jev_gate` is not a repo command | S1 build notes | all | §9 Q3 |
| L | **Read ranges can be one line long.** When SCIP gives a definition no `enclosingRange`, `pipeline.ts` stores start = end, the name line. M2 found that `enclosingRange` marks only the definitions that contain calls, so leaf functions are affected. A range for such a function makes Claude read one line of a function it is about to edit | S7 report; M1/M2 | 1 (G4) | **S7b** (new) |
| M | **Correlated changes miss the origin's own file.** CORRELATED CHANGES looks only at the static surface's files, so a commit to the failing function's file is not listed when that function has no control-flow analysis | S13 report | 2 | Folded into **S19** |
| N | **`error_trace` has no size cap.** A synthetic route crossed Claude Code's 10,000-token MCP warning at about 280 error exits. The corpus router has 7; `syf-*` size is unknown | S13 report | 2, 5 | Delta to **S17** |
| K | **`syf-*` facts are unknown**: path, stack, whether it boots safely, where its traces are, its databases, its model style | tracker "Things that need you" | 5 | §9 Q5 |

---

## 3. New slices

Template per slice: **Outcome** · **Problem** · **Depends on** · **Changes** · **Tests
(written first)** · **Evidence** · **Jev gate** · **Commit boundary** · **Parallel**.
Every slice ends with `npm run typecheck`, the filtered full suite with 0 failures, and a
tracker update.

### CTX-S7b: Exact end lines for symbols SCIP gives no enclosing range

- **Outcome:** 1 (G4 "Claude reads only the exact lines it edits").
- **Problem:** Gap L.
- **Depends on:** S7 (read ranges).
- **Changes:** when SCIP has no `enclosingRange` for a definition, take the end line from
  the tree-sitter function or class node at the same start. The tree-sitter pass already
  enumerates those (`findings.functions`). Record where the range came from (`scip` or
  `treesitter`), so a parser-derived end is marked as such. When neither source has a
  range, keep S7's read-range gap. This adds a column only if its producer ships in the
  same commit (R72).
- **Tests:** a leaf function with no `enclosingRange` gets a multi-line range that ends at
  the function's closing line, marked `treesitter`. A function with an `enclosingRange`
  keeps the SCIP range.
- **Evidence:** on the corpus, the share of symbols with start = end drops, and every
  remaining one is a one-line definition or a listed gap. A hand-check of 10 leaf functions
  against the source.
- **Jev gate:** diff, tests, the before/after counts.
- **Commit boundary:** one commit, `feat(CTX-S7b)`.
- **Parallel:** yes. It touches `src/index/pipeline.ts` symbol storage, so it follows S9
  and S10a, which also edit the pipeline.

### CTX-S18: Env-fork and pass-through proxy edges

- **Outcome:** 1 (G3 endpoint flow) and 3 (G7 service → service).
- **Problem:** Gap A. `endpoint_flow POST /api/v1/po` stops at the router, so answer-key
  Q1 facts 6–9 (engine `serviceAuth`, `validatePO`, `purchase_orders` read and insert) are
  unreachable from the graph, and the UI cannot draw router → engine.
- **Depends on:** S12, because both change `src/derive/cross-service.ts` and run in
  sequence on it. Q1 decides what the procurement branch resolves to.
- **Changes:**
  0. *Read-only diagnostic, on the corpus graph:* list the router's `unresolved_calls`
     rows (line, target hint, reason) and quote the expressions at `server.js:127` and
     `:176`. The fixture in step 1 copies that exact shape rather than an assumed one.
  1. Resolve each branch of an env-conditional base separately. A branch whose base
     resolves to an indexed service is a candidate. A branch that names no indexed
     service stays an unresolved row naming its env var.
  2. When the forwarded path is the inbound request's own URL (a pass-through proxy),
     the target is the same method + path on the candidate service. Emit one edge per
     inbound route served by the proxy: inbound route → target route, `inferred`, with the
     detail "pass-through via `<fn>` at file:line; chosen when `<ENV>` is unset/set". No
     env value is read (R23).
  3. `endpoint_flow` follows only the edge for the route being asked about, so it does
     not fan out to all 9 targets.
- **Tests:** a fixture proxy serving 3 routes with the step-0 shape → 3 inferred edges,
  each with its own inbound route. The non-indexed branch stays unresolved and names
  its variable. `endpoint_flow` for one route shows only its own target. A forwarded path
  that is not the inbound URL stays unresolved.
- **Evidence:** on the corpus (your machine), router → engine edges equal the number of
  proxied routes that exist on the engine, hand-checked against the engine's route list.
  The router's unresolved count drops by exactly the resolved rows.
  `endpoint_flow POST /api/v1/po` reaches `serviceAuth` and `validatePO`, and, with S10a,
  `purchase_orders`.
- **Jev gate:** `jev_gate` on the diff, with the test output, the before/after unresolved
  rows and the hand-check as evidence.
- **Commit boundary:** one commit, `feat(CTX-S18)`.
- **Parallel:** yes, after S12 lands; it is file-disjoint from S19 and S20.

### CTX-S19: An observed error origin names the function and file:line

- **Outcome:** 2 (G6 code origin).
- **Problem:** Gap C.
- **Depends on:** S13 (`error_trace`). S14 then proves it on real traces.
- **Changes:**
  1. Keep `exception.stacktrace` from span events. That needs a spans column, and its
     producer in `otlp.ts` ships in the same commit (R72).
  2. Map the top in-repo stack frames (file:line) to the innermost symbol by SCIP range.
     That gives the origin function, `observed`.
  3. For an error response with no exception (a returned 4xx/5xx), link the observed
     service + route + status to the static failure-surface sites reachable from that
     route that return the same status. Exactly one gives an origin *candidate*,
     `inferred`, printed on its own "observed → static link" line. Several are all
     listed; none is UNKNOWN. The OBSERVED and STATIC sections are never merged (R41).
  4. CORRELATED CHANGES also covers the file of the observed origin (gap M), not only the
     static surface's files. It stays a ranking signal, never a cause.
- **Tests:** a commit to the origin's file appears in CORRELATED CHANGES even when that
  function has no control-flow analysis. Also: a Node stack trace in a fixture span → origin symbol and line. A 422 span on
  a route with one 422 site → one linked candidate. Two 422 sites → both listed. Neither
  an exception nor a matching site → UNKNOWN. The sections stay separate.
- **Evidence:** S14's real error shows the function and file:line, hand-checked against the
  source.
- **Jev gate:** diff, tests, and a sample `error_trace` output.
- **Commit boundary:** one commit, `feat(CTX-S19)`.
- **Parallel:** yes with S18 and S20. It must follow S13 because both touch
  `src/query/errors*.ts`.

### CTX-S20: Table and column impact over MCP

- **Outcome:** 4 (G8 "SQL reads and writes linked to them"; visible to Claude).
- **Problem:** Gap E.
- **Depends on:** S9, S10a, S10b.
- **Changes:** `impact` also accepts a table (`purchase_orders`) or column
  (`purchase_orders.status`) seed and returns reads and writes grouped by route and
  function, with file:line and confidence. A `SELECT *` shows as "all columns",
  `inferred`. The OPEN-9 limit line is always printed. This adds no new tool: it widens
  `impact`'s input description and keeps the tool list under 2,000 tokens.
- **Tests:** two routes, one writing and one reading a table. A column-level match vs an
  "all columns" match. A table name shared by two services lists both, with the OPEN-9
  line.
- **Evidence:** on the corpus, `impact purchase_orders` lists the engine's `POST
  /api/v1/po` (read and insert) and its readers, hand-checked against the source.
- **Jev gate:** diff, tests, the hand-check.
- **Commit boundary:** one commit, `feat(CTX-S20)`.
- **Parallel:** yes with S18 and S19 (it only touches `src/query/impact*.ts`).

### CTX-S21: Gate closure, one sub-slice per failing corpus question

- **Outcome:** 1 (G5).
- **Problem:** Gap F.
- **Depends on:** S2 (the gate and its baseline) and every slice that adds graph facts:
  S3, S4, S7b, S10b, S12, S14, S18, S19, S20.
- **Changes:** rerun `bench --corpus --gate`. Each failing question becomes
  `S21.<question id>`. Its root cause comes from the scorer's output:
  - a missing fact → the extractor, query or tool plan that lacks it;
  - a token overrun → the oversized section.
  Fix that cause and rerun. If a question cannot pass by design (for example it needs a
  whole file read), stop and bring it to you. It is never re-scored to pass.
- **Tests:** the gate itself, red → green per question, plus the unit test that pins the
  root cause.
- **Evidence:** the `--gate` output with every question passing, recorded in
  `docs/measurements.md` together with the per-slice delta table.
- **Jev gate:** per sub-slice.
- **Commit boundary:** one commit per sub-slice, `feat(CTX-S21.<q>)`.
- **Parallel:** sub-slices are parallel when they touch disjoint files.

### Conditional slices (defined only after your answer)

- **CTX-S22: Python OTel for FastAPI** (if Q2 = yes). Instrument `51-integration` without
  editing its source, via `opentelemetry-instrument` from a venv. Evidence: an error that
  starts in the Python service is traced to its origin.
- **CTX-S23: Onboard procurement-module** (if Q1 says it exists and should be indexed).
  Add it to `repos.json` and build it; S18's second candidate then resolves to routes.

---

## 4. Deltas to existing slices

| Slice | Delta | Why |
|---|---|---|
| S4 | The Linux venv and `scip-python` live under this repo's `.codeintel/wsl/`, never in the target repo | Gap I, G2 "target repos are not modified" |
| S6 | `build` proves each target repo is byte-identical before and after (a file listing and hash, plus `git status --porcelain` where git exists). It sets `PYTHONDONTWRITEBYTECODE=1`, and the generated tsconfig is always removed | Gap G. Already sent to the running agent |
| S8 | `find_workflow` gets a line in the SessionStart instruction. The tool list stays under 2,000 tokens | Features must be visible to Claude |
| S10b | Evidence: every SQL → column link on the corpus is hand-checked, and the false-positive count is written down (R70 style) | "Database relationships inferred incorrectly" |
| S11 | A test asserts that no field-to-column edge exists anywhere. Fastify route `schema` capture from boot is added only if Q5 says `syf-*` uses it | G9; Gap K |
| S13 | `error_trace` gets a line in the SessionStart instruction (sent to the running agent) | Visible to Claude |
| S14 | Depends on **S18** (so a router → engine edge can be promoted to `observed`) and **S19** (origin function and line). Evidence includes the live branch of the `PROCUREMENT_BASE_URL` fork | Gaps A, C |
| S15 | Depends on **S18** and **S3**. Evidence: `tests/ui.test.ts` asserts that the `/api/graph` JSON holds the full path frontend → router → engine → `purchase_orders`, plus a screenshot on the corpus graph | Gap H |
| S16 | Rerun after S21, with F2's `.env` deny in both arms | Token claim measured on the finished graph |
| S17 (size) | Measure `error_trace`, `endpoint_flow` and `context_pack` sizes on the largest `syf-*` route. Above 10,000 tokens, add a cap with an exact count, as `impact` already does | Gap N |
| S17 | Split, once Q5 is answered, into: **a** build with the no-modification proof; **b** golden questions written from `syf-*` source plus the S2 gate; **c** headless `claude -p` from the `syf-*` folder showing graph calls and token totals; **d** `error_trace` on a real `syf-*` error (as Q5 allows); **e** the UI path | Outcome 5 needs each capability proved there, not only on the corpus |

---

## 5. Order of the remaining work

```
Now      (running) S2-code  S6  S9  S10a  S12   ← integrate by cherry-pick; F1, F2, S7, S13 done
You      S1 panel check + sign-off · S2 baseline run · S3 (pip install, boot) · S5 (git init) · S4 sudo
Wave 2   S7b(S7,S9,S10a)   S8   S10b(S9,S10a)   S11(fixture part; corpus part after S3)   S18(S12)   S19(S13)
Wave 3   S20(S10b)   S14(S3,S5,S13,S18,S19; your machine)   S15(S10b,S12,S13,S18,S3)   [S22, S23 if approved]
Wave 4   S21.*  (gate closure)  →  S16 (final live A/B)
Wave 5   S17a–e  (after Q5)
Later    L1 · L2 · L3  (specified in the plan of record, not built)
```

Critical path to Outcome 1: S2 → S3 → S12 → S18 → S10a/S10b → S21 → S16.

---

## 6. Requirement → slice → test → evidence

| Req | Slice(s) | Test | Evidence that proves it |
|---|---|---|---|
| G1 Claude Code (CLI + panel) uses the graph over MCP | S1 | `tests/claude-integration.test.ts`, `tests/mcp-stdio.test.ts` | Headless run: 1 `endpoint_flow`, 0 reads (done). **Open:** the panel check |
| G2 user scope, steering only in listed folders, target repos untouched | S1, S6-delta, S17a | hook tests (non-indexed cwd prints nothing); the S6 no-modification test | `claude mcp list` Connected (done); the before/after proof on the corpus and on `syf-*` |
| G3 endpoint flow | S3, S4, S10a, S12, S18, S10b | fixture tests per slice | corpus `endpoint_flow POST /api/v1/po` holds Q1 facts 1–13; S2 gate question "endpoint flow" passes |
| G3 feature by description | S8 | golden phrase set (≥10) | hit rate before/after; gate question "feature by description" passes |
| G3 edit context | S7, S7b, S10a | read-range, end-line and caller tests | gate question "edit context" passes (Q3 facts 1–7, including the `:292` caller) |
| G4 cut exploratory reads | S7, S7b, S1 steering | read ranges present and multi-line where the code is | S16: Read calls with vs without; S2: "still to read" limited to the ranges |
| G5 token proof | S2, S21, S16 | pure gate function; gate per question | `--gate` all-pass in measurements; S16 table (n = 1, labelled as a sanity check) |
| G6 error origin + correlated changes, over MCP and in the UI | S5, S13, S19, S14, S15 (+S22 if Q2) | fixture spans, stack trace, temp git repo | a real corpus error: `error_trace` gives the function, file:line and the comment-only commit; the same in the UI view |
| G7 UI: service → service, frontend → backend, API → tables | S3, S12, S18, S10a/b, S15 | `tests/ui.test.ts` JSON path assertion | corpus screenshot of frontend → router → engine → `purchase_orders` |
| G8 tables, columns, SQL reads/writes | S9, S10a, S10b, S20 | DDL fixture; SQL → column fixture; impact on a table | every corpus `CREATE TABLE` with its column count; hand-checked SQL links with an FP count; `impact purchase_orders` |
| G9 API models, route-level, no field → column | S3, S11 | Pydantic and zod fixtures; the "no field → column" assertion | `POST /api/v1/mail/send` → `MailSendRequest` (certain, from boot) |
| G10 Python call tree via WSL | S4 | runner mapping test | `51-integration` symbols > 0 and CALLS > 0 |
| G11 infrastructure later | L1–L3 | none (not built) | specified in the plan of record, §6 Lane F |
| G12 corpus first, then `syf-*` | all · S17a–e | per S17 sub-slice | the S2 gate on `syf-*` questions; a headless run; an error trace; the UI path |
| G13 Jev dev-time only | every slice | grep: no `jev`/`typesafe` import under `src/` query or MCP paths | the gate record per slice (Q3 decides where it runs) |

---

## 7. Outcome checks (if every slice above passes)

1. **Whole workflow and fewer tokens:** yes, on the corpus, *if* S21 closes every
   question and S1's panel check passes. Tokens are proved per question by the gate, and
   a live run confirms it (S16). The remaining risks: Claude may skip the graph (measured,
   not forced), and the Python call tree depends on S4.
2. **Error → root cause:** yes for errors that start in the Node services (router,
   engine), once S19 exists. **No** for errors that start in the Python service unless Q2
   is answered yes (S22). Correlated changes rest on synthetic corpus history (S5), which
   is already accepted in plan §4.2.
3. **UI path:** yes once S18 is in. Without S18 the path breaks at router → engine.
4. **Tables, columns, SQL, models:** yes on the corpus for tables, columns and SQL. Models
   on the corpus are one Pydantic model; zod is proved on fixtures only (accepted in plan
   §4.2). Correctness rests on the S10b hand-check. OPEN-9 is safe only if the corpus
   services share one database (goal.md says "the corpus database", singular).
5. **`syf-*`:** not plannable in detail yet. Q5 is needed.

## 8. Second pass: what could still make the goal false

| Check | Finding | Resolution |
|---|---|---|
| Missing dependencies | S14 lacked S18/S19; S15 lacked S18/S3 | §4 deltas |
| Hidden assumptions | That the proxy shape is `${base}${req.url}` | S18 step 0 reads the real shape first |
| Unverified claims | S14 "origin function and line" (confirmed missing by S13's report); read ranges assumed exact (one line for leaf functions) | S19; S7b |
| Features not exposed to Claude | `tables` (CLI-only); `error_trace` and `find_workflow` missing from the instruction | S20; S8/S13 deltas |
| Works only on the fixture corpus | S12 wrapper shape, S18 proxy shape, zod | S17b gate on `syf-*`; failures become S21-style sub-slices there |
| Token claims without evidence | none left: every claim goes through the S2 gate or S16 | — |
| UI without data | S15 before S18 | dependency added |
| Error tracing without real traces | Python service; `syf-*` | Q2, Q5 |
| DB relationships inferred wrongly | OPEN-9 across services; `SELECT *`; aliases | S10b hand-check; S20 prints OPEN-9; Q5 asks how `syf-*` databases are laid out |
| Target repos modified | tsconfig, `__pycache__`, boot side effects, WSL venv | S6 and S4 deltas; S17a proof; Q5 on safe boot |
| Tool-list budget (≤ 2,000 tokens) | 1,165 before; S7 → 1,187; S13 → 1,428. S8 and S20 still add text | Each slice re-measures; S8/S20 must fit in the remaining ≈570 |
| Unknown owner inputs | live env branch, A/B numbers | already listed as yours in the tracker |

---

## 9. Questions that block approval

1. **procurement-module.** Is `PROCUREMENT_BASE_URL` set in `40-kri-router/.env` (line 3)?
   If it is, where does the procurement-module repo live, and should it become a fifth
   corpus service (S23)? If it is unset, the engine is the live branch and the corpus
   covers it.
2. **Python tracing.** May `51-integration` be traced with OpenTelemetry for Python?
   That means installing the OTel Python packages into a venv outside the repo and
   starting it under `opentelemetry-instrument` (S22). The alternative is to prove G6 on
   the Node services only, with Python-origin errors reported as "not instrumented".
3. **Jev gates.** This build container has neither `jev-key` nor your `jev_gate` tool.
   Will you run the gate on your machine after each pushed slice? And when a gate
   escalates on confidence without a finding (as with S1), is your sign-off the
   resolution?
4. **`.env.example`.** F2's `Read(//**/.env.*)` rule also blocks `.env.example`, which
   conflicts with CLAUDE.md ("edit `.env.example`"). Keep the strict rule and reword
   CLAUDE.md, or narrow the rule so `.env.example` stays readable?
5. **`syf-*` (S17).** The path; which service first; its framework; whether it can boot
   locally without reaching real databases or external services; where its traces are
   (an existing collector we can read, or a local run under the preload); whether its
   services share databases; its request/response model style (Pydantic, zod, Fastify
   JSON Schema/TypeBox); and whether the `syf-*` services it calls should be onboarded
   with it.
