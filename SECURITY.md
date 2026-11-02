# Security

`claude-omni-rc` gives a Telegram chat the ability to drive Claude Code sessions
on your machine. Read this before installing it.

## What you are granting

Claude Code can run shell commands, read and write files, and reach the network.
This project forwards that capability to Telegram. In practice:

> **Whoever can send messages to your bot, while remote control is armed, can run
> code on your computer as your user.**

There is no sandbox. Treat the bot token and the pairing code like SSH keys.

## Trust boundaries

| Boundary | What protects it |
|---|---|
| Who may command the bot | `ALLOWED_USER_IDS` (numeric Telegram ids) or a one-time `PAIRING_CODE`. Default-deny: with neither set, nobody is authorized. |
| When commands are accepted | The `armed` switch (`/rc on` / `/rc off`). While disarmed the daemon streams nothing, injects nothing and relays nothing. |
| Where output goes | The private chat bound at pairing time. Group and channel chats are refused outright — the bot does not answer there and never binds them as a notification target. |
| What a tool may do | The permission flow: headless sessions default to `standard` (every tool call needs an explicit ✓ Approve). `--auto` / `DEFAULT_PERMISSION_MODE=auto` disables it — see below. |
| Where headless sessions run | `WORKSPACE_DIRS`. `/new` refuses to start if it is unset; it never falls back to your home directory. |
| The local API | Bound to `127.0.0.1` only. It is unauthenticated — see "Known limitations". |

## What Telegram sees

Everything that reaches the chat passes through Telegram's servers: your
prompts, the model's replies, tool-call summaries, file paths, and any file or
screenshot you send. Bot chats are **not** end-to-end encrypted. Do not use this
on code you cannot afford to have on a third-party server.

## Automode

`--auto` (or `DEFAULT_PERMISSION_MODE=auto`) approves every tool call without
asking. That is an unattended agent with shell access to the directories in
`WORKSPACE_DIRS`. It is genuinely useful for long unattended tasks, and it is
genuinely dangerous. It is opt-in per session, and the default is `standard`.

In automode the plan is **approved automatically** too: when the model calls
`ExitPlanMode`, the plan is accepted without a prompt, so you cannot review or
edit it from Telegram. If you want to approve plans yourself, run the session
with `--standard`.

## The PermissionRequest hook is global

`./install.sh` adds a `PermissionRequest` hook to `~/.claude/settings.json`, so
it applies to **every** Claude Code session on the machine, not just the ones you
intend to control remotely. While remote control is armed, a permission prompt
in any session is forwarded to Telegram and blocks that terminal until you
answer or `PERMISSION_TIMEOUT_SECONDS` (default 120) elapses, which denies it.

The hook fails open: if the daemon is down, disarmed, or has no Telegram chat
bound, it returns no decision and Claude Code shows its normal in-terminal
prompt. Remove it any time with `./install.sh --uninstall` or `./scripts/stop.sh`.

## Known limitations

These are real and not yet fixed. They are listed here rather than hidden.

- **The loopback API is unauthenticated.** `127.0.0.1:${API_PORT}` accepts
  `POST /api/attach` and `GET /api/sessions` from any local process, and does not
  validate the `Host` header (so DNS-rebinding from a browser is possible). The
  impact is limited to registering or listing sessions, not executing tools.
- **Pairing codes do not expire and are not rate-limited.** A code stays valid
  after first use, failed `/start` attempts are unlimited, and there is no
  `/unpair`. To revoke an account, remove its id from `authorizedUserIds` in
  `~/.claude-omni-rc/state.json` and restart the daemon.
- **Notifications go to one chat.** With several ids in `ALLOWED_USER_IDS`, the
  chat bound last receives the streams. Any authorized user can rebind it.
- **`/attach <project>` does not reject `..`** in the project name, so it can
  point a tracked session outside `WORKSPACE_DIRS`.
- **With `MULTIPLEXER=zellij`, messages pass through `ps`.** zellij takes input
  as a command-line argument (`zellij action paste`), so each message you send
  to a terminal session is briefly visible to other accounts on the same
  machine. tmux receives it on stdin.
- **Secrets live in `.env` in plain text**, and the bot token also appears in the
  file-download URLs the daemon builds. Keep the repo directory private.

## Reporting a vulnerability

Open a [security advisory](https://github.com/ontech7/claude-omni-rc/security/advisories/new)
rather than a public issue. This is a hobby project maintained in spare time:
expect a best-effort response, not an SLA.
