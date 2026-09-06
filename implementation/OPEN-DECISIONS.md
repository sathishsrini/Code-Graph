# OPEN decisions — live status

The plan lists nine (§6). This is what each one actually resolved to once code
ran against the corpus.

| # | Subject | Blocks | Status | Resolution |
|---|---|---|---|---|
| OPEN-1 | Dead TS trees vs. live JS | P0-T3 | **closed** | Interpretation (1): index only the declared file set. Enforced by a *generated* tsconfig plus a second document gate in `deriveCalls` — see [D6](PLAN-DELTAS.md#d6). |
| OPEN-2 | Project name / location | P0-T1 | **closed** | `c:\Users\sathish\Projects`, package `code-intel`, CLI `codeintel`, git initialised. Not `D:\code-intel` as recommended. |
| OPEN-3 | Phase 0 target endpoint | P0-T9 | **closed** | Both, split as recommended: `60-kri-next` for the false-positive number (M3), `40-kri-router` `POST /api/v1/po` for the boot channel and the end-to-end tree (M7). |
| OPEN-4 | `procurement-module` outside the corpus | P1-T7 | **open** | Working assumption: env-conditional destinations emit **two candidate `REQUESTS` edges** or one `unresolved_calls` row, never one silently-wrong edge. `procurement-module` is not indexable, so no routes are seeded for it. |
| OPEN-5 | `scip-python` environment | P1-T3 | **open** | Working assumption: a dedicated indexing venv on 3.11/3.12, recorded in `repos.json` as `pythonBin`. The indexing environment need not match the runtime one. No `__init__.py` added to the fixture. |
| OPEN-6 | Route schemas unavailable | P1-T4 | **open** | Working assumption: accept NULL, record as a known gap. R72 — no producer, no fallback extractor for a fixture-specific problem. |
| OPEN-7 | OTel instrumentation owner | P2-T7 | **open, external** | Outside the engine's control. Must not block Phase 1. Fixture instrumentation + a traffic generator are in scope; real-service instrumentation is not. |
| OPEN-8 | LLM provider / model | P3-T2 | **open** | Deferred behind a provider interface. Not blocking Phases 0–2. |
| OPEN-9 | Shared-database coupling | P1-T13 | **open** | Working assumption: leave implicit, surface as a *data dependency* in `impact` (R38). Two services writing one `datastore` node is already a join, and a stored edge would violate R72. |

## What Phase 0 did not establish

Recorded here because the corpus is unrepresentative and pretending otherwise is
how the gate stops meaning anything.

1. **`scip-typescript` was never stressed.** 347 LOC. R74's OOM gate cannot fail
   here, so it is untested rather than passed.
2. **No inherited chains in the corpus.** Zero plugins, zero `preHandler` hooks.
   Inheritance is verified only against `tests/fixtures/fastify-app.cjs`, written
   to supply it.
3. **Untyped CJS resolves badly.** 86 of 306 skipped references are `local N`
   symbols with no stable identity.
4. **The chain contains no auth check and the endpoint is still authenticated.**
   `checkUserAuth` is the handler's first statement. Boot reflection is complete,
   correct, and blind to it; the call tree finds it. That is R26/P1-T10's
   territory, and it is why the inline-auth channel is on the critical path
   rather than optional.
