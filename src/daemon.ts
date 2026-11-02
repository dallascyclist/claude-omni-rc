import 'dotenv/config';
import { join } from 'node:path';
import { augmentPath } from './path.js';
import { loadConfig, resolveStateDir, type Config } from './config.js';
import { initLogger, log } from './log.js';
import { SettingsStore } from './settings.js';
import { StateStore } from './state.js';
import { Bus } from './bus.js';
import { SessionManager } from './sessions/manager.js';
import { PermissionFlow } from './permissions.js';
import { DialogFlow } from './dialogs.js';
import { OllamaClient } from './ollama.js';
import { SdkDriver } from './sessions/sdk-driver.js';
import { TmuxWatcher } from './sessions/tmux-watcher.js';
import { TranscriptWatcher } from './sessions/transcript-watcher.js';
import { TmuxClient, type Multiplexer } from './sessions/tmux-inject.js';
import { ZellijClient } from './sessions/zellij-inject.js';
import { Inbox } from './input.js';
import { startApi } from './api.js';
import { TelegramBot } from '../bot/telegram.js';
import { checkForUpdate, markNotified, CURRENT_VERSION, RELEASES_URL, CHECK_INTERVAL_MS } from './update.js';

// Prima di ogni altra cosa: il PATH di launchd non include ~/.local/bin (uv,
// pipx) né ~/bin, dove vivono `ollama-usage` e `claude`. Senza, ogni spawn()
// dal daemon fallisce con ENOENT anche se il tool è installato.
augmentPath();

export interface Daemon { start(): Promise<void>; stop(): Promise<void>; }

export function createDaemon(
  config: Config,
  overrides: { bot?: Pick<TelegramBot, 'start' | 'stop' | 'notify'>; settingsStore?: SettingsStore } = {},
): Daemon {
  // Prima di ogni altra cosa: da qui in poi qualunque modulo può chiamare log()
  // e finire nel file configurato, incluso ciò che fallisce durante il cablaggio.
  initLogger({
    file: config.logFile,
    level: config.logLevel,
    maxBytes: config.logMaxBytes,
    keep: config.logKeep,
  });
  log().info('daemon starting', {
    version: CURRENT_VERSION,
    pid: process.pid,
    apiPort: config.apiPort,
    multiplexer: config.multiplexer,
    armedOnStart: config.armedOnStart,
    stateDir: config.stateDir,
    settingsFile: config.settingsFile,
  });

  const state = new StateStore(join(config.stateDir, 'state.json'));
  const bus = new Bus();
  const manager = new SessionManager({ bus, state, idleGraceMs: config.idleGraceMs, armedOnStart: config.armedOnStart });
  // Il bot nasce dopo il flusso permessi (gli serve), ma il flusso deve poter
  // chiedere al bot se esiste una chat di notifica → riferimento tardivo.
  // Con un bot iniettato dai test (senza canNotify) si assume che possa notificare.
  let botRef: Pick<TelegramBot, 'start' | 'stop' | 'notify'> & { canNotify?: () => boolean };
  const permissionFlow = new PermissionFlow({
    bus, config,
    setStatus: (id, s) => manager.setStatus(id, s),
    canNotify: () => botRef?.canNotify?.() ?? true,
  });
  const dialogFlow = new DialogFlow({
    bus, config,
    setStatus: (id, s) => manager.setStatus(id, s),
    canNotify: () => botRef?.canNotify?.() ?? true,
  });
  const ollama = new OllamaClient({ baseUrl: config.ollamaBaseUrl });
  const sdk = new SdkDriver({ bus, manager, config, permissionFlow, dialogFlow, ollama });
  const tmux: Multiplexer = config.multiplexer === 'zellij' ? new ZellijClient() : new TmuxClient();
  const watcher = new TmuxWatcher({ config, manager, tmux });
  const transcriptWatcher = new TranscriptWatcher({ config, manager, bus });
  const inbox = new Inbox({ dir: config.inboxDir });
  const settingsStore = overrides.settingsStore ?? new SettingsStore(config.settingsFile);
  const bot = overrides.bot ?? new TelegramBot({ config, bus, manager, permissionFlow, dialogFlow, sdk, tmux, inbox, ollama, settingsStore });
  botRef = bot;

  const reaper = setInterval(() => manager.reapIdle(), 1000);
  reaper.unref();
  const api = startApi(config.apiPort, { manager, permissionFlow, config, bus });

  // Check versione su GitHub (vedi update.ts): al riavvio e poi ogni 24h. Log +
  // notifica Telegram, una volta per versione — mai bloccante sull'avvio.
  const updateStatePath = join(config.stateDir, 'update-check.json');
  async function runUpdateCheck(): Promise<void> {
    const latest = await checkForUpdate({ statePath: updateStatePath, disabled: config.noUpdateCheck });
    if (!latest) return;
    const message = `⬆️ New version available: claude-omni-rc ${latest} (you have ${CURRENT_VERSION}) — ${RELEASES_URL}`;
    log().info('update available', { latest, current: CURRENT_VERSION });
    bot.notify(message);
    markNotified(updateStatePath, latest);
  }
  let updateTimer: NodeJS.Timeout | undefined;

  return {
    async start() {
      // Prima sincronizzazione dei terminali PRIMA che il transcript-watcher
      // parta: projectDir viene risolto dal cwd del processo claude (worktree
      // incluso), così i transcript non vengono adottati nella dir precedente.
      await watcher.poll();
      watcher.start(); // gated su armed
      transcriptWatcher.start();
      await bot.start();
      void runUpdateCheck();
      updateTimer = setInterval(() => void runUpdateCheck(), CHECK_INTERVAL_MS);
      updateTimer.unref();
    },
    async stop() {
      clearInterval(reaper);
      if (updateTimer) clearInterval(updateTimer);
      watcher.stop();
      transcriptWatcher.stop();
      await api.close();
      await bot.stop();
      manager.persist();
      log().info('daemon stopped');
    },
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // rete di sicurezza: anche un fire-and-forget sfuggito non deve uccidere il daemon.
  process.on('unhandledRejection', err => { log().error('unhandledRejection', { err }); });
  const settingsStore = new SettingsStore(join(resolveStateDir(process.env), 'settings.json'));
  const daemon = createDaemon(loadConfig(process.env, settingsStore.load()), { settingsStore });
  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  daemon.start().catch(err => { log().error('daemon start failed', { err }); process.exit(1); });
}
