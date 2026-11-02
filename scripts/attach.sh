#!/usr/bin/env bash
#
# claude-omni-rc attach — registers the current Claude Code session with the daemon.
#
# Called by the Claude Code SessionStart hook (installed by ./install.sh), so
# every session auto-attaches to remote control — the closest equivalent to
# Claude Code's native /remote-control. It reads the project dir from the
# working directory and, if running inside tmux or zellij, records that
# session as the injection target (the daemon keeps it only when it matches the
# multiplexer it drives — MULTIPLEXER in .env).
#
# Never fails loudly: if the daemon isn't running, the hook does nothing and
# Claude Code starts normally.
#
# Every Claude Code session is registered, whatever model backs it (Ollama,
# another provider via ANTHROPIC_BASE_URL, or Anthropic itself) — that's the
# "omni" promise of claude-omni-rc.
#
# When the session is NOT inside tmux or zellij but the daemon is running, the hook emits
# a systemMessage (JSON on stdout) reminding the user to start it with
# `omni-rc <name>` instead — a session outside them can be mirrored read-only
# from Telegram but can't receive input or be captured with /view.
#
set -uo pipefail

PORT="${API_PORT:-4123}"
BASE="http://127.0.0.1:${PORT}"
PROJECT_DIR="$(pwd 2>/dev/null || printf '%s' "${HOME:-}")"
TMUX_NAME=""
[ -n "${TMUX:-}" ] && TMUX_NAME="$(tmux display-message -p '#S' 2>/dev/null || true)"
ZELLIJ_NAME=""
[ -n "${ZELLIJ:-}" ] && ZELLIJ_NAME="${ZELLIJ_SESSION_NAME:-}"
# Nested multiplexers (zellij started from a tmux pane, or the reverse) set both
# variables. The claude:<project> session is the one claude runs in; when that
# doesn't settle it, tmux wins, as it did before zellij support.
TMUX_TARGET=""
MULTIPLEXER=""
if [ -n "$ZELLIJ_NAME" ] && { [ -z "$TMUX_NAME" ] || { [ "${ZELLIJ_NAME#claude:}" != "$ZELLIJ_NAME" ] && [ "${TMUX_NAME#claude:}" = "$TMUX_NAME" ]; }; }; then
  TMUX_TARGET="$ZELLIJ_NAME"
  MULTIPLEXER="zellij"
elif [ -n "$TMUX_NAME" ]; then
  TMUX_TARGET="$TMUX_NAME"
  MULTIPLEXER="tmux"
fi

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if curl -fsS --max-time 5 -X POST "$BASE/api/attach" \
  -H 'content-type: application/json' \
  -d "{\"projectDir\":\"$(json_escape "$PROJECT_DIR")\",\"tmuxTarget\":\"$(json_escape "$TMUX_TARGET")\",\"multiplexer\":\"$MULTIPLEXER\",\"title\":\"$(json_escape "$(basename "$PROJECT_DIR" 2>/dev/null || echo claude-omni-rc)")\"}" \
  >/dev/null 2>&1; then
  # daemon is up: if this session isn't inside tmux or zellij, remind the user
  # that remote control can inject input and capture the screen only from there.
  if [ -z "$TMUX_TARGET" ]; then
    NAME="$(basename "$PROJECT_DIR" 2>/dev/null || echo session)"
    printf '{"systemMessage":"⚠️ omni-rc: this session is not inside tmux or zellij. If you plan to use remote control from your phone, restart it with: omni-rc %s"}\n' "$(json_escape "$NAME")"
  fi
fi
