import type { EffortLevel } from '../types.js';
import {
  createShExec, snapshotProcesses, findClaudeBelow, processCwd, processFlag, asEffort,
  type ExecFn, type ShExecFn, type Multiplexer, type ProcessTree, type QuestionKey,
} from './tmux-inject.js';

// zellij counterpart of TmuxClient (MULTIPLEXER=zellij). Written against the
// zellij 0.44+ CLI: `action list-panes --json` and `--pane-id` on paste,
// send-keys, write-chars and dump-screen. Every action names its pane
// explicitly: the focused pane of a fresh session is often a plugin (the "About
// Zellij" popup), so an action without --pane-id lands in the wrong place.

export function createZellijExec(opts: { timeoutMs?: number } = {}): ExecFn {
  const sh = createShExec(opts);
  return (args, o) => sh('zellij', args, o);
}

// Subset of one entry of `zellij action list-panes --all --json`.
export interface ZellijPane {
  id: number;
  is_plugin: boolean;
  is_focused?: boolean;
  exited?: boolean;
  pane_command?: string | null;
  pane_cwd?: string | null;
}

// `zellij list-sessions --no-formatting` prints `<name> [Created …] (…)` per
// line. Sessions marked EXITED are dead ones kept on disk for resurrection: they
// must not count as alive, or a session whose zellij died would never be pruned.
export function parseZellijSessions(stdout: string): string[] {
  return stdout.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.includes('(EXITED'))
    .map(l => l.split(' [Created')[0].trim())
    .filter(Boolean);
}

// Basename of the first word of a pane command. zellij reports the whole
// command line of the pane's foreground process (`/bin/zsh`, `claude --model x`),
// tmux just its name; the watcher compares names against SHELL_NAMES.
export function commandName(paneCommand: string): string {
  const first = paneCommand.trim().split(/\s+/)[0] ?? '';
  return first.split('/').pop() ?? '';
}

function runsClaude(paneCommand: string | null | undefined): boolean {
  return (paneCommand ?? '').split(/\s+/).some(w => w.split('/').pop() === 'claude');
}

// The pane that stands for the session: a live terminal pane, preferring the
// one running claude, then the focused one. Plugins (tab bar, status bar, About
// popup) and exited command panes are never targets. undefined when the
// session has no live terminal pane left.
export function pickPane(panes: ZellijPane[]): ZellijPane | undefined {
  const live = panes.filter(p => !p.is_plugin && !p.exited);
  return live.find(p => runsClaude(p.pane_command)) ?? live.find(p => p.is_focused) ?? live[0];
}

// The pane that receives input: stricter than pickPane. With several live
// panes and none running claude (claude exited, or was started by a wrapper
// script), the fallback would type a Telegram message plus Enter into whatever
// pane is focused — an editor, or a shell that runs it. Refuse instead. A lone
// pane keeps tmux's behaviour: it is the session's pane.
export function pickInputPane(panes: ZellijPane[]): ZellijPane | undefined {
  const live = panes.filter(p => !p.is_plugin && !p.exited);
  return live.find(p => runsClaude(p.pane_command)) ?? (live.length === 1 ? live[0] : undefined);
}

// How long the read-only answers the watcher polls (session list, pane
// command) are reused. Every poll asks for the session list twice and for each
// tracked session's pane command, and a zellij CLI call costs ~10ms of CPU
// against ~2ms for tmux: re-asking every POLL_INTERVAL_MS tripled the daemon's
// idle CPU. A second of staleness is harmless next to the 30s/120s prune
// graces; input, capture and cwd always read fresh panes.
export const READ_TTL_MS = 1000;

// The bot speaks tmux key names (`C-c`); zellij spells modifiers as words.
// Named keys used by the question menus (Down, Enter) and digits are the same.
export function toZellijKey(key: string): string {
  const ctrl = key.match(/^C-(.)$/);
  return ctrl ? `Ctrl ${ctrl[1]}` : key;
}

// The pid of the zellij server for a session, from `ps -x -o pid=,args=`: each
// session has its own `zellij --server <socket-dir>/<session-name>` process and
// the pane processes are its children. zellij exposes no pane pid, so this is
// the root the claude search starts from.
export function findServerPid(psOutput: string, session: string): string | undefined {
  for (const line of psOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[2].trimEnd();
    if (args.includes(' --server ') && args.endsWith(`/${session}`)) return m[1];
  }
  return undefined;
}

