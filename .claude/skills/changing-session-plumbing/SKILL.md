---
name: changing-session-plumbing
description: How the session pipeline of claude-omni-rc fits together — TmuxWatcher discovery, TranscriptWatcher tailing, SdkDriver headless turns, the Bus event contract, SessionManager state, and TmuxClient injection — and the failure modes to protect when changing any of it. Use this skill whenever you touch src/sessions/*, src/bus.ts, src/state.ts, src/permissions.ts or src/dialogs.ts, and whenever the user reports that a session doesn't appear in /sessions, messages don't stream to Telegram, a session is stuck "running", a worktree breaks streaming, permissions hang, or the daemon eats CPU — including in Italian ("la sessione non compare", "non arrivano i messaggi", "non streamma più", "la sessione è bloccata", "il daemon consuma CPU"). This is the part of the codebase where bugs are invisible until someone's phone goes quiet, so read it before editing.
---

# Changing session plumbing

Everything below `src/sessions/` exists to answer one question: *what is
happening in the user's Claude Code sessions right now, and how do I let a
phone talk to them?* The answers come from polling an OS that gives no
notifications, so the code is full of graces, retries and idempotence. When you
change it, the risk is never a crash — it's a session that silently stops
streaming while the daemon looks perfectly healthy.

## The pipeline

`src/daemon.ts` wires it, in this order — the order matters and is commented
there:

```
tmux (terminal sessions)                headless sessions (/new)
        │                                         │
  TmuxWatcher ──registers──┐          ┌──drives── SdkDriver ──► PermissionFlow
  (poll, ps/lsof cwd)      ▼          ▼                         DialogFlow
                      SessionManager ──owns──► StateStore (state.json)
        │                    ▲
  TranscriptWatcher ─────────┘
  (tails ~/.claude/projects/**.jsonl)
                             │
                             ▼
                            Bus ──► TelegramBot (streams, gated on armed)
                                 ◄── TmuxClient (injects text into the pane)
```

- **`TmuxWatcher`** discovers terminal sessions by polling `tmux list-sessions`
  for names shaped `claude:<project>`. It deliberately does *not* scan
  `~/.claude/projects` — that would adopt every unrelated Claude Code session
  on the machine into the registry. It resolves the pane's real cwd (`ps` +
  `lsof`, re-checked only every `CWD_REFRESH_MS`) because that's what lets a
  session that moved into a git worktree still find its transcript.
- **`TranscriptWatcher`** tails the CLI's JSONL transcript for each tracked
  terminal session and re-emits assistant/user messages onto the Bus — the same
  path headless sessions use, so the bot has one contract to render. Session
  status (working / waiting for the human) is *inferred* from the transcript.
- **`SdkDriver`** runs headless sessions through the Agent SDK, emitting the
  same Bus events and routing tool approvals to `PermissionFlow` and blocking
  dialogs to `DialogFlow`.
- **`SessionManager`** is the single owner of the session registry and the
  armed switch, persisted atomically by `StateStore`.
- **`TmuxClient`** is the only thing that writes into a pane (`send-keys`) and
  reads a screen (`capture-pane`) — or **`ZellijClient`** (`zellij-inject.ts`)
  when `MULTIPLEXER=zellij`. Both implement the `Multiplexer` interface in
  `tmux-inject.ts`; the watcher and the bot only see that interface, so a
  change to one client's behaviour usually needs the same change in the other.
  zellij differs in ways that matter here: a session survives its last
  terminal pane (`paneCommand` returns `undefined`), dead sessions are listed
  as EXITED, and every action must name its pane (`--pane-id`) because the
  focused pane can be a plugin.

## Rules that hold the whole thing together

**The Bus contract is `BusEvent` in `src/types.ts`.** Both producers
(`SdkDriver`, `TranscriptWatcher`) must emit the same shapes, because the bot
renders them without knowing which kind of session they came from. Adding a
field is fine; changing the meaning of one silently breaks the other producer.
The Bus is synchronous and has no error handling — a throwing handler takes
down the emitter, so handlers stay defensive.

**Everything is gated on `armed`.** `TmuxWatcher.poll` and
`TranscriptWatcher.poll` return immediately when disarmed, and every bus
subscription in the bot re-checks it. "Disarmed means the daemon does nothing"
is a promise made in the README, on the landing page and in SECURITY.md — a new
watcher or subscription that forgets the check breaks it.

**Polls must be self-limiting and non-overlapping.** `TmuxWatcher` holds a
`polling` flag because `ps`/`lsof` can take longer than `POLL_INTERVAL_MS`, and
overlapping polls stack spawns without limit. `TranscriptWatcher` wraps each
session in its own `try/catch` so one bad transcript can't stop the others. If
you add periodic work, copy both patterns and `unref()` the timer so it never
holds the process open.

**Disappearance needs a grace period, not a delete.** A missing tmux target is
given `PRUNE_GRACE_MS` (30s) because `/attach` can register a target that
hasn't started yet and a tmux restart shouldn't wipe the registry; a pane whose
`claude` process exited gets `CLAUDE_EXIT_GRACE_MS` (120s) because the human may
just be running a shell command before relaunching. Removing state is the one
irreversible thing this code does — when in doubt, wait another tick.

**Resolution must be re-doable.** Transcript paths, cwds and session bindings
are re-resolved rather than cached forever, because sessions move (worktrees)
and the CLI rotates files. If you cache something, cache it with an expiry and
a reason.

**Nothing here reads `process.env`.** Config arrives through the constructor.
That is what makes every one of these components testable without a machine
that has tmux, Ollama and a Telegram token.

## The failure modes to keep testing

Each of these is a bug this project already shipped and fixed — the CHANGELOG
is the list. They are the regression surface:

| Symptom | Where it comes from |
|---|---|
| session doesn't appear in `/sessions` | tmux name isn't `claude:<project>`, or the pane runs a shell (`SHELL_NAMES`) so it counts as exited |
| messages stop streaming after the session moves | cwd not re-resolved → transcript looked up in the old project dir |
| a fresh session shows the previous session's history | tail started from the beginning of a reused transcript file |
| permission prompt hangs forever | no bound notification chat — must deny (or defer to the native prompt), never block |
| session stuck on "running" | a status inferred from the transcript that has no path back to idle |
| idle CPU climbs | overlapping polls, or a per-session `ps` instead of one snapshot per poll |
| daemon dies overnight | an unhandled rejection from a fire-and-forget send; use `track()`/`.catch` at the edges |

When you change anything in this area, write the test that reproduces the
symptom in the left column before the fix, using fake timers rather than real
sleeps — see the `writing-tests` skill. Timing tests here are the ones most
likely to go flaky on CI, and `test/transcript-watcher.test.ts` already has the
precedent for how to keep them deterministic.

## Working on it safely

Read the file's header comment before editing: these modules carry long
explanations of *why* a grace, a flag or a fallback exists, and most of them
document a bug that took a while to find. If a comment seems to contradict your
change, that's the signal to slow down, not to delete the comment.

Verify with `npm run typecheck && npm test`. A real end-to-end check needs tmux,
a bot token and a phone, which CI doesn't have — so if you can't exercise the
path for real, say which parts are covered by tests and which are not, rather
than reporting it as verified.
