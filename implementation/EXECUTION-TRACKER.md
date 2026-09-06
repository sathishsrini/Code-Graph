# Implementation Execution Tracker

Plan of record: `plans/code-intelligence-engine-plan-v2.md`

This file records why each task was implemented in its current shape, the code
references used, the verification evidence, and the limits that remain. It is
updated with the implementation rather than after the fact.

## P1-T5 — Next.js static indexing

Status: **done** and verified.

Why:

- `60-kri-next` has no boot route extraction in the current scope.
- Its static symbols and API call sites are still required for cross-service
  linking and impact analysis.
- The existing SCIP runner already enforces `repos.json` include/exclude rules,
  rewrites trailing `/**` globs for TypeScript, and rejects empty indexes.

Code references:

- `config/repos.json` declares `framework: "nextjs"`, static includes, and
  `.next/**` exclusion.
- `src/static/scip/runner.ts` generates the exact temporary tsconfig and applies
  the second `documentAllowed` gate.
- `src/cli.ts` intentionally rejects `boot dump` for Next.js instead of
  creating an empty route artifact.
- `tests/scip-runner.test.ts` covers the glob and exclusion invariants.
- `tests/next-indexing.test.ts` covers static-only configuration, generated
  content exclusion, and non-broadened file set.

Decision:

- Reuse the shared SCIP path instead of adding a Next.js-specific indexer.
- Do not add route extraction for Next.js in this task.

Verification evidence:

- `npm run typecheck` — clean (0 errors).
- `npm test` — 225/225 pass (0 fail, 0 regressions).
- `tests/next-indexing.test.ts` — 2/2 pass.
- `tests/scip-runner.test.ts` — glob and exclusion invariants for Next.js repos
  confirmed.

Limit:

- A live `scip-typescript` run against the external fixture still depends on
  that fixture being mounted and the indexer being installed.

## P1-T7 — Cross-service linker

Status: **done** — resolver, store integration, and pipeline wiring complete.
The shipped design reflects an independent review (see D22): the first
implementation produced zero correct edges on the corpus, and the resolver was
reworked in place to iterate URL expressions instead of client calls.

Why:

- Tree-sitter deliberately records HTTP call sites and URL expressions without
  pretending they are already graph edges.
- A pure resolver makes matching deterministic and independently testable.
- Unmatched or ambiguous calls remain unresolved rather than becoming a wrong
  `REQUESTS` edge.
- Store/pipeline integration writes `REQUESTS` edges and `unresolved_calls` rows
  with scoped provenance deletion to avoid erasing unrelated evidence.

Code references:

- `src/static/treesitter/extract.ts` supplies `HttpFinding`, `UrlExpr`, and
  `EnvBinding`.
- `src/derive/cross-service.ts` iterates URLs, attributes each to its enclosing
  function, accepts only URLs consumed by an HTTP call (directly or through a
  callee wrapper such as the corpus `forward()`), resolves base URLs through
  the env-binding map, and classifies dynamic paths and unknown services as
  unresolved.
- `src/index/pipeline.ts` exports `linkCrossServiceRepos`, which runs after
  all repo-local indexing.
- `src/store/db.ts` gained `deleteEdgesByTypeAndProvenance` and
  `deleteUnresolvedByProvenanceAndKind` for scoped incremental deletion.
- `src/cli.ts` calls `linkCrossServiceRepos` after `indexRepo` in the `index`
  command.
- `tests/cross-service.test.ts` has nine corpus-shaped tests covering inline
  URLs, wrapper indirection, env-binding base resolution, non-loopback hosts,
  ternary honesty, outside-function URLs, bare-path literals, and config-style
  calls.

Decisions:

- Every resolved request is `confidence: "inferred"` with
  `evidence_kind: "treesitter"`.
- Dynamic empty paths are not guessed. They become unresolved unless a later
  rule can establish a unique route.
- Base identity is the env var, not the local variable name: the binding map is
  consulted before any name token match.
- `serviceFromUrl` requires a loopback host plus a declared port; a port alone
  is never identity.
- Bare `/…` literals are path literals (route registrations, `startsWith`
  comparisons) unless they are inline arguments of an HTTP client call, so
  they neither resolve nor flood the gap log.
- Only `REQUESTS` edges and cross_service gaps are deleted on re-indexing;
  CALLS, datastore, config, and boot evidence remain untouched.
- `artifactDir` is passed explicitly rather than assuming the process working
  directory.

Verification evidence:

- `npm run typecheck` — clean (0 errors).
- `npm test` — 230/230 pass (0 fail, 0 regressions).
- `tests/cross-service.test.ts` — 9/9 pass.
- Corpus run — `40-kri-router`: 2 REQUESTS (L216/L298 →
  `51-integration POST /api/v1/mail/send`) plus 4 honest gaps (L176 ternary ×2,
  L127 dynamic path, unconsumed CORS origin); engine 0; integration/frontend
  report base URLs and dynamic paths honestly.

Limit:

- No semantic URL normalization beyond the canonical route key.
- No resolution of calls to services outside the declared `repos.json` set.
- No bearer-token or OAuth inference — that is P1-T10's scope.

## P1-T9 — Security check-kind rule pack

Status: **done** and verified.

Why:

- Security classification must be reviewed configuration, not a heuristic that
  silently writes facts.
- Exact helper-name matching avoids classifying unrelated methods such as a
  generic `get()` call.
- The loader only returns classifications; the future inline detector owns
  evidence, confidence, and database writes.

Code references:

- `rules/check-kinds.yml` contains the reviewed vocabulary, including the
  corpus's real helper names — `serviceAuth` (41-kri-engine:77) under `auth`.
- `src/static/security-rules.ts` loads and classifies exact helper names. The
  parser skips comments, rejects malformed structure, and the classifier only
  matches exact names.
- `src/derive/routes.ts` currently leaves `check_kind` null because boot
  reflection cannot safely infer security semantics.
- `tests/security-rules.test.ts` covers valid YAML loading, exact matches,
  unknown helpers, malformed structure, and the corpus's `serviceAuth`.

Verification evidence:

- `npm run typecheck` — clean (0 errors).
- `npm test` — 230/230 pass (0 fail, 0 regressions).
- `tests/security-rules.test.ts` — 3/3 pass.

Limit:

- The initial helper list is based on the validation corpus and must be reviewed
  against production helper implementations before P1-T10.
- No evidence or database writes from this module — that is the inline
  detector's job.

## Next required work

1. Run validation corpus through full pipeline to exercise P1-T7 store
   integration end to end.
2. Use reviewed check-kind rules in P1-T10 inline security detection.
3. Begin Phase 2 work (P2-T1 spans + summaries schema, P2-T2 context packer).
