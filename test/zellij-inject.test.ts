import { describe, it, expect, vi } from 'vitest';
import {
  ZellijClient, parseZellijSessions, pickPane, pickInputPane, commandName, toZellijKey, findServerPid,
  READ_TTL_MS, type ZellijPane,
} from '../src/sessions/zellij-inject.js';
import type { ExecFn, ExecResult, ShExecFn } from '../src/sessions/tmux-inject.js';

// Panes as zellij 0.46 reports them for a fresh session: the "About Zellij"
// popup is a focused floating plugin, the shell is terminal 0.
const PLUGINS: ZellijPane[] = [
  { id: 1, is_plugin: true, is_focused: false, exited: false, pane_command: null },
  { id: 3, is_plugin: true, is_focused: true, exited: false, pane_command: null },
];
const claudePane: ZellijPane = { id: 0, is_plugin: false, is_focused: false, exited: false, pane_command: 'claude --model claude-opus-5', pane_cwd: '/home/u/proj' };

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

// Fake zellij: answers list-sessions / list-panes from fixtures, records every
// call, and succeeds on any other action unless told to fail it.
function fakeZellij(o: { sessions?: string; noSessions?: boolean; panes?: ZellijPane[]; screen?: string; fail?: string } = {}) {
  const calls: string[][] = [];
  const exec: ExecFn = async args => {
    calls.push(args);
    if (args[0] === 'list-sessions') {
      // zellij 0.46 with no session at all, live or EXITED
      if (o.noSessions) return { code: 1, stdout: '', stderr: 'No active zellij sessions found.\n' };
      return o.sessions === undefined ? { code: 1, stdout: '', stderr: 'boom' } : ok(o.sessions);
    }
    const action = args[3];
    if (action === o.fail) return { code: 1, stdout: '', stderr: `${action} broke` };
    if (action === 'list-panes') return ok(JSON.stringify(o.panes ?? []));
    if (action === 'dump-screen') return ok(o.screen ?? '');
    return ok();
  };
  return { exec, calls };
}

describe('parseZellijSessions', () => {
  it('returns live session names and skips dead (EXITED) ones', () => {
    const out = [
      'UGS [Created 2months ago] (EXITED - attach to resurrect)',
      'claude:proj [Created 8s ago]',
      'claude:other [Created 1h ago] (current)',
      '',
    ].join('\n');
    // an EXITED session counted as alive would never be pruned
    expect(parseZellijSessions(out)).toEqual(['claude:proj', 'claude:other']);
  });
});

describe('pickPane', () => {
  it('never picks a plugin, even the focused About popup', () => {
    const shell: ZellijPane = { id: 0, is_plugin: false, is_focused: false, exited: false, pane_command: '/bin/zsh' };
    expect(pickPane([...PLUGINS, shell])?.id).toBe(0);
  });
  it('prefers the pane running claude over the focused one', () => {
    const focusedShell: ZellijPane = { id: 2, is_plugin: false, is_focused: true, exited: false, pane_command: '/bin/zsh' };
    expect(pickPane([focusedShell, claudePane])?.id).toBe(0);
  });
  it('recognises claude launched through another program (ollama launch claude)', () => {
    const focusedShell: ZellijPane = { id: 2, is_plugin: false, is_focused: true, exited: false, pane_command: '/bin/zsh' };
    const viaOllama: ZellijPane = { id: 5, is_plugin: false, is_focused: false, exited: false, pane_command: 'ollama launch claude' };
    expect(pickPane([focusedShell, viaOllama])?.id).toBe(5);
  });
  it('falls back to the focused terminal pane, then the first one', () => {
    const a: ZellijPane = { id: 4, is_plugin: false, is_focused: false, exited: false, pane_command: 'vim' };
    const b: ZellijPane = { id: 6, is_plugin: false, is_focused: true, exited: false, pane_command: '/bin/zsh' };
    expect(pickPane([a, b])?.id).toBe(6);
    expect(pickPane([a, { ...b, is_focused: false }])?.id).toBe(4);
  });
  it('returns undefined when only plugins or exited panes are left', () => {
    const held: ZellijPane = { id: 0, is_plugin: false, exited: true, pane_command: 'claude' };
    expect(pickPane([...PLUGINS, held])).toBeUndefined();
  });
});

