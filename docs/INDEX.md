# Documentation Index

---

## Session Start (Essential - ~800 tokens)

- `CLAUDE.md` (~450 tokens)
- `.claude/COMMON_MISTAKES.md` (~350 tokens)
- `.claude/QUICK_START.md` (~100 tokens)
- `.claude/ARCHITECTURE_MAP.md` (~150 tokens)

## Plan of record (load when picking up a task)

- `plans/code-intelligence-engine-plan-v2.md` — 78 requirements, 44 tasks, 4 phases,
  9 open decisions. **§4 Tasks by Phase** is the working section; **§6 Open
  Decisions** lists what is still unresolved. Large — load the section you need, not
  the whole file.

## Source of truth (load only when a requirement is ambiguous)

- `docs/code-intelligence-engine.md` — the research verdict the plan implements.
  1,223 lines. Section map:
  - **§A** problem decomposition — why routes/middleware are a *boot* problem
  - **§F** indexing strategy (SCIP, tree-sitter, boot reflection, incremental)
  - **§G** graph model — 7 node kinds, 9 edge types, `route_chain`
  - **§H** SQLite schema + a post-mortem of the v2 schema failure
  - **§I** the six query types
  - **§L** where the LLM is allowed and where it is forbidden
  - **§M** error backtracking
  - **§Q** risks, and what static analysis cannot determine

## Task-Specific Topics (Load As Needed)

Add topic files in `docs/learnings/` and list them here.

---

**Last Updated**: 2026-09-06
