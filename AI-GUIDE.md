# claude-omni-rc — AI agent setup guide

Remote control for any model that runs through the Claude Code CLI — Ollama-served
models, other local or proxied LLMs, or Claude itself: a local daemon plus a
Telegram bot that mimics Claude Code's `/remote-control` without Anthropic
infrastructure. Repo: https://github.com/ontech7/claude-omni-rc · MIT · Node 22+ ·
unofficial, not affiliated with Anthropic or Ollama.

## How to use this file

You are setting this up for a human. **Ask them what they want**, then run
the matching command below and verify it worked. The one thing only the human
can do is create the Telegram bot token with @BotFather (one-time) and, if a
pairing code is used, send `/start <code>` from their phone.

## Install

```bash
git clone https://github.com/ontech7/claude-omni-rc
cd claude-omni-rc
./install.sh
```

The installer is interactive: it checks prerequisites (Node 22, Ollama, tmux or zellij),
runs `npm install`, guides the human through the bot token and authorization
into `.env`, optionally pulls the Ollama models, registers the launchd daemon,
and adds the Claude Code hooks (`SessionStart` auto-attach + `PermissionRequest`
approve/reject from Telegram). It never overwrites existing `.env` values. If
you are running it non-interactively, it does the silent steps only and prints
what still needs manual edits.

Manual equivalent (same result, step by step):

```bash
cp .env.example .env            # then fill TELEGRAM_BOT_TOKEN + ALLOWED_USER_IDS / PAIRING_CODE
npm install
./scripts/install-launchd.sh    # or: npm run dev  for a foreground test
```

## Setup matrix — "if the user asks X, do Y"

