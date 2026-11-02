#!/usr/bin/env bash
#
# omni-rc — start a Claude Code session inside tmux (or zellij), ready for remote control.
#
#   omni-rc <name> [options]
#
# Creates (or reattaches to) a tmux session named `claude:<name>` running
# Claude Code, so the claude-omni-rc daemon can mirror it, inject input and
# capture its screen. If the session already exists, omni-rc just attaches.
# With MULTIPLEXER=zellij in .env (or the environment) it uses a zellij session
# of the same name instead.
#
# The provider is chosen automatically, the same way as headless sessions:
#   - a model starting with `claude-` (or the opus/sonnet/haiku/fable aliases)
#     runs on Anthropic;
#   - any other model runs on Ollama (OLLAMA_BASE_URL), replicating
#     `ollama launch claude`;
#   - an explicit ANTHROPIC_BASE_URL in .env (different from Ollama) overrides
#     both and wins for every model.
#
# Options:
#   -c, --cwd <dir>     start in this directory (default: current)
#   -m, --model <model> model for the session (default: DEFAULT_MODEL from .env)
#   -p, --prompt <text> send <text> as the first message
#   -d, --detach        create the session but don't attach to it
#   -k, --kill          kill the claude:<name> session instead of starting it
#   -l, --list          list all claude:* sessions and exit
#   -h, --help          show this help
#   --                  everything after is passed to claude verbatim
#
# Examples:
#   omni-rc myproject                                     # Ollama (DEFAULT_MODEL)
#   omni-rc myproject -c ~/code/myproject -m deepseek-v4-flash:cloud
#   omni-rc myproject -m claude-opus-5                    # Anthropic
#   omni-rc myproject -p "review the current diff"
#   omni-rc -l
#
set -uo pipefail

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  exit 0
}

# --- parse options ---------------------------------------------------------
CWD=""
MODEL=""
PROMPT=""
DETACH=0
KILL=0
LIST=0
CLAUDE_ARGS=()
NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    -l|--list) LIST=1; shift ;;
    -k|--kill) KILL=1; shift ;;
    -d|--detach) DETACH=1; shift ;;
    -c|--cwd) CWD="${2:-}"; shift 2 ;;
    -m|--model) MODEL="${2:-}"; shift 2 ;;
    -p|--prompt) PROMPT="${2:-}"; shift 2 ;;
    --) shift; CLAUDE_ARGS+=("$@"); break ;;
    -*) echo "omni-rc: unknown option: $1" >&2; usage ;;
    *) NAME="$1"; shift ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"

# Legge una variabile dal .env del repo (vuoto se assente).
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r'
}

# Precedenza: env della shell, poi .env, poi default.
pick() {
  local key="$1" def="${2:-}" v
  v="${!key:-}"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  v="$(env_get "$key")"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  printf '%s' "$def"
}

# --- multiplexer: the one the daemon drives (MULTIPLEXER, default tmux) -----
MUX="$(pick MULTIPLEXER tmux | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
[ "$MUX" = "zellij" ] || MUX="tmux"

# Live zellij sessions, one name per line. EXITED ones are dead sessions kept
# for resurrection: they don't count as running.
zellij_live() {
  zellij list-sessions --no-formatting 2>/dev/null | grep -v '(EXITED' | sed 's/ \[Created.*$//'
}

if [ "$LIST" -eq 1 ]; then
  if ! command -v "$MUX" >/dev/null 2>&1; then
    echo "$MUX is not installed."
  elif [ "$MUX" = "zellij" ]; then
    zellij_live | grep '^claude:' || echo "No claude:* sessions."
  else
    tmux ls -F '#{session_name}' 2>/dev/null | grep '^claude:' || echo "No claude:* sessions."
  fi
  exit 0
fi

if [ -z "$NAME" ]; then
  echo "omni-rc: missing session name" >&2
  usage
fi

# tmux session names can't contain ':' and a name with spaces is asking for trouble
case "$NAME" in
  *:*|*' '*|'') echo "omni-rc: invalid session name '$NAME' (no spaces or colons)" >&2; exit 1 ;;
esac

if ! command -v "$MUX" >/dev/null 2>&1; then
  echo "omni-rc: $MUX is not installed" >&2
  exit 1
fi

SESSION="claude:$NAME"

# tmux reads `claude:<name>` as session:window, so a colon-named session can't
# be targeted by name. Resolve it to its session id (`$0`…) — unique and stable.
resolve_target() {
  tmux list-sessions -F '#{session_id} #{session_name}' 2>/dev/null | awk -v want="$1" '$2 == want { print $1; exit }'
}

