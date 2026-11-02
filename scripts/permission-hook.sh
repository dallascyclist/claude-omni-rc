#!/usr/bin/env bash
#
# claude-omni-rc PermissionRequest hook — Claude Code invokes it right before
# showing a permission prompt in interactive sessions. If the daemon is
# reachable and armed, it forwards the request to Telegram (✓ Approve / ✗ Reject)
# and returns the decision to the CLI; otherwise it emits no decision and
# Claude Code shows the normal terminal prompt (fail-safe).
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${API_PORT:-4123}"
BASE="http://127.0.0.1:${PORT}"

# Timeout consistent with the daemon's PERMISSION_TIMEOUT_SECONDS (default 120).
if [ -z "${PERMISSION_TIMEOUT_SECONDS:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  PERMISSION_TIMEOUT_SECONDS="$(grep -E '^PERMISSION_TIMEOUT_SECONDS=' "$REPO_DIR/.env" | head -n1 | cut -d= -f2)"
fi
PERMISSION_TIMEOUT_SECONDS="${PERMISSION_TIMEOUT_SECONDS:-120}"
MAX_WAIT=$((PERMISSION_TIMEOUT_SECONDS + 5))

# Hook request (stdin)
BODY="$(cat)"

# tmux/zellij session the CLI runs in → session id for the daemon
SID=""
if [ -n "${TMUX:-}" ]; then
  SID="$(tmux display-message -p '#S' 2>/dev/null || true)"
elif [ -n "${ZELLIJ:-}" ]; then
  SID="${ZELLIJ_SESSION_NAME:-}"
fi

# Extracts tool_name + tool_input + tool_use_id from the hook JSON (node is
# required by the installer). L'id della tool call serve al daemon per la
# deduplica con la copia che il transcript scriverà più tardi (Task 8): non
# tutte le versioni del CLI lo chiamano allo stesso modo, quindi si provano le
# varianti note e si lascia vuoto se nessuna è presente — mai un errore qui,
# l'hook resta fail-open.
PAYLOAD="$(SID="$SID" BODY="$BODY" node -e '
const body = (() => { try { return JSON.parse(process.env.BODY || "{}"); } catch { return {}; } })();
const toolName = body.tool_name ?? body.toolName ?? "tool";
const input = body.tool_input ?? body.input ?? {};
const toolUseId = body.tool_use_id ?? body.toolUseId ?? "";
console.log(JSON.stringify({ toolName, input, sessionId: process.env.SID || "", toolUseId }));
' 2>/dev/null)" || exit 0

# Long-poll: stays open until the user decides (or times out → deny).
RESP="$(printf '%s' "$PAYLOAD" | curl -fsS --max-time "$MAX_WAIT" -X POST "$BASE/api/permission" \
  -H 'content-type: application/json' -d @- 2>/dev/null)" || exit 0

case "$RESP" in
  ask) exit 0 ;; # no decision → native prompt
  allow)
    # AskUserQuestion auto-allow (the daemon answers plain 'allow'): the CLI
    # drops it (no updatedInput) and keeps the interactive menu, which the bot
    # drives with key injection — same as before.
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    ;;
  deny)
    # Compatibility fallback for a pre-JSON daemon: the current daemon answers
    # every permission decision as JSON, so plain-text 'deny' is never produced.
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Rejected from Telegram"}}}'
    ;;
  *) # JSON decision from the daemon: {behavior, updatedInput?, message?}. The
     # updatedInput is required for ExitPlanMode: the CLI (≥2.1.199) drops an
     # allow without it and keeps the interactive plan UI up — the session
     # would stay stuck on the plan. Echoing the tool input back as
     # updatedInput is the documented way to approve the plan programmatically.
     OUT="$(printf '%s' "$RESP" | node -e '
const resp = JSON.parse(require("fs").readFileSync(0, "utf8"));
const decision = { behavior: resp.behavior };
if (resp.behavior === "allow" && resp.updatedInput) decision.updatedInput = resp.updatedInput;
if (resp.behavior === "deny") decision.message = resp.message ?? "Rejected from Telegram";
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
' 2>/dev/null)" || exit 0
     printf '%s\n' "$OUT"
     ;;
esac
