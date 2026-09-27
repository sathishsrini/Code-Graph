# Goal — CodeGraph as the context source for Claude

**Owner:** Sathish · **Confirmed:** 2026-09-27 · **Plan:** [`plans/claude-context-plan.md`](plans/claude-context-plan.md) · **Status:** [`plans/claude-context-tracker.md`](plans/claude-context-tracker.md)

## The goal, as written

> I want CodeGraph to be where Claude and other AI tools get their context.
> Instead of reading files before planning or changing code, they should ask the
> graph for the whole workflow and use fewer tokens. It should also trace API
> errors back to their cause and help developers see how API calls connect.
> Today it only works at the API level. I want the infrastructure and
> database/model parts of the flow covered too.

"CodeGraph" here means this repository's engine, `code-intel`
(`sathishsrini/Code-Graph`). It does not mean the separate Rust CodeGraph project
whose build output sits in the git-excluded `vscode/` folder.

## What it means — confirmed requirement by requirement

| # | Requirement | Decided |
|---|---|---|
| G1 | Claude Code (CLI and the VS Code extension panel) gets its context from the graph over MCP. Other AI tools come later and are not named. | ✔ |
| G2 | The MCP server is registered at **user scope**. A "query the graph first" instruction and a **non-blocking** reminder hook live at user level and are active **only in folders listed in `config/repos.json`**. Target repos are not modified for this. | ✔ |
| G3 | Three questions the graph answers: **endpoint flow** (route → chain → calls → services → tables), **feature by description** (words → matching routes/functions → their flow), **edit context** (what you need before changing a function). | ✔ |
| G4 | The graph replaces *exploratory* reading. Claude still reads the exact lines it edits, because Claude Code's edit tool requires a read first. | ✔ |
| G5 | Token proof. A deterministic benchmark is the gate: per question, graph answer + files still needed < reading the files, **and** every required fact is present. A live A/B runs as a sanity check: 3 questions × 1 run each way. | ✔ |
| G6 | API error tracing from **OTel traces**: the code origin (service, function, line, error type, path) and **correlated recent changes (required)**. Claude can ask for it over MCP, and developers see it in the web UI. | ✔ |
| G7 | The existing web UI shows how API calls connect: **service → service**, **frontend → backend**, **API → tables**. | ✔ |
| G8 | Database layer: **tables and columns** from SQL migrations, with SQL reads and writes linked to them. **No ORM.** | ✔ |
| G9 | API data models (Pydantic / zod request and response schemas), in scope now, linked **through the route** (route → model, route → tables). No field-to-column guessing. | ✔ |
| G10 | Python call tree: run `scip-python` in WSL **Ubuntu-24.04**. The owner runs one `sudo apt install`; everything else runs without sudo. | ✔ |
| G11 | Infrastructure (Docker, k8s, Terraform, queues) goes into the plan as **later slices**, specified but not built. | ✔ |
| G12 | Test on the fixture corpus first, then use on the real `syf-*` services. The `syf-*` onboarding is a placeholder slice until their path is given. | ✔ |
| G13 | Jev (TypeSafe) is a **development-time** reviewer and gate only. The engine never calls it at runtime. | ✔ |

## Approved actions

- Build the corpus graph: `scip index`, `boot dump` and `index`.
- `pip install -r requirements.txt` into `51-integration`'s Windows venv.
- `git init` the four corpus repos. The baseline commit excludes `.env*`,
  `node_modules`, `.venv`, `__pycache__`, `.next` and logs. The test change is a
  comment-only commit inside the failing function.
- Start the corpus services, the OTLP receiver and generated traffic. The corpus
  database exists in the local Postgres.
- Edit the user-level Claude config (`claude mcp add --scope user`, hooks in
  `~/.claude/settings.json`).
- Run headless `claude -p` for verification and for the live A/B.

## Working rules

- Base branch `feat/workflow-context-slices` at `5f9b525`.
- Thin vertical slices. Each one goes: failing test → fix → typecheck plus
  filtered tests → Jev gate → one local commit with its slice ID. No push unless
  the owner asks.
- Never read `.env` files. The repo rules in [`CLAUDE.md`](CLAUDE.md) and
  [`.claude/COMMON_MISTAKES.md`](.claude/COMMON_MISTAKES.md) apply unchanged.

## Known limits, accepted up front

- Claude decides when to call the graph. The steering nudges it but cannot force it.
- Error tracing on `syf-*` needs those services instrumented, which is outside this
  engine's control (plan v2 OPEN-7).
- Token savings are proven per question by the benchmark, not promised in general.
- The Python call tree depends on the WSL route working.