export class ZellijClient implements Multiplexer {
  private reads = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private exec: ExecFn = createZellijExec(),
    private sh: ShExecFn = createShExec(),
  ) {}

  private cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.reads.get(key);
    if (hit && now - hit.at < READ_TTL_MS) return hit.value as Promise<T>;
    const value = read();
    this.reads.set(key, { at: now, value });
    return value;
  }

  async processTree(): Promise<ProcessTree | undefined> {
    return snapshotProcesses(this.sh);
  }

  // zellij has no single server: each session is its own. With no session at
  // all — live or EXITED — `list-sessions` exits 1 with this message: a definite
  // "there are none", so the last claude session still gets pruned after its
  // grace. Any other failure is ambiguous and reported as not running, which
  // makes the watcher skip pruning, as it does when the tmux server is down.
  private listing(): Promise<{ ok: boolean; names: string[] }> {
    return this.cached('list-sessions', async () => {
      const r = await this.exec(['list-sessions', '--no-formatting']);
      if (r.code === 0) return { ok: true, names: parseZellijSessions(r.stdout) };
      if (`${r.stderr}${r.stdout}`.includes('No active zellij sessions found')) return { ok: true, names: [] };
      return { ok: false, names: [] };
    });
  }

  async listSessions(): Promise<string[]> {
    return (await this.listing()).names;
  }

  async serverRunning(): Promise<boolean> {
    return (await this.listing()).ok;
  }

  private async panes(target: string): Promise<ZellijPane[]> {
    const r = await this.exec(['--session', target, 'action', 'list-panes', '--all', '--json']);
    if (r.code !== 0) throw new Error(`zellij list-panes failed: ${r.stderr.trim()}`);
    const parsed = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error('zellij list-panes: unexpected output');
    return parsed as ZellijPane[];
  }

  private async pane(target: string): Promise<ZellijPane> {
    const p = pickPane(await this.panes(target));
    if (!p) throw new Error(`zellij session has no terminal pane: ${target}`);
    return p;
  }

  private async inputPane(target: string): Promise<string> {
    const p = pickInputPane(await this.panes(target));
    if (!p) throw new Error(`no pane running claude in zellij session ${target}`);
    return `terminal_${p.id}`;
  }

  private async action(target: string, args: string[]): Promise<string> {
    const r = await this.exec(['--session', target, 'action', ...args]);
    if (r.code !== 0) throw new Error(`zellij ${args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  async capturePane(target: string): Promise<string> {
    const p = await this.pane(target);
    return this.action(target, ['dump-screen', '--pane-id', `terminal_${p.id}`]);
  }

  // The cwd of the pane's shell, not of its foreground process: like tmux's
  // pane_current_path it doesn't follow claude into a worktree, which is what
  // claudeCwd is for.
  async paneCwd(target: string): Promise<string> {
    const p = await this.pane(target);
    if (!p.pane_cwd) throw new Error(`zellij pane has no cwd: ${target}`);
    return p.pane_cwd;
  }

  async paneCommand(target: string): Promise<string | undefined> {
    const p = pickPane(await this.cached(`panes:${target}`, () => this.panes(target)));
    if (!p) return undefined; // no live terminal pane: nothing can be running claude
    if (!p.pane_command) throw new Error(`zellij pane has no command: ${target}`);
    return commandName(p.pane_command);
  }

  private async findClaudePid(target: string, tree?: ProcessTree): Promise<string | undefined> {
    try {
      // -x: the server has no controlling terminal, so plain `ps` would skip it.
      const ps = await this.sh('ps', ['-x', '-o', 'pid=,args=']);
      if (ps.code !== 0) return undefined;
      const root = findServerPid(ps.stdout, target);
      if (!root) return undefined;
      const snapshot = tree ?? await this.processTree();
      if (!snapshot) return undefined;
      return findClaudeBelow(root, snapshot);
    } catch {
      return undefined;
    }
  }

  async claudeCwd(target: string, tree?: ProcessTree): Promise<string | undefined> {
    try {
      const pid = await this.findClaudePid(target, tree);
      return pid ? await processCwd(this.sh, pid) : undefined;
    } catch {
      return undefined;
    }
  }

  async claudeModel(target: string, tree?: ProcessTree): Promise<string | undefined> {
    try {
      const pid = await this.findClaudePid(target, tree);
      return pid ? await processFlag(this.sh, pid, '--model') : undefined;
    } catch {
      return undefined;
    }
  }

  async claudeEffort(target: string, tree?: ProcessTree): Promise<EffortLevel | undefined> {
    try {
      const pid = await this.findClaudePid(target, tree);
      return pid ? asEffort(await processFlag(this.sh, pid, '--reasoning-effort')) : undefined;
    } catch {
      return undefined;
    }
  }

  // `paste` wraps the text in bracketed paste (like tmux paste-buffer -p), so a
  // multi-line message arrives as one prompt; then Enter submits it. `--` keeps
  // a message starting with "-" from being parsed as a zellij flag.
  async injectText(target: string, text: string): Promise<void> {
    const pane = await this.inputPane(target);
    await this.action(target, ['paste', '--pane-id', pane, '--', text]);
    await this.action(target, ['send-keys', '--pane-id', pane, 'Enter']);
  }

  async sendKeys(target: string, keys: string): Promise<void> {
    const pane = await this.inputPane(target);
    await this.action(target, ['send-keys', '--pane-id', pane, toZellijKey(keys)]);
  }

  // Same choreography as TmuxClient.sendKeySeq, including the 500ms pause the
  // Ink menu needs between keys. Text goes through write-chars (typed, no
  // bracketed paste): a paste corrupts the menu's "Type something" field.
  async sendKeySeq(target: string, seq: QuestionKey[], opts: { delayMs?: number } = {}): Promise<void> {
    const pane = await this.inputPane(target);
    const delayMs = opts.delayMs ?? 500;
    for (const step of seq) {
      const args = step.kind === 'key'
        ? ['send-keys', '--pane-id', pane, toZellijKey(step.key)]
        : ['write-chars', '--pane-id', pane, '--', step.text];
      await this.action(target, args);
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
