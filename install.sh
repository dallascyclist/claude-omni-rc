#!/usr/bin/env bash
#
# claude-omni-rc — guided installer
#
#   git clone https://github.com/ontech7/claude-omni-rc
#   cd claude-omni-rc
#   ./install.sh
#
# Walks you through everything a non-expert needs to get the daemon running:
# prerequisites, npm dependencies, your Telegram bot token, the Ollama models
# and (on macOS) the background daemon. You only answer a few prompts; the
# script never overwrites values you already set in .env.
#
# When stdin is not a terminal (piped / CI) the script skips the interactive
# prompts and just does the non-interactive steps.
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$REPO_DIR/.env"
ENV_EXAMPLE="$REPO_DIR/.env.example"
STATE_DIR="${STATE_DIR:-$HOME/.claude-omni-rc}"
DEFAULT_OLLAMA_URL="http://127.0.0.1:11434"
DEFAULT_MODEL_FALLBACK="deepseek-v4-flash:cloud"

if [ -t 1 ]; then
  c_reset='\033[0m'; c_bold='\033[1m'; c_dim='\033[2m'; c_green='\033[32m'
  c_yellow='\033[33m'; c_red='\033[31m'; c_cyan='\033[36m'
else
  c_reset=''; c_bold=''; c_dim=''; c_green=''; c_yellow=''; c_red=''; c_cyan=''
fi

info() { printf '%b\n' "${c_cyan}==>${c_reset} $*"; }
ok()   { printf '%b\n' "${c_green}==>${c_reset} $*"; }
warn() { printf '%b\n' "${c_yellow}==>${c_reset} $*"; }
err()  { printf '%b\n' "${c_red}==>${c_reset} $*" >&2; }
hint() { printf '%b\n' "${c_dim}$*${c_reset}"; }

[ -t 0 ] && INTERACTIVE=1 || INTERACTIVE=0

have() { command -v "$1" >/dev/null 2>&1; }

# ask_yes_no "question" → 0=yes, 1=no (non-interactive → always no)
ask_yes_no() {
  [ "$INTERACTIVE" -eq 0 ] && return 1
  printf '%b' "${c_bold}$1${c_reset} [y/N]: "
  local ans
  read -r ans
  case "${ans:-N}" in y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac
}

usage() {
  cat <<EOF | printf '%b\n' "$(cat)"
${c_bold}${c_cyan}claude-omni-rc installer${c_reset}

${c_bold}Usage:${c_reset} ./install.sh [--help|--uninstall]

${c_bold}Guided installer${c_reset} for the claude-omni-rc daemon + Telegram bot.
It checks prerequisites, installs npm dependencies, helps you configure
.env (bot token + authorization), pulls the Ollama models, registers the
background daemon (launchd), adds the Claude Code hooks (SessionStart
auto-attach + PermissionRequest approve/reject from Telegram) and adds the
${c_cyan}omni-rc${c_reset} shell function (start a session inside a claude:<name>
tmux session).

${c_bold}Options:${c_reset}
  ${c_cyan}--uninstall${c_reset}   remove the launchd agent, the SessionStart hook and (on
                confirmation) the Ollama model and the state dir (.env is kept)

${c_bold}Environment:${c_reset}
  ${c_cyan}STATE_DIR${c_reset}   where state and logs live (default: ~/.claude-omni-rc)
EOF
}

# set_env KEY VALUE — set or update one line in .env, never duplicates
set_env() {
  local key="$1" val="$2" esc
  esc="$(printf '%s' "$val" | sed 's/\\/\\\\/g; s/&/\\&/g; s/|/\\|/g')"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak -E "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

get_env() {
  grep "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-
}

check_platform() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin|Linux) ;;
    *)
      err "Unsupported platform: $(uname -s 2>/dev/null || echo unknown)"
      err "claude-omni-rc targets macOS (launchd) and Linux."
      exit 1
      ;;
  esac
}

check_node() {
  if ! have node; then
    err "Node.js is required but not installed."
    hint "  macOS:  brew install node"
    hint "  Linux:  install the LTS from https://nodejs.org"
    hint "  Then run this installer again."
    exit 1
  fi
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*$//')"
  if [ "${major:-0}" -lt 22 ]; then
    err "Node 22+ is required (you have $(node -v 2>/dev/null)). Upgrade and re-run."
    exit 1
  fi
  ok "Node $(node -v 2>/dev/null) found."
}

check_optional_tools() {
  if have tmux; then
    ok "tmux found."
  elif have zellij; then
    ok "zellij found (no tmux) — terminal sessions will run in zellij."
  else
    warn "Neither tmux nor zellij is installed. Terminal sessions (mirror + /attach) will be unavailable."
    hint "  Install one with:  brew install tmux   (or:  apt install tmux, or zellij 0.44+)"
  fi
}

