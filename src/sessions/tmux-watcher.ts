import type { Config } from '../config.js';
import type { EffortLevel } from '../types.js';
import type { SessionManager } from './manager.js';
import type { Multiplexer } from './tmux-inject.js';

export interface WatcherDeps {
  config: Config;
  manager: SessionManager;
  // tmux or zellij (MULTIPLEXER); the name predates zellij support.
  tmux: Pick<Multiplexer, 'listSessions' | 'serverRunning' | 'paneCwd' | 'paneCommand' | 'claudeCwd' | 'claudeModel' | 'claudeEffort'>
    & Partial<Pick<Multiplexer, 'processTree'>>;
}

// Grace prima di rimuovere una sessione terminale il cui target tmux è sparito:
// /attach può registrare un target non ancora avviato, e un restart di tmux non
// deve cancellare tutto. Oltre questo tempo la sessione è da considerare morta.
const PRUNE_GRACE_MS = 30_000;

// Grace per il caso "claude uscito ma finestra tmux ancora aperta": più larga
// del prune perché l'utente può legittimamente stare facendo altro nel pane
// (es. qualche comando shell) prima di rilanciare claude o chiudere.
const CLAUDE_EXIT_GRACE_MS = 120_000;

// Quando il pane mostra una shell, Claude Code non è in esecuzione (il CLI è
// uscito e il prompt è tornato). Qualsiasi altro comando nel pane — incluso
// "ollama" (lanciato con `ollama launch claude`) — significa sessione attiva.
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'ash', 'nu', 'pwsh']);

// Claude Code is not running in the session: the pane is back at a shell, or
// (zellij) the session has no live terminal pane left — paneCommand undefined.
export function claudeGone(cmd: string | undefined): boolean {
  return cmd === undefined || SHELL_NAMES.has(cmd);
}

// Scoperta sessioni terminale: `tmux list-sessions` → sessioni `claude:<progetto>`,
// registrate col cwd reale del pane (serve a risolvere il transcript). Solo
// sessioni tmux esplicite vengono registrate: niente scansione di
// ~/.claude/projects, quindi niente sessioni estranee (es. Claude Code non-Ollama)
// nel registro. Attivo solo quando il remote control è armed.
export class TmuxWatcher {
  private timer?: NodeJS.Timeout;
  private missingSince = new Map<string, number>();
  private exitedSince = new Map<string, number>();
  // Un poll che dura più dell'intervallo (ps/lsof non sono gratis) non deve
  // accavallarsi con il successivo: gli spawn si sommerebbero senza limite.
  private polling = false;
  private cwdCheckedAt = new Map<string, number>();