| User asks for… | Do this |
|----------------|---------|
| install / set up claude-omni-rc | run the clone + `./install.sh` flow |
| help creating the Telegram bot | point them to @BotFather (https://t.me/BotFather) → `/newbot` |
| allow only themselves | set `ALLOWED_USER_IDS` to their Telegram numeric id (@userinfobot) |
| allow via a code instead | set `PAIRING_CODE` in `.env`; they send `/start <code>` once |
| arm / disarm remote control | from Telegram: `/rc on` / `/rc off` (or `ARMED_ON_START=true` in `.env`) |
| create a headless session | from Telegram: `/new <prompt>` (standard by default: approve/reject buttons; `/new --auto <prompt>` for automode; `/new --model <name> <prompt>` to pick the model) |
| use a provider other than Ollama for headless sessions | set `ANTHROPIC_BASE_URL` (+ `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`) in `.env`; a `claude-*` model (or `opus`/`sonnet`/`haiku`/`fable`) means Anthropic even with `ANTHROPIC_BASE_URL` unset; anything else → Ollama (`OLLAMA_BASE_URL`) |
| continue an ongoing session from the phone | make sure it runs inside tmux — start it with `omni-rc <name>` (or `tmux new -s claude:<project>`); it auto-appears in `/sessions` and streams as a chat |
| use zellij instead of tmux | set `MULTIPLEXER=zellij` in `.env` and restart the daemon (needs zellij 0.44+); `omni-rc <name>` then starts a `claude:<name>` zellij session, or start one with `zellij -s claude:<project>` and run `claude` in it. One multiplexer at a time: sessions in the other are mirrored read-only |
| start a session ready for remote control | `omni-rc <name>` (shell function added by `./install.sh`); options in `omni-rc --help` |
| pick the provider for an `omni-rc` session | no `-m` → Ollama (`DEFAULT_MODEL` from `.env`); `-m claude-*`/`opus`/`sonnet`/`haiku`/`fable` → Anthropic; `ANTHROPIC_BASE_URL` in `.env` overrides both |
| started claude without tmux and want remote control | you can't move a running process into tmux — restart it with `omni-rc <name>`; the `SessionStart` hook warns you when a session starts outside tmux |
| see what the model is writing | select the session with `/sessions`: its messages stream as a chat automatically |
| see a subagent's work in a headless session | a `🤖 Agent` card appears per subagent with its progress; `👁 Details` / `🙈 Hide` expand/collapse its tool calls (headless only — a subagent in a terminal session shows just the `🤖 Agent` line) |
| answer a multiple-choice question | the question arrives as a `❓` message with one button per option; tap it (or reply with the option number/text) |
| auto-attach every session on start | `./install.sh` already adds the `SessionStart` + `PermissionRequest` hooks (see `~/.claude/settings.json`) |
| attach a terminal (tmux/zellij) session | from Telegram: `/attach <project>` (session must be named `claude:<project>`) |
| stop a session / a running turn | from Telegram: `/stop` |
| approve / reject a permission | tap `✓ Approve` / `✗ Reject` on the bot message (timeout → deny) |
| see the active session's raw screen | from Telegram: `/view` |
| send a file | the bot saves it to `~/.claude-omni-rc/inbox/` and forwards the path |
| check what sessions exist | from Telegram: `/sessions` or `/status` |
| check / change your settings from the phone | from Telegram: `/settings` (list), `/settings <key> <value>` (set), `/settings reset <key>` — saved to `settings.json`, applies at the next restart |
| check provider usage (5h / weekly) | from Telegram: `/usage` — Anthropic reads it via the Agent SDK directly; any other provider (Ollama, a custom proxy) shells out to `ollama-usage`, which must be installed and authenticated on the daemon's machine |
| see how much context the active session has used | from Telegram: `/context` — tokens used vs max (from the transcript's last usage and the model's context window) |
| compact a session's history from the phone | from Telegram: `/compact` on the active session (headless: sent as a prompt; terminal: pasted into the tmux pane) |
| run it without launchd | `npm run dev` in the repo (foreground) |
| uninstall claude-omni-rc | `./install.sh --uninstall` (asks about the Ollama model, then removes launchd, the hooks, and on confirmation the state dir; `.env` is kept) |

## Command reference (bot)

- `/start <code>` — pair this Telegram account (first time, if pairing is used).
- `/rc` (no arg) / `/rc on` / `/rc off` / `/rc status` — global armed switch;
  no argument toggles it. **While disarmed the bot answers only `/rc`, `/help`,
  `/start`**; no streaming, no injection, no relay.
- `/sessions` — list sessions and switch the active one (inline buttons). Only
  the active session's screen is streamed.
- `/view` — send the active session's current screen (tmux/zellij pane).
- `/new [--auto|--standard] [--model <name>] [--effort <level>] <text>` — create a headless
  session and send it the prompt (standard by default: approve/reject buttons;
  `--auto` for automode; `--model` to pick the model for this session;
  `--effort` to set the reasoning effort). Headless
  sessions use the provider configured in `.env` (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`),
  falling back to Ollama when unset.
- `/attach <project>` — attach the `claude:<project>` tmux (or zellij) session.
- `/stop` — abort the active session's running turn (sends `Ctrl+C` to the
  terminal pane, like pressing ESC).
- `/status` — active session status.
- `/history [id]` — show the last messages of a session.
- `/delete [id]` — delete a session (with an inline confirm).
- `/usage` — 5h/weekly usage window for the provider of the active session (or
  `DEFAULT_MODEL`): Anthropic natively; any other provider via `ollama-usage`,
  which must be installed and authenticated on the daemon's machine.
- `/context` — the active session's context window used vs max (tokens): the
  used figure comes from the last assistant turn's usage in the session
  transcript, the max from the Ollama model context or a known Anthropic window.
- `/compact` — compact the active session's history (runs the CLI's `/compact`:
  headless sessions get it as a prompt, terminal ones pasted into the
  terminal pane). The session must be idle to compact.
- `/diag` — daemon state, sessions, pending interactions and recent errors;
  per session it shows the model, the reasoning effort and the git branch when
  available (from the structured log at `~/.claude-omni-rc/logs/daemon.jsonl`).
- `/settings [key [value]]` · `/settings reset <key>` — view the curated user
  settings, change one (`/settings <key> <value>`) or reset it to the `.env`
  default (`/settings reset <key>`). Stored in `<STATE_DIR>/settings.json` with
  precedence over `.env`; changes apply at the next daemon restart.
- `/help` — list commands.

Plain messages go to the active session: headless sessions receive them as a
new turn, terminal sessions as pasted input + Enter (so the human can answer
interactive prompts). Slash commands the bot doesn't own are **not** forwarded:
they get an "Unknown command" reply (some CLI commands like `/context` are
interactive UIs that would leave the session stuck waiting for input).
Selecting a session in `/sessions` also shows its last messages.
Terminal sessions must run inside tmux (`claude:<project>`) to receive text —
or inside zellij with `MULTIPLEXER=zellij`.

### Headless sessions

Started from Telegram with `/new`, these run the Claude Agent SDK inside the
daemon: there is no terminal screen, and replies stream straight into the chat.

**What works:** send a message and get a reply; `/stop` aborts the turn in
progress; `/compact` and `/context`; approve or reject permissions and plans
from the buttons; answer multiple-choice questions from the buttons; attach
images and documents; per-subagent `🤖 Agent` cards with `👁 Details`.

**What differs from a tmux session:**

- **No terminal screen.** `/view` can't capture anything; the replies come to
  the chat instead.
- **Permissions.** Read-only tools (`Read`, `Grep`, `Glob`, `WebFetch`,
  `WebSearch`) are allowed without asking, like the native CLI. Tools that
  change state (`Bash`, `Edit`, `Write`, `NotebookEdit`, MCP tools) need
  Telegram approval: if nobody answers within `PERMISSION_TIMEOUT_SECONDS`
  (default 120) they are denied. For unattended work start with
  `/new --auto` or set `DEFAULT_PERMISSION_MODE=auto`.
- **A daemon restart loses the turn in progress.** The session's history
  survives (it resumes from its `claudeSessionId`), but an in-flight reply is
  aborted — re-send your message.
- **No arbitrary CLI slash commands.** Telegram intercepts `/…` as bot
  commands; only the bot's own commands (`/compact`, `/stop`, `/context`, …)
  reach the session.

## Configuration & data

- `.env` at the repo root (never commit it). See the README's
  [Configuration](https://github.com/ontech7/claude-omni-rc#configuration) table
  for every variable and default.
- Minimum: `TELEGRAM_BOT_TOKEN` plus either `ALLOWED_USER_IDS` or
  `PAIRING_CODE`.
- Data: `~/.claude-omni-rc/state.json` (armed switch + sessions),
  `~/.claude-omni-rc/inbox/` (attachments), `~/.claude-omni-rc/logs/` (daemon.log).
  Override with `STATE_DIR`.
- The daemon talks to the Telegram Bot API and, for headless sessions, to the
  provider decided by the model (same rule as `omni-rc`): an explicit
  `ANTHROPIC_BASE_URL` (≠ Ollama) wins for every model; a `claude-*` model (or
  the `opus`/`sonnet`/`haiku`/`fable` aliases) means Anthropic natively;
  anything else is Ollama (`OLLAMA_BASE_URL`).

## Verify

- `node -v` is 22+; `./install.sh` finishes with the summary screen.
- `.env` contains `TELEGRAM_BOT_TOKEN` and one of `ALLOWED_USER_IDS` /
  `PAIRING_CODE`.
- `ollama list` shows `deepseek-v4-flash:cloud`.
- From Telegram: `/rc on` replies "🔓 Remote control ARMED"; `/new hello`
  creates a session; a permission request shows `✓ Approve / ✗ Reject`.

## Links

[README](https://github.com/ontech7/claude-omni-rc#readme) · [Landing](https://ontech7.github.io/claude-omni-rc/) · [CHANGELOG](https://github.com/ontech7/claude-omni-rc/blob/main/CHANGELOG.md) · [LICENSE](https://github.com/ontech7/claude-omni-rc/blob/main/LICENSE)