describe('pickInputPane', () => {
  const shell: ZellijPane = { id: 2, is_plugin: false, is_focused: true, exited: false, pane_command: '/bin/zsh' };
  const editor: ZellijPane = { id: 4, is_plugin: false, is_focused: false, exited: false, pane_command: 'vim notes.md' };
  it('targets the claude pane among several', () => {
    expect(pickInputPane([shell, editor, claudePane])?.id).toBe(0);
  });
  it('refuses to guess when several panes are live and none runs claude', () => {
    // the focused shell would run the Telegram message as a command
    expect(pickInputPane([...PLUGINS, shell, editor])).toBeUndefined();
  });
  it('uses a lone terminal pane, like tmux does', () => {
    expect(pickInputPane([...PLUGINS, shell])?.id).toBe(2);
  });
});

describe('commandName', () => {
  it('reduces a full command line to the program name', () => {
    expect(commandName('/bin/zsh')).toBe('zsh'); // must match SHELL_NAMES
    expect(commandName('claude --model x')).toBe('claude');
    expect(commandName('ollama launch claude')).toBe('ollama');
  });
});

describe('toZellijKey', () => {
  it('translates tmux control keys and passes the rest through', () => {
    expect(toZellijKey('C-c')).toBe('Ctrl c');
    expect(toZellijKey('Down')).toBe('Down');
    expect(toZellijKey('Enter')).toBe('Enter');
    expect(toZellijKey('4')).toBe('4');
  });
});

describe('findServerPid', () => {
  const ps = [
    '  100 /usr/bin/zellij --server /tmp/zellij-501/contract_version_1/claude:ba',
    '  200 /usr/bin/zellij --server /tmp/zellij-501/contract_version_1/claude:a',
    '  300 zellij attach claude:a', // a client, not the server
  ].join('\n');
  it('finds the server of exactly that session', () => {
    expect(findServerPid(ps, 'claude:a')).toBe('200'); // not claude:ba's server
    expect(findServerPid(ps, 'claude:ba')).toBe('100');
  });
  it('returns undefined when the session has no server', () => {
    expect(findServerPid(ps, 'claude:gone')).toBeUndefined();
  });
});

