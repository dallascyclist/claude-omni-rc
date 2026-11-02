<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="claude-omni-rc" width="520">
  </picture>
</div>

<p align="center"><br><strong>Take your session with you.</strong><br><br>
A local daemon plus a Telegram bot that mimics Claude Code's
<code>/remote-control</code> — keep talking to any running session from your
phone, approve permissions, and pick up exactly where you left off — without
any Anthropic infrastructure. It works with <em>any</em> model that runs
through the Claude Code CLI: Ollama-served models, other local or proxied
LLMs, or Claude itself.</p>

<p align="center">
  <a href="https://github.com/ontech7/claude-omni-rc/actions/workflows/ci.yml"><img src="https://github.com/ontech7/claude-omni-rc/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white" alt="Node 22+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ontech7/claude-omni-rc" alt="License"></a>
</p>

<p align="center"><sub><a href="https://ontech7.github.io/claude-omni-rc/">Landing page</a> · <a href="SECURITY.md">SECURITY.md</a> · <a href="AI-GUIDE.md">AI-GUIDE.md</a> — AI agents, start at <a href="AI-GUIDE.md">AI-GUIDE.md</a></sub></p>

---

<img width="2200" height="787" alt="screenshot1" src="https://github.com/user-attachments/assets/9140bb1a-bb74-4330-a095-fff62e874b42" />

Headline use case: you leave a long task running, arm claude-omni-rc, walk out
the door — and keep steering that session, plus any other you have running,
from your phone. Starting brand-new conversations is a bonus, not the point.

**Why not the native `/remote-control`?** Since Claude Code v2.1.196 it is
disabled when `ANTHROPIC_BASE_URL` doesn't point at `api.anthropic.com`, it
needs a claude.ai account, and it syncs transcripts through Anthropic's
servers. `claude-omni-rc` is the local replacement: a daemon on your machine
plus a Telegram bot (long-polling, outbound-only, no open ports), gated by an
explicit `armed` switch. Unofficial, not affiliated with Anthropic or Ollama.

## Install

```bash
git clone https://github.com/ontech7/claude-omni-rc
cd claude-omni-rc
./install.sh
```

The guided installer asks only what it needs — bot token, who may control it,
where headless sessions may run — then installs dependencies, registers the
background daemon and adds the Claude Code hooks. It never overwrites a value
already in `.env`. Then, from Telegram: `/start <code>` if you chose a pairing
code, and `/rc on`.

`./install.sh --uninstall` removes the launchd agent, the hooks and the
`omni-rc` shell function, and asks before touching the Ollama model and the
state dir. Your `.env` is kept.

