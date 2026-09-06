#!/bin/bash
# user-prompt-ghost-scanner.sh
# EVENT: UserPromptSubmit
# DESCRIPTION: Detect CLAUDE.md sections never referenced in recent sessions and suggest pruning
#
# Claude Code UserPromptSubmit hook: scans .claude/sessions/token-log.md for session entries,
# extracts section headers from CLAUDE.md, and flags sections with zero references across
# the last 10+ sessions as "ghost tokens" worth pruning.
#
# stdout is injected as context Claude sees. Output is silent when:
#   - token-log.md has fewer than 5 sessions
#   - all sections are referenced
#   - CLAUDE.md doesn't exist
#   - already ran today (daily marker)
#
# Override: CTO_GHOST_SCAN_DISABLE=1

# ── Python resolution ────────────────────────────────────────────────────
# On Windows "python3" is intercepted by a Microsoft Store app-execution alias
# that SATISFIES `command -v` but fails on execution. So each candidate is
# actually run before being accepted. CTO_PY is empty if none work, and every
# caller below degrades gracefully in that case.
CTO_PY=""
for _cto_py in python3 python py; do
  if command -v "$_cto_py" >/dev/null 2>&1 && "$_cto_py" -c "" >/dev/null 2>&1; then
    CTO_PY="$_cto_py"
    break
  fi
done

if [ "${CTO_GHOST_SCAN_DISABLE:-0}" = "1" ]; then
  exit 0
fi

SESSION_MARKER=".claude/sessions/.ghost-checked-$(date +%Y%m%d)"
TOKEN_LOG=".claude/sessions/token-log.md"
CLAUDE_MD="CLAUDE.md"

# Run once per day
if [ -f "$SESSION_MARKER" ]; then
  exit 0
fi

# Require both files to exist
if [ ! -f "$TOKEN_LOG" ] || [ ! -f "$CLAUDE_MD" ]; then
  exit 0
fi

mkdir -p ".claude/sessions"
touch "$SESSION_MARKER"

"$CTO_PY" - "$TOKEN_LOG" "$CLAUDE_MD" << 'PYEOF'
import sys, re, os

log_path = sys.argv[1]
claude_path = sys.argv[2]

# Count sessions in log (lines starting with ##)
log_content = open(log_path, encoding='utf-8', errors='ignore').read()
sessions = re.findall(r'^## ', log_content, re.MULTILINE)
if len(sessions) < 5:
    sys.exit(0)

# Extract section headers from CLAUDE.md (## and ###, skip H1)
claude_content = open(claude_path, encoding='utf-8', errors='ignore').read()
headers = re.findall(r'^#{2,3}\s+(.+)$', claude_content, re.MULTILINE)
if not headers:
    sys.exit(0)

# Limit to last 10 sessions for ghost check
# Sessions are delimited by ## headers in log
session_blocks = re.split(r'^## .+$', log_content, flags=re.MULTILINE)
recent_blocks = session_blocks[-10:] if len(session_blocks) >= 10 else session_blocks
recent_log = '\n'.join(recent_blocks).lower()

ghosts = []
for header in headers:
    # Extract keywords from header (words > 3 chars)
    words = [w.lower() for w in re.findall(r'\b[a-zA-Z]{4,}\b', header)]
    if not words:
        continue
    # Ghost if NONE of the keywords appear in recent sessions
    referenced = any(w in recent_log for w in words)
    if not referenced:
        ghosts.append(header)

if not ghosts:
    sys.exit(0)

ghost_limit = int(os.environ.get('CTO_GHOST_MAX_REPORT', '5'))
shown = ghosts[:ghost_limit]
remaining = len(ghosts) - len(shown)

print(f'Note: {len(ghosts)} CLAUDE.md section(s) have not been referenced in recent sessions and may be safe to remove:')
for g in shown:
    print(f'- "{g}"')
if remaining > 0:
    print(f'... and {remaining} more')
print('Consider running: cto prune  to remove stale sections')
PYEOF
