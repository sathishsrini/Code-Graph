# Architecture Map

Full rationale: `plans/code-intelligence-engine-plan-v2.md`.
Research verdict it implements: `docs/code-intelligence-engine.md`.

---

## The one-paragraph version

Three **acquisition channels** with different trust levels feed a **normalizer**,
which writes canonical nodes and edges into a single-file **SQLite fact store**.
A **derivation layer** computes what can be recomputed (call edges, cross-service
links, reachability). A **query engine** answers six question types with recursive
CTEs. A **serialization layer** renders results for either an LLM or a UI. Every edge
carries `confidence` + `evidence_kind`, so provenance is structural rather than a
column someone remembers to fill.

```
CONSUMERS          CLI · MCP server · Web UI (React Flow + elkjs)
     ▲
SERIALIZATION      compact JSON / TOON (LLM) · node+edge JSON (UI) · Mermaid
     ▲
QUERY ENGINE       endpoint_flow · impact · error_paths · security_path
                   context_pack · workflow
     ▲
DERIVATION         CALLS · cross-service linker · route-chain expander
(regenerable)      reachability closure · summaries (LLM, cached)
     ▲
FACT STORE         SQLite (WAL): nodes · edges · route_chain · function_cfg
                   spans · unresolved_calls · provenance
     ▲
NORMALIZER         everything → canonical node keys
     ▲
CHANNELS      ┌─ STATIC ──────┬─ BOOT ─────────┬─ RUNTIME ──────┐
              │ scip-typescript│ fastify-overview│ OTel spans     │
              │ scip-python    │ FastAPI routes  │ http.route     │
              │ tree-sitter    │ + openapi()     │ code.* db.*    │
              │ semgrep · git  │ config dump     │ exception.*    │
              │ certain/inferred│ certain        │ observed       │
              └────────────────┴─────────────────┴────────────────┘
```

## Directory Structure

`[built]` = exists · `[planned]` = defined in the plan, not yet written

```
Projects/
├── src/
│   ├── cli.ts                    [planned] P0-T9  CLI entry
│   ├── config/                   [planned] P0-T2  repos.json loader + validation
│   ├── store/                    [planned] P0-T5  schema, migrations, bootstrap
│   ├── static/                   [planned]        STATIC channel
│   │   ├── scip/                 [planned] P0-T4  protobuf reader (behind interface)
│   │   ├── treesitter/           [planned] P1-T6  throws, HTTP sites, SQL, config
│   │   ├── cfg.ts                [planned] P1-T17 intra-function control flow (v2)
│   │   └── inline-auth.ts        [planned] P1-T10 handler-body security checks
│   ├── normalize/                [planned] P1-T2  canonical node keys
│   ├── derive/                   [planned]        DERIVATION layer
│   │   ├── calls.ts              [planned] P0-T6  occurrence → enclosing definition
│   │   └── cross-service.ts      [planned] P1-T7  call site → remote route
│   ├── query/                    [planned]        endpoint-flow, impact, security,
│   │                                              errors, context-pack
│   ├── serializers/              [planned]        toon, compact-json, mermaid
│   ├── runtime/                  [planned] P2-T8  OTLP receiver → spans
│   └── mcp/                      [planned] P1-T16 MCP server
├── adapters/                     [planned]        BOOT channel (out-of-process)
│   ├── fastify/boot-dump.js      [planned] P0-T8
│   └── fastapi/dump.py           [planned] P1-T4
├── config/repos.json             [planned] P0-T2  per-service paths + include/exclude
├── rules/check-kinds.yml         [planned] P1-T9  semgrep → check_kind mapping
├── tests/                        [planned]        node --test
├── docs/
│   ├── code-intelligence-engine.md   [built] the research verdict (source of truth)
│   └── INDEX.md                      [built]
├── plans/
│   └── code-intelligence-engine-plan-v2.md  [built] 78 reqs, 44 tasks, 4 phases
├── .claude/                      [built] session protocol, hooks, these docs
├── .github/workflows/ci.yml      [built] typecheck · test · token audit
├── package.json                  [built]
└── tsconfig.json                 [built]
```

## Key File Locations

- **Configuration**: `tsconfig.json`, `package.json`, `config/repos.json` *(planned)*
- **Main entry**: `src/cli.ts` *(planned — P0-T9)*
- **Tests**: `tests/` *(planned)* — run with `npm test`
- **Plan of record**: `plans/code-intelligence-engine-plan-v2.md`
- **Requirements source**: `docs/code-intelligence-engine.md`
- **Database**: `.codeintel/graph.db` *(generated, gitignored)*

## Data model — the seven node kinds

`service` · `route` · `symbol` · `file` · `external` · `datastore` · `config`

One `nodes` table, integer PK, `UNIQUE(kind, key)`. Symbol keys are **verbatim SCIP
symbol strings** (R4). Node identity is global, never repo-scoped — that is what makes
a cross-service edge an ordinary row (R9).

## The nine edge types

`CONTAINS` · `CALLS` · `HANDLES` · `REQUESTS` · `READS` · `WRITES` ·
`CALLS_EXTERNAL` · `THROWS` · `READS_CONFIG`

Plus one **ordered relation that is not an edge**: `route_chain(route_node_id,
position, symbol_node_id, phase, check_kind)`. Ordering is the entire point of a
security-flow graph, and an edge cannot carry it.

## Two enums that must never merge

```
confidence    ∈ certain | inferred | observed | unresolved
evidence_kind ∈ scip | treesitter | semgrep | boot | otel | manual
```

`confidence` is never a number. See COMMON_MISTAKES #5.

## Validation corpus (test fixtures — NOT the real repos)

`D:/###facilitator/dev-workspace/` — `40-kri-router` (Fastify/JS),
`41-kri-engine` (Fastify/JS), `51-integration` (FastAPI), `60-kri-next` (Next.js/TS).

⚠️ These are **unrepresentative** of the live `syf-*` services in specific ways:
zero plugin nesting, no `preHandler` hooks, no route schemas, no `Depends()`, no
`throw` statements, ~2,700 LOC total. Passing here does not prove the engine works on
real code. See plan §6 OPEN-3.

---

**Last Updated**: 2026-09-06
