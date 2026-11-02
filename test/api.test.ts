import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { StateStore } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessions/manager.js';
import { PermissionFlow } from '../src/permissions.js';
import { startApi, type ApiHandle } from '../src/api.js';

function makeApi(env: Record<string, string> = {}, flowOpts: { canNotify?: () => boolean } = {}) {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-api-'));
  const config = loadConfig({ STATE_DIR: dir, ...env });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const permissionFlow = new PermissionFlow({
    bus, config,
    setStatus: (id, s) => manager.setStatus(id, s),
    ...flowOpts,
  });
  const api = startApi(0, { manager, permissionFlow, config, bus });
  return { manager, permissionFlow, api, dir, bus };
}

describe('startApi', () => {
  const open: ApiHandle[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map(a => a.close())); });

  it('attaches a terminal session via POST /api/attach', async () => {
    const { manager, api } = makeApi();
    open.push(api);
    await api.ready;
    const base = `http://127.0.0.1:${api.port()}`;
    const res = await fetch(`${base}/api/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir: '/tmp/proj', tmuxTarget: 'claude:proj', title: 'proj' }),
    });
    expect(res.status).toBe(200);
    const session = manager.findByTmuxTarget('claude:proj');
    expect(session).toBeDefined();
    expect(session!.projectDir).toBe('/tmp/proj');
  });

  it('keeps the target of a session in the multiplexer the daemon drives', async () => {
    const { manager, api } = makeApi({ MULTIPLEXER: 'zellij' });
    open.push(api);
    await api.ready;
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir: '/tmp/proj', tmuxTarget: 'claude:proj', multiplexer: 'zellij' }),
    });
    expect(res.status).toBe(200);
    expect(manager.findByTmuxTarget('claude:proj')).toBeDefined();
  });

  it('drops a target from the other multiplexer and mirrors the session read-only', async () => {
    const { manager, api } = makeApi(); // tmux daemon
    open.push(api);
    await api.ready;
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir: '/tmp/proj', tmuxTarget: 'claude:proj', multiplexer: 'zellij' }),
    });
    expect(res.status).toBe(200);
    // the tmux watcher would never see claude:proj alive and would prune it
    expect(manager.findByTmuxTarget('claude:proj')).toBeUndefined();
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0].projectDir).toBe('/tmp/proj');
  });

  it('treats a target without multiplexer (older hook) as a tmux one', async () => {
    const { manager, api } = makeApi({ MULTIPLEXER: 'zellij' });
    open.push(api);
    await api.ready;
    await fetch(`http://127.0.0.1:${api.port()}/api/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir: '/tmp/proj', tmuxTarget: 'claude:proj' }),
    });
    expect(manager.findByTmuxTarget('claude:proj')).toBeUndefined();
    expect(manager.list()).toHaveLength(1);
  });

  it('lists sessions via GET /api/sessions', async () => {
    const { manager, api } = makeApi();
    open.push(api);
    await api.ready;
    manager.registerTerminal({ title: 'proj', projectDir: '/tmp/proj', tmuxTarget: 'claude:proj' });
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/sessions`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessions: unknown[] };
    expect(data.sessions.length).toBe(1);
  });

  it('rejects an attach without projectDir', async () => {
    const { api } = makeApi();
    open.push(api);
    await api.ready;
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('answers ask when disarmed', async () => {
    const { api } = makeApi();
    open.push(api);
    await api.ready;
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' } }),
    });
    expect(await res.text()).toBe('ask');
  });

  it('holds a permission request open until approved, using the tracked session id', async () => {
    const { manager, permissionFlow, api, bus } = makeApi();
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj', projectDir: '/tmp/proj', tmuxTarget: 'claude:proj' });
    const session = manager.findByTmuxTarget('claude:proj')!;
    let captured: { id: string; sessionId: string } | undefined;
    let resolveCapture: (() => void) | undefined;
    const capturedPromise = new Promise<void>(r => { resolveCapture = r; });
    bus.on('session.permission', ({ permission }) => {
      captured = permission;
      resolveCapture?.();
    });
    const req = fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' }, sessionId: 'claude:proj' }),
    });
    // la risposta non arriva finché non si approva (long-poll)
    const settled = await Promise.race([req.then(() => 'done'), new Promise(r => setTimeout(() => r('pending'), 100))]);
    expect(settled).toBe('pending');
    await capturedPromise;
    expect(captured?.sessionId).toBe(session.id); // mappa il target tmux alla sessione tracciata
    permissionFlow.approve(captured!.id);
    const res = await req;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ behavior: 'allow' });
  });

  it('propagates updatedInput for an ExitPlanMode approval (the CLI needs it to exit plan mode)', async () => {
    const { manager, permissionFlow, api, bus } = makeApi();
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj', projectDir: '/tmp/proj', tmuxTarget: 'claude:proj' });
    let captured: { id: string } | undefined;
    let resolveCapture: (() => void) | undefined;
    const capturedPromise = new Promise<void>(r => { resolveCapture = r; });
    bus.on('session.permission', ({ permission }) => {
      captured = permission;
      resolveCapture?.();
    });
    const plan = { plan: 'step 1\nstep 2', planFilePath: '/tmp/proj/plan.md', allowedPrompts: [] };
    const req = fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'ExitPlanMode', input: plan, sessionId: 'claude:proj' }),
    });
    await capturedPromise;
    // Approve conferma il piano originale come updatedInput (vedi onCallback).
    permissionFlow.approve(captured!.id, plan);
    const res = await req;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ behavior: 'allow', updatedInput: plan });
  });

  it('denies on timeout once armed (shown to the user) and nobody answers', async () => {
    const { manager, permissionFlow, api, bus } = makeApi({ PERMISSION_TIMEOUT_SECONDS: '1' });
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    // Il countdown parte solo quando la richiesta viene mostrata (arm()) — qui
    // si simula il bot che la mostra subito, come farebbe per la sessione attiva.
    bus.on('session.permission', ({ permission }) => permissionFlow.arm(permission.id));
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' }, sessionId: 'claude:proj' }),
    });
    expect(await res.json()).toEqual({ behavior: 'deny', message: 'Timeout 1s' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('answers ask when armed but no Telegram chat is connected', async () => {
    const { manager, api } = makeApi({ PERMISSION_TIMEOUT_SECONDS: '120' }, { canNotify: () => false });
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' }, sessionId: 'claude:proj' }),
    });
    // niente destinazione → prompt nativo nel terminale, subito: non un'attesa
    // di 120s che finisce in deny automatico.
    expect(await res.text()).toBe('ask');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('auto-allows AskUserQuestion without a permission request', async () => {
    const { manager, api, bus } = makeApi();
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    let permissionEvents = 0;
    bus.on('session.permission', () => { permissionEvents++; });
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'AskUserQuestion', input: { questions: [{ question: 'x', options: [{ label: 'a' }] }] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('allow');
    expect(permissionEvents).toBe(0); // nessuna notifica di permesso
  });

  // Task 8: l'hook AskUserQuestion è la sola sorgente che arriva in tempo per
  // Telegram (il transcript scrive la stessa tool_use solo quando il turno si
  // sblocca). Qui si verifica che l'API emetta la domanda sul bus SENZA
  // attendere nulla — la risposta 'allow' arriva comunque subito — con le
  // domande corrette, il toolUseId ricevuto e source: 'hook'.
  it('emits session.prompt for AskUserQuestion with valid questions, and answers allow without waiting', async () => {
    const { manager, api, bus } = makeApi();
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    let captured: { sessionId: string; questions: unknown; toolUseId?: string; source?: string } | undefined;
    bus.on('session.prompt', e => { captured = e; });
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        toolName: 'AskUserQuestion',
        toolUseId: 'toolu_abc123',
        sessionId: 'claude:proj',
        input: { questions: [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
      }),
    });
    expect(Date.now() - started).toBeLessThan(500); // nessuna attesa nel ramo AskUserQuestion
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('allow');
    expect(captured).toBeDefined();
    expect(captured!.toolUseId).toBe('toolu_abc123');
    expect(captured!.source).toBe('hook');
    expect(captured!.questions).toEqual([{ question: 'Deploy now?', multiSelect: false, options: [{ label: 'Yes', description: undefined }, { label: 'No', description: undefined }] }]);
  });

  it('answers allow and emits nothing for AskUserQuestion without valid questions', async () => {
    const { manager, api, bus } = makeApi();
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    let promptEvents = 0;
    bus.on('session.prompt', () => { promptEvents++; });
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'AskUserQuestion', input: { questions: [] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('allow');
    expect(promptEvents).toBe(0);
  });

  it('answers ask and emits nothing for AskUserQuestion when disarmed', async () => {
    const { api, bus } = makeApi();
    open.push(api);
    await api.ready;
    let promptEvents = 0;
    bus.on('session.prompt', () => { promptEvents++; });
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'AskUserQuestion', input: { questions: [{ question: 'x', options: [{ label: 'a' }] }] } }),
    });
    expect(await res.text()).toBe('ask');
    expect(promptEvents).toBe(0);
  });

  it('answers ask and emits nothing for AskUserQuestion when armed but no chat is connected', async () => {
    const { manager, api, bus } = makeApi({}, { canNotify: () => false });
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    let promptEvents = 0;
    bus.on('session.prompt', () => { promptEvents++; });
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'AskUserQuestion', input: { questions: [{ question: 'x', options: [{ label: 'a' }] }] } }),
    });
    expect(await res.text()).toBe('ask');
    expect(promptEvents).toBe(0);
  });
});