| Requirement | Why |
|---|---|
| **Node.js 22+** | runtime (required) |
| **Ollama**, running | the default provider — not needed if you point `ANTHROPIC_BASE_URL` at another one |
| **tmux** (or **zellij** 0.44+) | required for terminal sessions: 1:1 input injection and `/view` — see [Using zellij](#using-zellij-instead-of-tmux) |

### Manual install

<details>
<summary>What <code>./install.sh</code> does under the hood, step by step</summary>

**1. Bot token.** Message [@BotFather](https://t.me/BotFather), send `/newbot`,
copy the token.

**2. `.env`.** `cp .env.example .env`, then fill in at least:

- `TELEGRAM_BOT_TOKEN`
- one authorization method: `ALLOWED_USER_IDS` (your numeric id, from
  [@userinfobot](https://t.me/userinfobot)) or `PAIRING_CODE` (a secret; the
  first `/start <code>` authorizes that account)
- `WORKSPACE_DIRS` — required by `/new`

**3. Run.**

```bash
npm install
./scripts/install-launchd.sh   # background daemon, restarts on login
```

For a foreground test instead: `npm run dev`. Logs go to
`~/.claude-omni-rc/logs/daemon.log`.

| Script | What it does |
|---|---|
| `./scripts/start.sh` | installs anything missing, then starts the daemon |
| `./scripts/stop.sh` | stops the daemon, kills headless sessions, removes the hooks |
| `./scripts/restart.sh` | reload after code changes (`status` to check) |

`stop.sh` removes the SessionStart/PermissionRequest hooks from
`~/.claude/settings.json`, so sessions stop auto-attaching until you run
`start.sh` again. Your own tmux/zellij sessions are never touched.

</details>

## Usage

<img width="1099" height="661" alt="screenshots2" src="https://github.com/user-attachments/assets/4b63c273-fb24-4181-9fe1-d2a2c0989ddb" />

Run your interactive sessions inside tmux — the installer adds an `omni-rc`
shell function that does it for you:

```bash
omni-rc my-project                          # tmux session claude:my-project + claude
omni-rc my-project -c ~/code/my-project -m deepseek-v4-flash:cloud
omni-rc my-project -p "review the current diff"
omni-rc -l                                  # list claude:* sessions
```

It picks the provider the same way headless sessions do: `DEFAULT_MODEL` from
`.env` by default (Ollama), a `claude-*` model (or the `opus`/`sonnet`/`haiku`/
`fable` aliases) runs on Anthropic, and an explicit `ANTHROPIC_BASE_URL` wins
over both. `omni-rc --help` lists every option; an existing session is just
reattached.

### Using zellij instead of tmux

Set `MULTIPLEXER=zellij` in `.env` and restart the daemon (the installer does
it for you when zellij is installed and tmux isn't). Everything else stays the
same: sessions are still named `claude:<project>`, `omni-rc` starts them in
zellij, and input, `/view`, `/stop` and question answers go through
`zellij action`. Needs zellij 0.44+ (developed and tested on 0.46).

```bash
omni-rc my-project                          # zellij session claude:my-project + claude
zellij -s claude:my-project                 # or start one by hand, then run claude in it
```

The daemon drives one multiplexer at a time. A session running in the other one
is still mirrored to Telegram through the `SessionStart` hook, read-only. In a
zellij session with several panes, the pane running `claude` is the one that
receives input; if no pane runs `claude` (for instance it was started by a
wrapper script), input is refused rather than typed into another pane. When
claude exits in a session started by `omni-rc`, the session closes like a tmux
one does.

| Command | What it does |
|---------|--------------|
| `/start <code>` | pair this Telegram account (first time) |
| `/rc` · `/rc on` · `/rc off` · `/rc status` | global armed switch — no argument toggles it |
| `/sessions` | list sessions, switch the active one |
| `/view` | show the active session's current screen |
| `/new [--auto\|--standard] [--model <name>] [--effort <level>] <text>` | headless session + your prompt (standard by default: approve/reject buttons) |
| `/attach <project>` | attach a `claude:<project>` tmux (or zellij) session |
| `/stop` | abort the running turn (Ctrl+C for a terminal pane) |
| `/status` | the active session's status |
| `/history [id]` | last messages of a session |
| `/delete [id]` | delete a session (headless: stops it; terminal: untracks only) |
| `/usage` | 5h / weekly usage for the configured provider |
| `/context` | the active session's context used vs max (tokens) |
| `/compact` | compact the active session's history (runs the CLI's `/compact`) |
| `/settings [key [value]]` · `/settings reset <key>` | view / change user settings; saved to `settings.json`, applies at the next daemon restart |
| `/diag` | daemon state, sessions, pending interactions, recent errors; per session: model · effort · git branch |
| `/help` | list the commands |

Plain text goes to the active session — a new turn for headless sessions, typed
input (pasted + Enter) for terminal ones. **Slash commands the bot doesn't own
are not forwarded**: they get an "Unknown command" reply instead. Forwarding
them used to paste CLI-only commands into the session, and some (like
Claude Code's `/context`) are interactive UIs that can leave a session stuck.
The useful ones are bot commands instead — `/context` for the context window,
`/compact` to compact the history — so keep the CLI's other commands in the
terminal.

### How sessions get attached

Only **your sessions** are tracked — nothing scans `~/.claude/projects` on its
own. A session appears via `claude:*` tmux/zellij discovery, the `SessionStart` hook,
or `/attach`, whatever model backs it.

- **Chat, not screen** — the daemon tails the conversation the CLI writes and
  streams it as a chat: markdown-rendered replies (code blocks with their
  language, quotes, tables), your prompts echoed, and each tool call described
  in words — `📖 Read · bot/telegram.ts` or `⚡ Bash` with the command on its
  own line — instead of a wall of JSON. Paths are shortened relative to the
  project, Skills, MCP servers and subagents are recognized, and failed calls
  are marked `❌`. Per work burst the calls gather into one **silent** bubble
  that collapses into a `▸ N steps` expandable blockquote when the turn ends.
  Notifications are event-driven (`❓` questions, permission buttons, `❌` on
  serious errors), with no status chatter in between. History is never
  replayed: streaming starts when you select the session with `/sessions`.
- **Multiple-choice questions** arrive as a `❓` message, one question at a time
  (single-select, multi-select with toggle + Done, and a free-text "Other"
  option). Question sets are queued and shown in sequence; tap an option, or
  reply with the option number.
- **Plan approval** (headless sessions) arrives as a 📋 message with the plan
  text and ✓ Approve / ✗ Reject / ✏️ Edit buttons — Edit asks you to send the
  new plan text as a message, and the edited plan is sent back to the session.
  A model refusal offers 🔄 Retry / Skip. Any other blocking dialog the CLI asks
  for is shown with a Cancel button rather than ignored, so a session never
  parks waiting for input you can't give. **Terminal sessions work the same
  way**: the plan approval is a full-screen interactive UI inside the terminal
  pane, but the ✓ Approve / ✗ Reject / ✏️ Edit buttons resolve it from
  Telegram — the decision is sent back to the CLI with the plan as
  `updatedInput`, which is what the CLI needs to exit plan mode.
- **Interact 1:1** — your message is pasted into the pane and submitted. Needs
  tmux (or zellij, see `MULTIPLEXER`); a session outside it streams as chat but
  is read-only.
- **Headless sessions** (`/new`) run in the first `WORKSPACE_DIRS` entry, which
  must be set — `/new` refuses to start rather than falling back to your home
  directory. They ask before **every** tool call by default; `--auto` runs them
  unattended (read [SECURITY.md](SECURITY.md#automode) first), and
  `DEFAULT_PERMISSION_MODE=auto` makes that the default. They use the provider
  from `.env`, falling back to Ollama. **In automode the plan is approved
  automatically** — the model's plan is accepted without a prompt, so you cannot
  review or edit it from Telegram. Use `--standard` (or `/new` without `--auto`)
  when you want to approve plans yourself.
- **Subagent cards** — in headless sessions a subagent's activity gets its own
  `🤖 Agent` card instead of mixing into the main chat. Collapsed it shows the
  agent type, the task and its progress (`⏳ 7 steps · 42s`); tap `👁 Details`
  to expand its tool calls, `🙈 Hide` to collapse again, and the card flips to
  `✅` (or `❌` on failure) when the subagent finishes. **Headless only**:
  a subagent inside a terminal session has no card and shows just the `🤖
  Agent` line in the stream.
- **`/view`** grabs the raw current screen whenever you want the terminal.

### Remote permissions

Permission requests arrive as a message with `✓ Approve` / `✗ Reject`, from
headless and terminal sessions alike. Unanswered, they time out after
`PERMISSION_TIMEOUT_SECONDS` (default 120) and are denied. Tools already
covered by your allowlist rules never generate a notification.

Headless sessions use the Agent SDK flow (`canUseTool`); terminal sessions go
through a `PermissionRequest` hook. **The hook fails open**: when the daemon is
down, disarmed, or has no Telegram chat bound, it returns no decision and
Claude Code shows its normal in-terminal prompt — a regular session is never
blocked or auto-denied.

<details>
<summary>The two Claude Code hooks, and how to add them by hand</summary>

`./install.sh` adds both to `~/.claude/settings.json` (idempotently):

- **`SessionStart`** — registers every session with the daemon the moment it
  starts, recording the tmux or zellij session as the injection target. A session started
  without the `claude:` naming convention is still continuable from Telegram.
- **`PermissionRequest`** — delegates CLI permission decisions to Telegram.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "/abs/path/to/claude-omni-rc/scripts/attach.sh", "timeout": 10 }] }
    ],
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "/abs/path/to/claude-omni-rc/scripts/permission-hook.sh", "timeout": 600 }] }
    ]
  }
}
```

Note that `PermissionRequest` is global: it applies to every Claude Code session
on the machine. See [SECURITY.md](SECURITY.md) for what that implies.

</details>

### Usage windows (`/usage`)

<img width="540" height="132" alt="6041639000054894732" src="https://github.com/user-attachments/assets/fd8c900f-5d49-48b9-b6e3-4578759d26ca" />

`/usage` checks the 5-hour and weekly windows for whichever provider the
**active session** uses (or `DEFAULT_MODEL` when there is no active session) —
the same model-aware detection `omni-rc`/headless sessions use: an explicit
`ANTHROPIC_BASE_URL` (≠ Ollama) wins for every model; a model starting with
`claude-` (or the `opus`/`sonnet`/`haiku`/`fable` aliases) means Anthropic;
anything else is Ollama.

- **Anthropic** (a claude.ai Pro/Max/Team/Enterprise session): read via the
  Agent SDK's experimental `/usage` control API — no extra install needed. API
  key / Bedrock / Vertex auth has no plan rate limits, so the bot says so
  instead of a number.
- **Non-Anthropic** (Ollama, or any other `ANTHROPIC_BASE_URL`): requires
  [`ollama-usage`](https://github.com/ontech7/ollama-usage) installed and
  authenticated (`ollama-usage auth`) **on the machine running the daemon** —
  `/usage` shells out to `ollama-usage --json`. If it's missing, the bot
  replies with the install command. The daemon's PATH includes `~/.local/bin`
  and `~/bin` (where `ollama-usage` is typically installed) even under launchd.

### Media

Files and photos are saved to `~/.claude-omni-rc/inbox/` and forwarded to the
session as a **file-path reference**, which the model reads via its extra
directories. There is no image-input pipeline: a text-only model cannot *see* a
picture you send.

## Security

`claude-omni-rc` forwards Claude Code's ability to run commands on your machine
to a Telegram chat. **Whoever can message your bot while remote control is armed
can run code as your user.** There is no sandbox.

- Authorization is default-deny — set `ALLOWED_USER_IDS` or `PAIRING_CODE`.
- Everything is gated on the `armed` switch (`/rc off` kills streaming,
  injection and relay).
- The bot works **only in a private chat**; it refuses groups and channels.
- Headless sessions ask before every tool call unless you opt into `--auto`.
- Your prompts, the model's replies and any file you send pass through
  Telegram's servers, which are not end-to-end encrypted for bots.

Read [SECURITY.md](SECURITY.md) for the full trust boundaries, the caveat about
the globally-installed `PermissionRequest` hook, and the known limitations
(unauthenticated loopback API, non-expiring pairing codes).

## Configuration

`.env` (or environment variables). Everything is optional except the bot token
and one authorization method — plus `WORKSPACE_DIRS` if you want `/new`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | — | bot token from @BotFather (**required**) |
| `ALLOWED_USER_IDS` | — | comma-separated Telegram ids allowed to control |
| `PAIRING_CODE` | — | secret code authorizing the first `/start <code>` |
| `WORKSPACE_DIRS` | — | `:`-separated project roots for `/attach`; **required by `/new`**, which runs headless sessions in the first one |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | where Ollama listens; also the fallback provider |
| `ANTHROPIC_BASE_URL` | — | provider for sessions (unset → Ollama); e.g. `https://api.anthropic.com` or a proxy |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | — | credentials for that provider (Ollama uses the placeholder `ollama` token) |
| `DEFAULT_MODEL` | `deepseek-v4-flash:cloud` | model for headless sessions (per-session: `/new --model`) |
| `DEFAULT_PERMISSION_MODE` | `standard` | permission mode for `/new` without a flag; `auto` runs unattended |
| `DEFAULT_EFFORT` | `medium` | reasoning effort for headless `/new` without a flag (per-session: `/new --effort`) |
| `MAX_HEADLESS_SESSIONS` | `2` | concurrent headless sessions |
| `PERMISSION_TIMEOUT_SECONDS` | `120` | unanswered permission → deny |
| `STATE_DIR` | `~/.claude-omni-rc` | where state, logs and the inbox live |
| `INBOX_DIR` | `<STATE_DIR>/inbox` | incoming attachments |
| `PROJECTS_DIR` | `~/.claude/projects` | where Claude Code stores session transcripts |
| `API_PORT` | `4123` | loopback port for the local API (both hooks) |
| `ARMED_ON_START` | `false` | arm the remote control on daemon start |
| `IDLE_GRACE_MS` | `3000` | how long a session must be quiet to count as idle |
| `MULTIPLEXER` | `tmux` | `tmux` or `zellij`: where `claude:<project>` sessions run (discovery, input, `/view`, `/stop`) |
| `POLL_INTERVAL_MS` | `500` | tmux/zellij discovery polling interval |
| `CWD_REFRESH_MS` | `10000` | how often to re-check a session's real cwd (costs a `ps` + `lsof`) |
| `CLAUDE_OMNI_RC_NO_UPDATE_CHECK` | unset | set to disable the GitHub release check below |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` for the structured log |
| `LOG_FILE` | `<STATE_DIR>/logs/daemon.jsonl` | where the structured log is written |
| `LOG_MAX_BYTES` | `5000000` | rotate the structured log past this size |
| `LOG_KEEP` | `3` | how many rotated log files to keep |

Settings changed from Telegram with `/settings` are stored in
`<STATE_DIR>/settings.json` and take precedence over the `.env` values above.
They cover `DEFAULT_MODEL`, `DEFAULT_PERMISSION_MODE`,
`MAX_HEADLESS_SESSIONS`, `PERMISSION_TIMEOUT_SECONDS`, `ARMED_ON_START`,
`CLAUDE_OMNI_RC_NO_UPDATE_CHECK` and `DEFAULT_EFFORT`, and apply at the next
daemon restart.

> `~/.claude-omni-rc/logs/daemon.jsonl` is the structured log, one JSON record
> per line, rotated at `LOG_MAX_BYTES`. `daemon.log` and `daemon.err.log` remain
> the raw process output from launchd and have no automatic rotation — that's
> left to the OS (`newsyslog`) or to you.

## Update notifications

The daemon checks GitHub once a day (on start, then every 24h) for a newer
release. When one exists, it logs a one-line notice to `daemon.log` **and**
sends it to your bound Telegram chat — at most once per version:

```
⬆️ New version available: claude-omni-rc 0.4.0 (you have 0.3.0) — https://github.com/ontech7/claude-omni-rc/releases
```

Disable it with `CLAUDE_OMNI_RC_NO_UPDATE_CHECK=1` in `.env`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"Not authorized"* | Send `/start <PAIRING_CODE>`, or add your id to `ALLOWED_USER_IDS`. The bot ignores group chats entirely. |
| *"Remote control is off"* | The armed switch doing its job: send `/rc on` (or set `ARMED_ON_START=true`). |
| *"/new refuses to start"* | `WORKSPACE_DIRS` is unset. There is no fallback to `$HOME` on purpose. |
| The daemon seems dead | Check `~/.claude-omni-rc/logs/daemon.{log,err.log}`, then `npm run dev` to see errors live. |
| A session is stuck on *running* | `/stop` aborts the turn via `AbortController`. |
| Text *"can't be injected"* | That session isn't in the multiplexer the daemon drives (`MULTIPLEXER`). Restart it with `omni-rc <name>`. |
| A session doesn't show up | Sessions come from `claude:*` tmux/zellij discovery, the SessionStart hook or `/attach`. Check the hook is in `~/.claude/settings.json`, the daemon is up, and `API_PORT` is free. |
| zellij sessions don't show up (`MULTIPLEXER=zellij`) | zellij finds its sessions through `$TMPDIR`: if the daemon runs with a different `TMPDIR` than your shell, it sees none. Compare `zellij list-sessions` from the shell with `npm run dev`. |
| The session streams nothing | Only the **active** session streams — select it with `/sessions`. If it has no transcript, use `/view`. Check `PROJECTS_DIR` matches where the CLI writes. |
| Permission prompts hang in the terminal | The daemon is armed but has no chat bound. Send any message to the bot; the chat is then remembered across restarts. |
| A terminal session shows a plan I can't approve from the phone | The plan approval is a full-screen terminal UI, but the ✓ Approve / ✗ Reject / ✏️ Edit buttons resolve it from Telegram (the decision is sent back with the plan as `updatedInput`). If the buttons don't appear, check the daemon is armed and a chat is bound. |
| A message never arrived on Telegram | `/diag` from the phone, then `~/.claude-omni-rc/logs/daemon.jsonl`: every event carries an `eventId` from the transcript to the delivered message, and a dropped one is logged with its reason. |

**Can I move a running session into tmux?** No — a running process can't be
adopted by tmux. A session started outside tmux is still mirrored read-only
(you can follow it from your phone), but you lose input injection and `/view`.
Start it with `omni-rc <name>` from the beginning; the SessionStart hook warns
you when you don't.

**Where is my data?** State in `~/.claude-omni-rc/state.json`, attachments in
`inbox/`, logs in `logs/`. Override the root with `STATE_DIR`.

<details>
<summary><b>Architecture</b></summary>

```
src/
├── daemon.ts            entry: config, wiring, shutdown
├── config.ts            .env → typed config
├── bus.ts               typed pub/sub event bus
├── state.ts             persistent registry (atomic writes)
├── permissions.ts       canUseTool / hook → Approve/Reject flow
├── api.ts               loopback HTTP API (both hooks, session list)
├── input.ts             attachments → inbox
├── ollama.ts            capabilities, context length, tool-call summaries
└── sessions/
    ├── manager.ts       session registry + armed switch + idle reaping
    ├── sdk-driver.ts    headless sessions (Agent SDK query + resume)
    ├── tmux-watcher.ts  discover `claude:*` sessions, prune dead ones
    ├── tmux-inject.ts   pane cwd, capture-pane, paste-and-Enter input
    ├── zellij-inject.ts the same for zellij (MULTIPLEXER=zellij)
    ├── transcript.ts    read the CLI transcripts
    └── transcript-watcher.ts  tail transcripts → chat events + status
bot/telegram.ts          grammy bot: commands, keyboards, chat streaming
```

Data flow: `Telegram ↔ bot ↔ bus ↔ sessions (SDK / tmux or zellij) ↔ provider`.

- **Headless sessions** are owned by the daemon and driven via the Claude Agent
  SDK (`query` + `resume`, `canUseTool`), version **0.3.221** (pinned — the SDK
  is in preview and changes fast). Session ids are persisted, so they survive
  daemon restarts.
- **Terminal sessions** are discovered from tmux (or zellij) and streamed by tailing the
  transcript the CLI writes; input is driven 1:1 by pasting into the pane.
  Streaming runs only while armed, and follows the session selected in
  `/sessions`.
- **State** — the armed switch, the session registry and the bound chat — lives
  in `~/.claude-omni-rc/state.json`.

</details>

## License & disclaimer

MIT — see [LICENSE](LICENSE). Copyright (c) 2026.

An **unofficial** project: it talks to your configured provider and the Telegram
Bot API, nothing else. The Claude Agent SDK is a preview and may change — the
version is pinned for a reason. Not affiliated with Anthropic or Ollama.
