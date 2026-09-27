# A/B token check: plain Claude vs Claude with code-intel

Plan slice **CTX-S16** (goal G5): the same 3 questions, 1 run each way, comparing
**tokens** and **answer accuracy**. Tracker:
[`plans/claude-context-tracker.md`](../plans/claude-context-tracker.md).

- **Arm A, "without":** Claude Code with no MCP servers and no hooks. It can only
  read files.
- **Arm B, "with":** the same, plus the `code-intel` MCP server and the steering
  hooks.

Nothing else differs between the arms. Both use `--model sonnet` and
`--setting-sources project,local`, so your user settings (effort level, plugins,
other MCP servers) are left out of both. Arm B adds exactly two things:
[`ab/with-graph.mcp.json`](ab/with-graph.mcp.json) and
[`ab/with-graph.settings.json`](ab/with-graph.settings.json).

Isolation was checked on 2026-09-27 with a one-word prompt. Arm B showed
`code-intel` connected, its 4 tools and the SessionStart hook; arm A showed none of
them. Both ran `claude-sonnet-4-6`.

> **The answer keys below come from the source files, not from the graph.** A key
> built from the graph would reward the graph for agreeing with itself.

---

## 1. Run it

Git Bash, about 5–10 minutes. Expect roughly $0.50–$2 in total; each run is capped at $2.

```bash
cd "/d/###facilitator/dev-workspace"
OUT=/d/CodeGraph/.codeintel/ab        # gitignored
mkdir -p "$OUT"

COMMON=(--model sonnet --setting-sources project,local --strict-mcp-config
        --output-format stream-json --verbose --include-hook-events
        --max-budget-usd 2 --no-session-persistence)
WITH=(--settings D:/CodeGraph/docs/ab/with-graph.settings.json
      --mcp-config D:/CodeGraph/docs/ab/with-graph.mcp.json
      --allowedTools "mcp__code-intel__endpoint_flow,mcp__code-intel__impact,mcp__code-intel__context_pack,mcp__code-intel__security_path")

Q1="What happens end to end when a client calls POST /api/v1/po on 40-kri-router? List, in order: the hooks and auth checks that run, the functions called, every other service it calls, and every database table read or written. Cite file:line for each item."
Q2="A client calling POST /api/v1/po on 40-kri-router got an error response. List every HTTP status this request can return, with its error code and the service, function and file:line that produces it. Say which come from the router itself and which are passed through from downstream."
Q3="I want to change checkUserAuth in 40-kri-router so it also rejects requests without an X-Correlation-ID header. Before I edit anything: where is it defined, what calls it, which routes would be affected, and which paths are exempt? Cite file:line. Do not make the change."

# 1) Warm-up: fills each arm's prompt cache, so both start the questions equal.
claude -p "Reply with the single word OK." "${COMMON[@]}" "${WITH[@]}" > "$OUT/warm-with.jsonl"
claude -p "Reply with the single word OK." "${COMMON[@]}"              > "$OUT/warm-without.jsonl"

# 2) The three questions, each in a fresh session per arm.
claude -p "$Q1" "${COMMON[@]}" "${WITH[@]}" > "$OUT/q1-with.jsonl"
claude -p "$Q1" "${COMMON[@]}"              > "$OUT/q1-without.jsonl"
claude -p "$Q2" "${COMMON[@]}" "${WITH[@]}" > "$OUT/q2-with.jsonl"
claude -p "$Q2" "${COMMON[@]}"              > "$OUT/q2-without.jsonl"
claude -p "$Q3" "${COMMON[@]}" "${WITH[@]}" > "$OUT/q3-with.jsonl"
claude -p "$Q3" "${COMMON[@]}"              > "$OUT/q3-without.jsonl"

# 3) Numbers, plus each final answer saved as <run>.jsonl.answer.md for scoring.
node /d/CodeGraph/docs/ab/summarize.mjs "$OUT"/q*-*.jsonl
```

**What the summary columns mean**

| Column | Meaning |
|---|---|
| `totalTokens` | input + cache-write + cache-read + output for the whole session. **The token number to compare.** |
| `usd` | Billed cost. Cache reads are cheap and cache writes expensive, so cost and tokens can disagree. Report both. |
| `graphCalls` | `mcp__code-intel__*` calls. Must be 0 in arm A. |
| `fileReads` | Read + Grep + Glob calls. What the graph is meant to reduce. |
| `denied` | Tool calls refused in headless mode (e.g. Bash). Note them; they affect both arms alike. |