# TARGET is what later commands address: the tmux session id, or for zellij the
# session name itself (zellij takes colons in names as they are).
if [ "$MUX" = "zellij" ]; then
  TARGET="$(zellij_live | grep -xF "$SESSION" || true)"
else
  TARGET="$(resolve_target "$SESSION")"
fi

if [ "$KILL" -eq 1 ]; then
  if [ -n "$TARGET" ]; then
    if [ "$MUX" = "zellij" ]; then
      zellij delete-session --force "$SESSION" >/dev/null
    else
      tmux kill-session -t "$TARGET"
    fi
    echo "Killed $SESSION."
  else
    echo "No session $SESSION."
  fi
  exit 0
fi

# already running → just attach (or report when detached)
if [ -n "$TARGET" ]; then
  if [ "$DETACH" -eq 1 ]; then
    echo "$SESSION is already running."
    exit 0
  fi
  echo "Attaching to existing $SESSION…"
  [ "$MUX" = "zellij" ] && exec zellij attach "$SESSION"
  exec tmux attach-session -t "$TARGET"
fi

# --- provider: quale backend per questa sessione? ---------------------------
# Stessa filosofia "omni" del driver headless: il provider è quello configurato
# in .env; senza config esplicita si usa Ollama; un modello `claude-*` (o gli
# alias opus/sonnet/haiku/fable) significa Anthropic.
#
#  1. ANTHROPIC_BASE_URL esplicito (≠ Ollama) → provider custom (proxy o
#     Anthropic): vince per qualunque modello.
#  2. modello Anthropic → Anthropic nativo (auth di Claude Code: OAuth o key).
#  3. altrimenti → Ollama: replica `ollama launch claude` (token placeholder +
#     mapping dei modelli default + context length reale).
#
# L'env arriva a claude INIETTATO nel comando del pane (env KEY=VAL … claude …):
# senza `-e`, `tmux new-session` usa l'env del server, non quello del client,
# quindi un semplice `export` qui NON raggiungerebbe la sessione.

OLLAMA_BASE_URL="$(pick OLLAMA_BASE_URL 'http://127.0.0.1:11434')"
DEFAULT_MODEL="$(pick DEFAULT_MODEL 'deepseek-v4-flash:cloud')"
ANTHROPIC_BASE_URL="$(pick ANTHROPIC_BASE_URL '')"
ANTHROPIC_AUTH_TOKEN="$(pick ANTHROPIC_AUTH_TOKEN '')"
ANTHROPIC_API_KEY="$(pick ANTHROPIC_API_KEY '')"

MODEL="${MODEL:-$DEFAULT_MODEL}"

is_anthropic_model() {
  case "$1" in
    claude-*|opus|sonnet|haiku|fable) return 0 ;;
    *) return 1 ;;
  esac
}

# Context length reale del modello (`ollama show` → model_info.*.context_length),
# come fa `ollama launch claude`. Best-effort: vuoto se Ollama non risponde o il
# valore manca → non si setta CLAUDE_CODE_MAX_CONTEXT_TOKENS.
ollama_ctx() {
  command -v curl >/dev/null 2>&1 || return 1
  local out
  out="$(curl -fsS --max-time 5 "$1/api/show" -H 'content-type: application/json' -d "{\"model\":\"$2\"}" 2>/dev/null)" || return 1
  printf '%s' "$out" | sed -n 's/.*"\([a-zA-Z0-9_.]*\.context_length\)"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\2/p' | tail -1
}

# env da iniettare nel comando claude del pane
ENV_PREFIX=()
add_env() { ENV_PREFIX+=("$1=$2"); }

if [ -n "$ANTHROPIC_BASE_URL" ] && [ "$ANTHROPIC_BASE_URL" != "$OLLAMA_BASE_URL" ]; then
  # 1. provider esplicito (proxy o Anthropic): credenziali passano intatte
  add_env ANTHROPIC_BASE_URL "$ANTHROPIC_BASE_URL"
  [ -n "$ANTHROPIC_AUTH_TOKEN" ] && add_env ANTHROPIC_AUTH_TOKEN "$ANTHROPIC_AUTH_TOKEN"
  [ -n "$ANTHROPIC_API_KEY" ] && add_env ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
elif is_anthropic_model "$MODEL"; then
  # 2. modello Anthropic → Anthropic nativo (api.anthropic.com)
  add_env ANTHROPIC_BASE_URL "https://api.anthropic.com"
  [ -n "$ANTHROPIC_AUTH_TOKEN" ] && add_env ANTHROPIC_AUTH_TOKEN "$ANTHROPIC_AUTH_TOKEN"
  [ -n "$ANTHROPIC_API_KEY" ] && add_env ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
