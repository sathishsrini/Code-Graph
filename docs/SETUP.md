# Setting up code-intel on another machine

How to get this engine running from git on a fresh machine: clone, install, point it
at the code to analyse, build the graph, open the viewer, and (optionally) connect
Claude Code. Verified against branch `feat/workflow-context-slices` on 2026-09-28.

---

## 0. What git brings over, and what it does not

| Thing | In git? | On the new machine |
|---|---|---|
| Engine source, tests, docs, `config/repos.json` | ✅ yes | comes with `git clone` |
| `node_modules/` | ❌ | `npm install` (step 3) |
| **The code you analyse** (the corpus under `D:/###facilitator/dev-workspace`, later `syf-*`) | ❌ **not in this repo** | copy or clone it separately (step 4) |
| The built graph `.codeintel/` (graph, SCIP indexes, boot dumps) | ❌ gitignored | rebuild it (step 5) |
| `.env` (holds `jev-key`) | ❌ gitignored | create from `.env.example` only if you use Jev (step 8) |
| Your Claude Code wiring (MCP server + hooks in `~/.claude`) | ❌ per machine | `npm run claude:install` (step 7) |

---

## 1. Prerequisites

| Tool | Version | Why | Check |
|---|---|---|---|
| **git** | any recent | clone and update | `git --version` |
| **Node.js** | **22.18+** (or 23.6+). Tested here on 25.6.1; CI runs 22.x | runs the `.ts` sources directly, with no build step. `package.json` says `>=22.6`, but 22.6–22.17 need `--experimental-strip-types` to run `.ts` files | `node --version` |
| **scip-typescript** | global npm install | the TS/JS indexer; the engine calls it by name, so it must be on `PATH` | `scip-typescript --version` |
| **Python 3.11 / 3.12** | per Python service | boots the FastAPI service (`boot dump`) and runs `scip-python` | `python --version` |
| **Claude Code CLI** | optional | only to connect Claude (step 7) | `claude --version` |

Install the TS indexer once:

```bash
npm install -g @sourcegraph/scip-typescript
```

`scip-python` is **not** installed globally. It comes with this repo's dev
dependencies, and `npm install` patches it for Windows (`scripts/patch-scip-python.mjs`).

---

## 2. Clone

```bash
git clone https://github.com/sathishsrini/Code-Graph.git code-intel
cd code-intel
git checkout feat/workflow-context-slices   # the branch the current work is on; main is older
```

The repository may be private. If so, sign in to GitHub first (`gh auth login`, or a
credential manager).

---

## 3. Install and prove the engine works

```bash
npm install
npm run typecheck
npm test 2>&1 | grep -E '^(ℹ (tests|pass|fail)|✖)'
```

Expect `fail 0`. The test suite needs **neither** the corpus nor a built graph, so run
this before anything else. If it is red here, the problem is the machine, not your
data. (2026-09-28: 667/667 on Windows.)

---

## 4. Point it at the code to analyse

The analysed code is **not** in this repo. Put it on the new machine, by copying the
folder or by cloning its own repositories, then tell the engine where it is.

**a) Edit `config/repos.json`.** Every `rootPath` is absolute and machine-specific (today
`D:/###facilitator/dev-workspace/<repo>`). Change each one to where the code now lives.
Also change `pythonBin` for Python services: it is the *indexing* interpreter, usually
that service's own venv.

```jsonc
{
  "name": "40-kri-router",
  "rootPath": "/home/you/dev-workspace/40-kri-router",   // was D:/###facilitator/…
  ...
},
{
  "name": "51-integration",
  "pythonBin": "/home/you/dev-workspace/51-integration/.venv/bin/python",
  ...
}
```

If you keep exactly the same folder layout on the new machine (same drive and path),
there is nothing to edit.

> This edit is machine-local. Don't commit it unless the new layout should become
> everyone's default.

**b) Install each analysed service's own dependencies.** `boot dump` starts each
service's code far enough to read its routes (without opening a port), so those
services need their packages:

```bash
# Node services (Fastify, Next.js)
cd <workspace>/40-kri-router && npm install
cd <workspace>/41-kri-engine && npm install
cd <workspace>/60-kri-next  && npm install

# Python service: a venv with its requirements (this is what `pythonBin` points at)
cd <workspace>/51-integration
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
# .venv/bin/python -m pip install -r requirements.txt     # Linux / macOS
```

On the original machine, `51-integration`'s venv had **only `pip`**. That is why its
boot failed and it showed 0 routes. Install the requirements.

**c) Validate the config:**

```bash
node src/cli.ts config check
```

Every repo should resolve. A wrong `rootPath` fails here with the path named.

---

## 5. Build the graph

One command does every channel for every repo: `scip index`, `boot dump`, `index`,
then the search index.

```bash
node src/cli.ts db bootstrap
node src/cli.ts build
```

`build` reports each channel per repo, and **exits 1 if any channel failed**, naming
which one. It still indexes whatever succeeded. The output lands in `.codeintel/`.
Rebuild only one repo with `--repo <name>`. After code changes, `node src/cli.ts index`
is incremental; add `--force` to recompute everything.