**Sanity checks before trusting a run:** each `q*-with` log must contain a
`hook_response` line; each `q*-without` log must contain no `mcp__code-intel__`
text at all. If either fails, the arms leaked into each other.

**Fixed overhead of arm B (measured on the warm-up prompt):** +244 tokens per session
(19,325 vs 19,081). On a cold cache the cost roughly doubles for a one-word answer
($0.0265 vs $0.0127), because of about 4,000 extra cache-write tokens. That is why the
warm-up runs first.

---

## 2. Answer keys, with scoring

**How to score:** 1 point per fact the answer states correctly. A `file:line` may be
off by ±5 lines. **Accuracy = points ÷ facts** (bonus items are not in the
denominator). Separately, list every **wrong claim**, meaning a statement the source
contradicts. A correct-but-incomplete answer and a confidently wrong answer are
different failures, so keep the two counts apart.

File names are relative to `D:/###facilitator/dev-workspace/`.

### Q1: end-to-end flow of `POST /api/v1/po` (13 facts)

| # | Fact | Source |
|---|---|---|
| 1 | Router `onRequest` hook sets the correlation id (generating one if missing) and CORS headers | `40-kri-router/server.js:36–45` |
| 2 | The route's handler is `proxyToEngine` | `40-kri-router/server.js:281`, defined `:168` |
| 3 | `checkUserAuth` runs first. It requires a non-empty Bearer token, else **401 `KRI40-AUTH-001`**. Any non-empty token is accepted | `40-kri-router/server.js:76–86`, called `:169` |
| 4 | Forwards via `forward()` (axios) to **41-kri-engine `POST /api/v1/po`** (`ENGINE_BASE_URL`, default `localhost:3002`), sending the service token and `X-Integration-Key` | `40-kri-router/server.js:176–186`, `:55–69`, `:7` |
| 5 | If `PROCUREMENT_BASE_URL` is set, it forwards to the procurement module instead of the engine | `40-kri-router/server.js:172–176` |
| 6 | Engine `serviceAuth` checks the service token and the integration key, else **401 `KRI41-AUTH-001`** | `41-kri-engine/server.js:77–89`, called `:196` |
| 7 | Engine `validatePO`: `po_number`, `vendor_name`, `currency`, `po_date` are required and negative amounts are rejected, else **422 `KRI41-PO-VALIDATE-001`** | `41-kri-engine/server.js:183–193`, `:198–203` |
| 8 | Engine **reads `purchase_orders`** to reject a duplicate `po_number` → **409** | `41-kri-engine/server.js:≈209–214` |
| 9 | Engine **inserts into `purchase_orders`** → **201** | `41-kri-engine/server.js:≈215–222` |
| 10 | On a 2xx `success`, the router calls **51-integration `POST /api/v1/mail/send`** with event `PO_CREATED` | `40-kri-router/server.js:≈190–234` (URL at `:216`) |
| 11 | Integration **inserts into `mail_events`** | `51-integration/main.py:143` (route `:111`) |
| 12 | A failed mail send does **not** fail the PO request; the response gets `email.status = FAILED` | `40-kri-router/server.js:≈228–240` |
| 13 | Router `onResponse` hook logs the completed request | `40-kri-router/server.js:46–49` |

### Q2: every error `POST /api/v1/po` can return (9 facts)

