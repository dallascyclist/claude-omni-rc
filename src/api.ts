import { createServer, type Server } from 'node:http';
import { basename } from 'node:path';
import type { Config } from './config.js';
import type { SessionManager } from './sessions/manager.js';
import type { PermissionFlow } from './permissions.js';
import { newEventId, type Bus } from './bus.js';
import { parseAskUserQuestions } from './sessions/transcript.js';
import { log } from './log.js';

export interface ApiDeps {
  manager: SessionManager;
  permissionFlow: PermissionFlow;
  config: Config;
  // Task 8: il ramo AskUserQuestion emette direttamente sul bus (non passa
  // dal PermissionFlow, che è per i permessi veri) — serve il bus qui.
  bus: Bus;
}

// API locale su loopback: la usa l'hook SessionStart (POST /api/attach), lo
// script del permission prompt tool (POST /api/permission) e, in Fase 2, l'app
// Expo. Nessuna autenticazione: ascolta solo su 127.0.0.1.
export interface ApiHandle { close(): Promise<void>; port(): number; ready: Promise<void>; }

// Risolve l'id sessione per una richiesta di permesso arrivata dal CLI: se il
// target tmux corrisponde a una sessione tracciata usa il suo id, altrimenti un
// id sintetico (non registra nulla nel registro — quello lo fa il TmuxWatcher).
function resolveSessionId(manager: SessionManager, provided: string | undefined): string {
  if (!provided) return 'term:unknown';
  const found = manager.findByTmuxTarget(provided) ?? manager.findByTmuxTarget(provided.replace(/^claude:/, ''));
  if (found) return found.id;
  return `term:${provided}`;
}

export function startApi(port: number, deps: ApiDeps): ApiHandle {
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/permission') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        // da disattivo o con richiesta malformata: fallback al prompt nativo.
        if (!deps.manager.isArmed()) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ask'); return; }
        // armed ma senza chat collegata (es. daemon appena riavviato): nessuno
        // vedrebbe i bottoni. Il prompt nativo nel terminale è la risposta
        // giusta — non un'attesa di 120s che finisce in deny.
        if (!deps.permissionFlow.canNotify()) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ask'); return; }
        let input: { toolName?: string; input?: unknown; sessionId?: string; toolUseId?: string };
        try { input = JSON.parse(body); } catch { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ask'); return; }
        const toolName = input.toolName ?? 'tool';
        // AskUserQuestion non è una richiesta di permesso: il CLI mostra il menu
        // nel pane e la risposta arriva via tmux (bottoni della domanda). Auto-allow,
        // niente JSON + Approve/Reject in chat.
        //
        // Task 8: questo hook scatta PRIMA che il CLI apra il menu — è la sola
        // fonte che arriva in tempo per Telegram. Il transcript scrive la
        // stessa tool_use solo quando il turno si sblocca (l'utente ha già
        // risposto al terminale): usarlo come sorgente riprodurrebbe il bug
        // che questo ramo risolve. Qui si emette sul bus e si risponde
        // 'allow' SUBITO dopo, senza alcun await fra i due — l'hook tiene il
        // CLI in attesa della risposta HTTP, quindi qualunque attesa qui
        // (tmux, Telegram, …) si tradurrebbe in un CLI bloccato.
        if (toolName === 'AskUserQuestion') {
          const sid = resolveSessionId(deps.manager, input.sessionId);
          const questions = parseAskUserQuestions(input.input);
          if (questions.length) {
            const eventId = newEventId();
            const toolUseId = input.toolUseId || undefined;
            log().info('event emitted', { eventId, sessionId: sid, source: 'hook', kind: 'prompt', questions: questions.length, toolUseId });
            deps.bus.emit({ type: 'session.prompt', sessionId: sid, questions, eventId, toolUseId, source: 'hook' });
          }
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('allow');
          return;
        }
        const sid = resolveSessionId(deps.manager, input.sessionId);
        // long-poll: la richiesta resta aperta finché l'utente non decide
        // (o scade PERMISSION_TIMEOUT_SECONDS → deny).
        const decision = await deps.permissionFlow.request(sid, toolName, (input.input ?? {}) as Record<string, unknown>);
        // Risposta JSON, non più 'allow'/'deny' in chiaro: il CLI (≥2.1.199)
        // scarta un allow SENZA updatedInput per i tool con
        // requiresUserInteraction() (ExitPlanMode) e lascia la UI del piano
        // appesa. L'hook propaga updatedInput nella decisione; per gli altri
        // tool (Bash, Edit, …) updatedInput è assente e l'allow resta valido.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(decision));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/attach') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const input = JSON.parse(body) as { projectDir?: string; tmuxTarget?: string; multiplexer?: string; title?: string };
          if (!input.projectDir) throw new Error('projectDir is required');
          // A target from the multiplexer the daemon doesn't drive is useless
          // (it can't inject or capture there) and harmful: the watcher would
          // never see it alive and would prune a session that is still being
          // mirrored. Hooks older than zellij support send no `multiplexer`:
          // their target is a tmux one.
          const target = (input.multiplexer ?? 'tmux') === deps.config.multiplexer ? input.tmuxTarget : undefined;
          const session = deps.manager.registerTerminal({
            title: input.title ?? basename(input.projectDir),
            projectDir: input.projectDir,
            ...(target ? { tmuxTarget: target } : {}),
          });
          deps.manager.persist();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessionId: session.id }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions: deps.manager.list() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', e => { console.error('claude-omni-rc api:', (e as Error).message); });
  const ready = new Promise<void>(resolve => server.once('listening', resolve));
  server.listen(port, '127.0.0.1');
  return {
    port: () => (server.address() as { port: number }).port,
    close: () => new Promise(resolve => server.close(() => resolve())),
    ready,
  };
}