else
  # 3. Ollama: replica `ollama launch claude`
  add_env ANTHROPIC_BASE_URL "$OLLAMA_BASE_URL"
  add_env ANTHROPIC_AUTH_TOKEN "ollama"
  add_env ANTHROPIC_API_KEY ""
  add_env ANTHROPIC_DEFAULT_HAIKU_MODEL "$MODEL"
  add_env ANTHROPIC_DEFAULT_OPUS_MODEL "$MODEL"
  add_env ANTHROPIC_DEFAULT_SONNET_MODEL "$MODEL"
  ctx="$(ollama_ctx "$OLLAMA_BASE_URL" "$MODEL")"
  [ -n "$ctx" ] && add_env CLAUDE_CODE_MAX_CONTEXT_TOKENS "$ctx"
fi

# build the claude command
CLAUDE_BARE=(claude --model "$MODEL")
[ "${#CLAUDE_ARGS[@]}" -gt 0 ] && CLAUDE_BARE+=("${CLAUDE_ARGS[@]}")
CLAUDE_CMD=()
[ "${#ENV_PREFIX[@]}" -gt 0 ] && CLAUDE_CMD+=(env "${ENV_PREFIX[@]}")
CLAUDE_CMD+=("${CLAUDE_BARE[@]}")

CWD="${CWD:-$PWD}"
if [ ! -d "$CWD" ]; then
  echo "omni-rc: directory not found: $CWD" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "omni-rc: 'claude' not found on PATH — the session will start but Claude Code won't." >&2
fi

if [ "$MUX" = "zellij" ]; then
  # zellij keeps a session alive after its command pane exits (tmux closes it),
  # so the pane runs a wrapper that deletes the session once claude is done —
  # otherwise `omni-rc <name>` would later reattach to an empty session. `set -m`
  # puts claude in its own foreground process group: zellij reports the
  # foreground process as the pane command, and the daemon must see `claude`
  # there, not the `sh` wrapper (which it would take for an idle shell).
  # The session starts in the creating client's cwd, hence the subshell.
  # The provider env goes to the zellij client, whose environment the new
  # session server and its pane inherit — not onto the pane's command line:
  # the wrapper's argv lives as long as the session (visible in `ps`) and zellij
  # saves pane commands to disk for resurrection, tokens included.
  ZELLIJ_BIN="$(command -v zellij)"
  # A dead (EXITED) session of the same name — zellij crashed, the machine
  # rebooted — would be resurrected by `attach` instead of running claude.
  # It isn't live (checked above), so delete-session without --force only
  # removes its resurrection data.
  zellij delete-session "$SESSION" >/dev/null 2>&1 || true
  # TMUX/TMUX_PANE are dropped so that, run from a tmux pane, the session's
  # panes don't look nested to the hooks (they would report the outer tmux).
  if ! ( cd "$CWD" && env -u TMUX -u TMUX_PANE ${ENV_PREFIX[@]+"${ENV_PREFIX[@]}"} zellij attach --create-background "$SESSION" -- \
      sh -c 'set -m; z="$1"; shift; "$@"; "$z" delete-session --force "$ZELLIJ_SESSION_NAME" >/dev/null 2>&1' \
      sh "$ZELLIJ_BIN" "${CLAUDE_BARE[@]}" ); then
    echo "omni-rc: failed to create $SESSION" >&2
    exit 1
  fi
  TARGET="$SESSION"
else
  if ! tmux new-session -d -s "$SESSION" -c "$CWD" "${CLAUDE_CMD[@]}"; then
    echo "omni-rc: failed to create $SESSION" >&2
    exit 1
  fi
  TARGET="$(resolve_target "$SESSION")"
fi

if [ -n "$PROMPT" ] && [ -n "$TARGET" ]; then
  # let claude boot, then send the prompt as the first message
  if [ "$MUX" = "zellij" ]; then
    # terminal_0 is the command pane of a session created just above; without
    # --pane-id the text would go to the focused pane, which can be a plugin.
    ( sleep 2
      zellij --session "$SESSION" action write-chars --pane-id terminal_0 -- "$PROMPT"
      zellij --session "$SESSION" action send-keys --pane-id terminal_0 Enter ) >/dev/null 2>&1 &
  else
    ( sleep 2; tmux send-keys -t "$TARGET" "$PROMPT" Enter ) &
  fi
fi

echo "Started $SESSION in $CWD."
if [ "$DETACH" -eq 1 ]; then
  echo "Detached — attach later with: omni-rc $NAME"
elif [ "$MUX" = "zellij" ]; then
  exec zellij attach "$SESSION"
else
  exec tmux attach-session -t "$TARGET"
fi