| # | Status · code | Produced by | Source |
|---|---|---|---|
| 1 | **401 `KRI40-AUTH-001`**, missing bearer token | router `checkUserAuth` | `40-kri-router/server.js:80–82` |
| 2 | **502 `KRI40-DOWNSTREAM-UNAVAILABLE-001`**, downstream network error | router `proxyToEngine` catch | `40-kri-router/server.js:262–275` |
| 3 | **504 `KRI40-DOWNSTREAM-TIMEOUT-001`**, downstream timeout (`forward` default 5000 ms) | same catch | `40-kri-router/server.js:263–270`, `:55` |
| 4 | Engine statuses **pass through unchanged**, because `forward()` sets `validateStatus: () => true` | router | `40-kri-router/server.js:66`, `:261` |
| 5 | **401 `KRI41-AUTH-001`**, invalid service token or integration key | engine `serviceAuth` | `41-kri-engine/server.js:80–88` |
| 6 | **422 `KRI41-PO-VALIDATE-001`**, invalid fields | engine `validatePO` | `41-kri-engine/server.js:198–203` |
| 7 | **409 `KRI41-PO-DUPLICATE-001`**, from the duplicate check *and* from a unique-violation (`23505`) | engine handler | `41-kri-engine/server.js:≈210–214`, `≈225–229` |
| 8 | **500 `KRI41-PO-DB-001`**, other DB failure | engine handler catch | `41-kri-engine/server.js:≈230–233` |
| 9 | A mail-send failure is **not** an error status: the PO still succeeds | router | `40-kri-router/server.js:≈228–240` |

*Bonus:* the router's global `setErrorHandler` (`40-kri-router/server.js:325–343`)
returns 422 `KRI40-VALIDATE-001` or 500 `KRI40-INTERNAL-001`, but only if the handler
throws, which is not the main path.

### Q3: edit context for `checkUserAuth` (7 facts)

| # | Fact | Source |
|---|---|---|
| 1 | Defined in `40-kri-router/server.js` | `:76–86` |
| 2 | Called by `proxyToEngine` | `:169` |
| 3 | Called by the `POST /api/v1/mail/send` handler | `:292` |
| 4 | Via `proxyToEngine` it guards **9 routes**: GET/POST `/api/v1/po`, GET `/api/v1/po/:id`, GET/POST `/api/v1/grn`, GET `/api/v1/grn/:id`, GET/POST `/api/v1/bill`, GET `/api/v1/bill/:id` | `:280–288` |
| 5 | So **10 registered routes** in total are affected (the 9 plus `POST /api/v1/mail/send`) | `:280–291` |
| 6 | Exempt: `/api/v1/auth/login` and `/api/v1/auth/register` (`isPublicAuthPath`) and any URL starting with `/health` or `/ready`. Login and register are also served by `proxyAuth`, which never calls `checkUserAuth` | `:71–73`, `:77`, `:164–165` |
| 7 | The `onRequest` hook already **generates a correlation id when the header is missing**, so a check inside `checkUserAuth` must read the raw header, not `req.correlationId` | `:38` |

*Bonus:* Fastify also serves an automatic `HEAD` route for each of the 6 GET routes,
and those run `proxyToEngine` too. The boot dump shows them; the source does not
mention them.

---

## 3. Record the result

Copy this into `docs/measurements.md` under a new heading, with the date:

| Q | Arm | totalTokens | usd | turns | graphCalls | fileReads | Accuracy | Wrong claims |
|---|---|---|---|---|---|---|---|---|
| Q1 | without | | | | 0 | | /13 | |
| Q1 | with | | | | | | /13 | |
| Q2 | without | | | | 0 | | /9 | |
| Q2 | with | | | | | | /9 | |
| Q3 | without | | | | 0 | | /7 | |
| Q3 | with | | | | | | /7 | |

**Reading it honestly:**

- **n = 1 per arm.** This is a sanity check, not a statistic. A run can vary by tens
  of percent on its own.
- **Tokens only count if the answer is right.** The plan's gate (G5) is *fewer tokens
  **and** all required facts*. A cheaper but less accurate answer is not a win.
- **Expect the graph to lose some facts on today's graph.** It has 0 cross-service
  `REQUESTS` edges and no symbols for the Python service
  ([tracker baseline](../plans/claude-context-tracker.md)). So in arm B, Claude
  probably has to read files for the engine and integration hops in Q1/Q2. Q3 stays
  inside the router, where the graph is complete, so it is the fairest test of the
  graph as it stands.

---

## 4. Running it in the VS Code panel instead

The panel uses the same Claude Code engine and the same MCP config, but gives less
exact numbers. Per question:

- **Arm B:** start a new conversation with the folder `D:/###facilitator/dev-workspace`
  open, then paste the question.
- **Arm A:** first run `npm run claude:uninstall` in `D:/CodeGraph` (which removes
  the hooks and the MCP server), start a new conversation, and paste the question.
  Afterwards run `npm run claude:install` to restore them.

Read the session's usage from the panel. For exact token counts, use the CLI steps
above.