describe('ZellijClient', () => {
  it('lists live sessions, and nothing when zellij fails', async () => {
    const up = fakeZellij({ sessions: 'claude:proj [Created 8s ago]\nold [Created 1d ago] (EXITED - attach to resurrect)\n' });
    await expect(new ZellijClient(up.exec).listSessions()).resolves.toEqual(['claude:proj']);
    await expect(new ZellijClient(up.exec).serverRunning()).resolves.toBe(true);
    const down = fakeZellij();
    await expect(new ZellijClient(down.exec).listSessions()).resolves.toEqual([]);
    await expect(new ZellijClient(down.exec).serverRunning()).resolves.toBe(false); // → the watcher won't prune
  });
  it('reports "no sessions at all" as running and empty, so the last session can be pruned', async () => {
    const { exec } = fakeZellij({ noSessions: true });
    // zellij exits 1 here: read as "down", the last claude session would stay
    // in /sessions forever because the watcher never prunes while down
    await expect(new ZellijClient(exec).serverRunning()).resolves.toBe(true);
    await expect(new ZellijClient(exec).listSessions()).resolves.toEqual([]);
  });
  it('captures the claude pane by id, not the focused plugin', async () => {
    const { exec, calls } = fakeZellij({ panes: [...PLUGINS, claudePane], screen: 'screen\ncontent' });
    await expect(new ZellijClient(exec).capturePane('claude:proj')).resolves.toBe('screen\ncontent');
    expect(calls[0]).toEqual(['--session', 'claude:proj', 'action', 'list-panes', '--all', '--json']);
    expect(calls[1]).toEqual(['--session', 'claude:proj', 'action', 'dump-screen', '--pane-id', 'terminal_0']);
  });
  it('reports the pane cwd and command name', async () => {
    const { exec } = fakeZellij({ panes: [...PLUGINS, { ...claudePane, pane_command: '/bin/zsh' }] });
    const z = new ZellijClient(exec);
    await expect(z.paneCwd('claude:proj')).resolves.toBe('/home/u/proj');
    await expect(z.paneCommand('claude:proj')).resolves.toBe('zsh');
  });
  it('paneCommand is undefined when no terminal pane is left, and throws when panes cannot be read', async () => {
    await expect(new ZellijClient(fakeZellij({ panes: PLUGINS }).exec).paneCommand('claude:proj')).resolves.toBeUndefined();
    // unreadable ≠ empty: the watcher stays conservative on a throw
    await expect(new ZellijClient(fakeZellij({ fail: 'list-panes' }).exec).paneCommand('claude:proj')).rejects.toThrow('list-panes');
  });
  it('injects text with bracketed paste, then Enter, keeping a leading "-" literal', async () => {
    const { exec, calls } = fakeZellij({ panes: [...PLUGINS, claudePane] });
    await new ZellijClient(exec).injectText('claude:proj', '-h\nsecond line');
    expect(calls.slice(1)).toEqual([
      ['--session', 'claude:proj', 'action', 'paste', '--pane-id', 'terminal_0', '--', '-h\nsecond line'],
      ['--session', 'claude:proj', 'action', 'send-keys', '--pane-id', 'terminal_0', 'Enter'],
    ]);
  });
  it('refuses to inject when the session has no terminal pane', async () => {
    const { exec, calls } = fakeZellij({ panes: PLUGINS });
    await expect(new ZellijClient(exec).injectText('claude:proj', 'hi')).rejects.toThrow('no pane running claude');
    expect(calls).toHaveLength(1); // nothing typed anywhere
  });
  it('never types into a non-claude pane of a multi-pane session, but /view still captures', async () => {
    const shell: ZellijPane = { id: 2, is_plugin: false, is_focused: true, exited: false, pane_command: '/bin/zsh' };
    const editor: ZellijPane = { id: 4, is_plugin: false, is_focused: false, exited: false, pane_command: 'vim' };
    const { exec, calls } = fakeZellij({ panes: [shell, editor], screen: 'prompt$' });
    const z = new ZellijClient(exec);
    await expect(z.injectText('claude:proj', 'rm -rf build')).rejects.toThrow('no pane running claude');
    await expect(z.sendKeys('claude:proj', 'C-c')).rejects.toThrow('no pane running claude');
    expect(calls.filter(c => ['paste', 'send-keys', 'write-chars'].includes(c[3]))).toHaveLength(0);
    await expect(z.capturePane('claude:proj')).resolves.toBe('prompt$'); // read-only: the focused pane is fine
  });
  it('surfaces a failed paste as an error', async () => {
    const { exec } = fakeZellij({ panes: [claudePane], fail: 'paste' });
    await expect(new ZellijClient(exec).injectText('claude:proj', 'hi')).rejects.toThrow('zellij paste failed');
  });
  it('sends Ctrl+C in zellij key syntax', async () => {
    const { exec, calls } = fakeZellij({ panes: [claudePane] });
    await new ZellijClient(exec).sendKeys('claude:proj', 'C-c');
    expect(calls[1]).toEqual(['--session', 'claude:proj', 'action', 'send-keys', '--pane-id', 'terminal_0', 'Ctrl c']);
  });
  it('sendKeySeq resolves the pane once, sends keys one at a time and types text literally', async () => {
    const { exec, calls } = fakeZellij({ panes: [claudePane] });
    await new ZellijClient(exec).sendKeySeq('claude:proj', [
      { kind: 'key', key: 'Down' },
      { kind: 'text', text: 'my answer' },
      { kind: 'key', key: 'Enter' },
    ], { delayMs: 0 });
    expect(calls.filter(c => c[3] === 'list-panes')).toHaveLength(1);
    expect(calls.slice(1).map(c => c.slice(3))).toEqual([
      ['send-keys', '--pane-id', 'terminal_0', 'Down'],
      ['write-chars', '--pane-id', 'terminal_0', '--', 'my answer'], // typed, not pasted: a paste breaks the menu
      ['send-keys', '--pane-id', 'terminal_0', 'Enter'],
    ]);
  });
});