# MULTIPLEXER defaults to tmux. When only zellij is installed, a blank value
# would leave terminal sessions uncontrollable, so fill it in — but never over a
# value the user already chose.
prepare_multiplexer() {
  [ -n "$(get_env MULTIPLEXER)" ] && return
  if ! have tmux && have zellij; then
    set_env MULTIPLEXER zellij
    ok "MULTIPLEXER=zellij saved to .env (tmux is not installed)."
  fi
}

check_ollama() {
  local base="${OLLAMA_BASE_URL:-$DEFAULT_OLLAMA_URL}"
  if ! have ollama; then
    warn "Ollama is not installed. It is the default provider; skip this if you"
    warn "configured another one via ANTHROPIC_BASE_URL in .env."
    hint "  Install it from https://ollama.com/download and start it."
    return
  fi
  if curl -fsS "$base/api/version" >/dev/null 2>&1; then
    ok "Ollama is running ($base)."
  else
    warn "Ollama is installed but not reachable at $base. Start it (the Ollama app) and re-run this script."
  fi
}

install_deps() {
  info "Installing npm dependencies (first run takes a minute)…"
  ( cd "$REPO_DIR" && npm install ) || { err "npm install failed."; exit 1; }
  ok "Dependencies installed."
}

prepare_env() {
  [ -f "$ENV_FILE" ] || { cp "$ENV_EXAMPLE" "$ENV_FILE" && ok "Created .env from .env.example."; }

  local token ids pair
  token="$(get_env TELEGRAM_BOT_TOKEN)"
  ids="$(get_env ALLOWED_USER_IDS)"
  pair="$(get_env PAIRING_CODE)"

  if [ -n "$token" ]; then
    ok "TELEGRAM_BOT_TOKEN already set."
  elif [ "$INTERACTIVE" -eq 0 ]; then
    warn "TELEGRAM_BOT_TOKEN not set — edit $ENV_FILE manually and re-run (see README)."
  else
    info "Let's create your Telegram bot token."
    echo " 1. Open Telegram and message @BotFather:  https://t.me/BotFather"
    echo " 2. Send  /newbot  and follow the prompts (pick any name and username)"
    echo " 3. Copy the token BotFather sends (it looks like  123456789:AA…)"
    local n=0
    while [ -z "$token" ] && [ "$n" -lt 3 ]; do
      printf '%b' "${c_bold}Bot token${c_reset} (or press Enter to skip for now): "
      read -r token
      token="$(printf '%s' "$token" | tr -d '[:space:]')"
      n=$((n + 1))
    done
    if [ -n "$token" ]; then
      set_env TELEGRAM_BOT_TOKEN "$token"
      ok "TELEGRAM_BOT_TOKEN saved to .env."
    else
      warn "Skipped — you can edit $ENV_FILE later and re-run ./install.sh."
    fi
  fi

  if [ -n "$ids" ] || [ -n "$pair" ]; then
    ok "Authorization already configured (ALLOWED_USER_IDS / PAIRING_CODE)."
    return
  fi
  [ "$INTERACTIVE" -eq 0 ] && { warn "No authorization configured yet — set ALLOWED_USER_IDS or PAIRING_CODE in $ENV_FILE."; return; }

  info "Who is allowed to control this? Pick one."
  echo "  • Your own Telegram user id (recommended, easiest) — find it by messaging @userinfobot"
  echo "  • A pairing code you send to the bot as  /start <code>  (works from any account that knows the code)"
  printf '%b' "${c_bold}Telegram user id${c_reset} (or press Enter to use a pairing code instead): "
  read -r ids
  ids="$(printf '%s' "$ids" | tr -d '[:space:]')"
  if [ -n "$ids" ]; then
    if [ "$ids" -eq "$ids" ] 2>/dev/null; then
      set_env ALLOWED_USER_IDS "$ids"
      ok "ALLOWED_USER_IDS set to $ids."
      return
    fi
    warn "\"$ids\" doesn't look like a numeric id — falling back to a pairing code."
  fi
  printf '%b' "${c_bold}Pairing code${c_reset} (press Enter to auto-generate one): "
  read -r pair
  pair="$(printf '%s' "$pair" | tr -d '[:space:]')"
  [ -n "$pair" ] || pair="$(LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 8)"
  set_env PAIRING_CODE "$pair"
  ok "PAIRING_CODE saved. From Telegram, send:  /start $pair"
}

