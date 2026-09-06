# Architecture-Aware Code Intelligence & Context Engine — Research and Recommendation

**Scope:** multi-repo, multi-language (TS/JS + Python), microservice codebase (`60-syf-next`, `40-syf-router`, `51-syf-integration`, others). Goal: an endpoint-level execution graph, security/authz visibility, impact analysis, error backtracking, and a local SQLite context store for AI agents.

**Date of research:** September 2026. Tool status, licences and project health were checked at that time and go stale fast — re-verify before committing.

---

## 0. Verdict up front

**Build a thin custom system. Do not build the extractors, and do not fork an existing project.**

Three-line version:

1. **Symbols, types and call edges** → use `scip-typescript` and `scip-python`. They already do the hard part (TypeScript typechecker / Pyright-based inference) and emit a stable, language-agnostic symbol identity. Writing your own TS/Python AST walkers is the mistake that kills this project.
2. **Routes, middleware chains, auth/authz ordering** → do **not** derive statically. Extract them from **boot-time reflection** of the running app (`fastify-overview` for the router, FastAPI's `app.routes` + `app.openapi()`, Next.js build manifest). This is exact, not inferred, and it's ~200 lines of code per framework.
3. **Cross-service edges, the SQLite graph, the query engine, the context packer** → this is the only genuinely custom part, and it's small. Maybe 3–4k lines.

Everything else in the brief is either already solved by the above or is a research problem you should not take on.

---

## A. Problem decomposition

Your brief reads as one system. It is actually **eight** problems with wildly different difficulty and different correct tools. Treating it as one is why v2 collapsed.

| # | Sub-problem | Difficulty | Correct mechanism | Can it be exact? |
|---|---|---|---|---|
| 1 | Symbol extraction (functions, classes, signatures, params, returns) | Low | Compiler/typechecker via SCIP indexer | Yes |
| 2 | Intra-service call graph | Medium | SCIP occurrences + enclosing ranges, or LSP `callHierarchy` | Mostly — breaks on dynamic dispatch, HOFs, DI |
| 3 | Route → handler mapping | Low **if** done at boot; Hard statically | Framework reflection at boot | Yes (boot), No (static) |
| 4 | Middleware / auth / authz **ordering** on a route | Low at boot; Very hard statically | Framework reflection | Yes (boot) |
| 5 | Cross-service HTTP edges (client call site → remote route) | Medium-Hard | Custom matcher: static call sites + config resolution + OTel confirmation | No — inherently probabilistic |
| 6 | DB and external-service edges | Medium | Static heuristics, confirmed by OTel `db.*` / client spans | Partial static, exact at runtime |
| 7 | Error origin / propagation | **Hard, partly impossible** | Runtime traces primarily; static `throw` analysis is weak in TS | No |
| 8 | "What context does the LLM need" | Medium | Graph traversal with a token budget | N/A — it's a ranking problem |

**The key structural insight you missed in v2:** problems 3 and 4 — the ones your whole "endpoint execution graph" and "security boundary" features depend on — are *the easiest problems in the list if you stop trying to solve them with static analysis*, and among the hardest if you don't.

Fastify's hook chain is assembled by `avvio` at boot through encapsulation contexts. A route's effective `onRequest → preParsing → preValidation → preHandler → handler` chain is the union of hooks registered in every ancestor plugin context. No AST walker will ever get this right, because the chain depends on *registration order and plugin nesting at runtime*, not on lexical structure. `fastify-overview` gets it exactly right by hooking `onRoute`/`onRegister` and reading the assembled tree. Same story for FastAPI: `Depends()` resolution order lives in `route.dependant`, not in the source text.

So: **your auth/authz/validation flow is a runtime-reflection problem wearing a static-analysis costume.**

---

## B. Existing open-source solutions

### B.1 Code intelligence / symbol indexing

**SCIP (Sourcegraph Code Intelligence Protocol)** — Apache 2.0. Protobuf-based index format: symbols, occurrences (definition/reference roles), documentation, relationships. As of March 2026 it moved from Sourcegraph ownership to an **independent project with an open governance model and a Core Steering Committee including engineers from Uber and Meta** — a meaningful de-risking versus 2024, when Sourcegraph's own product went closed.

What it gives you that matters most: **a stable, canonical, cross-repo symbol string**. Something like `scip-typescript npm my-router 1.0.0 src/services/`zoom.ts`/createZoomMeeting().` That string is your primary key. It survives file moves less well than you'd like, but it survives *reindexing*, and it lets you join TS and Python indexes into one graph. This is precisely what your v2 schema lacks.

- `scip-typescript` — built on the TypeScript typechecker. Handles tsconfig projects, yarn/pnpm workspaces, JS with `--infer-tsconfig`. Known OOM issues on large repos; mitigated with `--no-global-caches` and `--max-old-space-size`.
- `scip-python` — built on Pyright's inference. Needs the virtualenv active.
- `scip` CLI — Go binary for inspecting/converting indexes. There's also `scip-io`, a Rust orchestrator that installs and merges multi-language indexers.

**Limitation to be clear-eyed about:** SCIP gives you *occurrences*, not *call edges*. An occurrence says "symbol X is referenced at file F line L". To get "A CALLS B" you compute: find the definition whose range encloses line L → that's A; the referenced symbol is B. This works and is what blarify does, but it over-approximates: a reference inside a type annotation or a re-export looks like a call. You'll need a filter on `SymbolRole` and syntactic kind.

**Glean (Meta)** — open source, stores typed schema-defined facts about code, queried with **Angle**, a Datalog-style language. Indexers for C++, Hack, Python, Haskell, Flow, plus LSIF/SCIP ingestion for Go/Java/Rust/TypeScript. Genuinely excellent and incremental. **Not for you:** Haskell service, heavy ops footprint, and it's a fact store, not a local-first single-file DB. It's the right answer at Meta scale, not at 6-developer scale.

**LSP `callHierarchy`** — `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls`. Supported by `typescript-language-server`/`vtsls` and Pyright. This is the highest-precision call-edge source available, because the language server resolves it. It's also **slow** — one request per symbol, over JSON-RPC. blarify measured **SCIP as ~330× faster than LSP for reference resolution** and treats them as equivalent in accuracy, which is why it auto-prefers SCIP when available.

Practical read: **use SCIP for the bulk index, keep an LSP client as a fallback for symbols SCIP resolves poorly.** Don't build LSP-first.

**universal-ctags** — regex/heuristic tags. No types, no call resolution. Fine for fuzzy symbol lookup, useless for your graph. Skip.

**tree-sitter** — incremental parsers, huge language coverage, embeddable, permissive. Gives you syntax, not semantics: it can tell you a call expression exists and what identifier is being called; it cannot tell you *which* definition that identifier resolves to across files. **Use it for the things SCIP doesn't model** — route decorator arguments, `axios.post('/path')` string literals, `throw new X()` statements, SQL string extraction. Do not use it as your call-graph engine.

**GitHub stack-graphs** — tree-sitter-based name resolution, incremental and file-local by design. Interesting, but TS/JS/Java grammars only and thin ecosystem. Not worth the bet for you.

### B.2 Static analysis platforms

**Joern** — Apache 2.0. Code Property Graph (CPG): AST + CFG + PDG unified, queried with a Scala DSL, with real interprocedural data-flow. Frontends for C/C++, Java, JS/TS, Python, Kotlin, PHP, binaries. This is the *only* tool in the list that actually does taint/data-flow across your languages under a permissive licence.

Why it's still not your engine: the C frontend is documented as very high maturity; **JS/TS and Python frontends are materially weaker**, and Joern's own docs warn that call resolution and type recovery produce false positives and negatives. It's JVM+Scala, memory-hungry, and its CPG format is not something you want as your primary store. **Correct use: an optional Phase-3 side-car for specific data-flow questions** ("does request body reach this SQL string"), not the backbone.

**CodeQL** — **rule this out now.** The licence permits use only on OSI-approved open-source codebases, for academic research, or to demonstrate the software. Using it on a private company codebase, or in CI at all, requires GitHub Advanced Security. Your codebase is private and commercial. Not an option. Don't spend another hour evaluating it.

**Semgrep CE** — LGPL. Pattern matching with **intraprocedural (single-function) taint only**. Cross-file and cross-function dataflow are in the paid Pro engine. In December 2024 Semgrep moved several previously open features behind a commercial licence, prompting **Opengrep**, a community fork launched January 2025 that restores cross-function taint.

Where Semgrep/Opengrep genuinely earns its place in your system: **as a rule-driven detector for security-relevant call sites**. Writing a rule that says "any call to `verifyJwt`, `requireRole`, `assertTenant`, `checkOwnership` is a security check of kind X" is trivial in Semgrep YAML and awful to hand-code in an AST walker. Use it as one evidence producer feeding your DB, not as the analysis engine.

**Fraunhofer-AISEC/cpg** — another CPG library, Apache 2.0, JVM. Same category as Joern, smaller ecosystem. Skip.

### B.3 Code-graph / AI-context projects (the closest prior art)

**blarify** (blarApp) — **MIT, and the closest thing to what you want that exists.** Builds a graph from a codebase using tree-sitter for structure + LSP (or SCIP) for reference resolution. Python, JS, TS, Ruby, Go, C#. Persists to Neo4j or FalkorDB. Handles incremental update on file add/delete/modify. ~230 stars, ~1500 commits, actively developed.

What it does **not** do: HTTP routes, middleware chains, cross-service links, auth/authz semantics, runtime traces, SQLite. It is the *substrate* layer of your system, correctly built. **Read its source before you write yours** — specifically its SCIP reference-resolution path and its incremental update logic. Whether you fork it or reimplement in Node depends on whether you want a Python service in your stack (see D).

**CodeBoarding** — LSP-based control-flow analysis + LLM abstraction into layered architecture diagrams, Mermaid output, incremental, VS Code extension and GitHub Action. Python/TS/JS/Java/Go/PHP/Rust/C#. Genuinely good at "explain this repo's architecture to a human". **Wrong shape for you:** LLM-derived components (probabilistic, contradicts your constraint 22), diagram-first not database-first, single-repo, no security or route modelling.

**code-graph-rag** (vitali87) — tree-sitter → Memgraph, natural-language → Cypher over a monorepo. Multi-language, MCP indexing, respects ignore files. **Wrong shape:** requires Memgraph (server), NL→Cypher is exactly the probabilistic-instead-of-deterministic pattern you said you want to avoid, and tree-sitter-only means no cross-file resolution.

**api-ghost-hunter** — MIT, static CLI that detects frontend API calls and backend endpoints and matches them, including path-parameter matching (`/api/users/123` ↔ `/api/users/{id}`). Supports fetch/axios/`axios.create()` baseURL resolution, Angular HttpClient, and backends including Express, Flask, **FastAPI**, NestJS, Django, Spring, Go, plus OpenAPI specs. **This is prior art for your single hardest custom problem.** Its purpose (find dead/broken endpoints) is not yours, but its matcher is the thing to study or lift.

**Ariadne** (MCP server) — cross-service API dependency mapping for Spring/Kotlin/TS/GraphQL, offline static analysis, MCP integration. Same category, wrong languages for you, but validates the design.

**Sourcegraph** — the product itself is no longer the open-source option it was. SCIP is; the platform isn't. Don't plan around self-hosting it.

### B.4 Dependency / architecture visualisers

- **dependency-cruiser** (MIT), **madge**, **pydeps** — all **module/file-level only**. They answer "which file imports which". You need function-level and cross-process. They are a rounding error against your requirements. Useful for a quick layering-violation check, nothing more.
- **Structurizr** — C4 model as code. **Manually authored**, which is exactly what you said you don't want. But worth keeping as an *output format*: your derived service-level graph could emit a Structurizr/C4 view for docs.
- **CodeSee** — do not plan around it; treat as unavailable.
- **JetBrains Endpoints tool window** — IntelliJ/CLion aggregate client+server endpoints and render a services diagram. Proprietary IDE feature, framework-limited (mostly JVM). Mentioned only as proof the concept is commercially validated.

### B.5 Observability

**OpenTelemetry** — the right and only sensible choice. Two facts make it directly usable as a graph source:

- `http.route` (the *template*, e.g. `/api/v1/zoom/meeting`, not the concrete URL) is a **stable** attribute on server spans. That is your join key from a trace to a route node.
- The `code.*` semantic conventions were promoted to **stable in semconv v1.33.0**: `code.function.name`, `code.file.path`, `code.line.number`, `code.column.number`, `code.stacktrace`. `code.namespace`/`code.function` were merged into `code.function.name`. That is your join key from a span to a symbol node.

Auto-instrumentation for Fastify and FastAPI will give you, for free and with certainty: service→service edges, DB operations, external HTTP calls, status codes, exception events. It gives you **almost nothing about intra-service function calls** unless you manually instrument.

So the division of labour is clean and worth stating as a design principle:

> **Runtime traces establish the boundaries with certainty. Static analysis fills in the interiors with inference.**

Jaeger / Grafana Tempo / an OTLP collector writing to your own SQLite — any is fine. For your purposes you don't need a tracing backend at all in Phase 2; you need an OTLP receiver that writes spans into your DB with tail-based sampling on errors.

### B.6 Storage

**SQLite** — right choice, keep it. Recursive CTEs handle bounded multi-hop traversal fine; WAL mode gives concurrent reads during writes; the cost is bounded by branching factor and depth, not table size.

**Embedded graph DBs — a warning.** Kùzu, the obvious "upgrade from SQLite" candidate, was **archived in October 2025** after Apple acqui-hired the team. The MIT licence let the community fork it (LadybugDB, bighorn, RyuGraph, a Vela Partners fork), but the codebase is reportedly understood by fewer than ten people and the file format changed in the final release. **Do not bet your storage layer on it.** This is a live example of why "local-first, boring format" was the correct instinct.

**Vector search in SQLite:** `sqlite-vec` is still explicitly pre-v1 with breaking changes and alpha ANN indexes. SQLite.org now ships its own **`vec1`** extension (IVFADC + OPQ, single C file, currently v0.7). Both are moving targets. Practical answer: **brute-force cosine over BLOBs is exact and fine up to roughly 50–100k vectors** — which is more symbols than your three services have. Don't take an ANN dependency until you measure a problem.

### B.7 Visualisation

- **React Flow / xyflow** — MIT. Every node is a React component, so your "click a function → see its contract" inspector is trivial. **No built-in layout** — pair with `elkjs` (configurable, layered) or `dagre` (fast, trees). DOM-based rendering, so it degrades on very large graphs. Default OSS build shows a "Built with React Flow" attribution, removable with a Pro subscription; the MIT licence itself does not require it.
- **Cytoscape.js** — MIT, canvas-based, built-in graph algorithms and layouts, extensions for dagre/expand-collapse/context-menus. Better raw performance on big graphs, less ergonomic for rich node UIs.
- **Sigma.js + graphology** — WebGL, for genuinely large graphs (tens of thousands of nodes). Renderer only; graphology brings the algorithms.
- **Mermaid / Graphviz** — static output. Excellent for docs, PR comments and LLM-consumable diagrams. Useless for interactive expand/collapse.

Don't cite universal node-count limits; edge density and label rendering dominate. Benchmark with your actual graph shape.

---

## C. Capability comparison

Legend: **Y** = yes, **P** = partial, **N** = no. "Custom" = the architecture in section E (SCIP + boot reflection + SQLite + OTel).

| Capability | SCIP indexers | Joern | Semgrep CE / Opengrep | blarify | CodeBoarding | code-graph-rag | OTel + tracing | **Custom** |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Multi-repository | P¹ | P² | Y | P³ | N | Y | Y | **Y** |
| TypeScript | Y | P⁴ | Y | Y | Y | Y | Y | **Y** |
| Python | Y | P⁴ | Y | Y | Y | Y | Y | **Y** |
| Function-level graph | P⁵ | Y | N | Y | P⁶ | P⁷ | N | **Y** |
| HTTP route mapping | N | N | P⁸ | N | N | N | Y⁹ | **Y** |
| Cross-service flow | N | N | N | N | N | N | Y | **Y** |
| Authentication flow | N | P | P⁸ | N | N | N | N | **P**¹⁰ |
| Authorization flow | N | P | P⁸ | N | N | N | N | **P**¹⁰ |
| Business-logic understanding | N | N | N | N | P¹¹ | P¹¹ | N | **P**¹¹ |
| Error paths | N | P | N | N | N | N | Y¹² | **P** |
| Runtime traces | N | N | N | N | N | N | Y | **Y** |
| Impact analysis | P⁵ | Y | N | Y | N | P | N | **Y** |
| Data flow | N | Y | P¹³ | N | N | N | N | **N**¹⁴ |
| SQLite storage | N | N | N | N | N | N | N | **Y** |
| AI context retrieval | N | N | N | P | P | Y | N | **Y** |
| Incremental indexing | P¹⁵ | N | Y | Y | Y | Y | N/A | **Y** |
| Interactive visualisation | N | N | N | P¹⁶ | P¹⁷ | P¹⁸ | Y¹⁹ | **Y** |
| Open source | Y | Y | Y | Y | Y | Y | Y | **Y** |
| Self-hosted | Y | Y | Y | Y | Y | Y | Y | **Y** |
| Extensible | Y | Y | Y | Y | P | P | Y | **Y** |

**Explaining the "Partial" cases — these are the ones that matter:**

1. **SCIP multi-repo (P):** the symbol format encodes package manager + package name + version, so symbols from separate indexes *are* comparable — but only for shared library code. Two services talking over HTTP share no symbols. Cross-service linking is entirely outside SCIP's model.
2. **Joern multi-repo (P):** you can build one CPG over multiple source roots, but it has no notion of process boundaries — it will treat two services as one program and find no edges between them.
3. **blarify multi-repo (P):** it can index multiple repos into one Neo4j graph, but again with no cross-process edges.
4. **Joern TS/Python (P):** frontends exist and work, but maturity is below the C frontend, and Joern's own documentation warns about call-resolution and type-recovery false positives/negatives.
5. **SCIP function graph / impact (P):** SCIP emits *occurrences*, not call edges. You derive `CALLS` by mapping each reference occurrence to its enclosing definition. That derivation is yours to write and it over-approximates.
6. **CodeBoarding function graph (P):** it extracts a control-flow graph via LSP, then *abstracts it away* into LLM-named components. You get architecture, not a queryable function graph.
7. **code-graph-rag function graph (P):** tree-sitter only, so calls are matched by name, not resolved. Two `save()` methods in different classes collide.
8. **Semgrep route/auth (P):** you can pattern-match `fastify.get(...)` or `@app.post(...)` and match calls to your auth helpers. What you *cannot* get is **ordering** — which hook runs before which — and ordering is the entire point of a security-flow graph.
9. **OTel route mapping (Y):** `http.route` gives you the real route template on every server span, which is more reliable than any static extraction. But it only covers routes that were actually hit.
10. **Custom auth/authz (P) — read this one carefully.** With boot reflection you can determine *exactly* which hooks and dependencies run, in what order, for a given route. You can classify them ("this one is `verifyJwt`, this one is `requireRole`"). What you **cannot** do is determine whether the check is *correct* — whether `requireRole('admin')` is the right role, or whether an object-ownership check actually compares the right IDs. Statically detecting BOLA is an unsolved research problem, not an engineering task. Design the feature accordingly: **the tool's strong signal is the *absence* of a check on a path, not the presence of one.**
11. **Business logic (P):** everywhere this is marked P, it means "an LLM wrote a summary". That's the only mechanism that exists. It's fine as long as it's clearly labelled as generated and never used to create graph edges.
12. **OTel error paths (Y):** span status, `exception.type`, `exception.stacktrace` and parent-child span structure give you the actual failure chain for a real request. This is dramatically better than any static approximation.
13. **Semgrep dataflow (P):** CE is single-function only. Opengrep restores cross-function taint. Cross-file remains Pro in upstream Semgrep.
14. **Custom data flow (N) — deliberate.** Do not build taint analysis. If you need it later, shell out to Joern or Opengrep for a specific question. Building your own is a multi-year project.
15. **SCIP incremental (P):** `scip-typescript`/`scip-python` index a whole project per run; they are not file-incremental. Your incrementality comes from *your* layer — re-run the indexer on change (it's fast enough for a service-sized project), diff by file content hash, and replace only the affected rows.
16. **blarify viz (P):** graph goes into Neo4j/FalkorDB, so you view it in their browsers. No purpose-built UI.
17. **CodeBoarding viz (P):** Mermaid + a VS Code extension. Not zoom/pan/expand-collapse on a large graph.
18. **code-graph-rag viz (P):** Memgraph Lab.
19. **OTel viz (Y):** Jaeger/Grafana render traces beautifully — but a trace, not a code graph.

**The honest read of this matrix:** *no single existing tool covers even half your rows*, and the rows nothing covers — cross-service flow, auth/authz ordering, SQLite context store, endpoint execution graph — are exactly the rows that define your product. But the rows that are *hardest to build* (symbols, types, call resolution) are fully covered. That combination is the textbook case for "integrate, don't fork".

---

## D. Recommended strategy — extend or build?

**Build a custom orchestration-and-query layer. Reuse every extractor. Fork nothing.**

### Why not fork blarify

It's the closest fit and MIT-licensed, so forking is tempting. Reasons not to:

- Its core abstraction is "codebase → graph of definitions and references". Yours is "distributed system → graph of requests, boundaries and checks". Bolting route/middleware/service-boundary semantics onto its node model means rewriting its centre while carrying its periphery.
- It's Python, and two of your three services (and your whole team's daily language) are Node/TypeScript. A Python service in the loop is an operational tax forever.
- Its storage is Neo4j/FalkorDB. You want SQLite. That's not a config change; the traversal model is different.
- Forking a 1500-commit project you didn't write means you own its bugs and can't easily take upstream fixes.

**Do this instead:** read blarify's SCIP-to-graph conversion and its incremental update code carefully, and reimplement that specific piece in your language. That's a few hundred lines, and you'll understand every one of them.

### Why not build the extractors

Because you will spend six months on TypeScript's type system and still be worse than `tsc`. Every hour spent on an AST walker is an hour not spent on the parts that are actually yours — cross-service linking, the query engine, the context packer.

### The buy/build line

| Layer | Decision | What |
|---|---|---|
| Parse + typecheck + resolve symbols | **Reuse** | `scip-typescript`, `scip-python` |
| Syntactic extras SCIP doesn't model | **Reuse** | tree-sitter (call-site string literals, `throw`, decorators, SQL) |
| Security-check classification | **Reuse** | Semgrep/Opengrep rules |
| Route + middleware + dependency chains | **Build (tiny)** | Boot-time reflection adapters, ~200 LOC per framework |
| Cross-service HTTP linking | **Build** | The genuinely novel part |
| Graph store + incremental update | **Build** | SQLite, ~1 file |
| Query engine (flow/impact/error/context) | **Build** | Recursive CTEs + ranking |
| Runtime ingest | **Reuse + thin build** | OTel SDKs + a small OTLP receiver |
| Data-flow / taint | **Defer, then reuse** | Joern or Opengrep side-car, Phase 3+ |
| Visualisation | **Reuse** | React Flow + elkjs |
| Explanations | **Reuse** | Any LLM, cached |

Realistic custom surface: **3,000–5,000 lines**, most of it query logic. That's a real project but a finishable one.

---

## E. Recommended architecture

Your proposed layer stack is close but has one structural flaw: it has a single "Indexer Engine" feeding the store. In reality you have **three fundamentally different acquisition channels with different trust levels**, and collapsing them loses the provenance you explicitly said you need.

```
┌──────────────────────────────────────────────────────────────────┐
│  CONSUMERS                                                       │
│  ├─ Web UI (React Flow)   ├─ CLI    ├─ MCP server (for agents)   │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  SERIALIZATION LAYER                                             │
│  graph subset → Compact JSON / TOON (for LLM)                    │
│  graph subset → node+edge JSON (for UI)                          │
│  Budget-aware. Never dumps raw source unless asked.              │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  QUERY ENGINE                                                    │
│  endpoint_flow · impact · error_paths · security_path ·          │
│  context_pack · workflow                                         │
│  Every result carries per-edge confidence + evidence.            │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  DERIVATION LAYER  (regenerable, never hand-edited)              │
│  ├─ CALLS derivation (occurrence → enclosing definition)         │
│  ├─ Cross-service linker (client call site → remote route)       │
│  ├─ Route chain expander (hooks/deps → ordered symbol list)      │
│  ├─ Reachability closure (route → reachable symbol set)          │
│  └─ Summary generator (LLM, cached by input hash)                │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  FACT STORE — SQLite (single file, WAL)                          │
│  nodes · edges · observations · provenance                       │
│  Every edge tagged: confidence + evidence_kind + run_id          │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  NORMALIZER                                                      │
│  Everything → canonical node keys (SCIP symbol / route key /     │
│  service name / external name / table name)                      │
└──────┬──────────────────┬──────────────────┬─────────────────────┘
       │                  │                  │
┌──────▼──────┐  ┌────────▼────────┐  ┌──────▼──────────┐
│  STATIC     │  │  BOOT-TIME      │  │  RUNTIME        │
│  CHANNEL    │  │  CHANNEL        │  │  CHANNEL        │
│             │  │                 │  │                 │
│ scip-ts     │  │ fastify-overview│  │ OTel spans      │
│ scip-python │  │ FastAPI routes  │  │ (http.route,    │
│ tree-sitter │  │  + openapi()    │  │  code.*,        │
│ semgrep     │  │ Next.js manifest│  │  db.*,          │
│ git         │  │ config/env dump │  │  exception.*)   │
│             │  │                 │  │                 │
│ confidence: │  │ confidence:     │  │ confidence:     │
│  certain /  │  │  certain        │  │  observed       │
│  inferred   │  │                 │  │                 │
└─────────────┘  └─────────────────┘  └─────────────────┘
```

**Four things this buys you that your v1/v2 didn't have:**

1. **Provenance is structural, not a column you remember to fill.** An edge's `evidence_kind` tells you which channel produced it, and therefore how much to trust it. Your section-7 requirement (statically known / statically inferred / runtime observed / unknown) falls out of the architecture instead of being retrofitted.
2. **The boot-time channel exists at all.** This is the piece that makes auth/authz/validation flows exact instead of guessed.
3. **Derivation is separate from facts.** Facts are expensive to acquire and cheap to keep. Derived edges are cheap to recompute and should be thrown away and rebuilt whenever the derivation logic changes. Your v2 mixed these — `derivation_metadata` was trying to bolt this distinction on after the fact.
4. **Serialization is its own layer.** This matches the principle you already settled on: storage format and LLM serialization format are separate concerns.

---

## F. Code indexing strategy

### F.1 TypeScript (`60-syf-next`, `40-syf-router`)

**Step 1 — SCIP index.** Run `scip-typescript index` per service (`--infer-tsconfig` for plain JS, `--pnpm-workspaces`/`--yarn-workspaces` if applicable). Expect OOM on large repos; budget `node --max-old-space-size=8192` and `--no-global-caches`.

**Step 2 — parse the protobuf.** `Index → Document[] → { symbols: SymbolInformation[], occurrences: Occurrence[] }`. From `SymbolInformation` take the symbol string, kind, signature documentation, and `relationships`. From each `Occurrence` take symbol, range, and `symbol_roles` (Definition / ReadAccess / etc.).

**Step 3 — derive `CALLS`.** Build a per-file interval tree of definition ranges. For each non-definition occurrence, find the innermost enclosing definition D and emit `D CALLS S`. **Filter:** drop occurrences that are type-position-only, and drop imports/re-exports (they're `IMPORTS`, not `CALLS`). Mark confidence `certain` when the target resolves to a local definition, `inferred` when it resolves to an external package symbol.

**Step 4 — tree-sitter pass for what SCIP won't tell you.** Per file:
- `throw new X(...)` → `THROWS` edges (see limitations in Q).
- `axios.post('...')`, `fetch('...')`, `client.request({url})` → outbound HTTP call sites with the literal template if present.
- SQL string literals / ORM method names → DB operation candidates.
- `process.env.X` reads → `CONFIG_READS`.

**Step 5 — Semgrep/Opengrep pass for security classification.** A handful of rules mapping your actual helper names to check kinds: `authn.jwt`, `authz.rbac`, `tenant.scope`, `object.ownership`, `validation.schema`. This is a config file you maintain, not analysis.

### F.2 Python (`51-syf-integration`)

Identical shape. `scip-python index . --project-name=51-syf-integration` with the venv active. Same occurrence→CALLS derivation. tree-sitter-python for decorators, `raise`, `httpx`/`requests` call sites.

FastAPI note: `@app.post("/x")` decorators are visible to tree-sitter, but `APIRouter` prefixes, `include_router` composition and `Depends` chains are not reliably reconstructable statically. Get them from boot (F.3).

### F.3 Boot-time reflection — the part that actually matters

**Fastify (`40-syf-router`).** Register `fastify-overview` first (before everything else), `await` the registration, and read `app.overview()` after `ready`. You get a tree of contexts with, per route: method, full url, prefix, and the hooks registered at that route plus every inherited ancestor hook, in execution order — `onRequest`, `preParsing`, `preValidation`, `preHandler`, `preSerialization`, `onSend`, `onResponse`, `onError` — plus decorators and plugin nesting. With `addSource: true` you also get source locations.

Two operational caveats from its docs: hooks must be **named functions** (arrow functions produce useless output), and the plugin must be registered first and awaited.

Emit a JSON file per service at build/CI time. That file *is* your route + middleware + security-chain ground truth, and it's `certain`, not inferred.

**FastAPI (`51-syf-integration`).** Walk `app.routes`; for each `APIRoute` read `path`, `methods`, `endpoint.__module__` + `__qualname__` (→ map to the SCIP symbol), and `route.dependant.dependencies` recursively for the resolved `Depends` chain in order. Also dump `app.openapi()` for request/response schemas. ~80 lines.

**Next.js (`60-syf-next`).** App-router route groups and API handlers are enumerable from the build output manifests; server actions and client-side fetch call sites come from the static channel.

**Config resolution.** Dump resolved env/config per service per environment (redacting secrets — store key names and *whether* a value is set, never values). This is what turns `axios.create({baseURL: process.env.INTEGRATION_URL})` into a resolvable service target.

### F.4 Incremental indexing

The rule that makes this work: **delete by provenance, not by node.**

```
on change:
  1. hash every file → compare to files.content_sha256
  2. changed set C = files whose hash differs (+ added, + deleted)
  3. re-run the language indexer for the affected project
     (scip-typescript on one service is seconds-to-a-minute, not hours)
  4. for each f in C:
       DELETE FROM edges WHERE file_id = f AND evidence_kind IN ('scip','treesitter','semgrep')
       DELETE FROM occurrences WHERE file_id = f
       -- do NOT delete nodes
  5. re-insert facts for C
  6. re-run derivations whose inputs touched C
```

Nodes are keyed by stable SCIP symbol strings, so they survive. Edges *into* a changed file from unchanged files survive too, because they're owned by the *source* file's provenance. This is the property your v2 schema could not provide, because it had no stable symbol identity.

Boot-channel facts are replaced wholesale per service per run — they're small and always consistent as a set.

---

## G. Graph model

### G.1 Nodes

**Ship these seven. Not fifteen.**

| Kind | Key format | Source |
|---|---|---|
| `service` | `40-syf-router` | config |
| `route` | `40-syf-router\|POST\|/api/v1/zoom/meeting` | boot |
| `symbol` | SCIP symbol string | static |
| `file` | `repo:path` | static |
| `external` | `zoom`, `ses`, `whatsapp` | config + runtime |
| `datastore` | `pg:public.meetings` | static + runtime |
| `config` | `40-syf-router\|ZOOM_BASE_URL` | boot |

Deliberately **not** nodes: `Repository` (a property of file/symbol), `Module`/`Class` (containment via `enclosing_symbol`), `Middleware` (it's a symbol playing a role — see `route_chain`), `Error` (a symbol or a string on an edge), `Test` (a symbol with a flag), `MessageQueue` (add it when you actually have one).

Every one of those "extra" node types in your v2 is a property or a role masquerading as an entity. That's how a 15-table schema becomes a 40-table schema.

### G.2 Edges

**Ship these nine.**

| Type | Meaning | Source | Typical confidence |
|---|---|---|---|
| `CONTAINS` | file→symbol, symbol→symbol (nesting) | static | certain |
| `CALLS` | symbol→symbol | static | certain / inferred |
| `HANDLES` | symbol→route (the handler) | boot | certain |
| `REQUESTS` | symbol→route (a *remote* route) | derived | inferred / observed |
| `READS` / `WRITES` | symbol→datastore | static + runtime | inferred / observed |
| `CALLS_EXTERNAL` | symbol→external | static + runtime | inferred / observed |
| `THROWS` | symbol→error name | static | inferred |
| `READS_CONFIG` | symbol→config | static | certain |

Plus one **ordered relation** that is not an edge and should not be modelled as one:

```
route_chain(route_node_id, position, symbol_node_id, phase, check_kind)
```

This is the single most important table in your schema and your v2 didn't have it. `phase` ∈ {`onRequest`, `preParsing`, `preValidation`, `preHandler`, `handler`, `dependency`, `onError`}. `check_kind` ∈ {`authn`, `authz`, `tenant`, `validation`, `ownership`, `rate_limit`, `other`, `null`}.

**Everything you listed that isn't here, and why:**

- `CALLED_BY` — that's `SELECT ... WHERE dst = ?`. Storing both directions doubles writes and guarantees they drift.
- `IMPORTS` — derivable from `CALLS` + file containment; only useful for module-level views you don't need.
- `EXPOSES` — `service CONTAINS route` covers it.
- `ROUTES_TO` — same as `HANDLES`.
- `USES`, `DEPENDS_ON` — meaningless catch-alls. If you can't say *how*, you shouldn't store it.
- `PERSISTS_TO` — synonym of `WRITES`.
- `AUTHENTICATES`, `AUTHORIZES`, `VALIDATES` — these are `check_kind` values on `route_chain` rows, not edge types. Modelling them as edges loses the ordering, which is the only reason you wanted them.
- `CATCHES` — you can't do this reliably in either language. Skip.
- `AFFECTS` — this is a *query result* (transitive `CALLS` closure), not a stored edge. Storing it means invalidating a closure on every commit.
- `INVOKES`, `PRODUCES`, `PUBLISHES_TO`, `SUBSCRIBES_TO`, `COMMUNICATES_WITH`, `CROSSES`, `BELONGS_TO_LAYER`, `FOLLOWS`, `FAILS_WITH`, `TRANSFORMS_ERROR`, `PROPAGATES_ERROR`, `VIOLATES`, `TESTED_BY`, `DEPLOYED_AS` — every one of these was in your v2 vocabulary. **Not one of them had a producer.** A relationship type with no extractor is a comment, not a schema.

### G.3 Edge attributes

```
confidence   ∈ certain | inferred | observed | unresolved
evidence_kind ∈ scip | treesitter | semgrep | boot | otel | manual
```

`confidence` maps 1:1 onto your section-7 requirement:
- **Statically known** → `certain` (compiler resolved it, or boot reported it)
- **Statically inferred** → `inferred` (heuristic matched it)
- **Runtime observed** → `observed`
- **Unknown** → `unresolved` (call site found, target not determined — *store these*, they're the honest gaps)

Never merge these into a numeric score. Your v2 had both a REAL confidence and a TEXT enum with a lossy mapping (`>= 0.9 → 'exact'`), which is the worst of both: a 0.91 heuristic guess is not "exact", and calling it that destroys the distinction you built the column for.

---

## H. SQLite schema (MVP)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- Provenance
-- ============================================================
CREATE TABLE repos (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,      -- '40-syf-router'
  root_path   TEXT NOT NULL,
  service_name TEXT                       -- may differ from repo name
);

CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha    TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('static','boot','runtime')),
  tool          TEXT NOT NULL,            -- 'scip-typescript@0.4.0'
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX idx_runs_repo ON runs(repo_id, channel, started_at DESC);

CREATE TABLE files (
  id             INTEGER PRIMARY KEY,
  repo_id        INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,           -- repo-relative
  lang           TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  last_run_id    INTEGER REFERENCES runs(id),
  UNIQUE (repo_id, path)
);
CREATE INDEX idx_files_hash ON files(repo_id, content_sha256);

-- ============================================================
-- Identity: ONE node table. Everything anchors here.
-- ============================================================
CREATE TABLE nodes (
  id      INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN
            ('service','route','symbol','file','external','datastore','config')),
  key     TEXT NOT NULL,                  -- canonical, stable, human-readable
  repo_id INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  UNIQUE (kind, key)
);
CREATE INDEX idx_nodes_repo ON nodes(repo_id, kind);

-- Detail tables: 1:1 with nodes, keyed BY node id. No parallel id space.
CREATE TABLE symbols (
  node_id             INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  file_id             INTEGER REFERENCES files(id) ON DELETE CASCADE,
  display_name        TEXT NOT NULL,
  symbol_kind         TEXT,               -- function|method|class|const|...
  signature           TEXT,
  doc                 TEXT,
  start_line          INTEGER,
  end_line            INTEGER,
  enclosing_node_id   INTEGER REFERENCES nodes(id),
  is_exported         INTEGER NOT NULL DEFAULT 0,
  is_test             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_symbols_file  ON symbols(file_id, start_line);
CREATE INDEX idx_symbols_encl  ON symbols(enclosing_node_id);

CREATE TABLE routes (
  node_id     INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  service     TEXT NOT NULL,
  method      TEXT NOT NULL,
  path_template TEXT NOT NULL,            -- '/api/v1/zoom/meeting'
  is_public   INTEGER,                    -- null = unknown
  request_schema  TEXT,                   -- JSON, from openapi/fastify schema
  response_schema TEXT
);
CREATE INDEX idx_routes_lookup ON routes(service, method, path_template);

-- ============================================================
-- Ordered execution chain per route. THE key table.
-- ============================================================
CREATE TABLE route_chain (
  route_node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  symbol_node_id INTEGER REFERENCES nodes(id),
  symbol_name    TEXT NOT NULL,           -- kept even if unresolvable
  phase          TEXT NOT NULL,           -- onRequest|preValidation|preHandler|handler|dependency|onError
  check_kind     TEXT,                    -- authn|authz|tenant|validation|ownership|rate_limit|other
  inherited_from TEXT,                    -- plugin/router context name
  run_id         INTEGER NOT NULL REFERENCES runs(id),
  PRIMARY KEY (route_node_id, position)
);
CREATE INDEX idx_route_chain_symbol ON route_chain(symbol_node_id);
CREATE INDEX idx_route_chain_check  ON route_chain(check_kind, route_node_id);

-- ============================================================
-- ONE edge table.
-- ============================================================
CREATE TABLE edges (
  id            INTEGER PRIMARY KEY,
  src_node_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst_node_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN
                  ('CONTAINS','CALLS','HANDLES','REQUESTS','READS','WRITES',
                   'CALLS_EXTERNAL','THROWS','READS_CONFIG')),
  confidence    TEXT NOT NULL CHECK (confidence IN
                  ('certain','inferred','observed','unresolved')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN
                  ('scip','treesitter','semgrep','boot','otel','manual')),
  file_id       INTEGER REFERENCES files(id) ON DELETE CASCADE,  -- provenance owner
  line          INTEGER,
  detail        TEXT,                     -- error name, table name, sql shape...
  run_id        INTEGER NOT NULL REFERENCES runs(id),
  UNIQUE (src_node_id, dst_node_id, type, evidence_kind, file_id, line)
);
CREATE INDEX idx_edges_out ON edges(src_node_id, type, confidence);
CREATE INDEX idx_edges_in  ON edges(dst_node_id, type, confidence);
CREATE INDEX idx_edges_prov ON edges(file_id, evidence_kind);   -- incremental delete

-- Unresolved call sites: honest gaps, queryable.
CREATE TABLE unresolved_calls (
  id          INTEGER PRIMARY KEY,
  src_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line        INTEGER,
  raw_text    TEXT NOT NULL,              -- 'client[method](url)'
  reason      TEXT NOT NULL               -- dynamic_dispatch|computed_url|di|reflection
);
CREATE INDEX idx_unresolved_file ON unresolved_calls(file_id);

-- ============================================================
-- Runtime observations (Phase 2)
-- ============================================================
CREATE TABLE spans (
  id             INTEGER PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  span_id        TEXT NOT NULL,
  parent_span_id TEXT,
  service        TEXT NOT NULL,
  name           TEXT,
  route_node_id  INTEGER REFERENCES nodes(id),   -- via http.route
  symbol_node_id INTEGER REFERENCES nodes(id),   -- via code.function.name + code.file.path
  status_code    INTEGER,
  error_type     TEXT,                            -- exception.type
  error_message  TEXT,
  started_at     TEXT NOT NULL,
  duration_ms    REAL,
  attrs          TEXT                             -- JSON, trimmed
);
CREATE INDEX idx_spans_trace ON spans(trace_id, started_at);
CREATE INDEX idx_spans_route ON spans(route_node_id, status_code, started_at DESC);
CREATE INDEX idx_spans_error ON spans(error_type, started_at DESC);

-- ============================================================
-- Derived / cached. Regenerable. Never a source of truth.
-- ============================================================
CREATE TABLE summaries (
  node_id       INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_sha256  TEXT NOT NULL,            -- hash of exactly what was sent
  generated_at  TEXT NOT NULL
);

CREATE TABLE schema_version (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
```

**Twelve tables. Your v2 migration alone added roughly that many on top of an already-large v1.**

### H.1 Answers to your specific schema questions

**Primary keys.** Integer surrogate everywhere, with a `UNIQUE(kind, key)` natural key on `nodes`. Integer PKs keep the edge table narrow (two 8-byte columns instead of two long strings), which matters at millions of edges. The natural key keeps it debuggable — you can `SELECT * FROM nodes WHERE key LIKE '%createZoomMeeting%'` without joins.

**Symbol identity.** The SCIP symbol string. This is the answer to the question your v2 never resolved. It's stable across reindexes, comparable across repos for shared packages, and human-readable. Store it verbatim as `nodes.key` where `kind='symbol'`.

**Cross-repository relationships.** They're just edges — `nodes` has no repo constraint on edges, so a `REQUESTS` edge from a symbol in `40-syf-router` to a route in `51-syf-integration` is an ordinary row. This works *only* because node identity is global. Repo-scoped IDs would have made cross-repo edges impossible without a mapping table, which is a trap.

**Indexing.** The three edge indexes above cover 95% of queries: forward traversal, reverse traversal, and provenance deletion. Add `idx_route_chain_check` for security queries. Don't add more until you profile.

**Incremental updates.** Covered in F.4. The mechanism is `DELETE FROM edges WHERE file_id = ? AND evidence_kind = ?` followed by re-insert. `idx_edges_prov` exists purely for this.

**Is a relational model enough, or do you need a graph model?** Relational with recursive CTEs is enough at your scale, and here's the reasoning rather than an assertion: your traversals are **bounded-depth, typed and directed**. `endpoint_flow` is depth ≤ ~15 following `CALLS`. `impact` is depth ≤ ~5 reverse `CALLS`. Neither is "find all paths between arbitrary nodes", which is where SQL falls apart. A recursive CTE with a depth cap and a visited-set (via `UNION` rather than `UNION ALL`) handles this in milliseconds on an indexed edge table.

**When would SQLite actually become the bottleneck?**
- Unbounded-depth or all-paths queries → you need a real graph engine.
- Graph algorithms (PageRank, community detection, centrality) → SQL is the wrong tool.
- Concurrent multi-writer indexing → SQLite serialises writes. Fine for one indexer process; not fine if six developers' machines write to a shared file.
- Beyond roughly 10M edges, recursive CTE latency starts to be noticeable on wide fan-out nodes.

Your three services are nowhere near any of these. **And critically: the obvious upgrade path is currently broken.** Kùzu — the embedded, Cypher-speaking, SQLite-shaped graph DB everyone would have recommended — was archived in October 2025 after an Apple acqui-hire, with the community left choosing between four unfunded forks. If you outgrow SQLite, the realistic escape hatches are (a) keep SQLite as the fact store and load a subgraph into an in-memory graph library per query, or (b) move to Postgres with recursive CTEs, or (c) accept an operational dependency on Neo4j/FalkorDB. Option (a) is almost certainly what you'd do, and it doesn't require changing your schema at all.

**Concurrent access.** WAL mode: many readers, one writer. Indexing runs on one machine (CI or a dev's laptop) and produces a `.db` file that's read by everyone. If you want a shared instance, put the DB behind a small HTTP/MCP service rather than sharing a file over a network mount — SQLite over NFS is a well-known way to corrupt a database.

### H.2 What went wrong in `software-intelligence-migration-v2.sql`

Direct, because you asked:

**1. Three parallel edge tables.** `edges` (symbol→symbol), `graph_edges` (node→node), and now `symbol_resource_edges` (symbol→node). The comment on FIX-002 is an admission: *"the typed `edges` table stays symbol-to-symbol (P-1); these four enum values are deprecated for symbol-to-symbol use and are canonical here."* You have deprecated enum values inside a CHECK constraint you can't change, with a third table created to route around it. That isn't a schema; it's a schema that already broke and got patched twice.

**2. Two identity systems.** `symbols.id` and `graph_nodes.id`, bridged by `symbols.graph_node_id`. Rule P-3 — *"every new codebase entity anchors on graph_nodes"* — is the right instinct arriving one version too late. Anchoring on `graph_nodes` was correct; keeping `symbols.id` as a parallel key was the error, and every join in the file pays for it. Look at the NEURAL-006 example query: it has to do `(SELECT id FROM symbols WHERE graph_node_id = :node_id)` as a subquery in three separate CTEs.

**3. No stable symbol identity.** `qualified_name` is not a key. It isn't unique across repos, it isn't stable across refactors, and it can't join a TypeScript symbol to anything. Without a canonical symbol string, incremental indexing degenerates into "delete everything for this file and hope nothing pointed at it," and cross-repo edges are unrepresentable. **This is the single root cause.** Everything else is downstream.

**4. Twenty-eight relationship types, zero extractors.** `CALLS` vs `INVOKES`. `WRITES` vs `PERSISTS_TO`. `PRODUCES` vs `PUBLISHES_TO`. `DEPENDS_ON` as a documented catch-all ("Generic dependency"). These are synonyms and placeholders. A vocabulary this size before a single extractor exists is a sign the schema was written from the requirements document rather than from real extractor output.

**5. The "neural layer" is built on data you cannot produce.** `entity_associations` with `decay_rate`, `association_types` including `co_debugged` and `co_incident`, `navigation_events` with `actor_type IN ('human','agent')`, four levels of embeddings plus structural embeddings. `co_debugged` requires a debugging-session capture pipeline. `co_incident` requires incident tooling integration. `navigation_events` requires a UI that doesn't exist yet. You designed the memory system for a brain that has no eyes.

To be fair: `co_changed` from git history is genuinely valuable, cheap, and would be a great Phase-3 feature. It's one table and one `git log` parser. The other five association types are speculative.

**6. `derivation_metadata` is unenforceable.** `PRIMARY KEY (derived_table, derived_row_id)` is a polymorphic reference SQLite cannot constrain. Delete a row from `symbol_embeddings` and the metadata row silently orphans. What you actually wanted — "is this derived row stale?" — is one `input_sha256` column on each derived table, compared against a recomputed hash. That's what I've used for `summaries` above.

**7. The temporal columns are dead on arrival.** `ALTER TABLE edges ADD COLUMN valid_from TEXT NOT NULL DEFAULT ''` means every pre-existing row has `valid_from = ''`, so `idx_edges_temporal` is useless for all historical data from the moment it's created. More fundamentally: **git already stores your history.** Bitemporal edge validity is a serious modelling commitment that buys you nothing you can't get from `runs.commit_sha` plus re-indexing an old commit if you ever need to.

**8. Two confidence vocabularies with a lossy bridge.** `symbol_responsibilities.confidence` is REAL; everything else uses the four-value TEXT enum; the migration maps `>= 0.9 → 'exact'`. A heuristic that scored 0.91 is not exact. That mapping actively destroys the fact/inference distinction the enum exists to preserve.

**9. Vocabulary-enforcement triggers cost you on every insert.** `trg_graph_edges_relationship_type_ins` runs a correlated subquery on every row. At a few hundred thousand edges that's the difference between a two-minute and a twenty-minute index. Validate the vocabulary in the application, or use a CHECK, not a trigger.

**10. The real problem is none of the above.** It's that **the schema was the deliverable.** 470 lines of carefully-reasoned DDL — versioned migration, provenance rules, re-runnability guards, a documented recall query — for tables whose producers don't exist. Every design decision in the file is defensible in isolation; collectively they describe a system nobody has proved can be populated.

The fix isn't a better schema. The fix is to write the extractor for **one endpoint** first, see what shape the data actually is, and let the schema be whatever that data needs. The schema in section H above is my best guess, and you should expect to change a third of it within two weeks of running a real indexer. **That's fine.** A schema that survives contact with real extractor output unchanged is a schema that was over-designed.

---

## I. Query engine

Six query types. All of them are recursive CTEs plus ranking — no query language, no NL→Cypher, no LLM in the loop.

### I.1 Endpoint flow

```
POST /api/v1/zoom/meeting on 40-syf-router
```

1. Resolve the route node: `routes WHERE service=? AND method=? AND path_template=?`.
2. Read `route_chain` ordered by `position` → the exact, boot-verified sequence of hooks and the handler, each with `phase` and `check_kind`.
3. From the handler symbol, recursive CTE over `edges WHERE type='CALLS'`, depth-capped (start at 12), carrying `confidence` and accumulated path.
4. Terminate expansion at nodes of kind `external`, `datastore`, or `route` (a `REQUESTS` edge to a remote route means "this hop leaves the process").
5. If the terminal is a remote route, recurse into *that* service's chain — this is what produces the cross-service flow.
6. Attach `unresolved_calls` rows for any symbol in the reachable set, rendered as explicit "unknown branch" nodes.

```sql
WITH RECURSIVE flow(node_id, depth, path, min_conf) AS (
  SELECT :handler_node_id, 0, ',' || :handler_node_id || ',', 'certain'
  UNION
  SELECT e.dst_node_id,
         f.depth + 1,
         f.path || e.dst_node_id || ',',
         CASE WHEN e.confidence = 'certain' AND f.min_conf = 'certain'
              THEN 'certain' ELSE 'inferred' END
  FROM flow f
  JOIN edges e ON e.src_node_id = f.node_id
  JOIN nodes n ON n.id = e.dst_node_id
  WHERE e.type IN ('CALLS','REQUESTS','READS','WRITES','CALLS_EXTERNAL')
    AND f.depth < 12
    AND f.path NOT LIKE '%,' || e.dst_node_id || ',%'   -- cycle guard
)
SELECT * FROM flow;
```

The `min_conf` propagation matters: **a path is only as trustworthy as its weakest edge.** A flow that traverses one `inferred` hop must not be rendered as fact downstream of that hop.

### I.2 Impact analysis

Same CTE, reversed (`e.dst_node_id = f.node_id`, select `src`), then two projections:

- **Affected routes:** join the reachable set against `route_chain.symbol_node_id` and against `HANDLES` edges.
- **Affected services:** distinct `nodes.repo_id` over the reachable set.

Report **direct** (depth 1) separately from **transitive** (depth > 1), and separately again for `confidence != 'certain'` paths. "This change affects 47 endpoints" is useless; "this change directly affects 3 functions and 2 endpoints with certainty, and possibly 45 more through inferred paths" is actionable.

Extra dependency kinds you asked about, and how each is answered:
- **Configuration dependency:** `READS_CONFIG` edges on the reachable set.
- **Data dependency:** shared `datastore` nodes between two symbols' reachable sets.
- **Runtime dependency:** co-occurrence in the same `trace_id` in `spans` — this catches things static analysis missed entirely.

### I.3 Error investigation

Two independent passes, presented separately. Do **not** merge them into one confident answer.

**Static pass** — "what *could* produce a 500 here":
- Reachable set from the route's handler.
- Collect `THROWS` edges (uncaught error constructors).
- Collect `CALLS_EXTERNAL` and `READS`/`WRITES` — every external boundary is a failure candidate.
- Collect `READS_CONFIG` on the reachable set — missing/invalid config is a top real-world cause and is completely invisible to call-graph analysis alone.
- Rank by boundary depth (deepest external call first).

**Runtime pass** — "what *did* produce a 500 here":
```sql
SELECT error_type, COUNT(*) n, MAX(started_at) last_seen
FROM spans
WHERE route_node_id = :route AND status_code >= 500
GROUP BY error_type ORDER BY n DESC;
```
Then for the worst offender, walk the trace tree to the **deepest span with a non-OK status** — that's the origin. Its `code.function.name`/`code.file.path` attributes map it back to a symbol node, and its ancestors give you the propagation chain.

**Present these side by side.** "Statically, 6 things on this path can fail. In the last 7 days, 94% of 500s came from `ZoomApiError` originating in `zoomClient.createMeeting`, correlating with `ZOOM_CLIENT_SECRET` last modified 3 days ago." That second sentence is the product.

### I.4 Security analysis

```sql
SELECT position, symbol_name, phase, check_kind, inherited_from
FROM route_chain WHERE route_node_id = :route ORDER BY position;
```

That's it — one query, exact data, correct ordering. Then two derived views that are worth more than the flow diagram:

**Coverage matrix.** All routes × required check kinds:
```sql
SELECT r.node_id, ro.method, ro.path_template,
       MAX(rc.check_kind = 'authn')     AS has_authn,
       MAX(rc.check_kind = 'authz')     AS has_authz,
       MAX(rc.check_kind = 'tenant')    AS has_tenant,
       MAX(rc.check_kind = 'ownership') AS has_ownership
FROM routes ro
JOIN nodes r ON r.id = ro.node_id
LEFT JOIN route_chain rc ON rc.route_node_id = r.id
GROUP BY r.node_id;
```

**The anomaly query — the one that will actually find bugs:**
> "Show every route that reaches a `WRITES` edge but has no `tenant` check in its chain."

Absence of a check is a hard, reliable, statically-determinable signal. Presence of a *correct* check is not. Build the product around the former.

### I.5 AI context retrieval ("minimum context to modify `createZoomMeeting()`")

Budgeted BFS from the seed symbol, priority-ordered:

| Priority | Content | Why |
|---|---|---|
| 1 | Seed symbol: full source | You're modifying it |
| 2 | Direct callees: signature + doc only | You call them; you don't need their bodies |
| 3 | Direct callers: signature + call-site line | You must not break them |
| 4 | Route chain if reachable from a route | Auth/validation context |
| 5 | `datastore` + `external` + `config` edges | Side effects |
| 6 | Sibling symbols in the same file: names only | Local conventions |
| 7 | Type definitions referenced in the signature | Needed to write valid code |
| 8 | Cached summaries of ancestors (module/service) | Orientation |
| 9 | Tests referencing the seed | Contract |

Fill until the token budget is hit, then stop. Emit as TOON or compact JSON per your existing layering decision. Never include raw source for anything below priority 1 unless explicitly asked.

The measurable claim: full-repo context for `40-syf-router` is on the order of hundreds of thousands of tokens; a well-built context pack for one function is a few thousand. That ratio is the entire justification for the project, and it's the number you should measure and publish internally in week two.

### I.6 Workflow / user-story query

Be honest about what this is: **it is not a deterministic query.** "Approve a voucher" is natural language; the graph has no such node.

The correct implementation is a two-stage retrieval where only the first stage is fuzzy:
1. **Fuzzy:** FTS5 over route paths, symbol names, and cached summaries → candidate seed nodes, ranked. Optionally blend with embedding similarity.
2. **Deterministic:** for the top-k seeds, run I.1 (endpoint flow). The *paths* are exact; only the *choice of starting point* was fuzzy.

Show the user which seed was chosen and let them correct it. Do not let the LLM invent the graph.

---

## J. Runtime integration

**Yes — but as confirmation and completion, not as a parallel truth.**

**Standard:** OpenTelemetry, no serious alternative. Auto-instrumentation exists for Fastify and FastAPI.

**Ingest path:** OTLP receiver → tail-based sampling (keep 100% of errored traces, ~1% of successes) → write to `spans`. You do not need Jaeger or Tempo for this feature; you need spans in your own DB so you can join them to nodes. Run Jaeger separately if you want trace UIs.

**Join keys:**

| Span attribute | Maps to |
|---|---|
| `service.name` + `http.route` | `route` node — exact |
| `code.function.name` + `code.file.path` | `symbol` node — needs manual span attributes on key functions |
| `db.system.name` + `db.collection.name`/table | `datastore` node |
| `server.address` on client spans | `external` node, or a remote `route` node |
| `exception.type` / `exception.stacktrace` | error origin |

Note the `code.*` attributes went **stable in semconv v1.33.0** with a rename (`code.filepath` → `code.file.path`, `code.function` + `code.namespace` → `code.function.name`). Pin your semconv version and handle both spellings during migration.

**What runtime gives you that static analysis cannot:**
- Confirmation that an inferred `REQUESTS` edge is real (promote `inferred` → `observed`).
- Cross-service edges through dynamic base URLs, proxies and service discovery.
- DB operations through ORM abstraction layers.
- Actual error origins with stack traces.
- Which paths are hot vs which are dead code that merely exists.
- Discovery of edges no static analyser found — these are the *most* valuable rows in the table, because each one is a bug report about your static analysis.

**What runtime cannot give you:**
- Anything on a code path that wasn't executed.
- Intra-service function calls without manual instrumentation.
- Anything before you deployed the instrumentation.

**Design rule:** runtime never deletes a static edge. It *upgrades* one (`inferred` → `observed`) or *adds* one (`observed`, `evidence_kind='otel'`). A static edge with no runtime confirmation after 30 days is a useful signal — surface it as "possibly dead" — but not proof of anything.

**Sequencing:** this is Phase 2. It requires instrumented deployed services, which is a dependency outside your control. Do not let it block Phase 1.

---

## K. Visualisation

**Recommendation: React Flow + elkjs.**

Reasoning against the alternatives, tied to your actual requirements rather than popularity:

- Your section 9 requirement — click a function, see its contract, input/output schema, calls, throws, source location — means each node is a **rich, stateful, interactive component**. In React Flow a node is a React component, so this is a normal React problem. In Cytoscape.js (canvas) it's a popover you build and position yourself.
- Your success/failure/security-boundary colouring, cross-service grouping and confidence styling are CSS on a component in React Flow.
- Your graphs are **small by construction**. An endpoint flow is 10–60 nodes. An impact graph is 20–200. You are never rendering 50,000 nodes, because the entire point of the tool is to *not* show you the whole codebase. React Flow's DOM-rendering ceiling is irrelevant at this scale.
- React Flow ships no layout engine — you must add one. Use **elkjs** (`layered` algorithm) rather than dagre: your graphs are layered by nature (route → middleware → handler → service → repository → DB), elkjs handles ports and ordering constraints, and it's more configurable. Dagre is faster but less controllable.
- MIT licence. The OSS build renders a "Built with React Flow" attribution by default; removing it requires a Pro subscription, though the licence itself doesn't mandate attribution. For an internal tool this is a non-issue either way — just know it's there.

**Keep Cytoscape.js in your back pocket** for one specific case: a whole-system overview showing every symbol across all repos. If you build that view, it will be too big for React Flow and Cytoscape is the right tool for it. There's no harm in using both for different views.

**Also emit Mermaid.** Not for the UI — for PR comments, docs, and LLM consumption. A flow rendered as ~20 lines of Mermaid is a compact, model-readable representation of a path, and it costs you a serialiser function.

**Skip:** D3 (you'd be rebuilding React Flow), Graphviz (server-side rendering, no interactivity), vis-network (weaker React story), Sigma (WebGL you don't need at this scale).

**UI features, in order of value delivered per hour spent:**
1. Ordered route chain with `check_kind` badges — highest value, easiest to build
2. Node click → contract panel with source link
3. Confidence rendering (solid = certain, dashed = inferred, dotted = observed-only, red = unresolved)
4. Service-boundary grouping (elkjs compound nodes)
5. Expand/collapse by depth
6. Filter by repo / edge type / confidence
7. Runtime overlay (executed vs possible paths)

---

## L. AI integration — exactly where the LLM goes

**Permitted (five uses, all cached, all optional):**

1. **Function explanation.** One or two sentences from signature + body + callee names. Cache keyed on `input_sha256`. Regenerate only when the hash changes.
2. **Module/service summaries.** Bottom-up from function summaries. This is genuinely the only way to get "what does this service do" and it's cheap because it's hierarchical.
3. **Path narration.** Turn a retrieved flow into prose: "This endpoint authenticates via JWT, resolves the tenant, then calls the integration service." The *facts* come from the graph; the LLM only renders them.
4. **Seed selection for user-story queries** (I.6, stage 1) — and only stage 1.
5. **`check_kind` classification suggestions** — proposing that `assertVoucherOwner` is an `ownership` check. Output goes to a **human-reviewed config file**, not directly into the DB. Once classified, it's deterministic forever.

**Forbidden — with the specific failure mode for each:**

| Never use an LLM for | Because |
|---|---|
| Creating any edge | A hallucinated `CALLS` edge is indistinguishable from a real one and poisons every downstream query permanently |
| Determining route→handler mapping | Boot reflection is exact and free |
| Determining middleware order | Boot reflection is exact; the LLM will confidently invent a plausible order |
| Signatures, params, return types | The typechecker already knows |
| Impact analysis | It's a graph traversal; an LLM approximation of a traversal is strictly worse |
| Deciding whether an authz check is present | The single highest-stakes question in the system. Never probabilistic |
| Naming/inventing architectural components | Fine for a diagram (CodeBoarding does it well), poison in a queryable database |

**The rule, stated so it survives being read by a future you at 2am:** *the LLM may read the graph and may write prose. It may never write a row that another query will treat as fact.*

Enforce it structurally, not by discipline: LLM output lands only in `summaries`, which has no foreign keys used by any traversal. If the LLM can't reach `edges`, it can't corrupt them.

**Cost control.** Summaries are the only recurring LLM cost. A service with 2,000 functions summarised once is 2,000 small calls; incrementally, it's however many functions changed in a commit — typically single digits. Use a small model. This should cost cents per week.

---

## M. Error backtracking design

Split into three mechanisms with clearly different reliability, and never blend their outputs into a single confident answer.

### M.1 Static failure surface — "what could break"

For a route, over the reachable set:
- `THROWS` edges → declared error constructors
- `CALLS_EXTERNAL` → network failures, auth failures, rate limits
- `READS`/`WRITES` → constraint violations, deadlocks, missing rows
- `READS_CONFIG` → missing or malformed config
- `unresolved_calls` → **explicitly rendered as "unknown risk"**

Rank by boundary depth. This runs with zero runtime data and is available on day one.

### M.2 Trace-based root cause — "what did break"

Given a failed `trace_id`:
1. Build the span tree via `parent_span_id`.
2. Find the **deepest** span with error status — that's the origin, not the outermost 500.
3. Walk up: every ancestor is a propagation hop.
4. Map each span to a node via `code.*` / `http.route` / `db.*` attributes.
5. Render the chain against the static flow graph, highlighting the executed path.

This is where your "500 → createZoomMeeting → zoomClient.createMeeting → 401 from Zoom → invalid OAuth token" example actually becomes achievable — **every one of those hops is a span**, not a static inference. Statically you could never determine that Zoom returned 401.

### M.3 Correlation — "what changed"

Cheap and disproportionately useful:
- `git log` for files owning symbols on the failing path, filtered to since-first-occurrence of the error.
- `READS_CONFIG` nodes on the failing path, cross-referenced against config change timestamps if you have them.
- `co_changed` history: which files historically change together with the failing one.

### M.4 Presenting uncertainty

Three labelled sections. Never one merged verdict:

```
POST /api/v1/zoom/meeting — 500 analysis

OBSERVED (47 traces, last 24h)  ← highest confidence
  94%  ZoomApiError    origin: zoomClient.createMeeting:88   external: zoom
   6%  DbError         origin: meetingRepository.save:34     table: meetings

STATIC FAILURE SURFACE           ← possibilities, not evidence
  external  zoomClient.createMeeting  → zoom
  db        meetingRepository.save    → meetings (NOT NULL tenant_id)
  config    ZOOM_CLIENT_SECRET, ZOOM_BASE_URL
  throws    InvalidMeetingError @ validateMeeting:21
  UNKNOWN   1 unresolved call @ zoomClient.ts:44 (computed method name)

CORRELATED CHANGES               ← hypotheses, verify manually
  zoomClient.ts    modified 3d ago  (a1b2c3d, "refactor token refresh")
```

That last "UNKNOWN" line is the most important thing on the screen. A tool that silently omits what it couldn't analyse is worse than no tool, because it converts an unknown into a false negative.

---

## N. Impact analysis

### N.1 The core traversal

Reverse `CALLS` closure from the changed symbol, depth-capped, cycle-guarded. Then project onto routes (via `route_chain` and `HANDLES`) and onto services (via `nodes.repo_id`).

### N.2 Distinguishing dependency kinds

You asked for five. Here's how each is actually derived, and how reliable it is:

| Kind | Derivation | Reliability |
|---|---|---|
| **Direct** | depth = 1 reverse `CALLS` | High — compiler-resolved |
| **Indirect** | depth > 1 | High, but noisy: fan-out explodes on utility functions |
| **Runtime** | co-occurrence in the same `trace_id` in `spans` | Observed fact — catches what static analysis missed |
| **Configuration** | shared `config` node via `READS_CONFIG` | High |
| **Data** | shared `datastore` node between reachable sets | Medium — implies coupling, not causation |

### N.3 Two failure modes to design against

**Fan-out explosion.** `resolveTenant()` is called by everything. "Affects 200 endpoints" is technically true and operationally useless. Mitigations:
- Report depth-1 separately and prominently.
- Compute fan-in per symbol and flag high-fan-in nodes as "utility — expect broad impact" instead of listing 200 endpoints.
- Rank affected routes by runtime traffic from `spans` — 200 possible, 12 actually hit in the last week.

**False confidence.** An impact set built from `inferred` edges is a guess. Segment the output:
```
Changing resolveTenant():
  CERTAIN   3 direct callers, 2 endpoints
  INFERRED  11 transitive callers, 7 endpoints
  OBSERVED  4 of those 7 endpoints were hit in the last 7 days
  UNKNOWN   2 unresolved call sites reference a symbol named 'resolveTenant'
```

### N.4 The high-value variant

The most useful impact query isn't for a function — it's for a **git diff**. Take the changed lines from a PR, map them to enclosing symbols, run the closure, and post the affected endpoints as a PR comment. That's a 100-line GitHub Action on top of everything above, and it's the feature that makes the tool part of the team's workflow rather than a thing someone opens occasionally.

---

## O. MVP implementation plan

Ordered by *risk retired per unit of effort*, not by architectural tidiness. The UI is last on purpose: a beautiful graph of wrong data is worse than no graph, and building the UI first is the most common way this class of project dies.

### Phase 0 — Prove the pipeline (target: 1 week)

**One endpoint. One service. One language. No UI. No schema beyond what's needed.**

1. `scip-typescript index` on `40-syf-router`. If it OOMs or fails, **stop and fix that first** — everything downstream depends on it.
2. Parse the SCIP protobuf. Dump symbol count, occurrence count, and 20 random symbols. Eyeball them.
3. Derive `CALLS` edges via the enclosing-definition method. Manually verify ~20 against the source. **Measure your false-positive rate.** Write it down.
4. Register `fastify-overview`, boot the router, dump the JSON. Verify the hook chain for one real endpoint matches what you know is true.
5. Load both into a minimal SQLite schema.
6. A CLI that prints the ordered chain + call tree for `POST /api/v1/zoom/meeting`.

**Exit criterion:** the printed tree matches what a senior developer would draw by hand. If it doesn't, the rest of the project is built on sand — iterate here, not forward.

### Phase 1 — Useful to humans and agents (target: 3–4 weeks)

7. Add `scip-python` for `51-syf-integration`. Same pipeline.
8. FastAPI boot reflection (`app.routes` + `app.openapi()`).
9. Cross-service linker: tree-sitter for HTTP call sites → config resolution for base URLs → path-template matching (study `api-ghost-hunter`'s matcher). **Everything it produces is `inferred`. Log every non-match to `unresolved_calls`.**
10. Full schema from section H.
11. Incremental indexing on file hash. Test: change one file, confirm only its rows are replaced and nothing else moves.
12. Query engine: `endpoint_flow`, `impact`, `security_path`, `context_pack`.
13. **MCP server** exposing those four as tools.
14. Semgrep/Opengrep rules for `check_kind` classification.

**Exit criterion:** an agent in your existing orchestration setup can call `context_pack('createZoomMeeting')` and get a materially smaller, materially better context than dumping files. **Measure the token delta.** This is the number that justifies the project to anyone who asks.

### Phase 2 — Visualisation and runtime (target: 3–4 weeks)

15. React Flow + elkjs UI: endpoint flow, node inspector, confidence styling, service grouping.
16. OTel instrumentation on the three services (`http.route` comes free; add `code.*` attributes to key functions manually).
17. OTLP receiver → `spans` table, tail-sampled on errors.
18. Runtime overlay on the UI; promote `inferred` → `observed`.
19. Error backtracking (M.1 + M.2 + M.3).
20. GitHub Action: PR diff → impact comment.

### Phase 3 — Depth (open-ended)

21. `co_changed` from git history — the one association type from your v2 that's genuinely worth building.
22. LLM summaries, hierarchical, cached.
23. FTS5 + optional embeddings for user-story seeding.
24. Optional Joern/Opengrep side-car for specific data-flow questions.
25. Additional languages (the SCIP indexer ecosystem covers Go, Java, Rust, C#, Ruby, C/C++).

### O.1 The discipline that makes this finish

Given the size of the design space, three rules:

- **Nothing enters the schema until an extractor produces it.** No speculative tables, no placeholder relationship types. If you can't populate it this week, it doesn't exist.
- **Every phase ends in something usable.** Phase 0 ends with a CLI you'd actually run. Phase 1 ends with a tool your agents use daily. If a phase would end with "and then Phase N+1 makes it useful", the phase is wrong.
- **Timebox Phase 0 hard.** If SCIP parsing plus call derivation isn't producing a believable tree in a week, the answer isn't more design — it's to fork blarify after all and accept a Python service in your stack.

---

## P. Example end-to-end: `POST /api/v1/zoom/meeting`

### 1. Indexing

```
$ scip-typescript index                      # in 40-syf-router
  → index.scip (protobuf)
$ node scripts/boot-dump.js                  # boots router with fastify-overview
  → overview.json
$ scip-python index . --project-name=51-syf-integration
  → index.scip
$ python scripts/fastapi_dump.py
  → routes.json + openapi.json
```

### 2. Normalisation → nodes

```
nodes
  id  kind        key
  1   service     40-syf-router
  2   route       40-syf-router|POST|/api/v1/zoom/meeting
  3   symbol      scip-typescript npm syf-router 1.0.0 `src/hooks/auth.ts`/authenticateRequest().
  4   symbol      ... `src/hooks/tenant.ts`/resolveTenant().
  5   symbol      ... `src/hooks/authz.ts`/authorizeMeetingCreation().
  6   symbol      ... `src/controllers/zoom.ts`/createMeetingHandler().
  7   symbol      ... `src/services/zoom.ts`/createZoomMeeting().
  8   symbol      ... `src/services/zoom.ts`/validateMeeting().
  9   symbol      ... `src/clients/zoom.ts`/zoomClient.createMeeting().
  10  route       51-syf-integration|POST|/zoom/meetings
  11  symbol      scip-python python 51-syf-integration ... zoom/router.py/create_meeting().
  12  external    zoom
  13  datastore   pg:public.meetings
  14  config      40-syf-router|INTEGRATION_BASE_URL
```

### 3. Facts

From **boot** (`certain`):
```
route_chain (route=2)
  pos phase           symbol              check_kind
  0   onRequest       3  authenticateRequest   authn
  1   preHandler      4  resolveTenant         tenant
  2   preHandler      5  authorizeMeetingCreation  authz
  3   preValidation   -  ajv:zoomMeetingSchema validation
  4   handler         6  createMeetingHandler  -
edges: 6 HANDLES 2 (certain, boot)
```

From **SCIP** (`certain`):
```
6 CALLS 7   7 CALLS 8   7 CALLS 9
```

From **tree-sitter + config** (`inferred`):
```
9  REQUESTS 10       (inferred, treesitter — axios.post(`${baseURL}/zoom/meetings`))
9  READS_CONFIG 14   (certain, treesitter)
7  WRITES 13         (inferred, treesitter — meetingRepository.save)
8  THROWS 'InvalidMeetingError' (inferred)
9  THROWS 'ZoomApiError'        (inferred)
```

From **scip-python + boot** (`certain`):
```
11 HANDLES 10        11 CALLS_EXTERNAL 12
```

### 4. Query

```
$ syfgraph flow --service 40-syf-router --method POST --path /api/v1/zoom/meeting
```

```
POST /api/v1/zoom/meeting                        [40-syf-router]
│
├─ [0] onRequest      authenticateRequest()      AUTHN      ✓ boot
├─ [1] preHandler     resolveTenant()            TENANT     ✓ boot
├─ [2] preHandler     authorizeMeetingCreation() AUTHZ      ✓ boot
├─ [3] preValidation  ajv:zoomMeetingSchema      VALIDATION ✓ boot
│
└─ [4] handler        createMeetingHandler()               ✓ scip
       └─ createZoomMeeting()                              ✓ scip
          ├─ validateMeeting()                             ✓ scip
          │  └─ throws InvalidMeetingError                 ~ inferred
          ├─ WRITES pg:public.meetings                     ~ inferred
          └─ zoomClient.createMeeting()                    ✓ scip
             ├─ reads INTEGRATION_BASE_URL                 ✓ scip
             ├─ throws ZoomApiError                        ~ inferred
             └─ POST /zoom/meetings ──────────► [51-syf-integration]  ~ inferred
                                                └─ create_meeting()    ✓ scip
                                                   └─ CALLS_EXTERNAL zoom  ✓ scip

  ✓ certain (4 boot, 8 static)   ~ inferred (5)   ○ unresolved (0)
```

### 5. Visualisation

Same data, React Flow: three service swim-lanes (elkjs compound nodes), security chain rendered as a distinct band with `check_kind` badges, solid edges for `certain` and dashed for `inferred`, clicking `createZoomMeeting` opening a panel with signature, params, return type, callees, throws, source link, and the cached one-line summary.

### 6. Explanation (only here does the LLM appear)

The graph subset above is serialised compactly and sent with: *"Explain in two sentences what this function does. Use only the provided facts."* Result cached against the input hash.

### 7. Context pack

```
$ syfgraph context createZoomMeeting --budget 4000
```
Returns: full source of `createZoomMeeting`; signatures of `validateMeeting` and `zoomClient.createMeeting`; the route chain that leads to it; the `meetings` table shape; `INTEGRATION_BASE_URL`; the two error types; the caller's call-site line. Roughly 1.5k tokens versus roughly 200k for the repo.

---

## Q. Risks and limitations

### Q.1 What static analysis cannot determine — be explicit in the UI, not just the docs

| Construct | Effect | Mitigation |
|---|---|---|
| **Dynamic dispatch / HOFs** | `handlers[key]()` unresolvable | Record in `unresolved_calls`; render as explicit unknown branch |
| **Dependency injection** | Container-resolved targets invisible | Boot reflection where the framework exposes it; otherwise unresolved |
| **Runtime-registered routes** | Loop-generated routes invisible statically | Boot reflection solves this completely |
| **Computed URLs** | `` `${base}/${resource}/${id}` `` | Partial template matching; confirm via OTel; else unresolved |
| **Config-dependent base URLs** | Same code points at different services per env | Index config per environment; store env on the edge. **This is the #1 source of wrong cross-service edges** |
| **Monkey patching / decorators that rewrite** | Graph doesn't match execution | Runtime traces only |
| **Dynamic SQL** | Table unknown | tree-sitter on literals; `db.*` span attributes for the rest |
| **Feature flags** | Path exists but is never taken | Runtime traffic marks it cold |
| **`async`/promise error propagation** | Rejection paths not lexically visible | Runtime traces |
| **Global error handlers** | The 500 is produced far from its cause | Trace tree gives the real origin |

### Q.2 The five hardest problems, ranked

**1. Cross-service edge accuracy.** The whole product hinges on it and it is irreducibly probabilistic. `axios.post(\`${process.env.INTEGRATION_URL}/zoom/meetings\`)` requires resolving an env var to a service, and that mapping differs per environment. You will get false positives (matching the wrong service) and false negatives (missing computed paths). **Mitigation:** always mark these `inferred`; promote to `observed` only via OTel; maintain a small hand-written service-URL map as the highest-priority resolution source; make `unresolved_calls` visible in the UI so gaps are known rather than silent.

**2. `THROWS` is much weaker than your section 9 implies.** Your example function card lists `Throws: InvalidMeetingError, ZoomApiError`. TypeScript has no checked exceptions and no `throws` in the type system, so this cannot come from types. You can extract `throw new X()` from a function body with tree-sitter, and transitively union callees' throws — but that union explodes within two or three levels, ignores `catch`, and misses everything thrown by libraries. **Set expectations: `THROWS` is a "declared locally" list, always `inferred`, never complete.** The trustworthy error data is in traces.

**3. Authorization correctness is out of scope and must be said so.** You can determine which checks run in what order. You cannot determine whether `requireRole('admin')` should have been `requireRole('owner')`, or whether an ownership check compares the right IDs. Static BOLA detection is an open research problem. **Frame the feature as coverage and anomaly detection**, and make the flagship query "routes that write data with no tenant check" rather than "this endpoint is secure".

**4. Call-graph precision in TypeScript.** SCIP occurrences over-approximate: type-position references, re-exports and barrel files all look like references. Interface method calls resolve to the declaration, not implementations. Expect to spend real time on filters. **Measure your false-positive rate in Phase 0 and track it.** If it's above ~10% on a manual sample of 50, the graph will feel untrustworthy and people will stop using it.

**5. Keeping the boot channel honest.** Boot reflection is exact *for the configuration it was run under*. If someone adds a route behind an env flag that's off in your dump environment, it's invisible. **Mitigation:** run the boot dump in CI against a config as close to production as possible, and diff route sets between environments — that diff is itself a useful artifact.

### Q.3 Project-level risks

**Scope.** Your brief describes at least three products: a code intelligence engine, a security analysis tool, and an AI context system. Each is a real product. The MVP boundary in section O exists to keep you from building all three at once. If Phase 1 slips past six weeks, cut scope rather than extending.

**Building the UI first.** The most attractive part is a beautiful interactive graph. It is also the part that teaches you nothing about whether your data is correct. Phase 0 deliberately ends with a CLI.

**Schema-first design — the specific failure that produced v2.** 470 lines of DDL for tables with no producers. The countermeasure is mechanical: **no table without an extractor that populates it this week.** Expect to change a third of the section-H schema once real data hits it; that's the schema working, not failing.

**Dependency health.** SCIP's governance move to an independent steering committee in March 2026 is a genuine positive. But `scip-typescript` and `scip-python` are small projects; if one stalls, you fall back to LSP `callHierarchy` (slower, same accuracy) — keep that path in mind, and keep the SCIP parser behind an interface so a second implementation can be dropped in.

**Storage churn in the ecosystem.** Kùzu's October 2025 archival is a warning about betting on young infrastructure. SQLite is the boring, correct choice here and it should stay boring. Resist the urge to "upgrade" the storage layer before you have a measured problem.

---

## Summary

| Question | Answer |
|---|---|
| Does this exist? | **No.** Every layer exists in pieces; the composition does not. |
| Extend or build? | **Build a thin custom layer.** Reuse all extractors. Fork nothing. |
| Closest prior art | **blarify** (substrate), **api-ghost-hunter** (cross-service matching) — study both, own neither |
| Biggest correction to your plan | **Routes, middleware and auth chains come from boot-time reflection, not static analysis** |
| Root cause of the v2 failure | **No stable symbol identity**, plus a schema designed before any extractor existed |
| Storage | **SQLite, single edge table, single node table.** No graph DB. |
| Ruled out | **CodeQL** (licence prohibits private commercial codebases), **Kùzu** (archived Oct 2025) |
| LLM role | Summaries and narration only. Never writes a row a query treats as fact. |
| First milestone | One endpoint, one service, a CLI, one week |
| Realistic custom code | 3,000–5,000 lines |