describe('ZellijClient read cache', () => {
  it('answers a poll\'s serverRunning + listSessions with one zellij call, and re-reads after the TTL', async () => {
    vi.useFakeTimers();
    try {
      const { exec, calls } = fakeZellij({ sessions: 'claude:proj [Created 8s ago]\n' });
      const z = new ZellijClient(exec);
      await z.serverRunning();
      await z.listSessions();
      expect(calls).toHaveLength(1); // CPU: a zellij call costs ~5x a tmux one
      vi.advanceTimersByTime(READ_TTL_MS);
      await z.listSessions();
      expect(calls).toHaveLength(2); // a dead session must not look alive for long
    } finally {
      vi.useRealTimers();
    }
  });
  it('reuses the pane command between polls but reads panes fresh for input', async () => {
    vi.useFakeTimers();
    try {
      const { exec, calls } = fakeZellij({ panes: [claudePane] });
      const z = new ZellijClient(exec);
      await z.paneCommand('claude:proj');
      await z.paneCommand('claude:proj');
      expect(calls.filter(c => c[3] === 'list-panes')).toHaveLength(1);
      await z.injectText('claude:proj', 'hi');
      // a pane id cached from before could point at a pane that is gone
      expect(calls.filter(c => c[3] === 'list-panes')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ZellijClient process inspection', () => {
  // server 50 → pane shell 51 → claude 52 (the shared snapshot of one poll)
  const tree = {
    children: new Map([['50', ['51']], ['51', ['52']]]),
    comms: new Map([['51', '/bin/zsh'], ['52', '/usr/local/bin/claude']]),
  };
  function fakeSh(o: { serverFor?: string; cwd?: string; args?: string }) {
    const calls: string[][] = [];
    const sh: ShExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'ps' && args[0] === '-x') return ok(o.serverFor ? `   50 /usr/bin/zellij --server /tmp/zellij-501/x/${o.serverFor}\n` : '');
      if (cmd === 'lsof') return ok(o.cwd ? `p52\nfcwd\nn${o.cwd}\n` : '');
      if (cmd === 'ps' && args.includes('args=')) return ok(o.args ?? '');
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { sh, calls };
  }
  const exec: ExecFn = async () => ok();

  it('finds the cwd of the claude process under the session server (worktree)', async () => {
    const { sh, calls } = fakeSh({ serverFor: 'claude:proj', cwd: '/home/u/proj/.claude/worktrees/fix' });
    await expect(new ZellijClient(exec, sh).claudeCwd('claude:proj', tree)).resolves.toBe('/home/u/proj/.claude/worktrees/fix');
    expect(calls.find(c => c[0] === 'lsof')).toContain('52');
    expect(calls.some(c => c[0] === 'ps' && c.includes('pid=,ppid=,comm='))).toBe(false); // reused the snapshot
  });
  it('reads --model and --reasoning-effort from the claude command line', async () => {
    const { sh } = fakeSh({ serverFor: 'claude:proj', args: 'claude --model claude-opus-5 --reasoning-effort high\n' });
    const z = new ZellijClient(exec, sh);
    await expect(z.claudeModel('claude:proj', tree)).resolves.toBe('claude-opus-5');
    await expect(z.claudeEffort('claude:proj', tree)).resolves.toBe('high');
  });
  it('returns undefined when the session has no server process', async () => {
    const { sh } = fakeSh({});
    await expect(new ZellijClient(exec, sh).claudeCwd('claude:proj', tree)).resolves.toBeUndefined();
  });
});