  constructor(private deps: WatcherDeps) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.config.pollIntervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    if (!this.deps.manager.isArmed()) return;
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    let sessions: string[];
    try {
      if (!(await this.deps.tmux.serverRunning())) return;
      sessions = await this.deps.tmux.listSessions();
    } catch { return; }
    this.prune(sessions);
    await this.checkExited(sessions);
    // Uno snapshot dei processi per tutto il giro: senza, ogni claudeCwd()
    // spawnerebbe il suo `ps` — per ogni sessione, a ogni poll.
    const tree = await this.deps.tmux.processTree?.().catch(() => undefined);
    for (const target of sessions) {
      if (!target.startsWith('claude:')) continue;
      if (this.deps.manager.findByTmuxTarget(target)) continue;
      const name = target.slice('claude:'.length);
      // un pane tornato alla shell non ha claude in esecuzione: niente da
      // tracciare (checkExited la rinnoverebbe all'infinito altrimenti).
      try {
        if (claudeGone(await this.deps.tmux.paneCommand(target))) continue;
      } catch { /* pane illeggibile → registra comunque (fallback) */ }
      let projectDir = `~/${name}`;
      try {
        // Il cwd del PROCESSO claude è la verità per il transcript (la sessione
        // può essersi spostata in un git worktree mentre il pane resta dov'era);
        // il cwd del pane è il fallback se claude non è ancora rintracciabile.
        projectDir = (await this.deps.tmux.claudeCwd(target, tree)) ?? ((await this.deps.tmux.paneCwd(target)) || projectDir);
      } catch { /* tmux in mezzo a un restart: fallback al project dir di default */ }
      // Modello del processo claude (`claude --model <modello>`): serve a /usage
      // per decidere il provider della sessione attiva. Best-effort: undefined se
      // non leggibile → il chiamante usa DEFAULT_MODEL.
      let model: string | undefined;
      try { model = await this.deps.tmux.claudeModel(target, tree); } catch { /* best-effort */ }
      // Effort del processo claude (`--reasoning-effort <livello>`), per /diag.
      // Best-effort: undefined se non leggibile → la resa mostra '—'.
      let effort: EffortLevel | undefined;
      try { effort = await this.deps.tmux.claudeEffort(target, tree); } catch { /* best-effort */ }
      this.cwdCheckedAt.set(target, Date.now());
      this.deps.manager.registerTerminal({ title: name, projectDir, tmuxTarget: target, model, effort });
      this.deps.manager.persist();
    }
    // refresh: il cwd del PROCESSO claude può cambiare (il CLI sposta la sessione
    // in un git worktree) mentre il pane resta dov'era. Senza aggiornare
    // projectDir, il transcript verrebbe risolto nella dir sbagliata e la chat
    // resterebbe muta.
    // Il refresh è throttlato: una sessione si sposta in un worktree una volta
    // ogni tanto, mentre `ps` + `lsof` per sessione ogni pollIntervalMs sono un
    // costo continuo (CPU e batteria) per un evento raro.
    const now = Date.now();
    for (const s of this.deps.manager.list()) {
      if (s.kind !== 'terminal' || !s.tmuxTarget || !sessions.includes(s.tmuxTarget)) continue;
      const checkedAt = this.cwdCheckedAt.get(s.tmuxTarget);
      if (checkedAt !== undefined && now - checkedAt < this.deps.config.cwdRefreshMs) continue;
      this.cwdCheckedAt.set(s.tmuxTarget, now);
      try {
        const claudeCwd = await this.deps.tmux.claudeCwd(s.tmuxTarget, tree);
        if (claudeCwd) {
          if (claudeCwd !== s.projectDir) {
            this.deps.manager.setProjectDir(s.id, claudeCwd);
            this.deps.manager.persist();
          }
        } else if (!s.projectDir.includes('.claude/worktrees')) {
          // claude non rintracciabile (es. appena uscito): il cwd del pane è il
          // fallback, ma non riportare una sessione GIÀ in un worktree alla dir
          // principale (niente flapping).
          const cwd = await this.deps.tmux.paneCwd(s.tmuxTarget);
          if (cwd && cwd !== s.projectDir) {
            this.deps.manager.setProjectDir(s.id, cwd);
            this.deps.manager.persist();
          }
        }
      } catch { /* pane illeggibile in questo poll → si riprova al prossimo */ }
    }
  }

  private prune(sessions: string[]): void {
    const alive = new Set(sessions);
    const now = Date.now();
    for (const s of this.deps.manager.list()) {
      if (s.kind !== 'terminal' || !s.tmuxTarget) continue;
      if (alive.has(s.tmuxTarget)) {
        this.missingSince.delete(s.tmuxTarget);
        continue;
      }
      const since = this.missingSince.get(s.tmuxTarget) ?? now;
      this.missingSince.set(s.tmuxTarget, since);
      if (now - since < PRUNE_GRACE_MS) continue;
      this.deps.manager.remove(s.id);
      this.deps.manager.persist();
    }
  }

  // La finestra tmux c'è ancora ma il pane è tornato alla shell: Claude Code è
  // uscito. Oltre la grace (l'utente può star facendo altro nel pane) la sessione
  // viene rimossa dal registro — tenere una sessione "chiusa" solo perché tmux la
  // vede ancora non ha senso, e se l'utente rilancia claude la sessione torna.
  private async checkExited(sessions: string[]): Promise<void> {
    const alive = new Set(sessions);
    const now = Date.now();
    for (const s of this.deps.manager.list()) {
      if (s.kind !== 'terminal' || !s.tmuxTarget) continue;
      if (!alive.has(s.tmuxTarget)) { this.exitedSince.delete(s.tmuxTarget); continue; } // gestito da prune
      let cmd: string | undefined;
      try { cmd = await this.deps.tmux.paneCommand(s.tmuxTarget); } catch { continue; } // pane illeggibile → conservativo
      if (!claudeGone(cmd)) { this.exitedSince.delete(s.tmuxTarget); continue; } // qualcosa gira (claude) → vivo
      const since = this.exitedSince.get(s.tmuxTarget) ?? now;
      this.exitedSince.set(s.tmuxTarget, since);
      if (now - since >= CLAUDE_EXIT_GRACE_MS) {
        this.deps.manager.remove(s.id);
        this.deps.manager.persist();
      }
    }
  }
}