# Headless sessions (/new) run in the first WORKSPACE_DIRS entry. There is no
# fallback to $HOME on purpose: an unattended agent should not be rooted at your
# whole home directory. The interactive default is the state dir, which the
# installer creates anyway — so pressing Enter gives a working /new right away.
prepare_workspace() {
  local ws default_ws
  ws="$(get_env WORKSPACE_DIRS)"
  if [ -n "$ws" ]; then
    ok "WORKSPACE_DIRS already set ($ws)."
    return
  fi
  if [ "$INTERACTIVE" -eq 0 ]; then
    warn "WORKSPACE_DIRS not set — /new will refuse to start until you set it in $ENV_FILE."
    return
  fi
  default_ws="$STATE_DIR"
  info "Where may headless (/new) sessions run?"
  echo "  This is the project root a session started from Telegram works in."
  echo "  Several roots can be separated by ':'. Press Enter to use the default."
  printf '%b' "${c_bold}Project root${c_reset} [default: $default_ws]: "
  read -r ws
  ws="$(printf '%s' "$ws" | tr -d '[:space:]')"
  [ -n "$ws" ] || ws="$default_ws"
  mkdir -p "${ws%%:*}"
  set_env WORKSPACE_DIRS "$ws"
  ok "WORKSPACE_DIRS set to $ws."
}

ensure_model() {
  local name="$1" note="$2"
  [ -n "$name" ] || return
  if ! have ollama; then return; fi
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$name"; then
    ok "Model $name already present."
    return
  fi
  [ "$INTERACTIVE" -eq 0 ] && { warn "Model $name missing — run  ollama pull $name  when ready."; return; }
  printf '%b' "Download model ${c_bold}$name${c_reset} ($note)? [y/N]: "
  read -r ans
  case "${ans:-N}" in
    y|Y|yes|Yes)
      info "Pulling $name (large download)…"
      ollama pull "$name" || warn "Pull failed — retry later with:  ollama pull $name"
      ;;
    *) warn "Skipped. Pull later with:  ollama pull $name" ;;
  esac
}

install_service() {
  case "$(uname -s)" in
    Darwin)
      if [ -x "$REPO_DIR/scripts/install-launchd.sh" ]; then
        info "Registering the background daemon (launchd)…"
        if STATE_DIR="$STATE_DIR" "$REPO_DIR/scripts/install-launchd.sh"; then
          ok "Daemon registered — it now runs and will restart automatically."
        else
          warn "launchd setup failed — you can still run  npm run dev  to test in the foreground."
        fi
      fi
      ;;
    Linux)
      info "On Linux there is no launchd; run the daemon in the foreground for now:"
      hint "    cd $REPO_DIR && npm run dev"
      ;;
  esac
}

# Claude Code hook: the session that starts auto-attaches to remote control
# (SessionStart, the equivalent of the native /remote-control) and permission
# requests are delegated to the daemon (permissionPromptTool → Telegram bot).
# The merge preserves everything already in ~/.claude/settings.json and is idempotent.
install_hook() {
  if ! have node; then return; fi
  info "Adding the Claude Code hooks (SessionStart auto-attach + PermissionRequest approve/reject)…"
  if node "$REPO_DIR/scripts/setup-hook.mjs" "$HOME/.claude/settings.json" "$REPO_DIR/scripts/attach.sh" "$REPO_DIR/scripts/permission-hook.sh"; then
    ok "Claude Code hooks installed."
  else
    warn "Hook install failed — add it manually (see README → \"Auto-attach\")."
  fi
}

# The `omni-rc` shell function: starts a Claude Code session inside a
# `claude:<name>` tmux (or zellij) session, ready for remote control. Added to the user's
# shell rc so it's available as a plain command. Idempotent; removed by
# --uninstall.
shell_rc_file() {
  case "${SHELL:-}" in
    *zsh) printf '%s\n' "$HOME/.zshrc" ;;
    *)    printf '%s\n' "$HOME/.bashrc" ;;
  esac
}

install_omni_rc_function() {
  local rc marker_start marker_end
  rc="$(shell_rc_file)"
  marker_start="# >>> claude-omni-rc omni-rc launcher >>>"
  marker_end="# <<< claude-omni-rc omni-rc launcher <<<"
  [ -f "$rc" ] || touch "$rc"
  if grep -qF "$marker_start" "$rc"; then
    ok "omni-rc function already present in $rc."
    return
  fi
  cat >> "$rc" <<EOF

$marker_start
# omni-rc <name> — start Claude Code inside a claude:<name> tmux/zellij session
omni-rc() { "$REPO_DIR/scripts/omni-rc.sh" "\$@"; }
$marker_end
EOF
  ok "Added the omni-rc function to $rc (open a new shell to use it)."
}

remove_omni_rc_function() {
  local rc marker_start marker_end
  rc="$(shell_rc_file)"
  marker_start="# >>> claude-omni-rc omni-rc launcher >>>"
  marker_end="# <<< claude-omni-rc omni-rc launcher <<<"
  if [ -f "$rc" ] && grep -qF "$marker_start" "$rc"; then
    sed -i.bak "/^$marker_start/,/^$marker_end/d" "$rc" && rm -f "$rc.bak"
    ok "Removed the omni-rc function from $rc."
  fi
}

