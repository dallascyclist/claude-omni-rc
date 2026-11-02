import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { TmuxWatcher } from '../src/sessions/tmux-watcher.js';

function makeWatcher(tmuxSessions: string[] = [], serverUp = true, env: Record<string, string> = {}) {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
  const config = loadConfig({ STATE_DIR: dir, ...env });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const tmux = {
    serverRunning: vi.fn(async () => serverUp),
    listSessions: vi.fn(async () => tmuxSessions),
    paneCwd: vi.fn(async (t: string) => `/home/user/${t.replace('claude:', '')}`),
    paneCommand: vi.fn(async (): Promise<string | undefined> => 'ollama'), // default: claude attivo nel pane
    claudeCwd: vi.fn(async (_t: string, _tree?: unknown): Promise<string | undefined> => undefined), // default: nessun processo claude distinguibile
    claudeModel: vi.fn(async (_t: string, _tree?: unknown): Promise<string | undefined> => undefined), // default: nessun --model leggibile
    claudeEffort: vi.fn(async (_t: string, _tree?: unknown): Promise<string | undefined> => undefined), // default: nessun --reasoning-effort leggibile
    processTree: vi.fn(async () => ({ children: new Map<string, string[]>(), comms: new Map<string, string>() })),
  };
  const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
  return { manager, watcher, tmux };
}

