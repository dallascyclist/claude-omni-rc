# claude-omni-rc

Local daemon + Telegram bot that replaces Claude Code's `/remote-control` for
any model running through the Claude Code CLI (Ollama, a proxy, or Anthropic).
Node 22+, TypeScript ESM, no build step — `tsx` runs the sources directly.

**What this repo really is:** a program that forwards the ability to run
commands on someone's machine to a chat app, with no sandbox. Every decision
below follows from that. When a change makes the tool friendlier but the
failure mode worse, the failure mode wins.

## Commands

```bash
npm run dev          # run the daemon in the foreground (tsx src/daemon.ts)
npm run typecheck    # tsc --noEmit   ← CI runs this
npm test             # vitest run     ← CI runs this
npx vitest run test/permissions.test.ts   # a single file while iterating
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run typecheck && npm test`
on Node 22. That is the whole automated gate: no linter, no formatter, no
coverage threshold, no e2e. Everything else is caught by a human or not at all.

## Map

| Path | What lives there |
|---|---|
| `src/daemon.ts` | wiring: builds every component and starts/stops them, in a deliberate order |
| `src/config.ts` | `loadConfig(env)` — the **only** place `process.env` is read |
| `src/bus.ts`, `src/types.ts` | the synchronous event bus and the `BusEvent` contract both session kinds emit |
| `src/sessions/` | `manager` (registry + armed switch), `tmux-watcher` (discovery), `transcript-watcher` (tailing), `sdk-driver` (headless turns), `tmux-inject` / `zellij-inject` (pane I/O, picked by `MULTIPLEXER`), `transcript` (JSONL parsing) |
| `src/permissions.ts`, `src/dialogs.ts` | approval and blocking-dialog flows, with their timeouts |
| `src/state.ts` | `state.json`, written atomically; a corrupt file is preserved, never overwritten |
| `bot/render.ts` | pure presentation: markdown→HTML, tag splitting, tool-call descriptions, agent card |
| `bot/telegram.ts` | every Telegram command, button and stream; the presentation lives in `bot/render.ts` |
| `test/` | one Vitest file per module, `sessions/` flattened |
| `index.html`, `assets/` | the GitHub Pages landing page — a merged commit is a live deploy |
| `install.sh`, `scripts/` | interactive installer, launchd unit, hooks, the `omni-rc` launcher |
| `docs/superpowers/` | historical plans and design specs; context, not current truth |

## Non-negotiables

- **Disarmed means nothing happens.** While `/rc` is off the bot answers only
  `/rc`, `/help`, `/start` — no streaming, no injection, no relay. Watchers
  return early; every bus subscription re-checks `isArmed()`.
- **Default-deny authorization.** No `ALLOWED_USER_IDS` and no `PAIRING_CODE`
  means nobody is authorized. Private chats only — never a group or channel.
- **Failures land on the safe side.** An unanswered permission denies. A
  missing notification target denies instead of blocking. An unknown dialog
  kind answers `cancelled`. Permissive behaviour is always an explicit opt-in.
- **Config is read once**, in `loadConfig()`. Components take what they need in
  their constructor. A `process.env.X` anywhere else is invisible to tests, to
  `.env.example` and to the installer.
- **Every dynamic fragment sent to Telegram is `htmlEscape`d**, and every reply
  goes through `this.send()` so `splitHtmlMessage` handles the 4096-char limit.
  Both failures are silent: the message simply never arrives.
- **Removing state needs a grace period**, not a delete. Sessions disappear
  from tmux for boring reasons; waiting another tick is always cheaper than
  losing someone's session.
- **Docs ship in the same commit as the code.** `AI-GUIDE.md` is executed by
  agents, `.env.example` is copied by users, the README is read before someone
  runs an unsandboxed daemon. Stale docs here are wrong docs.

## Style

- TypeScript `strict`, ESM. Relative imports carry the **`.js` extension**
  (`import { Bus } from './bus.js'`) even for `.ts` sources.
- Pure logic goes in exported top-level functions so it can be tested directly;
  stateful pieces take their dependencies in the constructor. This is why the
  suite needs no mocking library.
- No new runtime dependencies without asking. The three that exist
  (`@anthropic-ai/claude-agent-sdk`, `grammy`, `dotenv`) are the budget.
- Comments explain **why**, not what — a grace period, a re-entrancy flag, a
  fallback usually encodes a bug that took a while to find. If a comment seems
  to contradict your change, slow down rather than deleting it. Some existing
  comments are in Italian; leave them, write new ones in English, and keep all
  user-facing strings and docs in English.
- Conventional Commits with an optional scope (`fix(bot): …`, `feat: …`,
  `test(transcript-watcher): …`, `chore: …`), imperative, one concern each.
  Commit to the working branch, never straight to `main`.

## Skills

These live in `.claude/skills/` and carry the detail this file deliberately
leaves out. Read the matching one **before** editing, not after something
breaks:

| Task | Skill |
|---|---|
| touching `index.html` or `assets/` | `editing-the-landing-page` |
| writing or fixing anything in `test/` | `writing-tests` |
| a Telegram command, flag or button | `adding-a-bot-command` |
| a new setting, or changing a default | `adding-a-config-option` |
| anything in `src/sessions/`, the bus, or state | `changing-session-plumbing` |
| committing, pushing, releasing | `shipping-a-change` |
| starting any implementation, adding a dependency, deciding how much to build | `keep-it-simple` |
| opening a pull request | `open-pr` (runs the `pr-reviewer` subagent first) |

The `pr-reviewer` subagent (`.claude/agents/pr-reviewer.md`) does a
senior-architect self-review of the current branch — edge cases, bugs by
severity, security, consistency — and is invoked by `open-pr` before the PR is
created.

## Reporting work

Say what you ran and what you couldn't verify. A real end-to-end check needs
tmux, a bot token and a phone; CI has none of them, and neither does a sandbox.
"typecheck and tests pass, the tmux path is covered by unit tests but I couldn't
exercise a live session" is a complete answer. A confident "done" over an
unverified assumption is how a broken daemon reaches someone's phone at 2am.
