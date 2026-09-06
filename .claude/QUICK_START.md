# Quick Start Commands

---

## Development

```bash
npm install                 # first time only
npm run typecheck           # tsc --noEmit (this is also `npm run lint`)
npm test                    # node --test tests/
node src/cli.ts --help      # CLI entry (Node 25 runs .ts natively, no flag)
```

**No build step.** Node >=22.6 strips types at run time, so `src/*.ts` executes
directly. `tsconfig.json` sets `erasableSyntaxOnly`, which keeps the source runnable —
no enums, no parameter properties, no namespaces.

## Engine workflow

```bash
node src/cli.ts db bootstrap            # create .codeintel/graph.db (WAL, FK on)
node src/cli.ts db bootstrap --reset    # drop and recreate
node src/cli.ts index --config config/repos.json
node src/cli.ts flow --service 40-kri-router --method POST --path /api/v1/po
node src/cli.ts context <symbol> --budget 4000
```

## Token discipline

```bash
npm run audit:tokens        # npx claude-token-optimizer audit --json
```

Runs in CI on every push and PR — see `.github/workflows/ci.yml`.

## Git workflow

One commit per completed plan task, tagged with the task ID:

```bash
git commit -m "feat(P0-T5): minimal SQLite schema + bootstrap"
```

Prefixes: `feat` new capability · `fix` · `chore` scaffolding · `docs` · `test` ·
`refactor`. Always name the task ID (`P0-T1` … `P3-T5`) so history maps onto
`plans/code-intelligence-engine-plan-v2.md`.

## Prerequisites not yet installed

```bash
npm i -g @sourcegraph/scip-typescript   # P0-T3
pip install scip-python                 # P1-T3 — needs a 3.11/3.12 venv, see OPEN-5
```

`scip`, `scip-typescript`, `scip-python` and `semgrep` are **not** on PATH yet.
`python3` is also unavailable (only `python`, 3.14) — the `.claude/hooks/` scripts all
invoke `python3` and will silently no-op until that is fixed.

---

**Last Updated**: 2026-09-06