describe('TmuxWatcher', () => {
  it('registers claude:* tmux sessions when armed, with the pane cwd', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1', 'claude:proj2', 'work']);
    manager.setArmed(true);
    await (watcher as any).poll();
    const s1 = manager.findByTmuxTarget('claude:proj1');
    expect(s1).toBeDefined();
    expect(s1?.projectDir).toBe('/home/user/proj1'); // cwd reale dal pane
    expect(manager.findByTmuxTarget('claude:proj2')).toBeDefined();
    expect(manager.findByTmuxTarget('work')).toBeUndefined(); // non claude:* → ignorata
    expect(tmux.paneCwd).toHaveBeenCalled();
  });
  it('records the claude --model on registration when readable', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1']);
    tmux.claudeModel.mockResolvedValue('claude-sonnet-5');
    manager.setArmed(true);
    await (watcher as any).poll();
    const s1 = manager.findByTmuxTarget('claude:proj1');
    expect(s1?.model).toBe('claude-sonnet-5');
  });
  it('records the claude --reasoning-effort on registration when readable', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1']);
    tmux.claudeEffort.mockResolvedValue('high');
    manager.setArmed(true);
    await (watcher as any).poll();
    const s1 = manager.findByTmuxTarget('claude:proj1');
    expect(s1?.effort).toBe('high');
  });
  it('does nothing when disarmed', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1']);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(0);
  });
  it('does not duplicate an already-registered session', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1']);
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1);
  });
  it('prunes a terminal session whose tmux target is gone (after the grace)', async () => {
    const sessions = ['claude:proj1'];
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
    const config = loadConfig({ STATE_DIR: dir });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const tmux = {
      serverRunning: vi.fn(async () => true),
      listSessions: vi.fn(async () => sessions),
      paneCwd: vi.fn(async () => '/home/user/proj1'),
      claudeCwd: vi.fn(async () => undefined),
    };
    const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    // primo poll: il target c'è → non si pruna
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1);
    // il target sparisce: entro la grace resta, oltre la grace viene rimosso
    sessions.pop();
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1); // ancora dentro la grace
    (watcher as any).missingSince.set('claude:proj1', Date.now() - 60_000);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(0);
  });
  it('does not prune when the tmux server is down', async () => {
    const { manager, watcher } = makeWatcher([], false);
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    (watcher as any).missingSince.set('claude:proj1', Date.now() - 60_000);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1);
  });
  it('removes a session whose pane is back at the shell (claude exited) after the grace', async () => {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
    const config = loadConfig({ STATE_DIR: dir });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const tmux = {
      serverRunning: vi.fn(async () => true),
      listSessions: vi.fn(async () => ['claude:proj1']),
      paneCwd: vi.fn(async () => '/home/user/proj1'),
      paneCommand: vi.fn(async () => 'zsh'), // pane tornato alla shell
      claudeCwd: vi.fn(async () => undefined),
    };
    const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1); // dentro la grace
    (watcher as any).exitedSince.set('claude:proj1', Date.now() - 120_001); // oltre la grace
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(0); // sessione "chiusa" rimossa
  });
  it('keeps the session while the pane runs a program (claude alive)', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1']);
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    (watcher as any).exitedSince.set('claude:proj1', Date.now() - 130_000);
    await (watcher as any).poll(); // paneCommand → 'ollama', non una shell
    expect(manager.list()).toHaveLength(1);
  });
  it('refreshes projectDir when the pane cwd changes (worktree relocation)', async () => {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
    // CWD_REFRESH_MS=0: qui interessa CHE il refresh avvenga, non ogni quanto
    const config = loadConfig({ STATE_DIR: dir, CWD_REFRESH_MS: '0' });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    let cwd = '/home/user/proj1';
    const tmux = {
      serverRunning: vi.fn(async () => true),
      listSessions: vi.fn(async () => ['claude:proj1']),
      paneCwd: vi.fn(async () => cwd),
      paneCommand: vi.fn(async () => 'ollama'),
      claudeCwd: vi.fn(async () => undefined),
    };
    const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
    manager.setArmed(true);
    await (watcher as any).poll();
    const s = manager.findByTmuxTarget('claude:proj1')!;
    expect(s.projectDir).toBe('/home/user/proj1');
    // il CLI sposta la sessione nel worktree → il cwd del pane cambia
    cwd = '/home/user/proj1/.claude/worktrees/fix';
    await (watcher as any).poll();
    expect(manager.get(s.id)?.projectDir).toBe('/home/user/proj1/.claude/worktrees/fix');
  });
  it('uses the claude process cwd (worktree) as projectDir, not the pane cwd', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1']);
    manager.setArmed(true);
    // il CLI è dentro un git worktree: il processo claude ha il cwd nel worktree,
    // il pane resta nella dir principale — projectDir deve seguire il PROCESSO.
    tmux.claudeCwd.mockResolvedValue('/home/user/proj1/.claude/worktrees/fix');
    await (watcher as any).poll();
    const s1 = manager.findByTmuxTarget('claude:proj1');
    expect(s1?.projectDir).toBe('/home/user/proj1/.claude/worktrees/fix');
  });
  it('does not remove when the pane command cannot be read', async () => {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
    const config = loadConfig({ STATE_DIR: dir });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const tmux = {
      serverRunning: vi.fn(async () => true),
      listSessions: vi.fn(async () => ['claude:proj1']),
      paneCwd: vi.fn(async () => '/home/user/proj1'),
      paneCommand: vi.fn(async () => { throw new Error('tmux error'); }),
      claudeCwd: vi.fn(async () => undefined),
    };
    const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    (watcher as any).exitedSince.set('claude:proj1', Date.now() - 130_000);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1); // conservativo: non rimuove se non può leggere il pane
  });
  // zellij keeps a session alive after its last terminal pane closes, so the
  // client reports "nothing runs here" as undefined rather than a shell name.
  it('removes a session left with no live pane (paneCommand undefined) after the grace', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1']);
    tmux.paneCommand.mockResolvedValue(undefined);
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1); // within the grace: the user may relaunch claude
    (watcher as any).exitedSince.set('claude:proj1', Date.now() - 120_001);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(0); // a ghost session would otherwise stay in /sessions forever
  });
  it('does not register a claude:* session with no live pane', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1']);
    tmux.paneCommand.mockResolvedValue(undefined);
    manager.setArmed(true);
    await (watcher as any).poll();
    expect(manager.findByTmuxTarget('claude:proj1')).toBeUndefined();
  });
  it('skips a poll that overlaps a slow one still in flight', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1']);
    manager.setArmed(true);
    let release: (() => void) | undefined;
    tmux.serverRunning.mockImplementation(() => new Promise<boolean>(r => { release = () => r(true); }));
    const first = (watcher as any).poll();
    const second = (watcher as any).poll(); // deve tornare subito, senza ri-entrare
    await second;
    release!();
    await first;
    expect(tmux.serverRunning).toHaveBeenCalledTimes(1);
  });

  it('takes one process-tree snapshot per poll and shares it', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1', 'claude:proj2']);
    manager.setArmed(true);
    await (watcher as any).poll();
    expect(tmux.processTree).toHaveBeenCalledTimes(1);
    for (const call of tmux.claudeCwd.mock.calls) expect(call[1]).toBeDefined();
  });

  it('does not re-check the claude cwd on every poll', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1']);
    manager.setArmed(true);
    await (watcher as any).poll();
    const afterFirst = tmux.claudeCwd.mock.calls.length;
    await (watcher as any).poll();
    await (watcher as any).poll();
    expect(tmux.claudeCwd.mock.calls.length).toBe(afterFirst); // throttlato
  });

  it('re-checks the claude cwd once the refresh interval has elapsed', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1'], true, { CWD_REFRESH_MS: '0' });
    manager.setArmed(true);
    await (watcher as any).poll();
    const afterFirst = tmux.claudeCwd.mock.calls.length;
    await (watcher as any).poll();
    expect(tmux.claudeCwd.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