uninstall() {
  printf '%b\n' "${c_bold}Uninstalling claude-omni-rc…${c_reset}"

  # 1. launchd agent
  local plist="$HOME/Library/LaunchAgents/com.ontech7.claude-omni-rc.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    ok "launchd agent removed."
  else
    warn "No launchd agent found — nothing to remove."
  fi

  # 2. hook (SessionStart + PermissionRequest) from ~/.claude/settings.json
  #    (preserves everything else)
  if have node; then
    node "$REPO_DIR/scripts/setup-hook.mjs" --remove "$HOME/.claude/settings.json" "$REPO_DIR/scripts/attach.sh" "$REPO_DIR/scripts/permission-hook.sh"
  else
    warn "node not found — remove the claude-omni-rc hooks manually from ~/.claude/settings.json."
  fi

  # 3. the omni-rc shell function from the shell rc
  remove_omni_rc_function

  # 4. Ollama model (only on confirmation: it may be used outside claude-omni-rc too)
  local model
  model="$(get_env DEFAULT_MODEL 2>/dev/null)"
  [ -n "$model" ] || model="$DEFAULT_MODEL_FALLBACK"
  if have ollama && ask_yes_no "Remove the Ollama model '$model'?"; then
    if ollama rm "$model" >/dev/null 2>&1; then
      ok "Model '$model' removed."
    else
      warn "Failed to remove '$model' — try: ollama rm $model"
    fi
  else
    warn "Keeping the Ollama model '$model'."
  fi

  # 5. state (on confirmation) — .env is left intact for a possible reinstall
  if ask_yes_no "Remove the state dir '$STATE_DIR' (state, logs, inbox)?"; then
    rm -rf "$STATE_DIR"
    ok "Removed $STATE_DIR."
  else
    warn "Keeping $STATE_DIR."
  fi

  ok "claude-omni-rc uninstalled. .env and the repo itself are kept — re-run ./install.sh to set it up again."
}

print_summary() {
  cat <<EOF | printf '%b\n' "$(cat)"

${c_bold}${c_green}✓ claude-omni-rc is installed.${c_reset} ${c_bold}Next steps:${c_reset}
  1. Open the chat with your bot on Telegram.
     • If you set a pairing code, send:        ${c_cyan}/start <pairing code>${c_reset}
     • If you allowlisted your user id, any message works.
  2. Arm remote control:                       ${c_cyan}/rc on${c_reset}
  3. Try it:
     ${c_cyan}/new write a haiku${c_reset}            — headless session
     ${c_cyan}/sessions${c_reset}                     — list and switch sessions
     ${c_cyan}/attach <project>${c_reset}             — attach a tmux terminal session
     ${c_cyan}/help${c_reset}                         — all commands

  Start a session ready for remote control from the shell (new shell needed
  after install):
     ${c_cyan}omni-rc <name>${c_reset}                — e.g.  omni-rc myproject
     ${c_cyan}omni-rc <name> -c <dir> -m <model>${c_reset} — enrich it (see omni-rc --help)

  The SessionStart hook auto-attaches every Claude Code session you start,
  including the one you're in right now — restart it (or run  claude  again)
  and it will show up in /sessions.

  ${c_yellow}Logs:${c_reset}   $STATE_DIR/logs/daemon.log
  ${c_yellow}Docs:${c_reset}   https://github.com/ontech7/claude-omni-rc#readme
  ${c_red}Read SECURITY.md: an armed bot can run code on this machine as you.${c_reset}
  ${c_red}Your $ENV_FILE holds secrets — keep it private, never commit it.${c_reset}
EOF
}

main() {
  case "${1:-}" in
    --help|-h) usage; exit 0 ;;
    --uninstall|-u) uninstall; exit 0 ;;
    --) ;;
    "") ;;
    *) err "Unknown option: $1"; usage; exit 1 ;;
  esac

  printf '%b\n' "${c_bold}${c_cyan}claude-omni-rc${c_reset} ${c_bold}— remote control for Claude Code, via Telegram${c_reset}"
  printf '%b\n' "${c_cyan}────────────────────────────────────────────────────────${c_reset}"
  check_platform
  check_node
  check_optional_tools
  check_ollama
  install_deps
  prepare_env
  prepare_multiplexer
  prepare_workspace
  local default_model
  default_model="$(get_env DEFAULT_MODEL)"; [ -n "$default_model" ] || default_model="$DEFAULT_MODEL_FALLBACK"
  ensure_model "$default_model" "used for headless sessions"
  install_service
  install_hook
  install_omni_rc_function
  print_summary
}

main "$@"