**Known on Windows today:** `scip-python` may write an **empty** index for the Python
service (`Python was not found`), so that service then has routes but no call tree. It
works on Linux (recorded in the tracker). Slice CTX-S4 covers running it through WSL.

---

## 6. Use it

```bash
# The graph viewer (web UI) — then open http://127.0.0.1:7777
node src/cli.ts ui                     # add --port <n> for another port

# The same questions from the terminal
node src/cli.ts flow --repo 40-kri-router --method POST --path /api/v1/po
node src/cli.ts impact checkUserAuth
node src/cli.ts context checkUserAuth --measure
node src/cli.ts tables
node src/cli.ts security --repo 41-kri-engine
```

> **Git Bash on Windows rewrites arguments that start with `/`.** `--path /api/v1/po`
> reaches Node as `C:/Program Files/Git/api/v1/po`, and `flow` answers "no route".
> In Git Bash, prefix the command with `MSYS_NO_PATHCONV=1` (e.g.
> `MSYS_NO_PATHCONV=1 node src/cli.ts flow … --path /api/v1/po`), or run it from
> PowerShell or cmd, which leave it alone. Both were checked on 2026-09-28.

A quick health check of the viewer, once it runs:

```bash
curl -s http://127.0.0.1:7777/api/routes | head -c 300
```

The viewer only serves `127.0.0.1`. It is not reachable from other machines.

---

## 7. Connect Claude Code (optional)

This registers the graph as an MCP server **at user scope**, plus a non-blocking
"ask the graph first" hook. Claude Code's CLI and its VS Code extension share this
configuration.

```bash
npm run claude:install    # backs up ~/.claude/settings.json first; safe to re-run
claude mcp list           # expect:  code-intel: node <this checkout>/src/cli.ts mcp --db … - ✓ Connected
npm run claude:status     # hooks, MCP registration, graph db, indexed folders
```

- The registration stores **absolute paths to this checkout** and its
  `.codeintel/graph.db`. If you move the checkout, run `npm run claude:install` again.
- The hook only speaks up in folders listed in `config/repos.json` (step 4a). Everywhere
  else it stays silent.
- Optional: stop Claude reading `.env` files anywhere with `npm run claude:deny-env`
  (undo: `npm run claude:allow-env`).
- Remove everything: `npm run claude:uninstall`.

To check it works, start a new Claude conversation in the analysed workspace and ask
*"What runs when POST /api/v1/po is called on 40-kri-router?"*. The transcript should
show a `code-intel` tool call.

---

## 8. Development-only extras (optional)

- **Jev (TypeSafe) key:** used only while developing this engine (reviews and gates),
  never by the engine at runtime.

  ```bash
  cp .env.example .env    # then put your key after  jev-key=
  npm run jev:verify      # one real request
  ```

  `.env` is gitignored. Never commit it.
- **The `jev` MCP server** used for the gates is separate, user-level Claude config
  (`npx -y @jkudish/jev-mcp` on the original machine). Register it on the new machine the
  same way you did there. Its key setting is not documented in this repo.
- **Token A/B check** (plain Claude vs Claude with code-intel):
  [`docs/ab-token-check.md`](ab-token-check.md). Its two config files under
  `docs/ab/` contain `D:/CodeGraph/…` paths. Change them to this checkout's path first.

---

## 9. Keeping the machine up to date

```bash
git pull                              # on feat/workflow-context-slices
npm install                           # dependencies may have changed
npm test 2>&1 | grep -E '^(ℹ (tests|pass|fail)|✖)'
node src/cli.ts build                 # new migrations and extractors need a rebuild
npm run claude:install                # only if the checkout path changed
```

If `git pull` refuses because of a local `config/repos.json` edit, keep your paths in
a stash (`git stash`, `git pull`, `git stash pop`), or commit the layout if it should
be shared.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `index` reports `MISSING: scip index` / `MISSING: boot dump`, and the graph has 0 symbols or 0 routes | `index` alone does not run the indexer or boot reflection | Use `node src/cli.ts build` |
| `scip-typescript: command not found` | the indexer is not installed globally | `npm install -g @sourcegraph/scip-typescript` |
| `boot dump` fails: `No module named 'fastapi'` | the Python service's venv lacks its requirements | Step 4b |
| `boot dump` fails on a Node service | that service's `node_modules` are missing | `npm install` inside that service |
| `config check` fails with `rootPath does not exist` | paths still point at the old machine | Step 4a |
| `flow: no route POST C:/Program Files/Git/api/v1/…` | Git Bash (Windows) rewrote the `/…` argument into a Windows path | `MSYS_NO_PATHCONV=1 node src/cli.ts flow …`, or use PowerShell |
| `SyntaxError` / `Unknown file extension ".ts"` | Node too old to run `.ts` directly | Node 22.18+ |
| Python service: routes but no call tree | empty `scip-python` index on Windows | Known (CTX-S4); works on Linux |
| Claude never calls `code-intel` | not installed on this machine, or the folder is not in `config/repos.json` | `npm run claude:status`; step 7 |
| `ExperimentalWarning: SQLite is an experimental feature` | `node:sqlite` in current Node | Harmless |
