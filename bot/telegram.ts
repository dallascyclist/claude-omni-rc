import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Bus } from '../src/bus.js';
import type { Config } from '../src/config.js';
import type { SessionManager } from '../src/sessions/manager.js';
import type { PermissionFlow } from '../src/permissions.js';
import type { DialogFlow } from '../src/dialogs.js';
import type { SdkDriver } from '../src/sessions/sdk-driver.js';
import type { Multiplexer, MultiplexerKind, QuestionKey } from '../src/sessions/tmux-inject.js';
import { createShExec } from '../src/sessions/tmux-inject.js';
import { currentBranch } from '../src/git.js';
import type { OllamaClient } from '../src/ollama.js';
import type { Inbox } from '../src/input.js';
import type { SettingsStore } from '../src/settings.js';
import type { Session, SessionKind, SessionStatus, PermissionRequest, PromptQuestion, PromptAnswer, UserDialog, EffortLevel } from '../src/types.js';
import { EFFORT_LEVELS } from '../src/types.js';
import { SETTINGS_KEYS, parseSettingsValue, type SettingsKey, type UserSettings } from '../src/settings.js';
import type { RecentMessage } from '../src/sessions/transcript.js';
import { readRecentMessages, resolveSessionTranscript } from '../src/sessions/transcript.js';
import { isOllamaProvider, isAnthropicModel, fetchOllamaUsage, fetchAnthropicUsage } from '../src/usage.js';
import { log } from '../src/log.js';
import { CURRENT_VERSION } from '../src/update.js';
import { htmlEscape, mdToHtml, balanceHtml, splitHtmlMessage, truncateAtWord, SEND_MAX_CHARS, describeTool, renderToolLine, renderAgentCard, lastContextTokens, renderContext, anthropicContextWindow } from './render.js';
import type { AgentCard } from './render.js';

// ---------- pure helpers ----------

export type ParsedCommand =
  | { kind: 'control'; command: 'rc' | 'help'; arg?: string }
  | { kind: 'start'; arg?: string }
  | { kind: 'session'; command: 'sessions' | 'new' | 'stop' | 'status' | 'attach'; arg?: string }
  | { kind: 'text' }
  | { kind: 'unknown' };

const CONTROL_COMMANDS = new Set(['rc', 'help', 'start']);

export function parseCommand(text: string): ParsedCommand {
  const t = text.trim();
  if (!t.startsWith('/')) return { kind: 'text' };
  const [raw, ...rest] = t.split(/\s+/);
  const command = raw.slice(1).toLowerCase();
  const arg = rest.join(' ').trim();
  // `arg` è omesso quando vuoto (campo opzionale nel tipo)
  const control = (c: 'rc' | 'help'): ParsedCommand =>
    arg ? { kind: 'control', command: c, arg } : { kind: 'control', command: c };
  const sessionCmd = (c: 'sessions' | 'new' | 'stop' | 'status' | 'attach'): ParsedCommand =>
    arg ? { kind: 'session', command: c, arg } : { kind: 'session', command: c };
  if (command === 'rc' || command === 'help') return control(command as 'rc' | 'help');
  if (command === 'start') return arg ? { kind: 'start', arg } : { kind: 'start' };
  if (['sessions', 'new', 'stop', 'status', 'attach'].includes(command)) {
    return sessionCmd(command as 'sessions' | 'new' | 'stop' | 'status' | 'attach');
  }
  return { kind: 'unknown' };
}

// Flag in testa di /new, in qualsiasi ordine: --auto/--standard (permessi),
// --model <name> (modello per questa sessione) e --effort <level> (effort di
// ragionamento). `mode`/`effort` restano undefined se nessun flag è presente:
// i default li decide la config (DEFAULT_PERMISSION_MODE / DEFAULT_EFFORT),
// non il parser.
export function parseNewFlags(raw: string): { mode?: 'auto' | 'standard'; model?: string; effort?: EffortLevel; text: string } {
  let mode: 'auto' | 'standard' | undefined;
  let model: string | undefined;
  let effort: EffortLevel | undefined;
  let text = raw.trim();
  for (;;) {
    const modeFlag = text.match(/^--(auto|standard)(?:\s+|$)/);
    if (modeFlag) {
      mode = modeFlag[1] === 'standard' ? 'standard' : 'auto';
      text = text.slice(modeFlag[0].length).trim();
      continue;
    }
    const modelFlag = text.match(/^--model\s+(\S+)(?:\s+|$)/);
    if (modelFlag) {
      model = modelFlag[1];
      text = text.slice(modelFlag[0].length).trim();
      continue;
    }
    const effortFlag = text.match(/^--effort\s+(\S+)(?:\s+|$)/);
    if (effortFlag && (EFFORT_LEVELS as readonly string[]).includes(effortFlag[1])) {
      effort = effortFlag[1] as EffortLevel;
      text = text.slice(effortFlag[0].length).trim();
      continue;
    }
    break;
  }
  return { ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), text };
}

// ---------- /settings ----------

// Sottoinsieme delle chiavi curate (SettingsStore) con una riga leggibile per
// il report. La fonte si deriva dal contenuto del file: settings[key] presente
// → 'settings.json', assente → '.env / default' (il config è già fuso).
export const SETTINGS_LABELS: Record<SettingsKey, string> = {
  defaultModel: 'default model for headless sessions',
  defaultPermissionMode: 'permission mode for /new without a flag',
  maxHeadlessSessions: 'concurrent headless sessions',
  permissionTimeoutSeconds: 'unanswered permission denies after (seconds)',
  armedOnStart: 'arm the remote control on daemon start',
  noUpdateCheck: 'disable the daily GitHub release check',
  defaultEffort: 'reasoning effort for headless sessions',
};

export type SettingsCommand =
  | { kind: 'all' }
  | { kind: 'show'; key: SettingsKey }
  | { kind: 'set'; key: SettingsKey; value: string }
  | { kind: 'reset'; key: SettingsKey }
  | { kind: 'invalid'; reason: string };

export function parseSettingsCommand(raw: string): SettingsCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'all' };
  if (tokens[0] === 'reset') {
    const key = tokens[1] as SettingsKey;
    if (tokens.length !== 2 || !(SETTINGS_KEYS as readonly string[]).includes(key)) {
      return { kind: 'invalid', reason: `expected /settings reset <key>; known keys: ${SETTINGS_KEYS.join(', ')}` };
    }
    return { kind: 'reset', key };
  }
  const key = tokens[0] as SettingsKey;
  if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
    return { kind: 'invalid', reason: `unknown setting "${tokens[0]}"; known keys: ${SETTINGS_KEYS.join(', ')}` };
  }
  if (tokens.length === 1) return { kind: 'show', key };
  return { kind: 'set', key, value: tokens.slice(1).join(' ') };
}

function settingsLine(key: SettingsKey, settings: UserSettings, config: Config): string {
  const stored = settings[key];
  const value = stored !== undefined ? String(stored) : String(config[key]);
  const source = stored !== undefined ? 'settings.json' : '.env / default';
  return `<code>${htmlEscape(key)}</code> = <code>${htmlEscape(value)}</code> <i>(${htmlEscape(source)})</i> — ${htmlEscape(SETTINGS_LABELS[key])}`;
}

export function formatSettingsReport(settings: UserSettings, config: Config): string {
  const rows = SETTINGS_KEYS.map(key => settingsLine(key, settings, config)).join('\n');
  return `<b>Settings</b>\n${rows}\n\n<i>Changes apply at the next daemon restart.</i>`;
}

export function formatSettingsKey(key: SettingsKey, settings: UserSettings, config: Config): string {
  return `${settingsLine(key, settings, config)}\n\nSet it: <code>/settings ${htmlEscape(key)} &lt;value&gt;</code> · reset: <code>/settings reset ${htmlEscape(key)}</code>`;
}

// Dove gira una sessione headless. Senza WORKSPACE_DIRS il vecchio fallback era
// la home: un agente con accesso a Bash radicato su TUTTI i file dell'utente.
// Meglio rifiutare e chiedere una configurazione esplicita.
export function resolveHeadlessProjectDir(workspaceDirs: string[]): { dir?: string; error?: string } {
  const dir = workspaceDirs[0];
  if (!dir) {
    return { error: 'No workspace configured. Set <code>WORKSPACE_DIRS</code> in .env to the project roots headless sessions may run in, then restart the daemon.' };
  }
  return { dir };
}

export interface CallbackData {
  action: 'approve' | 'deny' | 'select' | 'answer' | 'done' | 'other' | 'cancel' | 'del' | 'del-yes' | 'del-no'
    | 'perm-edit' | 'dlg-retry' | 'dlg-skip' | 'agent-toggle';
  id: string;
  index?: number;        // per 'answer': indice opzione
  questionIndex?: number; // per 'answer'/'done'/'other': indice domanda
}

export function parseCallbackData(data: string): CallbackData {
  const parts = data.split(':');
  if (parts.length === 3) {
    const [ns, action, id] = parts;
    if (ns === 'perm' && (action === 'approve' || action === 'deny') && id) return { action, id };
    if (ns === 'perm' && action === 'edit' && id) return { action: 'perm-edit', id };
    if (ns === 'sess' && action === 'select' && id) return { action: 'select', id };
    if (ns === 'sess' && action === 'del' && id) return { action: 'del', id };
    if (ns === 'sess' && (action === 'del-yes' || action === 'del-no') && id) return { action, id };
    if (ns === 'dlg' && (action === 'retry' || action === 'skip') && id) {
      return { action: `dlg-${action}` as CallbackData['action'], id };
    }
    if (ns === 'agent' && action === 'toggle' && id) return { action: 'agent-toggle', id };
  }
  if (parts.length === 4) {
    const [ns, action, token, q] = parts;
    if (ns === 'q' && (action === 'done' || action === 'other' || action === 'cancel') && token && /^\d+$/.test(q)) {
      return { action, id: token, questionIndex: Number(q) };
    }
  }
  if (parts.length === 5) {
    const [ns, action, token, q, o] = parts;
    if (ns === 'q' && action === 'answer' && token && /^\d+$/.test(q) && /^\d+$/.test(o)) {
      return { action: 'answer', id: token, questionIndex: Number(q), index: Number(o) };
    }
  }
  throw new Error(`bad callback data: ${data}`);
}

export function formatPct(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return `${Math.round(value)}%`;
}

export function formatResetAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

// Rimuove le sequenze ANSI (colori, movimento cursore) dal contenuto del pane.
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '');
}

// Il controllo remoto vive SOLO in chat privata: in un gruppo il daemon
// streammerebbe codice, output dei tool e path davanti a membri non autorizzati
// (l'autorizzazione è per utente, la destinazione delle notifiche è la chat).
export function isPrivateChat(chat: { type?: string } | undefined): boolean {
  return chat?.type === 'private';
}

export function permissionMessage(req: PermissionRequest): string {
  // ExitPlanMode: il "permesso" è l'approvazione del piano — mostra il piano
  // (non il JSON troncato) e i bottoni Approve/Reject/Edit.
  if (req.toolName === 'ExitPlanMode') {
    const plan = typeof req.input.plan === 'string' ? req.input.plan : '';
    const body = plan ? truncateAtWord(plan, 2000) : '<i>(no plan text in input)</i>';
    return `📋 <b>Plan approval</b> — session <b>${htmlEscape(req.sessionId.slice(0, 8))}</b>\n<pre>${htmlEscape(body)}</pre>`;
  }
  const input = htmlEscape(JSON.stringify(req.input, null, 2).slice(0, 1000));
  return `🔧 Permission requested — session <b>${htmlEscape(req.sessionId.slice(0, 8))}</b>\nTool: <code>${htmlEscape(req.toolName)}</code>\n<pre>${input}</pre>`;
}

// Bottoni per una richiesta di permesso: Approve/Reject, più Edit per ExitPlanMode.
export function permissionKeyboard(req: PermissionRequest): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✓ Approve', `perm:approve:${req.id}`)
    .text('✗ Reject', `perm:deny:${req.id}`);
  if (req.toolName === 'ExitPlanMode') kb.text('✏️ Edit', `perm:edit:${req.id}`).row();
  return kb;
}

// ---------- dialoghi bloccanti (request_user_dialog) ----------

// Messaggio Telegram per un dialogo bloccante. L'unico kind che il CLI emette
// davvero via request_user_dialog è refusal_fallback_prompt (l'approvazione del
// piano passa da canUseTool/ExitPlanMode, non da qui). I kind sconosciuti
// vengono comunque mostrati (con un bottone Cancel) invece di essere ignorati:
// un dialogo ignorato parcheggia il turno e blocca l'utente.
export function dialogMessage(dialog: UserDialog, session?: Session): string {
  const who = session ? `<b>${htmlEscape(session.title)}</b>` : `<code>${htmlEscape(dialog.id.slice(0, 8))}</code>`;
  if (dialog.dialogKind === 'refusal_fallback_prompt') {
    const model = typeof dialog.payload.fallbackModel === 'string' ? dialog.payload.fallbackModel
      : typeof dialog.payload.fallback_model === 'string' ? dialog.payload.fallback_model
      : typeof dialog.payload.model === 'string' ? dialog.payload.model : undefined;
    const reason = typeof dialog.payload.guidanceText === 'string' ? dialog.payload.guidanceText
      : typeof dialog.payload.reason === 'string' ? dialog.payload.reason : undefined;
    const why = reason ? `\n<i>${htmlEscape(reason.slice(0, 300))}</i>` : '';
    return `❌ <b>Model refused</b> — ${who}${model ? `\nRetry with <code>${htmlEscape(model)}</code>?` : '\nRetry?'}${why}`;
  }
  return `❓ <b>Dialog</b> <code>${htmlEscape(dialog.dialogKind)}</code> — ${who}`;
}

// Bottoni per un dialogo: refusal → Retry/Skip; sconosciuto → solo Cancel (il
// default del CLI è comunque applicato).
export function dialogKeyboard(dialog: UserDialog): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (dialog.dialogKind === 'refusal_fallback_prompt') {
    kb.text('🔄 Retry', `dlg:retry:${dialog.id}`).row();
    kb.text('Skip', `dlg:skip:${dialog.id}`).row();
  } else {
    kb.text('Cancel', `dlg:skip:${dialog.id}`).row();
  }
  return kb;
}

// Intestazione della domanda a scelta multipla: elenco numerato completo delle
// opzioni (mai troncato) — il reply col numero resta sempre valido.
export function promptMessage(questions: PromptQuestion[]): string {
  return questions
    .map(q => {
      const title = q.header ? `${q.header}: ${q.question}` : q.question;
      const opts = q.options
        .map((o, i) => `  ${i + 1}. ${htmlEscape(o.label)}${o.description ? ` — <i>${htmlEscape(o.description)}</i>` : ''}`)
        .join('\n');
      return `❓ <b>${htmlEscape(title)}</b>\n${opts}`;
    })
    .join('\n\n');
}

export interface PromptOption { label: string; callback: string }

// Layout dei bottoni per le domande: etichetta corta come scorciatoia sopra
// l'elenco numerato completo. Sopra il cap di opzioni niente bottoni: il reply
// col numero resta il fallback. I label dei bottoni sono testo semplice (il
// parse_mode HTML non si applica ai bottoni inline di Telegram).
export function promptLayout(questions: PromptQuestion[], token: string, maxButtons = 12): { options: PromptOption[]; hint: string } {
  const all = questions.flatMap((q, qi) =>
    q.options.map((o, oi) => ({
      label: o.label.length > 40 ? `${o.label.slice(0, 40).trimEnd()}…` : o.label,
      callback: `q:answer:${token}:${qi}:${oi}`,
    })));
  const useButtons = all.length > 0 && all.length <= maxButtons;
  return {
    options: useButtons ? all : [],
    hint: useButtons
      ? '\n\n<i>Tap an option or reply with its number.</i>'
      : '\n\n<i>Reply with the number of an option.</i>',
  };
}

// ---------- flusso domande multiple (AskUserQuestion) ----------

// Macchina a stati per le domande del CLI: accoda i set (ogni `session.prompt`
// = una chiamata AskUserQuestion), mostra UNA domanda alla volta e raccoglie le
// risposte. Un set è completo quando tutte le sue domande hanno una risposta; a
// quel punto le risposte vengono consegnate (iniezione tmux per le terminali,
// un messaggio unico via runTurn per le headless) e si passa al set successivo.
export interface QuestionFlow {
  sessionId: string;
  sets: PromptQuestion[][];   // coda dei set
  // I2/C2: eventId del session.prompt che ha generato ciascun set, parallelo a
  // `sets` — permette a showQuestion() di loggare la consegna con lo stesso
  // eventId della riga 'event queued'/'event emitted' che l'ha preceduta.
  eventIds: (string | undefined)[];
  // toolUseId della tool_use AskUserQuestion che ha generato ciascun set,
  // parallelo a `sets`. Serve a correlare il tool_result che il transcript
  // scrive quando l'utente risponde al terminale: se l'id corrisponde al set
  // corrente, la domanda è stata risolta fuori da Telegram e va marcata come
  // tale invece di restare appesa coi bottoni.
  toolUseIds: (string | undefined)[];
  setIndex: number;           // set corrente
  qIndex: number;             // domanda corrente nel set
  answers: (PromptAnswer | undefined)[][];  // risposte per set, per domanda (undefined = non risposta)
  token: string;              // token callback
  messageId?: number;         // messaggio Telegram della domanda corrente
  // Guardia anti-race: true mentre l'invio async di showQuestion è in volo.
  // `messageId` viene assegnato solo a invio completato, quindi da solo non
  // basta — due set ravvicinati (es. copia hook + copia transcript della stessa
  // domanda che passano la dedupe in finestre diverse) potrebbero entrambi
  // passare la condizione "flow idle" e mandare due messaggi.
  displaying?: boolean;
  chatId?: number;
  multiSel: number[];         // opzioni togglate per la multi-select corrente
  awaitingOther?: { setIndex: number; qIndex: number };  // in attesa di testo libero
}

// Riepilogo leggibile di una risposta (per l'acknowledgment e la consegna).
export function answerSummary(a: PromptAnswer): string {
  if (a.kind === 'option') {
    const labels = a.labels.join(', ');
    return a.extraText ? `${labels}${labels ? ', ' : ''}${a.extraText}` : labels;
  }
  return a.text;
}

// Sequenza di tasti da iniettare nel pane tmux per rispondere a una domanda
// del menu del CLI (AskUserQuestion). Il menu è interattivo (↑/↓ + Enter): i
// numeri NON selezionano (nel single-select non fanno nulla, nel multi-select
// togglano soltanto e serve un'azione + una schermata di conferma), e il
// bracketed paste lo corrompe (la sequenza ESC di chiusura vale come Esc).
// Coreografie verificate sul CLI 2.1.227 (menu reale in tmux), anche per i SET
// con più domande (in quel caso il menu ha un'azione "Next" finché non si è
// all'ULTIMA domanda, poi l'azione diventa "Submit" e a fine set compare la
// review "Submit answers / Cancel" da confermare con un Enter finale):
//   single:      Down×i + Enter  (+ Enter se ultima domanda di un set >1)
//   multi:       tasto (i+1) per ogni opzione togglata (il cursore resta in
//                alto) + Down×(N+1) fino all'azione (Next o Submit)
//                + Enter (+ Enter se ultima: Submit + review)
//   other:       Down×N fino alla riga "Type something", testo libero,
//                (multi: Down all'azione) + Enter (+ Enter se ultima)
// ctx: isLast=true quando la domanda è l'ultima del suo set (la review finale
// appare SOLO per l'ultima domanda), setSize = numero di domande nel set
// (una singola domanda single-select non mostra review → un solo Enter).
// Limite noto: il toggle numerico del multi è a una cifra (1–9); una domanda
// con più di 9 opzioni è fuori scope (rara in AskUserQuestion).
export function answerToKeys(q: PromptQuestion, a: PromptAnswer, ctx: { isLast: boolean; setSize: number } = { isLast: true, setSize: 1 }): QuestionKey[] {
  const key = (k: string): QuestionKey => ({ kind: 'key', key: k });
  const downs = (n: number): QuestionKey[] => Array.from({ length: n }, () => key('Down'));
  // La review "Submit answers / Cancel" (un Enter per confermare, opzione 1
  // già evidenziata) compare per l'ultima domanda se è multiSelect (l'azione
  // Submit la apre) oppure se il set ha più domande (la chiusura del set la
  // mostra comunque, anche per single-select).
  const needsReviewEnter = ctx.isLast && (q.multiSelect || ctx.setSize > 1);
  if (a.kind === 'other') {
    // "Type something" è la riga N+1 (le N opzioni + quella aggiunta dal CLI).
    const seq: QuestionKey[] = [...downs(q.options.length), { kind: 'text', text: a.text }];
    if (q.multiSelect) seq.push(key('Down')); // → Next (set >1) o Submit (ultima)
    seq.push(key('Enter'));
    if (needsReviewEnter) seq.push(key('Enter'));
    return seq;
  }
  const indices = a.labels.map(label => q.options.findIndex(o => o.label === label)).filter(i => i >= 0);
  // Nessuna opzione valida e nessun testo libero da scrivere: niente da iniettare
  // (la domanda resta aperta perché l'utente risponda dal terminale).
  if (!indices.length && !a.extraText) return [];
  if (q.multiSelect) {
    const toggles = indices.map(i => key(String(i + 1)));
    const seq: QuestionKey[] = [...toggles];
    if (a.extraText) {
      // Opzioni togglate + testo libero insieme (es. "A, custom text"): il CLI
      // li accetta entrambi — si togglano le opzioni, si naviga alla riga
      // "Type something" (N+1, quindi N Down dalla riga 1) e si digita il
      // testo, poi all'azione.
      seq.push(...downs(q.options.length));
      seq.push({ kind: 'text', text: a.extraText });
      seq.push(key('Down')); // → Next (set >1) o Submit (ultima)
    } else {
      // Dal cursore (riga 1, i numeri non lo spostano) all'azione (Next o
      // Submit): N opzioni + "Type something" = N+1 Down.
      seq.push(...downs(q.options.length + 1));
    }
    seq.push(key('Enter'));
    if (needsReviewEnter) seq.push(key('Enter'));
    return seq;
  }
  const seq: QuestionKey[] = [...downs(indices[0]), key('Enter')];
  if (needsReviewEnter) seq.push(key('Enter'));
  return seq;
}

// Messaggio unico con tutte le risposte di un set, per le sessioni headless.
export function answersToMessage(questions: PromptQuestion[], answers: (PromptAnswer | undefined)[]): string {
  const lines = answers.map((a, i) => {
    const q = questions[i];
    const title = q.header ? `${q.header}: ${q.question}` : q.question;
    return `${i + 1}. ${title} → ${a ? answerSummary(a) : '(no answer)'}`;
  });
  return `Answers to your questions:\n${lines.join('\n')}`;
}

// Task 8, punto 4: chiave di deduplica per una domanda arrivata sul bus.
// toolUseId se presente (identità univoca della tool_use — sia l'hook che il
// transcript lo portano per la STESSA domanda); altrimenti una firma del
// contenuto (sessione + testo di domande e opzioni), per il caso raro in cui
// l'hook non è riuscito a leggere l'id (variante di payload non prevista).
// Pura ed esportata: la logica "quale delle due copie vince" NON vive qui —
// vive nell'ORDINE DI ARRIVO all'handler del bus (vedi registerPromptKey):
// la prima occorrenza di una chiave è mostrata, la seconda è lo scarto. Dato
// che l'hook scatta prima che il CLI apra il menu e il transcript scrive la
// stessa tool_use solo quando il turno si sblocca (l'utente ha già risposto
// al terminale), la copia dell'hook arriva SEMPRE per prima: non c'è verso di
// invertire l'esito scambiando l'ordine dei controlli qui dentro, perché qui
// dentro non c'è nessun controllo sull'ordine — solo sull'identità.
// Chiave di deduplica per una domanda arrivata sul bus: SOLO la firma del
// contenuto (sessione + testo di domande e opzioni). L'hook PermissionRequest
// di 2.1.227 non porta il tool_use_id nel payload (scatta prima che il
// tool_use esista: può solo dire "ask"), quindi il toolUseId non può essere la
// chiave condivisa fra la copia dell'hook e quella del transcript — la firma di
// contenuto sì, ed è l'unica che collida fra le due sorgenti. La one-shot +
// age-bound di registerPromptKey (commit 0892a7e) copre il caso di domande
// identiche ripetute nella stessa sessione: per le terminali la prima copia
// registra, la seconda (il duplicato) consuma la chiave, la domanda ripetuta
// successiva riparte pulita.
export function promptDedupeKey(sessionId: string, questions: PromptQuestion[]): string {
  const sig = questions.map(q => `${q.question}|${q.options.map(o => o.label).join(',')}`).join(';');
  return `sig:${sessionId}:${sig}`;
}

// Quante chiavi di deduplica tenere per sessione: abbastanza per il caso
// normale (poche domande in coda contemporaneamente), non un archivio senza
// fine per una sessione che vive per giorni.
export const PROMPT_DEDUPE_CAP = 50;

// Fix round 1 (Important): quanto restare in vita una chiave 'sig:' (fallback
// senza toolUseId) in attesa della sua eventuale copia dal transcript, se
// quella copia non arriva mai — sessione finita, cancellata, o /stop mentre
// la domanda era ancora in sospeso. Senza un bound la chiave resterebbe
// registrata per sempre e la PROSSIMA domanda con lo stesso testo/opzioni
// (es. un "Continue? Yes/No" ripetuto) verrebbe scartata a torto come falso
// duplicato — la stessa sparizione muta che questo task esiste per
// eliminare, reintrodotta nel percorso degradato. Deliberatamente largo:
// AskUserQuestion non ha un timeout proprio (vedi il commento in
// subscribeBus), e rispondere a mano al terminale può richiedere molti
// minuti — un bound stretto scadrebbe mentre l'utente sta ancora decidendo,
// riaprendo esattamente lo stesso buco. 30 minuti è il compromesso: molto
// più lungo di qualunque tempo di risposta plausibile, ma non "per sempre".
export const PROMPT_DEDUPE_MAX_AGE_MS = 30 * 60_000;

// Un ingresso della cache di deduplica: la chiave e il momento in cui è stata
// registrata (serve alla scadenza per età delle chiavi 'sig:', vedi sopra).
export interface PromptKeyEntry { key: string; at: number }

// Registra `key` nell'elenco delle chiavi già viste per una sessione (FIFO
// con cap): se era già presente la domanda è un duplicato (va scartata con
// motivo 'duplicate-prompt', mai in silenzio); altrimenti viene aggiunta.
// Pura: non tocca lo stato del bot, il chiamante (isDuplicatePrompt) si
// limita a leggere/scrivere la Map per sessione.
//
// Le due famiglie di chiavi (vedi promptDedupeKey) si comportano diversamente
// su un hit:
// - 'id:' (toolUseId, univoco per tool call): resta registrata esattamente
//   come prima di questo fix — nessun rischio di collisione fra domande
//   diverse, quindi nessun bisogno di consumarla né di farla scadere.
// - 'sig:' (fallback quando l'hook non ha un toolUseId leggibile): è
//   ONE-SHOT. La firma è solo testo+opzioni, quindi una domanda IDENTICA ma
//   successiva nella stessa sessione produce la STESSA chiave. Lasciarla
//   registrata per sempre scarterebbe quella domanda successiva come falso
//   duplicato — per questo un hit su una chiave 'sig:' la CONSUME (la
//   rimuove): sopprime esattamente la sua copia dal transcript, poi la
//   sessione riparte pulita per la prossima domanda con la stessa firma. Le
//   chiavi 'sig:' scadono anche per età (PROMPT_DEDUPE_MAX_AGE_MS) nel caso
//   quella copia non arrivi mai.
export function registerPromptKey(
  seen: readonly PromptKeyEntry[],
  key: string,
  opts: { cap?: number; maxAgeMs?: number; now?: number } = {},
): { duplicate: boolean; seen: PromptKeyEntry[] } {
  const cap = opts.cap ?? PROMPT_DEDUPE_CAP;
  const maxAgeMs = opts.maxAgeMs ?? PROMPT_DEDUPE_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  // La scadenza per età riguarda SOLO le 'sig:' — le 'id:' restano com'erano.
  const alive = seen.filter(e => !e.key.startsWith('sig:') || now - e.at < maxAgeMs);
  const idx = alive.findIndex(e => e.key === key);
  if (idx !== -1) {
    const oneShot = key.startsWith('sig:');
    const next = oneShot ? alive.filter((_, i) => i !== idx) : alive;
    return { duplicate: true, seen: next };
  }
  const next = [...alive, { key, at: now }];
  return { duplicate: false, seen: next.length > cap ? next.slice(next.length - cap) : next };
}

// Reply numerico dell'utente come fallback ai bottoni: "2" → [2], "1, 3" → [1,3].
// undefined se il testo non è una lista di numeri positivi.
export function parseNumericReply(text: string): number[] | undefined {
  const t = text.trim();
  if (!/^[\d,\s]+$/.test(t)) return undefined;
  const nums = t.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return nums.length ? nums : undefined;
}

// Matcher per il Fix 1: sopprime l'echo di un testo che il bot ha appena
// iniettato nel pane (l'utente lo vede già). Confronto trim, finestra 60s.
export function matchesInjected(recent: { text: string; at: number }[], text: string, now: number, windowMs = 60_000): boolean {
  const t = text.trim();
  return recent.some(item => now - item.at <= windowMs && item.text.trim() === t);
}

// Blocco di storia (Fix 5): gli ultimi messaggi renderizzati come chat. Il cap è
// per messaggi INTERI — i più vecchi vengono scartati, mai un messaggio spezzato;
// un singolo messaggio più lungo del cap viene troncato a fine parola.
export function renderHistory(messages: RecentMessage[], title: string, maxChars = 3800): string {
  const header = `<b>Last messages · ${htmlEscape(title)}</b>`;
  let remaining = maxChars - header.length - 2;
  const body: string[] = [];
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const m = messages[i];
    const line = `${m.role === 'user' ? '🧑' : '🤖'} ${mdToHtml(m.text)}`;
    const sep = body.length ? 2 : 0;
    if (line.length + sep > remaining) {
      body.push(truncateAtWord(line, Math.max(remaining - sep, 1)));
      break;
    }
    body.push(line);
    remaining -= line.length + sep;
  }
  return balanceHtml(`${header}\n\n${body.reverse().join('\n\n')}`);
}

// Risposta di /stop basata sull'esito reale (spec §3.3): mai un generico
// "Stop requested" quando non c'è nulla da fermare.
// The command that starts a session the daemon can drive, for the multiplexer
// in use (HTML-escaped, ready for a <code> block).
export function startSessionHint(mux: MultiplexerKind): string {
  return mux === 'zellij' ? 'zellij -s claude:&lt;project&gt;' : 'tmux new -s claude:&lt;project&gt;';
}

export function stopReply(o: {
  kind: 'headless' | 'terminal';
  id8: string;
  aborted?: boolean;
  status?: string;
  target?: string;
  mux?: MultiplexerKind;
}): string {
  if (o.kind === 'headless') {
    return o.aborted
      ? `🛑 Turn aborted for session <b>${htmlEscape(o.id8)}</b>.`
      : `No turn is running for session <b>${htmlEscape(o.id8)}</b> (status: ${htmlEscape(o.status ?? 'unknown')}).`;
  }
  return o.target
    ? `🛑 Ctrl+C sent to <code>${htmlEscape(o.target)}</code> — generation interrupted.`
    : `This terminal session has no ${o.mux ?? 'tmux'} pane to interrupt.`;
}

// Perché un evento non è stato consegnato. Ogni `return` silenzioso dei gestori
// del bus corrisponde a uno di questi motivi: senza un nome, uno scarto è
// indistinguibile da una perdita.
// 'duplicate-prompt' (Task 8): la copia dal transcript della stessa domanda
// già mostrata dall'hook — vedi promptDedupeKey/registerPromptKey. Non passa
// da gateSessionEvent (non è un gate armed/sessione-attiva, è un'identità
// già vista), ma condivide il vocabolario di questo tipo per restare
// cercabile allo stesso modo di ogni altro scarto.
export type DropReason = 'not-armed' | 'no-chat-bound' | 'not-active-session' | 'injected-echo' | 'duplicate-prompt';
export type DeliveryGate = { deliver: true } | { deliver: false; reason: DropReason };
export type GateKind = 'text' | 'tool' | 'error' | 'result' | 'prompt' | 'permission' | 'dialog';

export interface GateInput {
  kind: GateKind;
  armed: boolean;
  sessionId: string;
  activeSessionId?: string;
  isInjectedEcho?: boolean;
}

// Testo, tool, errori e risultati sono uno *stream*: riguardano solo la sessione
// che stai guardando. Domande, permessi e dialoghi sono *bloccanti*: scartarli
// perché la sessione non è selezionata la lascerebbe in attesa per sempre, senza
// modo di rispondere da Telegram — quindi passano sempre, e sono le rispettive
// code a decidere quando mostrarli.
const STREAM_KINDS: ReadonlySet<GateKind> = new Set<GateKind>(['text', 'tool', 'error', 'result']);

// `no-chat-bound` non compare qui di proposito: la mancanza di una chat collegata
// non ferma i gestori (che continuano a chiudere la bolla e a ripulire i flow),
// ferma l'invio — quindi va registrata dove l'invio avviene davvero, non qui.
//
// `not-active-session` è testato PRIMA di `injected-echo` di proposito: il
// gestore di `session.text` chiude la bolla tool e scarta le summary pendenti
// solo quando il motivo riportato è proprio l'echo, non per qualunque scarto.
// Se l'echo vincesse anche su una sessione non selezionata, quell'evento
// riporterebbe 'injected-echo' e il gestore chiuderebbe/ripulirebbe una
// sessione che non è quella dell'iniezione in corso (es. injection instradata
// su list()[0] o sul flow di una domanda, che non è detto siano la sessione
// selezionata) — un vero side effect su dati di un'altra sessione, non un
// semplice mancato inoltro. Riportare 'injected-echo' solo per la sessione che
// sarebbe stata comunque consegnata tiene il motivo allineato all'unico caso
// in cui il gestore deve intervenire.
export function gateSessionEvent(input: GateInput): DeliveryGate {
  if (!input.armed) return { deliver: false, reason: 'not-armed' };
  if (!STREAM_KINDS.has(input.kind)) return { deliver: true };
  if (input.sessionId !== input.activeSessionId) return { deliver: false, reason: 'not-active-session' };
  if (input.isInjectedEcho) return { deliver: false, reason: 'injected-echo' };
  return { deliver: true };
}

// Indicatore "sta scrivendo…" di Telegram: la bolla del chat action dura ~5s,
// quindi va rinnovata. start() invia subito e poi a intervalli; stop() ferma.
export class TypingIndicator {
  private timer?: NodeJS.Timeout;
  private cutoff?: NodeJS.Timeout;

  constructor(private send: () => Promise<unknown>, private intervalMs = 4000, private maxMs = 15 * 60_000) {}

  start(): void {
    if (!this.timer) {
      void this.send().catch(() => {});
      this.timer = setInterval(() => void this.send().catch(() => {}), this.intervalMs);
      this.timer.unref?.();
    }
    // Safety ceiling, re-armed on every start: a long but active turn (continuous
    // tool_use events) keeps resetting it, so only a wedged state with no further
    // events reaches the limit and "sta scrivendo…" auto-stops instead of hanging.
    if (this.cutoff) clearTimeout(this.cutoff);
    this.cutoff = setTimeout(() => this.stop(), this.maxMs);
    this.cutoff.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.cutoff) { clearTimeout(this.cutoff); this.cutoff = undefined; }
  }
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// One session per two lines: the first says title/status/activity, the second
// the target (tmux for terminal sessions, the model for headless ones). On a
// narrow screen a single line per session wrapped and mixed the facts; the
// active session is marked with a filled ● and a bold title (▸ was ambiguous).
export function sessionListText(sessions: Session[], activeId?: string, mux: MultiplexerKind = 'tmux'): string {
  if (!sessions.length) return 'No sessions.';
  return sessions
    .map(s => {
      const active = s.id === activeId;
      const marker = active ? '●' : '○';
      const title = htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8));
      const status = htmlEscape(s.status);
      const kindIcon = s.kind === 'terminal' ? '🖥' : '🧠';
      const detail = s.kind === 'terminal'
        ? (s.tmuxTarget ? htmlEscape(s.tmuxTarget) : `no ${mux}`)
        : htmlEscape(s.model ?? 'model');
      const line1 = `${marker} ${active ? `<b>${title}</b>` : title} · ${status} · ${relativeTime(s.lastActivity)}`;
      return `${line1}\n  ${kindIcon} ${detail}`;
    })
    .join('\n\n');
}

// Fotografia dello stato del daemon, resa per Telegram. Serve nella situazione
// in cui il servizio è utile: sei fuori casa, qualcosa non arriva, e non hai un
// terminale per guardare i log.
export interface DiagSession {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  title: string;
  transcript?: string;
  hasTmux: boolean;
  model?: string;
  effort?: EffortLevel;
  branch?: string;
}

export interface DiagSnapshot {
  version: string;
  armed: boolean;
  chatBound: boolean;
  activeSessionId?: string;
  sessions: DiagSession[];
  pending: { permissions: number; dialogs: number; questionFlows: number };
  recentErrors: string[];
  multiplexer?: MultiplexerKind;
}

export function diagReport(s: DiagSnapshot): string {
  const head = [
    `🩺 <b>claude-omni-rc ${htmlEscape(s.version)}</b>`,
    `state: ${s.armed ? 'armed' : 'disarmed'} · chat ${s.chatBound ? 'bound' : 'not bound'}`,
    `selected: ${s.activeSessionId ? `<code>${htmlEscape(s.activeSessionId.slice(0, 8))}</code>` : '—'}`,
  ].join('\n');

  const sessions = s.sessions.length
    ? s.sessions.map(x => {
        const active = x.id === s.activeSessionId;
        const marker = active ? '●' : '○';
        const title = htmlEscape(x.title) || htmlEscape(x.id.slice(0, 8));
        const kindIcon = x.kind === 'terminal' ? '🖥' : '🧠';
        const mux = s.multiplexer ?? 'tmux';
        const bits = [x.kind, x.hasTmux ? mux : `no-${mux}`, x.transcript ? 'transcript' : 'no-transcript'];
        const modelEffortBranch = [x.model ?? '—', x.effort ?? '—', x.branch ?? '—'].map(htmlEscape).join(' · ');
        const line1 = `${marker} ${active ? `<b>${title}</b>` : title} · ${htmlEscape(x.status)}`;
        return `${line1}\n  ${kindIcon} ${htmlEscape(bits.join(' · '))} · ${modelEffortBranch}`;
      }).join('\n\n')
    : 'no sessions tracked';

  const pending = `permissions ${s.pending.permissions} · dialogs ${s.pending.dialogs} · questions ${s.pending.questionFlows}`;

  // M3: ogni riga è un record JSON completo con stack trace espansa — senza
  // troncamento venti di queste bastano a spaccare /diag in dieci-più messaggi
  // Telegram per un solo comando. Il ring in log().recentErrors() resta intatto:
  // si tronca solo la resa qui, col marcatore esplicito di truncateAtWord.
  const errors = s.recentErrors.length
    ? s.recentErrors.map(l => `<code>${htmlEscape(truncateAtWord(l, 300))}</code>`).join('\n')
    : 'no recent errors';

  return `${head}\n\n<b>Sessions</b>\n${sessions}\n\n<b>Pending</b>\n${htmlEscape(pending)}\n\n<b>Recent errors</b>\n${errors}`;
}

// spec §8: mai inoltrare blocchi immagine a modelli text-only.
// Nota onesta (review finale): l'inoltro immagine è un "path reference" — il modello
// legge il file via additionalDirectories: inboxDir — NON un blocco immagine nel
// prompt, perché l'SDK query accetta solo prompt testuali. Il flag attach è
// volutamente assente (il codice non deve fingere un attach che non fa).
export function attachmentPlan(
  modelHasVision: boolean,
  kind: 'image' | 'document',
): { warning?: string } {
  if (kind === 'image' && !modelHasVision) {
    return { warning: '⚠️ This model has no vision: forwarding only the file path reference.' };
  }
  return {};
}

export class EditThrottler {
  private lastEdit = 0;
  constructor(private minIntervalMs = 1000) {}
  async throttled<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const wait = this.lastEdit + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastEdit = Date.now();
    try { return await fn(); } catch { return undefined; }
  }
}

// Aggregazione delle notifiche tool in una bubble per raffica: il primo tool_use
// crea il messaggio, i successivi lo modificano (edit) finché la raffica è aperta.
// `close()` viene chiamato su testo/domanda/permesso/errore → la raffica successiva
// apre una bubble nuova. Cap su maxLen: oltre il limite si apre una bubble nuova.
export interface ToolBurstSink {
  edit(messageId: number, text: string): Promise<boolean>;
  send(text: string): Promise<number | undefined>;
}

export class ToolBurstAggregator {
  private open?: { messageId: number; text: string };
  private lastWasTool = false;
  private chain: Promise<void> = Promise.resolve();
  // Contatore di generazione: `close()` lo incrementa. Una pushNow in volo
  // (await sul sink) cattura la generazione all'inizio e la ri-verifica dopo
  // l'await: se close() è scattato nel frattempo, non riapre la bubble chiusa.
  private generation = 0;
  // toolUseId → indice della riga dentro la bolla aperta: serve a riscrivere
  // in place la riga giusta quando arriva il suo tool_result fallito.
  private lineIds: (string | undefined)[] = [];
  private lines: string[] = [];

  // The burst is bounded by events, not by time: every push here is a tool
  // line (text never enters the bubble), so consecutive tool calls stay
  // grouped until close() — called on any text, prompt, permission, dialog,
  // result or error — opens a fresh bubble. A time window only split bursts
  // that happened to be slow.
  constructor(private sink: ToolBurstSink, private maxLen = 3800) {}

  // La bolla è SEMPRE nella forma raggruppata, dalla prima tool call: header col
  // conteggio + blocco espandibile. Una singola call parte già raggruppata, così
  // 1 e 2+ hanno lo stesso aspetto (coerenza) e le successive si aggiungono dentro.
  private bubbleText(lines: string[]): string {
    const n = lines.length;
    return `▸ <b>${n} ${n === 1 ? 'step' : 'steps'}</b>\n<blockquote expandable>${lines.join('\n\n')}</blockquote>`;
  }

  // Serializza le push: il bus emette in modo sincrono e due tool_use nello stesso
  // tick leggerebbero open/lastWasTool prima di ogni await — la catena rende le
  // mutazioni atomiche rispetto alle push concorrenti. La generazione viene
  // catturata QUI (non in pushNow): se close() scatta tra push() e l'avvio di
  // pushNow(), la push sa di appartenere alla generazione precedente e non
  // riapre la bubble chiusa.
  push(line: string, toolUseId?: string): Promise<void> {
    const gen = this.generation;
    this.chain = this.chain.then(() => this.pushNow(line, toolUseId, gen)).catch(() => { /* la catena sopravvive a un errore inatteso del sink */ });
    return this.chain;
  }

  private async pushNow(line: string, toolUseId: string | undefined, gen: number): Promise<void> {
    const open = this.open;
    if (this.lastWasTool && open) {
      // riga vuota tra una tool call e l'altra: la bubble non diventa un muro
      // di testo, ogni tool call resta riconoscibile come voce separata.
      const nextLines = [...this.lines, line];
      const next = this.bubbleText(nextLines);
      if (next.length <= this.maxLen && await this.sink.edit(open.messageId, next)) {
        if (gen !== this.generation) return; // chiusa nel frattempo: non toccare
        this.lines = nextLines;
        this.lineIds.push(toolUseId);
        open.text = next;
        return;
      }
    }
    const id = await this.sink.send(this.bubbleText([line]));
    if (gen !== this.generation) return; // chiusa nel frattempo: non riaprire
    if (id !== undefined) {
      this.open = { messageId: id, text: this.bubbleText([line]) };
      this.lines = [line];
      this.lineIds = [toolUseId];
      this.lastWasTool = true;
    } else {
      // send fallita (es. chatId assente): senza bubble aperta la prossima push
      // deve aprirne una nuova, non editare una bubble stantia.
      this.lastWasTool = false;
    }
  }

  // Only failures are signalled: the EditThrottler allows 1 op/s per chat, and
  // marking every success would double the calls for information that the
  // absence of ❌ already conveys.
  async markFailed(toolUseId: string, reason: string): Promise<void> {
    const open = this.open;
    if (!open) return;                       // bubble closed: do not reopen
    const i = this.lineIds.indexOf(toolUseId);
    if (i === -1) return;
    if (this.lines[i].startsWith('❌ ')) return; // already marked
    const short = reason.split('\n').find(l => l.trim())?.slice(0, 100) ?? '';
    this.lines[i] = `❌ ${this.lines[i]}${short ? `\n<i>${htmlEscape(short)}</i>` : ''}`;
    const next = this.bubbleText(this.lines);
    if (next.length <= this.maxLen && await this.sink.edit(open.messageId, next)) {
      open.text = next;
    }
  }

  // La bolla è già raggruppata a ogni push (vedi bubbleText): alla chiusura non
  // c'è più nulla da compattare. Il metodo resta per i call-site di chiusura.
  async collapse(): Promise<void> {
    return;
  }

  close(): void {
    this.generation++;
    this.open = undefined;
    this.lastWasTool = false;
    this.lines = [];
    this.lineIds = [];
  }
}

// ---------- bot ----------

// I2: correlazione opzionale per gli invii — non ogni chiamante ha un eventId
// (es. le notifiche di livello daemon), quindi entrambi i campi restano
// opzionali invece di forzare un valore inventato.
interface SendCorrelation { eventId?: string; sessionId?: string }

export interface BotDeps {
  config: Config;
  bus: Bus;
  manager: SessionManager;
  permissionFlow: PermissionFlow;
  dialogFlow: DialogFlow;
  sdk: SdkDriver;
  tmux: Multiplexer; // tmux or zellij (MULTIPLEXER)
  inbox: Inbox;
  ollama: OllamaClient;
  settingsStore: SettingsStore;
  bot?: Bot; // iniettabile nei test; default: il Bot grammy reale
}

// Text→question ordering guarantee: text sends are serialized on a per-session
// chain, and a prompt waits for the chain — plus a quiet-wait for hook prompts,
// where the text is already in the transcript but may not have reached the bus
// yet (poll). Injectable now/sleep for tests, same pattern as
// EditThrottler/ToolBurstAggregator.
export class TextOrderGate {
  private chain = new Map<string, Promise<void>>();
  private lastTextAt = new Map<string, number>();
  constructor(
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = ms => new Promise<void>(r => setTimeout(r, ms)),
    private onError?: (err: unknown) => void,
  ) {}

  record(sessionId: string, send: () => Promise<void>): Promise<void> {
    this.lastTextAt.set(sessionId, this.now());
    const prev = this.chain.get(sessionId) ?? Promise.resolve();
    const next = prev.then(send).catch(err => { this.onError?.(err); });
    this.chain.set(sessionId, next);
    return next;
  }

  flush(sessionId: string): Promise<void> {
    return this.chain.get(sessionId) ?? Promise.resolve();
  }

  async waitForPrecedingText(sessionId: string, quietMs = 300, capMs = 2000): Promise<void> {
    const deadline = this.now() + capMs;
    const lastAtStart = this.lastTextAt.get(sessionId) ?? 0;
    // The text preceding a hook question is already in the transcript but may
    // not have reached the bus yet (the transcript watcher polls). If a text
    // event was recorded recently, the text is flowing: wait for quiet after it.
    // If not, the poll hasn't drained the text yet: wait for the first text
    // event of this turn, then for quiet. Without this, a hook prompt that beats
    // its text on the bus (lastTextAt stale or 0) would break out immediately
    // and the question would precede the text in chat.
    // `lastAtStart` is 0 only when no text was ever recorded (real timestamps
    // are never 0): then now - 0 is huge and textWasFlowing is false.
    const textWasFlowing = this.now() - lastAtStart < quietMs;
    while (this.now() < deadline) {
      const last = this.lastTextAt.get(sessionId) ?? 0;
      const textIsCurrent = textWasFlowing || last > lastAtStart;
      if (textIsCurrent && this.now() - last > quietMs) break;
      await this.sleep(50);
    }
    await this.flush(sessionId);
  }
}

export class TelegramBot {
  private bot: Bot;
  private throttler = new EditThrottler(1000);
  private chatId?: number;
  private lastMsg = new Map<string, { messageId: number; raw: string; at: number; role: 'user' | 'assistant' }>();
  private textOrder = new TextOrderGate(undefined, undefined, err => log().error('text forward failed', { err }));
  private toolBursts = new Map<string, ToolBurstAggregator>();
  // One card per subagent, keyed by the toolUseId of the Task tool_use — the
  // same key the subagent's events carry in parentToolUseId.
  private agentCards = new Map<string, { messageId?: number; taskId: string; card: AgentCard; lastText?: string }>();
  // Events of a subagent that arrive before the task_started that creates its
  // card: buffered here so no tool line is lost when the card appears.
  private orphanAgentLines = new Map<string, string[]>();
  // Fix 1: testi iniettati dal bot per sessione (per sopprimere l'echo del transcript).
  private recentInjected = new Map<string, { text: string; at: number }[]>();
  // Fix 2: flusso delle domande a scelta multipla per sessione (macchina a
  // stati: set accodati, una domanda alla volta, multi-select e "Other").
  private questionFlows = new Map<string, QuestionFlow>(); // sessionId → flow
  private flowsByToken = new Map<string, QuestionFlow>(); // token → flow
  // Task 8, punto 4: chiavi di deduplica già viste per sessione (vedi
  // promptDedupeKey/registerPromptKey) — riconosce la copia tardiva del
  // transcript della stessa domanda già mostrata dall'hook.
  private seenPromptKeys = new Map<string, PromptKeyEntry[]>();
  // Permessi ExitPlanMode in attesa del testo libero per "Edit plan":
  // sessionId → id della richiesta di permesso.
  private pendingPlanEdits = new Map<string, string>();
  // Permessi/dialoghi arrivati per una sessione NON selezionata: restano in coda
  // (niente notifica, niente countdown — vedi PermissionFlow.arm/DialogFlow.arm)
  // finché l'utente non seleziona quella sessione (sess:select in onCallback).
  private pendingPermissions = new Map<string, PermissionRequest[]>();
  private pendingDialogs = new Map<string, UserDialog[]>();
  // Indicatore "sta scrivendo…" per la sessione attiva (chat action, non un messaggio).
  private typing = new TypingIndicator(() => {
    if (!this.chatId) return Promise.resolve();
    return this.bot.api.sendChatAction(this.chatId, 'typing');
  });
  private shExec = createShExec();

  constructor(private deps: BotDeps) {
    // Ripristina la chat di notifica dallo stato: dopo un riavvio del daemon le
    // richieste di permesso devono avere una destinazione già al primo prompt,
    // senza aspettare che l'utente scriva.
    this.chatId = deps.manager.getChatId();
    // timeout di sicurezza su ogni chiamata API Telegram (le getUpdates long-poll
    // usano 30s server-side: 35s non le taglia, ma ogni altra chiamata è limitata).
    this.bot = deps.bot ?? new Bot(deps.config.telegramBotToken, { client: { timeoutSeconds: 35 } });
    // senza bot.catch, grammy STOPPA il bot al primo errore di middleware non
    // gestito → il daemon moriva (spec §3.1). Ora logghiamo e si va avanti.
    // I4: console.error non raggiunge daemon.jsonl né /diag — solo daemon.err.log.
    // Stesso catch, stesso momento: cambia solo dove finisce il report.
    this.bot.catch(err => { log().error('telegram bot error', { err: (err as { error?: unknown })?.error ?? err }); });
    this.register();
    this.subscribeBus();
  }

  async start(): Promise<void> {
    if (!this.deps.config.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN missing');
    await this.bot.api.setMyCommands([
      { command: 'rc', description: 'Arm / disarm remote control' },
      { command: 'sessions', description: 'List and switch sessions' },
      { command: 'view', description: 'Show the active session screen' },
      { command: 'new', description: 'Start a headless session' },
      { command: 'stop', description: 'Stop the active session' },
      { command: 'status', description: 'Active session status' },
      { command: 'attach', description: `Attach a ${this.deps.config.multiplexer} terminal session` },
      { command: 'history', description: 'Show the last messages of a session' },
      { command: 'delete', description: 'Delete a session' },
      { command: 'usage', description: 'Check provider usage (5h / weekly)' },
      { command: 'context', description: 'Show the active session context used vs max' },
      { command: 'compact', description: 'Compact the active session history' },
      { command: 'diag', description: 'Daemon diagnostics' },
      { command: 'settings', description: 'View / change user settings' },
      { command: 'help', description: 'Show all commands' },
    ]).catch(this.logCatch('setMyCommands'));
    await this.bot.start({ drop_pending_updates: true });
  }
  async stop(): Promise<void> {
    await this.bot.stop();
  }

  // Ogni risposta passa dallo splitter: oltre 4096 caratteri Telegram rigetta il
  // messaggio e il .catch lo farebbe sparire in silenzio.
  private async send(ctx: Context, text: string): Promise<unknown> {
    const parts = splitHtmlMessage(text);
    // With a single part the marker would be pure noise.
    const label = (i: number): string => (parts.length > 1 ? `\n<i>(${i + 1}/${parts.length})</i>` : '');
    let last: unknown;
    for (let i = 0; i < parts.length; i++) {
      last = await ctx.reply(parts[i] + label(i), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
    return last;
  }

  // Invio sequenziale dei chunk (l'ordine conta) con gli extra — tastiera
  // inclusa — solo sull'ultimo. Ritorna l'id dell'ultimo messaggio inviato.
  // I2: `correlation` propaga eventId/sessionId fin qui quando il chiamante li
  // ha — così 'telegram send failed' (l'ultimo anello della catena) resta
  // agganciabile allo stesso eventId della riga 'event delivering' che l'ha
  // preceduto. Un chiamante senza quei valori (es. notify per un avviso di
  // daemon) non li propaga: il record dice onestamente che non c'erano,
  // invece di inventarli.
  private async sendChunked(chatId: number, text: string, extra: Record<string, unknown> = {}, correlation: SendCorrelation = {}): Promise<number | undefined> {
    const parts = splitHtmlMessage(text);
    // The marker is appended AFTER the split: prepending it to the text would
    // shift the character count on which splitHtmlMessage decides the cuts.
    // A single part needs no marker.
    const label = (i: number): string => (parts.length > 1 ? `\n<i>(${i + 1}/${parts.length})</i>` : '');
    let lastId: number | undefined;
    for (let i = 0; i < parts.length; i++) {
      const opts = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, ...(i === parts.length - 1 ? extra : {}) };
      const msg = await this.bot.api.sendMessage(chatId, parts[i] + label(i), opts).catch(err => { log().error('telegram send failed', { ...correlation, chatId, part: i, of: parts.length, err }); return undefined; });
      if (msg) lastId = msg.message_id;
    }
    return lastId;
  }

  // Pubblico: usato anche da daemon.ts per l'avviso "nuova versione disponibile".
  notify(text: string): void {
    const chatId = this.chatId;
    if (!chatId) { log().warn('send skipped', { kind: 'notice', reason: 'no-chat-bound' }); return; }
    this.track(this.sendChunked(chatId, text), 'notify');
  }

  // Contiene ogni errore degli handler: log + reply amichevole, mai un throw che
  // risale al middleware di grammy (che senza bot.catch fermerebbe la coda).
  private safe(ctx: Context, label: string, fn: () => Promise<unknown>): Promise<unknown> {
    return Promise.resolve().then(fn).catch(err => {
      // I4: instradato su log().error (prima console.error, invisibile a
      // daemon.jsonl e /diag) — stesso catch, stesso momento.
      log().error('handler failed', { label, err });
      return this.send(ctx, '❌ Something went wrong. Check the daemon log.').catch(() => undefined);
    });
  }

  // Aggiunge il log a un'operazione fire-and-forget: niente unhandled rejection
  // (in Node 22 una promise rifiutata non gestita uccide il processo).
  private track(p: Promise<unknown>, label: string): void {
    // I4: idem — il flusso domande (session.prompt) passa proprio da qui
    // (this.track(this.onSessionPrompt(...), 'prompt flow')), quindi un throw
    // dentro il flow era invisibile sia al log strutturato che a /diag.
    void p.catch(err => log().error('background task failed', { label, err }));
  }

  private logCatch(label: string): (err: unknown) => void {
    return err => log().error(label, { err });
  }

  // Applica il gate e registra l'esito. Restituisce il gate stesso: i
  // chiamanti che devono distinguere il motivo (es. session.text con l'echo)
  // guardano `.reason`, gli altri si limitano a `.deliver`.
  private passes(kind: GateKind, sessionId: string, eventId: string | undefined, isInjectedEcho = false): DeliveryGate {
    const gate = gateSessionEvent({
      kind,
      armed: this.deps.manager.isArmed(),
      sessionId,
      activeSessionId: this.deps.manager.getActive(),
      isInjectedEcho,
    });
    if (!gate.deliver) log().info('event dropped', { eventId, sessionId, kind, reason: gate.reason });
    return gate;
  }

  // Task 8, punto 4: true se questa chiave è già stata vista per la sessione
  // (la domanda va scartata come 'duplicate-prompt'), false se è nuova (e la
  // registra). Wrapper stateful attorno a registerPromptKey (pura, testata
  // direttamente) — qui vive solo la lettura/scrittura della Map per sessione.
  private isDuplicatePrompt(sessionId: string, key: string): boolean {
    const { duplicate, seen } = registerPromptKey(this.seenPromptKeys.get(sessionId) ?? [], key);
    this.seenPromptKeys.set(sessionId, seen);
    return duplicate;
  }

  // Converts on the ACCUMULATED text, not piece by piece: a table (or any
  // markdown block) split across events is recognized once it is complete. The
  // buffer holds the current bubble's raw markdown; when the converted HTML
  // exceeds SEND_MAX_CHARS a new message opens with only the new text and the
  // buffer restarts from there.
  private async forwardText(sessionId: string, raw: string, role: 'user' | 'assistant', eventId?: string, delta?: boolean): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) { log().warn('send skipped', { sessionId, kind: 'text', reason: 'no-chat-bound' }); return; }
    const last = this.lastMsg.get(sessionId);
    const now = Date.now();
    // A delta is the tail of a message the CLI rewrote in place: it already
    // carries its own boundary newline, so it merges without adding one — a
    // `\n` join would double the newline and break the row run of a streamed
    // table. Whole messages keep the `\n` join.
    const merged = last && last.role === role ? (delta ? `${last.raw}${raw}` : `${last.raw}\n${raw}`) : raw;
    const html = mdToHtml(merged);
    if (last && last.role === role && now - last.at < 10_000 && html.length <= SEND_MAX_CHARS) {
      const ok = await this.throttler.throttled(() =>
        this.bot.api.editMessageText(chatId, last.messageId, html, { parse_mode: 'HTML' }).then(() => true).catch(() => false));
      if (ok) {
        last.raw = merged; last.at = now;
        log().info('event delivered', { eventId, sessionId, kind: 'text', messageId: last.messageId });
        return;
      }
    }
    const freshHtml = mdToHtml(raw);
    const messageId = await this.sendChunked(chatId, freshHtml, {}, { eventId, sessionId });
    if (messageId !== undefined) {
      this.lastMsg.set(sessionId, { messageId, raw, at: now, role });
      log().info('event delivered', { eventId, sessionId, kind: 'text', messageId });
    }
  }

  // Bubble di raffica per le notifiche tool (una per sessione); il sink usa
  // l'EditThrottler condiviso e l'API del bot. `close()` è chiamato dai handler
  // di testo/domanda/permesso/errore (via `toolBurst(id).close()`).
  private toolBurst(sessionId: string): ToolBurstAggregator {
    let agg = this.toolBursts.get(sessionId);
    if (!agg) {
      agg = new ToolBurstAggregator({
        edit: async (messageId, text) => {
          const chatId = this.chatId;
          if (!chatId) { log().warn('send skipped', { sessionId, kind: 'tool', reason: 'no-chat-bound' }); return false; }
          const ok = await this.throttler.throttled(() =>
            this.bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
              .then(() => true)
              // C1: il sink non ha l'eventId (non è instradato dentro push(), fuori
              // scope per questa fase) — sessionId + kind bastano a legare questo
              // fallimento alla riga 'event merged into tool bubble' che lo precede.
              // Il valore di ritorno resta false: nessun cambio di comportamento.
              .catch(err => { log().error('tool bubble edit failed', { sessionId, kind: 'tool', err }); return false; }));
          return ok ?? false;
        },
        send: async text => {
          const chatId = this.chatId;
          if (!chatId) { log().warn('send skipped', { sessionId, kind: 'tool', reason: 'no-chat-bound' }); return undefined; }
          // anche il send passa dal throttler: massimo 1 op/sec per chat (niente 429).
          // C1: prima questo fallimento era doppiamente inghiottito (qui e dentro
          // EditThrottler.throttled) senza lasciare traccia — un testo fuso nella
          // bubble tool spariva senza nessuna riga di log dopo 'event merged into
          // tool bubble'. Il valore di ritorno resta undefined: nessun cambio di
          // comportamento, solo il record in più.
          const msg = await this.throttler.throttled(() =>
            // A Read must not buzz the phone: tool notifications stay silent.
            this.bot.api.sendMessage(chatId, text, {
              parse_mode: 'HTML',
              disable_notification: true,
              link_preview_options: { is_disabled: true },
            })
              .catch(err => { log().error('tool bubble send failed', { sessionId, kind: 'tool', err }); return undefined; }));
          return msg?.message_id;
        },
      });
      this.toolBursts.set(sessionId, agg);
    }
    return agg;
  }

  private agentKeyboard(key: string, expanded: boolean): InlineKeyboard {
    return new InlineKeyboard().text(expanded ? '🙈 Hide' : '👁 Details', `agent:toggle:${key}`);
  }

  // task_progress can arrive very often: the EditThrottler allows 1 op/s per
  // chat, so a card redrawn identically would steal the model text's turn. The
  // edit only fires if the rendered text actually changed.
  private async refreshAgentCard(key: string): Promise<void> {
    const entry = this.agentCards.get(key);
    const chatId = this.chatId;
    if (!entry) return;
    if (!chatId) { log().warn('send skipped', { kind: 'agent', reason: 'no-chat-bound' }); return; }
    const text = renderAgentCard(entry.card);
    if (text === entry.lastText) return;
    const opts = {
      parse_mode: 'HTML' as const,
      link_preview_options: { is_disabled: true },
      reply_markup: this.agentKeyboard(key, entry.card.expanded),
    };
    if (entry.messageId === undefined) {
      const msg = await this.throttler.throttled(() =>
        this.bot.api.sendMessage(chatId, text, { ...opts, disable_notification: true })
          .catch(err => { log().error('agent card send failed', { kind: 'agent', err }); return undefined; }));
      if (msg?.message_id !== undefined) { entry.messageId = msg.message_id; entry.lastText = text; }
      return;
    }
    const ok = await this.throttler.throttled(() =>
      this.bot.api.editMessageText(chatId, entry.messageId!, text, opts)
        .then(() => true)
        .catch(err => { log().error('agent card edit failed', { kind: 'agent', err }); return false; }));
    if (ok) entry.lastText = text;
  }

  // A task_updated that never arrives would leave the card in "⏳" forever: at
  // end of turn every card still running is interrupted.
  private closeAgentCards(): void {
    for (const [key, entry] of this.agentCards) {
      if (entry.card.status === 'running') { entry.card.status = 'killed'; void this.refreshAgentCard(key); }
    }
    this.agentCards.clear();
    this.orphanAgentLines.clear();
  }


  private isAuthorized(ctx: Context): boolean {
    if (!isPrivateChat(ctx.chat)) return false;
    const userId = ctx.from?.id;
    return !!userId && (this.deps.config.allowedUserIds.includes(userId) || this.deps.manager.isAuthorizedUser(userId));
  }

  // Destinazione delle notifiche: la chat privata da cui è arrivato l'ultimo
  // comando autorizzato, persistita così da sopravvivere ai riavvii del daemon.
  private bindChat(ctx: Context): void {
    const id = ctx.chat?.id;
    if (id === undefined || !isPrivateChat(ctx.chat)) return;
    this.chatId = id;
    this.deps.manager.setChatId(id);
  }

  // C'è una chat a cui notificare? Lo consulta il flusso permessi: senza
  // destinazione una richiesta resterebbe appesa fino al timeout.
  canNotify(): boolean { return this.chatId !== undefined; }

  private authorize(ctx: Context): boolean {
    if (this.isAuthorized(ctx)) { this.bindChat(ctx); return true; }
    if (!isPrivateChat(ctx.chat)) return false; // in un gruppo il bot tace del tutto
    this.track(this.send(ctx, '⛔ Not authorized. Send <code>/start &lt;pairing code&gt;</code>.'), 'authorize reply');
    return false;
  }

  private register(): void {
    const bot = this.bot;
    bot.command('start', ctx => this.safe(ctx, 'start', () => this.onStart(ctx)));
    bot.command('help', ctx => this.safe(ctx, 'help', async () => {
      if (this.authorize(ctx)) await this.send(ctx, 'Commands: /rc [on|off|status] (no arg toggles) · /sessions · /view · /new &lt;text&gt; · /stop · /status · /attach &lt;project&gt; · /history [id] · /delete [id] · /usage · /context · /compact · /diag · /settings · /help');
    }));
    bot.command('rc', ctx => this.safe(ctx, 'rc', () => this.onRc(ctx)));
    bot.command('sessions', ctx => this.safe(ctx, 'sessions', () => this.onSessions(ctx)));
    bot.command('view', ctx => this.safe(ctx, 'view', () => this.onView(ctx)));
    bot.command('new', ctx => this.safe(ctx, 'new', () => this.onNew(ctx)));
    bot.command('stop', ctx => this.safe(ctx, 'stop', () => this.onStop(ctx)));
    bot.command('status', ctx => this.safe(ctx, 'status', () => this.onStatus(ctx)));
    bot.command('attach', ctx => this.safe(ctx, 'attach', () => this.onAttach(ctx)));
    bot.command('history', ctx => this.safe(ctx, 'history', () => this.onHistory(ctx)));
    bot.command('delete', ctx => this.safe(ctx, 'delete', () => this.onDelete(ctx)));
    bot.command('usage', ctx => this.safe(ctx, 'usage', () => this.onUsage(ctx)));
    bot.command('context', ctx => this.safe(ctx, 'context', () => this.onContext(ctx)));
    bot.command('compact', ctx => this.safe(ctx, 'compact', () => this.onCompact(ctx)));
    bot.command('settings', ctx => this.safe(ctx, 'settings', () => this.onSettings(ctx)));
    bot.command('diag', ctx => this.safe(ctx, 'diag', async () => {
      if (!this.authorize(ctx)) return;
      const sessions = this.deps.manager.list();
      const diagSessions = await Promise.all(sessions.map(async x => ({
        id: x.id,
        kind: x.kind,
        status: x.status,
        title: x.title,
        transcript: x.transcriptFile ? basename(x.transcriptFile) : undefined,
        hasTmux: Boolean(x.tmuxTarget),
        model: x.model ?? this.deps.config.defaultModel,
        effort: x.effort,
        branch: await currentBranch(x.projectDir),
      })));
      await this.send(ctx, diagReport({
        version: CURRENT_VERSION,
        armed: this.deps.manager.isArmed(),
        chatBound: this.chatId !== undefined,
        activeSessionId: this.deps.manager.getActive(),
        sessions: diagSessions,
        multiplexer: this.deps.config.multiplexer,
        pending: {
          permissions: this.deps.permissionFlow.pendingCount(),
          dialogs: this.deps.dialogFlow.pendingCount(),
          questionFlows: this.questionFlows.size,
        },
        recentErrors: log().recentErrors(),
      }));
    }));
    bot.on('callback_query:data', ctx => this.safe(ctx, 'callback', () => this.onCallback(ctx)));
    bot.on('message:text', ctx => this.safe(ctx, 'message', () => this.onMessage(ctx)));
    bot.on('message:photo', ctx => this.safe(ctx, 'photo', () => this.onPhoto(ctx)));
    bot.on('message:document', ctx => this.safe(ctx, 'document', () => this.onDocument(ctx)));
  }

  private async onStart(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    // Il pairing non avviene mai in un gruppo: autorizzerebbe un account e
    // punterebbe le notifiche su una chat condivisa.
    if (!isPrivateChat(ctx.chat)) {
      await this.send(ctx, '⛔ claude-omni-rc works only in a private chat with the bot.');
      return;
    }
    if (this.isAuthorized(ctx)) {
      this.bindChat(ctx);
      await this.send(ctx, `👋 Welcome! State: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disarmed'}. Use /help.`);
      return;
    }
    const code = ctx.match?.toString().trim() ?? '';
    if (this.deps.config.pairingCode && code === this.deps.config.pairingCode) {
      this.deps.manager.addAuthorizedUser(userId);
      this.deps.manager.persist();
      this.bindChat(ctx);
      await this.send(ctx, '✅ Pairing successful. Use /help.');
    } else {
      await this.send(ctx, '⛔ Not authorized. Send <code>/start &lt;pairing code&gt;</code>.');
    }
  }

  private async arm(ctx: Context): Promise<void> {
    this.deps.manager.setArmed(true); this.deps.manager.persist();
    await this.send(ctx, '🔓 Remote control ARMED.');
  }

  private async disarm(ctx: Context): Promise<void> {
    this.deps.manager.setArmed(false);
    for (const s of this.deps.manager.list()) {
      this.deps.permissionFlow.cancelAllForSession(s.id);
      this.deps.dialogFlow.cancelAllForSession(s.id);
      this.pendingPlanEdits.delete(s.id);
      this.pendingPermissions.delete(s.id);
      this.pendingDialogs.delete(s.id);
      this.deps.sdk.stop(s.id); // spegne anche i turni headless in corso
    }
    this.deps.manager.persist();
    await this.send(ctx, '🔒 Remote control DISARMED. No mirroring, injection or relay.');
  }

  private async onRc(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    const arg = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (arg === 'on') {
      await this.arm(ctx);
    } else if (arg === 'off') {
      await this.disarm(ctx);
    } else if (arg === 'status') {
      await this.send(ctx, `Switch: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disarmed'}`);
    } else if (arg === '') {
      // no argument → toggle the armed switch
      if (this.deps.manager.isArmed()) await this.disarm(ctx);
      else await this.arm(ctx);
    } else {
      await this.send(ctx, 'Usage: /rc [on|off|status] — no argument toggles.');
    }
  }

  private requireArmed(ctx: Context): boolean {
    if (!this.deps.manager.isArmed()) { this.track(this.send(ctx, '🔒 Remote control is off. Send /rc on.'), 'requireArmed reply'); return false; }
    return true;
  }

  private async onSessions(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const list = this.deps.manager.list();
    if (!list.length) {
      await ctx.reply(
        `No sessions yet.\n\nRun Claude Code inside ${this.deps.config.multiplexer} and it will show up here automatically:\n<code>${startSessionHint(this.deps.config.multiplexer)}</code>\n\nOr start a headless session:\n<code>/new &lt;prompt&gt;</code>`,
        { parse_mode: 'HTML' });
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of list) kb.text(s.id.slice(0, 6), `sess:select:${s.id}`).text('🗑', `sess:del:${s.id}`).row();
    await ctx.reply(sessionListText(list, this.deps.manager.getActive(), this.deps.config.multiplexer), {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }

  private async onSettings(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const cmd = parseSettingsCommand(raw);
    const settings = this.deps.settingsStore.load();
    switch (cmd.kind) {
      case 'all':
        await this.send(ctx, formatSettingsReport(settings, this.deps.config));
        return;
      case 'show':
        await this.send(ctx, formatSettingsKey(cmd.key, settings, this.deps.config));
        return;
      case 'set': {
        const parsed = parseSettingsValue(cmd.key, cmd.value);
        if (!parsed.ok) {
          await this.send(ctx, `❌ Invalid value for <code>${htmlEscape(cmd.key)}</code>: ${htmlEscape(parsed.error)}.`);
          return;
        }
        const next = { ...settings, ...parsed.settings };
        this.deps.settingsStore.save(next);
        await this.send(ctx, `✅ <code>${htmlEscape(cmd.key)}</code> = <code>${htmlEscape(cmd.value.trim())}</code> saved. Applies at the next daemon restart.`);
        return;
      }
      case 'reset': {
        const next = { ...settings };
        delete next[cmd.key];
        this.deps.settingsStore.save(next);
        await this.send(ctx, `↩️ <code>${htmlEscape(cmd.key)}</code> reset to the .env / default value. Applies at the next daemon restart.`);
        return;
      }
      case 'invalid':
        await this.send(ctx, `❌ ${htmlEscape(cmd.reason)}`);
        return;
    }
  }

  private async onNew(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const raw = ctx.match?.toString().trim() ?? '';
    if (!raw) {
      await this.send(ctx, 'Usage: /new [--auto|--standard] [--model &lt;name&gt;] [--effort &lt;level&gt;] &lt;text&gt;');
      return;
    }
    const { mode, model, effort, text } = parseNewFlags(raw);
    if (!text) { await this.send(ctx, 'Usage: /new [--auto|--standard] [--model &lt;name&gt;] [--effort &lt;level&gt;] &lt;text&gt;'); return; }
    const running = this.deps.manager.list().filter(s => s.kind === 'headless' && s.status === 'running').length;
    if (running >= this.deps.config.maxHeadlessSessions) { await this.send(ctx, `Reached the limit of ${this.deps.config.maxHeadlessSessions} active headless sessions.`); return; }
    const { dir: projectDir, error } = resolveHeadlessProjectDir(this.deps.config.workspaceDirs);
    if (!projectDir) { await this.send(ctx, `⚠️ ${error}`); return; }
    const permissionMode = mode ?? this.deps.config.defaultPermissionMode;
    const session = this.deps.manager.createHeadless({
      title: text.slice(0, 40), projectDir, model: model ?? this.deps.config.defaultModel,
      permissionMode, effort: effort ?? this.deps.config.defaultEffort,
    });
    this.deps.manager.setActive(session.id); // persiste anche la nuova sessione
    const modeLabel = permissionMode === 'standard' ? ' (standard — approvals via buttons)' : ' (automode — no approvals)';
    await this.send(ctx, `🆕 Session <b>${htmlEscape(session.id.slice(0, 8))}</b> started${modeLabel}.`);
    // NON await: grammy processa gli update in sequenza — aspettare un turno di minuti
    // bloccherebbe /stop, /rc off e i callback. Il driver emette gli eventi sul bus.
    this.track(this.deps.sdk.runTurn(session.id, text), 'runTurn');
  }

  private async onStop(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const active = this.deps.manager.getActive();
    const s = active ? this.deps.manager.get(active) : undefined;
    if (!s) { await this.send(ctx, 'No active session.'); return; }
    const id8 = s.id.slice(0, 8);
    const flow = this.questionFlows.get(s.id);
    if (flow) this.deleteFlow(flow); // /stop: niente domande pendenti
    this.pendingPlanEdits.delete(s.id);
    if (s.kind === 'headless') {
      this.deps.permissionFlow.cancelAllForSession(s.id);
      this.deps.dialogFlow.cancelAllForSession(s.id);
      const aborted = this.deps.sdk.stop(s.id); // abort del turno in corso
      await this.send(ctx, stopReply({ kind: 'headless', id8, aborted, status: s.status }));
    } else if (s.tmuxTarget) {
      try {
        await this.deps.tmux.sendKeys(s.tmuxTarget, 'C-c');
        await this.send(ctx, stopReply({ kind: 'terminal', id8, target: s.tmuxTarget }));
      } catch (e) {
        await this.send(ctx, `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
      }
    } else {
      await this.send(ctx, stopReply({ kind: 'terminal', id8, mux: this.deps.config.multiplexer }));
    }
  }

  private async onStatus(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const active = this.deps.manager.getActive(); const s = active ? this.deps.manager.get(active) : undefined;
    await this.send(ctx, s
      ? `Active session: <b>${s.id.slice(0, 8)}</b> [${s.kind}] — ${s.status}`
      : 'No active session. Create one with /new.');
  }

  // Ollama Cloud (via ollama-usage) o Anthropic (via l'API sperimentale della
  // Agent SDK) a seconda del provider della sessione attiva — stesso criterio
  // model-aware di omni-rc.sh e sdk-driver.ts (resolveProvider). Senza sessione
  // attiva si usa DEFAULT_MODEL.
  private async onUsage(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const active = this.deps.manager.getActive();
    const s = active ? this.deps.manager.get(active) : undefined;
    const model = s?.model ?? this.deps.config.defaultModel;
    if (isOllamaProvider(this.deps.config, model)) {
      await this.sendOllamaUsage(ctx);
    } else {
      await this.sendAnthropicUsage(ctx);
    }
  }

  // Context of the active session: the tokens the CLI actually sent in the last
  // turn (from the transcript usage) vs the model's context window. Reading the
  // transcript makes this work for headless and terminal sessions alike.
  private async onContext(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const active = this.deps.manager.getActive();
    const session = active ? this.deps.manager.get(active) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'No session yet. Create one with /new or /attach.'); return; }
    const file = resolveSessionTranscript(this.deps.config.projectsDir, session.projectDir, session.claudeSessionId, Date.parse(session.createdAt), session.transcriptFile);
    let used: number | undefined;
    if (file) {
      try { used = lastContextTokens(readFileSync(file, 'utf8').split('\n')); } catch { /* transcript unreadable: report no data */ }
    }
    let max: number | undefined;
    if (session.model) {
      max = isAnthropicModel(session.model)
        ? anthropicContextWindow(session.model)
        : await this.deps.ollama.modelContext(session.model);
    }
    await this.send(ctx, renderContext(used, max, session.model));
  }

  // /compact runs the CLI's compaction on the active session: the CLI treats a
  // leading-slash prompt as a command, so headless sessions get it through
  // runTurn and terminal ones by pasting into the tmux pane (recording it so
  // the echoed line is not re-sent to Telegram).
  private async onCompact(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const active = this.deps.manager.getActive();
    const s = active ? this.deps.manager.get(active) : undefined;
    if (!s) { await this.send(ctx, 'No active session.'); return; }
    const id8 = s.id.slice(0, 8);
    if (s.kind === 'headless') {
      if (this.deps.sdk.isBusy(s.id)) {
        await this.send(ctx, '⏳ Session busy: wait for it to go idle before compacting.');
        return;
      }
      this.track(this.deps.sdk.runTurn(s.id, '/compact'), 'runTurn compact');
      await this.send(ctx, `🧹 Compacting session <code>${htmlEscape(id8)}</code>…`);
    } else if (s.tmuxTarget) {
      try {
        await this.deps.tmux.injectText(s.tmuxTarget, '/compact');
        this.recordInjected(s.id, '/compact');
        await this.send(ctx, `🧹 Compacting session <code>${htmlEscape(id8)}</code>…`);
      } catch (e) {
        await this.send(ctx, `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
      }
    } else {
      await this.send(ctx, `This session is not running in ${this.deps.config.multiplexer}, so /compact can’t be sent.`);
    }
  }

  private async sendOllamaUsage(ctx: Context): Promise<void> {
    const result = await fetchOllamaUsage(this.shExec);
    switch (result.kind) {
      case 'not-installed':
        await this.send(ctx, '🦙 <code>ollama-usage</code> isn\'t installed on the daemon\'s machine. Install it:\n<code>curl -fsSL https://ontech7.github.io/ollama-usage/install.sh | sh</code>');
        return;
      case 'needs-auth':
        await this.send(ctx, '🦙 No Ollama session. Run <code>ollama-usage auth</code> on the daemon\'s machine.');
        return;
      case 'error':
        await this.send(ctx, `⚠️ <code>ollama-usage</code> failed: ${htmlEscape(result.message)}`);
        return;
      case 'ok': {
        const five = result.windows['5h'];
        const weekly = result.windows.weekly;
        const lines = ['🦙 <b>Ollama Cloud usage</b>'];
        if (five) lines.push(`5h: ${formatPct(five.pct_used)} (resets ${formatResetAt(five.reset_at)})`);
        if (weekly) lines.push(`weekly: ${formatPct(weekly.pct_used)} (resets ${formatResetAt(weekly.reset_at)})`);
        if (!five && !weekly) lines.push('No usage windows reported.');
        await this.send(ctx, lines.join('\n'));
        return;
      }
    }
  }

  private async sendAnthropicUsage(ctx: Context): Promise<void> {
    const result = await fetchAnthropicUsage();
    switch (result.kind) {
      case 'unavailable':
        await this.send(ctx, '🤖 Rate-limit windows aren\'t available for this auth method (API key / Bedrock / Vertex have no plan usage windows).');
        return;
      case 'error':
        await this.send(ctx, `⚠️ Couldn\'t fetch Anthropic usage: ${htmlEscape(result.message)}`);
        return;
      case 'ok': {
        const lines = ['🤖 <b>Anthropic usage</b>'];
        if (result.fiveHour) lines.push(`5h: ${formatPct(result.fiveHour.utilization)} (resets ${formatResetAt(result.fiveHour.resetsAt)})`);
        if (result.sevenDay) lines.push(`7d: ${formatPct(result.sevenDay.utilization)} (resets ${formatResetAt(result.sevenDay.resetsAt)})`);
        if (!result.fiveHour && !result.sevenDay) lines.push('No usage windows reported.');
        await this.send(ctx, lines.join('\n'));
        return;
      }
    }
  }

  private async onAttach(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const name = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (!name) { await this.send(ctx, 'Usage: /attach &lt;project&gt;'); return; }
    const projectDir = this.resolveProjectDir(name);
    if (!projectDir) { await this.send(ctx, `Project "${htmlEscape(name)}" not found in the workspaces.`); return; }
    const session = this.deps.manager.registerTerminal({ title: name, projectDir, tmuxTarget: `claude:${name}` });
    this.deps.manager.setActive(session.id); // persiste anche la sessione terminale
    await this.send(ctx, `📎 Terminal session <b>${htmlEscape(session.id.slice(0, 8))}</b> attached to <code>claude:${htmlEscape(name)}</code>.`);
  }

  private resolveProjectDir(name: string): string | undefined {
    for (const w of this.deps.config.workspaceDirs) {
      const candidate = join(w, name);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private async onHistory(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const id = ctx.match?.toString().trim() || this.deps.manager.getActive();
    if (!id) { await this.send(ctx, 'No active session. Select one with /sessions.'); return; }
    const hist = await this.readHistory(id);
    if (!hist) { await this.send(ctx, 'No transcript available for this session yet.'); return; }
    await this.send(ctx, hist);
  }

  // Fix 5: gli ultimi ~10 messaggi del transcript della sessione, come chat.
  private async readHistory(sessionId: string): Promise<string | undefined> {
    const s = this.deps.manager.get(sessionId);
    if (!s) return undefined;
    const file = resolveSessionTranscript(
      this.deps.config.projectsDir,
      s.projectDir,
      s.kind === 'headless' ? s.claudeSessionId : undefined,
      Date.parse(s.createdAt),
      s.transcriptFile, // path registrato: se non esiste più viene ritrovato per basename (worktree)
    );
    if (!file) return undefined;
    const msgs = readRecentMessages(file, 10);
    if (!msgs.length) return undefined;
    return renderHistory(msgs, s.title || s.id.slice(0, 8));
  }

  private async onDelete(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const id = ctx.match?.toString().trim() || this.deps.manager.getActive();
    if (!id) { await this.send(ctx, 'Usage: /delete [session id]'); return; }
    const s = this.deps.manager.get(id);
    if (!s) { await this.send(ctx, 'Session not found.'); return; }
    const kb = new InlineKeyboard()
      .text('✓ Yes, delete', `sess:del-yes:${s.id}`)
      .text('✗ No', `sess:del-no:${s.id}`);
    await ctx.reply(`Delete session <b>${htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}]?`, {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }

  // Fix 6: ferma il turno headless e rimuove la sessione dal registro.
  // Per le terminali il pane tmux continua a girare: si perde solo il tracking.
  private deleteSession(id: string): boolean {
    this.deps.permissionFlow.cancelAllForSession(id);
    this.deps.dialogFlow.cancelAllForSession(id);
    this.pendingPlanEdits.delete(id);
    this.pendingPermissions.delete(id); // niente notifiche fantasma per una sessione sparita
    this.pendingDialogs.delete(id);
    this.deps.sdk.stop(id); // abort del turno headless in corso
    const flow = this.questionFlows.get(id);
    if (flow) this.deleteFlow(flow); // niente domande pendenti per una sessione sparita
    const ok = this.deps.manager.remove(id);
    if (ok) this.deps.manager.persist();
    return ok;
  }

  // Feedback persistente (Fix 7): sostituisce i bottoni con l'esito della decisione.
  private async editCallbackDecision(ctx: Context, header: string): Promise<void> {
    const msg = ctx.callbackQuery?.message;
    if (!msg || !('text' in msg)) return;
    await ctx.editMessageText(`${header}\n\n${msg.text}`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard(), // svuota i bottoni
    }).catch(this.logCatch('callback edit'));
  }

  // ---------- flusso domande multiple ----------

  private setFlow(flow: QuestionFlow): void {
    this.questionFlows.set(flow.sessionId, flow);
    this.flowsByToken.set(flow.token, flow);
  }

  private deleteFlow(flow: QuestionFlow): void {
    this.questionFlows.delete(flow.sessionId);
    this.flowsByToken.delete(flow.token);
  }

  // Un nuovo set di domande (una chiamata AskUserQuestion) arriva dal bus:
  // accodato al flow della sessione; se il flow è idle, mostra la prima domanda.
  private async onSessionPrompt(sessionId: string, questions: PromptQuestion[], eventId: string | undefined, source: 'transcript' | 'hook' | undefined, toolUseId?: string): Promise<void> {
    let flow = this.questionFlows.get(sessionId);
    if (!flow) {
      flow = { sessionId, sets: [], eventIds: [], toolUseIds: [], setIndex: 0, qIndex: 0, answers: [], token: randomUUID(), multiSel: [] };
      this.setFlow(flow);
    }
    const setIndex = flow.sets.length;
    flow.sets.push(questions);
    flow.eventIds.push(eventId);
    flow.toolUseIds.push(toolUseId);
    flow.answers.push(questions.map(() => undefined));
    // La prima domanda di un flow nuovo si mostra subito solo se questa
    // sessione è quella selezionata — altrimenti resta in pending: niente
    // interruzioni per sessioni che non stai guardando (vedi sess:select per
    // il recupero quando l'utente ci passa sopra). `!flow.displaying` chiude la
    // finestra di race fra il controllo e l'assegnazione di messageId (l'invio
    // di showQuestion è async): senza, due set ravvicinati manderebbero due
    // messaggi per la stessa domanda.
    if (sessionId === this.deps.manager.getActive() && flow.setIndex === 0 && flow.qIndex === 0 && !flow.messageId && !flow.displaying) {
      await this.showQuestion(flow);
    } else {
      // C2: prima qui non c'era nessun record — il set resta accodato invece di
      // essere mostrato, e senza questa riga un operatore che segue l'eventId
      // vedrebbe la catena finire nel nulla dopo 'event emitted'/'event queued'.
      // Due cause distinte, nominate esplicitamente (non un generico "queued"):
      // la sessione non è quella selezionata, oppure questo stesso flow ha già
      // una domanda a schermo (nuovo set in coda dietro quella corrente).
      const reason = sessionId !== this.deps.manager.getActive() ? 'not-active-session' : 'question-on-screen';
      log().info('event queued', { eventId, sessionId, kind: 'prompt', reason });
    }
  }

  // Header + elenco numerato + stato selezione per la domanda corrente.
  // L'id sessione è nell'header perché la domanda arriva anche da sessioni non
  // selezionate (vedi session.prompt in subscribeBus) — senza non si capirebbe
  // a quale sessione rispondere quando ce n'è più di una in attesa.
  private renderQuestion(flow: QuestionFlow, q: PromptQuestion): string {
    const set = flow.sets[flow.setIndex];
    const header = `Session ${flow.sessionId.slice(0, 8)} · Set ${flow.setIndex + 1} of ${flow.sets.length} · Question ${flow.qIndex + 1} of ${set.length}`;
    const title = q.header ? `${q.header}: ${q.question}` : q.question;
    const multi = q.multiSelect ? ' (select all that apply)' : '';
    const opts = q.options
      .map((o, i) => `  ${i + 1}. ${htmlEscape(o.label)}${o.description ? ` — <i>${htmlEscape(o.description)}</i>` : ''}`)
      .join('\n');
    const sel = q.multiSelect && flow.multiSel.length
      ? `\n\n<i>Selected: ${flow.multiSel.map(i => htmlEscape(q.options[i].label)).join(', ')}</i>`
      : '';
    return `❓ <b>${htmlEscape(header)}</b>\n<b>${htmlEscape(title)}</b>${multi}\n${opts}${sel}`;
  }

  // Bottoni per la domanda corrente: opzioni (toggle per multi-select), Done e Other.
  private buildQuestionKeyboard(flow: QuestionFlow, q: PromptQuestion): InlineKeyboard {
    const kb = new InlineKeyboard();
    const token = flow.token;
    const qi = flow.qIndex;
    if (q.multiSelect) {
      for (let i = 0; i < q.options.length; i++) {
        const selected = flow.multiSel.includes(i);
        kb.text(`${selected ? '✓ ' : ''}${q.options[i].label}`, `q:answer:${token}:${qi}:${i}`).row();
      }
      kb.text('✓ Done', `q:done:${token}:${qi}`).row();
      kb.text('✏️ Other', `q:other:${token}:${qi}`).row();
    } else {
      for (let i = 0; i < q.options.length; i++) {
        kb.text(q.options[i].label, `q:answer:${token}:${qi}:${i}`).row();
      }
      kb.text('✏️ Other', `q:other:${token}:${qi}`).row();
    }
    return kb;
  }

  // Invia un nuovo messaggio per la domanda corrente.
  private async showQuestion(flow: QuestionFlow): Promise<void> {
    // C2: prima questo `return` silenzioso era l'unico sito di invio del file
    // senza il record 'send skipped' aggiunto altrove in questo branch —
    // stesso motivo ('no-chat-bound'), stessa forma degli altri.
    if (!this.chatId) { log().warn('send skipped', { sessionId: flow.sessionId, kind: 'prompt', reason: 'no-chat-bound' }); return; }
    const eventId = flow.eventIds[flow.setIndex];
    const q = flow.sets[flow.setIndex][flow.qIndex];
    const text = this.renderQuestion(flow, q);
    const kb = this.buildQuestionKeyboard(flow, q);
    // C2: 'event delivering' è stato spostato qui da subscribeBus — questo è il
    // solo punto in cui una domanda viene DAVVERO mostrata (chiamato dal ramo
    // "flow idle" di onSessionPrompt, da advance() per la domanda/set successivo,
    // e dal recupero di una domanda in pending su sess:select). Prima veniva
    // loggato incondizionatamente all'arrivo dell'evento, anche quando il set
    // finiva solo accodato — un operatore avrebbe letto "delivering" per
    // qualcosa che non era ancora successo.
    log().info('event delivering', { eventId, sessionId: flow.sessionId, kind: 'prompt', setIndex: flow.setIndex, qIndex: flow.qIndex });
    // La guardia anti-race va alzata PRIMA dell'await: messa qui, nel corpo di
    // showQuestion, è sincrona rispetto alla condizione "flow idle" di
    // onSessionPrompt (l'await di showQuestion la esegue nello stesso tick).
    flow.displaying = true;
    try {
      const id = await this.sendChunked(this.chatId, text, { reply_markup: kb }, { eventId, sessionId: flow.sessionId });
      if (id) {
        flow.messageId = id;
        // I3: chiude la catena per questa domanda — consegna riuscita, con l'id
        // del messaggio Telegram risultante.
        log().info('event delivered', { eventId, sessionId: flow.sessionId, kind: 'prompt', messageId: id });
      }
    } finally {
      flow.displaying = false;
    }
  }

  // Edita il messaggio corrente (toggle multi-select, cancel Other).
  private async updateQuestionMessage(flow: QuestionFlow): Promise<void> {
    if (!flow.messageId || !this.chatId) return;
    const q = flow.sets[flow.setIndex][flow.qIndex];
    const text = this.renderQuestion(flow, q);
    const kb = this.buildQuestionKeyboard(flow, q);
    await this.bot.api.editMessageText(this.chatId, flow.messageId, text, {
      parse_mode: 'HTML', reply_markup: kb,
    }).catch(this.logCatch('prompt edit'));
  }

  // Conferma visiva della risposta sul messaggio corrente (bottoni rimossi).
  private async acknowledgeAnswer(flow: QuestionFlow, ack: string): Promise<void> {
    if (!flow.messageId || !this.chatId) return;
    const q = flow.sets[flow.setIndex][flow.qIndex];
    const text = `${this.renderQuestion(flow, q)}\n\n✅ <b>Answer:</b> ${htmlEscape(ack)}`;
    await this.bot.api.editMessageText(this.chatId, flow.messageId, text, {
      parse_mode: 'HTML', reply_markup: new InlineKeyboard(),
    }).catch(this.logCatch('prompt edit'));
  }

  // L'utente ha risposto a questa domanda al terminale (il tool_result della
  // tool_use AskUserQuestion è arrivato dal transcript): la domanda in chat non
  // deve restare appesa coi bottoni. Si marca come risolta e si avanza OLTRE il
  // set — il turno si sblocca solo quando l'intero set è stato inviato, quindi
  // tutte le domande del set sono risolte. Cancellare l'intero flow qui
  // perderebbe un set che il modello ha già chiesto: la sua copia hook viene
  // accodata al flow prima che il tool_result del set precedente arrivi.
  private async markQuestionAnsweredAtTerminal(flow: QuestionFlow): Promise<void> {
    if (flow.messageId && this.chatId) {
      const q = flow.sets[flow.setIndex][flow.qIndex];
      const text = `${this.renderQuestion(flow, q)}\n\n✅ <b>Answered at the terminal</b>`;
      await this.bot.api.editMessageText(this.chatId, flow.messageId, text, {
        parse_mode: 'HTML', reply_markup: new InlineKeyboard(),
      }).catch(this.logCatch('prompt edit'));
    }
    flow.setIndex++;
    flow.qIndex = 0;
    flow.multiSel = [];
    flow.awaitingOther = undefined;
    if (flow.setIndex < flow.sets.length) {
      await this.showQuestion(flow);
    } else {
      this.deleteFlow(flow);
    }
  }

  // Prompt per il testo libero "Other" (con Cancel per tornare ai bottoni).
  private async showOtherPrompt(flow: QuestionFlow, qIndex: number): Promise<void> {
    if (!flow.messageId || !this.chatId) return;
    const q = flow.sets[flow.setIndex][qIndex];
    const title = q.header ? `${q.header}: ${q.question}` : q.question;
    const kb = new InlineKeyboard().text('↩️ Cancel', `q:cancel:${flow.token}:${qIndex}`);
    await this.bot.api.editMessageText(this.chatId, flow.messageId, `✏️ <b>Type your answer for:</b> ${htmlEscape(title)}`, {
      parse_mode: 'HTML', reply_markup: kb,
    }).catch(this.logCatch('prompt edit'));
  }

  // Tap su un'opzione: single-select risponde subito, multi-select toggla.
  private async answerPrompt(ctx: Context, parsed: CallbackData): Promise<void> {
    const flow = this.flowsByToken.get(parsed.id);
    if (!flow) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
    const qIndex = parsed.questionIndex ?? 0;
    const optIndex = parsed.index ?? 0;
    const q = flow.sets[flow.setIndex][qIndex];
    const opt = q?.options[optIndex];
    if (!q || !opt) { await ctx.answerCallbackQuery({ text: 'Invalid option' }); return; }
    if (q.multiSelect) {
      const i = flow.multiSel.indexOf(optIndex);
      if (i === -1) flow.multiSel.push(optIndex);
      else flow.multiSel.splice(i, 1);
      await ctx.answerCallbackQuery({ text: flow.multiSel.includes(optIndex) ? `✓ ${opt.label}` : opt.label });
      await this.updateQuestionMessage(flow);
      return;
    }
    await ctx.answerCallbackQuery({ text: `✓ ${opt.label}` });
    await this.answerSingle(flow, qIndex, optIndex);
  }

  // Tap su "Done": conferma la multi-select.
  private async donePrompt(ctx: Context, parsed: CallbackData): Promise<void> {
    const flow = this.flowsByToken.get(parsed.id);
    if (!flow) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
    const qIndex = parsed.questionIndex ?? 0;
    const q = flow.sets[flow.setIndex][qIndex];
    if (!q?.multiSelect) { await ctx.answerCallbackQuery({ text: 'Invalid' }); return; }
    if (!flow.multiSel.length) { await ctx.answerCallbackQuery({ text: 'Select at least one option' }); return; }
    const labels = flow.multiSel.map(i => q.options[i].label);
    await ctx.answerCallbackQuery({ text: `✓ ${labels.join(', ')}` });
    await this.doneMultiSelect(flow, qIndex);
  }

  // Logica core single-select (usata da callback e reply numerico).
  private async answerSingle(flow: QuestionFlow, qIndex: number, optIndex: number): Promise<void> {
    const q = flow.sets[flow.setIndex][qIndex];
    const opt = q.options[optIndex];
    flow.answers[flow.setIndex][qIndex] = { kind: 'option', labels: [opt.label] };
    await this.acknowledgeAnswer(flow, opt.label);
    await this.recordAndAdvance(flow);
  }

  // Logica core multi-select (usata da callback e reply numerico).
  private async doneMultiSelect(flow: QuestionFlow, qIndex: number): Promise<void> {
    const q = flow.sets[flow.setIndex][qIndex];
    const labels = flow.multiSel.map(i => q.options[i].label);
    flow.answers[flow.setIndex][qIndex] = { kind: 'option', labels };
    flow.multiSel = [];
    await this.acknowledgeAnswer(flow, labels.join(', '));
    await this.recordAndAdvance(flow);
  }

  // Tap su "Other": il prossimo testo dell'utente è la risposta libera.
  private async otherPrompt(ctx: Context, parsed: CallbackData): Promise<void> {
    const flow = this.flowsByToken.get(parsed.id);
    if (!flow) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
    const qIndex = parsed.questionIndex ?? 0;
    flow.awaitingOther = { setIndex: flow.setIndex, qIndex };
    await ctx.answerCallbackQuery({ text: 'Type your answer' });
    await this.showOtherPrompt(flow, qIndex);
  }

  // Tap su "Cancel" durante il testo libero: torna ai bottoni.
  private async cancelPrompt(ctx: Context, parsed: CallbackData): Promise<void> {
    const flow = this.flowsByToken.get(parsed.id);
    if (!flow) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
    flow.awaitingOther = undefined;
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await this.updateQuestionMessage(flow);
  }

  // Testo libero arrivato da onMessage mentre awaitingOther è attivo. Su una
  // multi-select l'utente può aver togglato delle opzioni PRIMA di usare
  // "Other": il CLI le registra insieme al testo (es. "A, custom text"), quindi
  // la risposta combina le opzioni togglate con il testo libero.
  private async answerOther(flow: QuestionFlow, text: string): Promise<void> {
    const { setIndex, qIndex } = flow.awaitingOther!;
    const q = flow.sets[setIndex][qIndex];
    const a: PromptAnswer = (q.multiSelect && flow.multiSel.length)
      ? { kind: 'option', labels: flow.multiSel.map(i => q.options[i].label), extraText: text }
      : { kind: 'other', text };
    flow.answers[setIndex][qIndex] = a;
    flow.awaitingOther = undefined;
    flow.multiSel = []; // consumata: non deve trapelare nella prossima domanda
    await this.acknowledgeAnswer(flow, answerSummary(a));
    await this.recordAndAdvance(flow);
  }

  // Dopo una risposta: per le terminali inietta subito la risposta nel pane;
  // poi avanza (per le headless la consegna avviene a set completo in advance).
  private async recordAndAdvance(flow: QuestionFlow): Promise<void> {
    const session = this.deps.manager.get(flow.sessionId);
    if (session?.kind === 'terminal') {
      const set = flow.sets[flow.setIndex];
      const q = set[flow.qIndex];
      const a = flow.answers[flow.setIndex][flow.qIndex];
      if (a) await this.deliverAnswer(session, q, a, { isLast: flow.qIndex === set.length - 1, setSize: set.length });
    }
    await this.advance(flow);
  }

  // Avanza alla prossima domanda/set; a set completo consegna (headless) e
  // passa al set successivo; a fine coda pulisce il flow.
  private async advance(flow: QuestionFlow): Promise<void> {
    // Le opzioni togglate appartengono alla domanda appena risposta: azzerarle
    // qui (oltre che in doneMultiSelect/answerOther) impedisce che trapelino
    // nella prossima domanda multi-select come pre-selezionate (bug "Coniglio
    // già selezionato").
    flow.multiSel = [];
    const set = flow.sets[flow.setIndex];
    if (flow.qIndex < set.length - 1) {
      flow.qIndex++;
      await this.showQuestion(flow);
      return;
    }
    const session = this.deps.manager.get(flow.sessionId);
    if (session?.kind === 'headless') {
      await this.deliverSet(flow, flow.setIndex);
    }
    flow.setIndex++;
    flow.qIndex = 0;
    if (flow.setIndex < flow.sets.length) {
      await this.showQuestion(flow);
    } else {
      this.deleteFlow(flow);
    }
  }

  // Iniezione tmux della risposta a una domanda (terminali): il menu del CLI è
  // interattivo, quindi si invia la sequenza di tasti di answerToKeys (mai il
  // paste numerico, che il menu corrompe). `recordInjected` registra il
  // riepilogo solo per coerenza col resto dei testi iniettati (il menu non
  // echeggia i tasti nel transcript, quindi l'echo non va soppresso davvero).
  private async deliverAnswer(session: Session, q: PromptQuestion, a: PromptAnswer, ctx: { isLast: boolean; setSize: number }): Promise<void> {
    if (session.kind !== 'terminal' || !session.tmuxTarget) return;
    const seq = answerToKeys(q, a, ctx);
    if (!seq.length) return;
    try {
      await this.deps.tmux.sendKeySeq(session.tmuxTarget, seq);
      this.recordInjected(session.id, answerSummary(a));
    } catch (e) {
      // I4: instradato su log().error — stesso catch, stesso momento.
      log().error('deliverAnswer failed', { sessionId: session.id, err: e });
    }
  }

  // Consegna di un intero set (headless): un unico messaggio con tutte le risposte.
  private async deliverSet(flow: QuestionFlow, setIndex: number): Promise<void> {
    const session = this.deps.manager.get(flow.sessionId);
    if (!session || session.kind !== 'headless') return;
    const text = answersToMessage(flow.sets[setIndex], flow.answers[setIndex]);
    if (this.deps.sdk.isBusy(session.id)) {
      this.notify('⏳ Session busy — the answers were not sent. Reply by text.');
      return;
    }
    this.track(this.deps.sdk.runTurn(session.id, text), 'runTurn');
  }

  // ---------- dialoghi bloccanti (request_user_dialog) ----------

  // Un dialogo arriva dal driver (headless): lo si mostra in chat con i bottoni
  // giusti. Va chiamato solo quando il dialogo deve DAVVERO apparire (sessione
  // attiva, o appena selezionata da onCallback) — arma qui il countdown, non
  // prima, altrimenti un dialogo tenuto in coda scadrebbe senza che l'utente
  // l'abbia mai visto.
  private async showDialog(sessionId: string, dialog: UserDialog): Promise<void> {
    if (!this.chatId) return;
    this.deps.dialogFlow.arm(dialog.id);
    const session = this.deps.manager.get(sessionId);
    const text = dialogMessage(dialog, session);
    const kb = dialogKeyboard(dialog);
    await this.sendChunked(this.chatId, text, { reply_markup: kb });
  }

  // Retry con il modello di fallback (refusal_fallback_prompt). Il result è la
  // stringa enum che il CLI si aspetta: 'retry_fallback' | 'edit_prompt' |
  // 'cancelled'. 'edit_prompt' fa editare il prompt localmente (inutile da
  // Telegram), quindi qui si offre solo Retry/Skip.
  private async dlgRetry(ctx: Context, parsed: CallbackData): Promise<void> {
    const ok = this.deps.dialogFlow.complete(parsed.id, 'retry_fallback');
    await ctx.answerCallbackQuery({ text: ok ? '🔄 Retrying' : 'Already resolved' });
    if (ok) await this.editCallbackDecision(ctx, '🔄 <b>Retrying with fallback model</b>');
  }

  // Skip / cancel (refusal_fallback_prompt o kind sconosciuto).
  private async dlgSkip(ctx: Context, parsed: CallbackData): Promise<void> {
    const ok = this.deps.dialogFlow.cancel(parsed.id);
    await ctx.answerCallbackQuery({ text: ok ? 'Skipped' : 'Already resolved' });
    if (ok) await this.editCallbackDecision(ctx, '⏭️ <b>Skipped</b>');
  }

  // Una richiesta di permesso va mostrata: va chiamato solo quando deve DAVVERO
  // apparire (sessione attiva, o appena selezionata da onCallback) — arma qui il
  // countdown, non prima (vedi showDialog).
  private showPermission(permission: PermissionRequest): void {
    this.deps.permissionFlow.arm(permission.id);
    const kb = permissionKeyboard(permission);
    if (this.chatId) {
      // I2: session.permission non porta ancora un eventId (Fase 2) — si propaga
      // solo il sessionId, quel che c'è.
      this.track(this.sendChunked(this.chatId, permissionMessage(permission), { reply_markup: kb }, { sessionId: permission.sessionId }), 'permission send');
    }
  }

  // ---------- approvazione del piano (ExitPlanMode via canUseTool) ----------

  // "Edit plan" su una richiesta di permesso ExitPlanMode: il prossimo testo
  // dell'utente è il nuovo piano. Il messaggio originale (col piano) resta
  // visibile, con la richiesta in coda.
  private async permEdit(ctx: Context, parsed: CallbackData): Promise<void> {
    const info = this.deps.permissionFlow.infoFor(parsed.id);
    if (!info) { await ctx.answerCallbackQuery({ text: 'Expired request' }); return; }
    this.pendingPlanEdits.set(info.sessionId, parsed.id);
    await ctx.answerCallbackQuery({ text: 'Type the new plan' });
    const msg = ctx.callbackQuery?.message;
    const original = msg && 'text' in msg ? msg.text : '';
    await ctx.editMessageText(`${original}\n\n✏️ <b>Type the new plan text.</b> Send it as a message; the session will continue with your edited plan.`, {
      parse_mode: 'HTML',
    }).catch(this.logCatch('plan edit'));
  }

  // Testo libero arrivato da onMessage mentre un "Edit plan" è in attesa.
  private async answerPlanEdit(sessionId: string, text: string): Promise<void> {
    const id = this.pendingPlanEdits.get(sessionId);
    if (!id) return;
    this.pendingPlanEdits.delete(sessionId);
    const info = this.deps.permissionFlow.infoFor(id);
    if (!info) return;
    const ok = this.deps.permissionFlow.approve(id, { ...info.input, plan: text });
    if (ok) this.notify('✏️ <b>Plan edited</b> — the session continues with your plan.');
  }

  private async onCallback(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    // da disattivo nessuna approvazione/deny/switch (constraint 8): un permesso
    // in sospeso resta pending e scade → deny per timeout.
    if (!this.deps.manager.isArmed()) { await ctx.answerCallbackQuery({ text: '🔒 Remote control is off' }); return; }
    const data = ctx.callbackQuery?.data ?? '';
    try {
      const parsed = parseCallbackData(data);
      switch (parsed.action) {
        case 'approve': {
          // ExitPlanMode: l'approvazione conferma il piano → updatedInput col
          // piano originale (il tool lo scrive sul file del piano).
          const info = this.deps.permissionFlow.infoFor(parsed.id);
          const updatedInput = info?.toolName === 'ExitPlanMode' ? info.input : undefined;
          const ok = this.deps.permissionFlow.approve(parsed.id, updatedInput);
          await ctx.answerCallbackQuery({ text: ok ? '✓ Approved' : 'Already resolved' });
          if (ok) await this.editCallbackDecision(ctx, '✅ <b>Approved</b>');
          break;
        }
        case 'deny': {
          const info = this.deps.permissionFlow.infoFor(parsed.id);
          const message = info?.toolName === 'ExitPlanMode' ? 'Plan rejected from Telegram' : undefined;
          const ok = this.deps.permissionFlow.deny(parsed.id, message);
          await ctx.answerCallbackQuery({ text: ok ? '✗ Rejected' : 'Already resolved' });
          if (ok) await this.editCallbackDecision(ctx, '❌ <b>Rejected</b>');
          break;
        }
        case 'perm-edit': {
          await this.permEdit(ctx, parsed);
          break;
        }
        case 'select': {
          const s = this.deps.manager.get(parsed.id);
          if (s) this.deps.manager.setActive(s.id);
          this.syncTyping(); // la sessione appena selezionata può essere già in running
          await ctx.answerCallbackQuery({ text: 'Session selected' });
          await ctx.editMessageText(sessionListText(this.deps.manager.list(), this.deps.manager.getActive(), this.deps.config.multiplexer), { parse_mode: 'HTML' });
          // Fix 5: mostra la storia recente della sessione appena selezionata.
          // Una sessione fresca non ha transcript suo → niente storia vecchia, solo
          // una nota (prima mostrava la history della sessione precedente).
          const hist = await this.readHistory(parsed.id);
          if (this.chatId) {
            this.track(this.sendChunked(this.chatId, hist ?? 'Fresh session — no history yet.'), 'callback send');
          }
          // Se questa sessione ha una domanda in pending (arrivata mentre era in
          // background, vedi onSessionPrompt) la ri-mostra qui, sempre — anche se
          // era già stata mostrata in una visita precedente a questa sessione.
          const flow = this.questionFlows.get(parsed.id);
          if (flow) {
            flow.awaitingOther = undefined; // torna ai bottoni invece del testo libero lasciato a metà
            this.track(this.showQuestion(flow), 'pending question resend');
          }
          // Permessi/dialoghi arrivati mentre questa sessione era in background
          // (vedi session.permission/session.dialog in subscribeBus): a differenza
          // della domanda sopra, una volta mostrati il countdown è già armato e
          // vivo in chat — non vanno ri-mandati a ogni nuova select, solo svuotati
          // dalla coda una volta.
          const perms = this.pendingPermissions.get(parsed.id);
          if (perms?.length) {
            this.pendingPermissions.delete(parsed.id);
            for (const p of perms) this.showPermission(p);
          }
          const dlgs = this.pendingDialogs.get(parsed.id);
          if (dlgs?.length) {
            this.pendingDialogs.delete(parsed.id);
            for (const d of dlgs) this.track(this.showDialog(parsed.id, d), 'dialog send');
          }
          break;
        }
        case 'answer': {
          await this.answerPrompt(ctx, parsed);
          break;
        }
        case 'done': {
          await this.donePrompt(ctx, parsed);
          break;
        }
        case 'other': {
          await this.otherPrompt(ctx, parsed);
          break;
        }
        case 'cancel': {
          await this.cancelPrompt(ctx, parsed);
          break;
        }
        case 'del': {
          const s = this.deps.manager.get(parsed.id);
          if (!s) { await ctx.answerCallbackQuery({ text: 'Session not found' }); return; }
          await ctx.answerCallbackQuery({ text: 'Confirm?' });
          const kb = new InlineKeyboard()
            .text('✓ Yes, delete', `sess:del-yes:${s.id}`)
            .text('✗ No', `sess:del-no:${s.id}`);
          await ctx.reply(`Delete session <b>${htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}]?`, {
            parse_mode: 'HTML', reply_markup: kb,
          }).catch(this.logCatch('callback send'));
          break;
        }
        case 'del-yes': {
          const ok = this.deleteSession(parsed.id);
          await ctx.answerCallbackQuery({ text: ok ? '🗑 Deleted' : 'Already deleted' });
          await ctx.editMessageText(ok ? '🗑 Session deleted.' : 'Session already gone.', { parse_mode: 'HTML' }).catch(this.logCatch('callback send'));
          break;
        }
        case 'del-no': {
          await ctx.answerCallbackQuery({ text: 'Cancelled' });
          await ctx.editMessageText('Delete cancelled.', { parse_mode: 'HTML' }).catch(this.logCatch('callback send'));
          break;
        }
        case 'dlg-retry': {
          await this.dlgRetry(ctx, parsed);
          break;
        }
        case 'dlg-skip': {
          await this.dlgSkip(ctx, parsed);
          break;
        }
        case 'agent-toggle': {
          const entry = this.agentCards.get(parsed.id);
          if (entry) { entry.card.expanded = !entry.card.expanded; await this.refreshAgentCard(parsed.id); }
          await ctx.answerCallbackQuery();
          return;
        }
      }
    } catch {
      await ctx.answerCallbackQuery({ text: 'Invalid data' });
    }
  }

  private async routeMessageToSession(ctx: Context, text: string): Promise<void> {
    const session = this.deps.manager.getActive() ? this.deps.manager.get(this.deps.manager.getActive()!) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'No session. Create one with /new or /attach.'); return; }
    if (session.kind === 'headless') {
      if (this.deps.sdk.isBusy(session.id)) {
        await this.send(ctx, '⏳ Session busy: wait for it to go idle before forwarding.');
        return;
      }
      this.track(this.deps.sdk.runTurn(session.id, text), 'runTurn');
    } else {
      if (!session.tmuxTarget) {
        await this.send(ctx, `This session is not running in ${this.deps.config.multiplexer}, so text can’t be injected. Start it with:\n<code>${startSessionHint(this.deps.config.multiplexer)}</code>`);
        return;
      }
      try {
        await this.deps.tmux.injectText(session.tmuxTarget, text);
        this.recordInjected(session.id, text);
      } catch (e) {
        // tmux giù o pane sparito: errore amichevole, mai un throw che uccide il daemon.
        await this.send(ctx, `❌ Can't inject into <code>${htmlEscape(session.tmuxTarget)}</code>: ${htmlEscape(e instanceof Error ? e.message : String(e))}. Is ${this.deps.config.multiplexer} running?`);
      }
    }
  }

  // Fix 1: registra i testi iniettati dal bot (per sopprimere l'echo del transcript).
  private recordInjected(sessionId: string, text: string): void {
    const list = this.recentInjected.get(sessionId) ?? [];
    list.push({ text, at: Date.now() });
    if (list.length > 5) list.shift();
    this.recentInjected.set(sessionId, list);
  }

  private isInjectedEcho(sessionId: string, text: string): boolean {
    return matchesInjected(this.recentInjected.get(sessionId) ?? [], text, Date.now());
  }

  private async onMessage(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    if (!ctx.message) return;
    // grammy 1.45: `text` è `text?: string` anche su message:text — la guardia non lo
    // restringe; `?? ''` è sicuro perché il filtro message:text scatta solo su testi.
    const text = ctx.message.text ?? '';
    if (!this.deps.manager.isArmed()) { await this.send(ctx, '🔒 Remote control is off. Send /rc on.'); return; }
    const active = this.deps.manager.getActive();
    const session = active ? this.deps.manager.get(active) : this.deps.manager.list()[0];
    // "Edit plan" in attesa: il testo dell'utente è il nuovo piano.
    if (session && this.pendingPlanEdits.has(session.id)) {
      await this.answerPlanEdit(session.id, text);
      return;
    }
    // Flusso domande: testo libero per "Other" o reply numerico come fallback ai
    // bottoni. Qualsiasi altro testo viene inoltrato alla sessione come sempre.
    const flow = session ? this.questionFlows.get(session.id) : undefined;
    if (flow) {
      if (flow.awaitingOther) {
        await this.answerOther(flow, text);
        return;
      }
      const nums = parseNumericReply(text);
      if (nums) {
        const q = flow.sets[flow.setIndex][flow.qIndex];
        if (nums.every(n => n >= 1 && n <= q.options.length)) {
          if (q.multiSelect) {
            flow.multiSel = nums.map(n => n - 1);
            await this.doneMultiSelect(flow, flow.qIndex);
          } else {
            await this.answerSingle(flow, flow.qIndex, nums[0] - 1);
          }
          return;
        }
      }
    }
    // I comandi del bot sono già gestiti da grammy (bot.command); uno slash
    // command che arriva qui non è nostro. Inoltrarlo alla sessione può
    // impallarla (es. /context è una UI interattiva del CLI che aspetta input
    // e blocca il turno): meglio un errore esplicito che pasticciare il prompt
    // della sessione.
    if (parseCommand(text).kind === 'unknown') {
      await this.send(ctx, 'Unknown command. Send /help to list the available commands.');
      return;
    }
    await this.routeMessageToSession(ctx, text);
  }

  // grammy 1.45: `ctx.getFile()` ritorna i METADATA del file ({ file_id, file_path }),
  // non i byte — i byte vanno scaricati dall'endpoint /file/bot<token>/<file_path>.
  private async downloadTelegramFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.deps.config.telegramBotToken}/${filePath}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async onPhoto(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const session = this.deps.manager.getActive() ? this.deps.manager.get(this.deps.manager.getActive()!) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'No session. Create one with /new or /attach.'); return; }
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File not downloadable.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, `image-${Date.now()}.jpg`);
    let hasVision = false;
    try { hasVision = await this.deps.ollama.hasVision(session.model ?? this.deps.config.defaultModel); } catch { /* assume no vision */ }
    const plan = attachmentPlan(hasVision, 'image');
    if (plan.warning) await this.send(ctx, plan.warning);
    await this.routeMessageToSession(ctx, `[Image attached: ${path}]`);
  }

  private async onView(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const s = this.deps.manager.getActive() ? this.deps.manager.get(this.deps.manager.getActive()!) : undefined;
    if (!s) {
      await this.send(ctx, 'No session selected. Pick one with /sessions.');
      return;
    }
    if (s.kind !== 'terminal') {
      await this.send(ctx, `This is a headless session — it has no terminal screen. Its replies stream here; send a message to chat. To view a terminal, pick a ${this.deps.config.multiplexer} session with /sessions.`);
      return;
    }
    if (!s.tmuxTarget) {
      await this.send(ctx, `This session is not running in ${this.deps.config.multiplexer}, so there is no pane to capture. Start it with:\n<code>${startSessionHint(this.deps.config.multiplexer)}</code>`);
      return;
    }
    try {
      const pane = stripAnsi(await this.deps.tmux.capturePane(s.tmuxTarget)).trimEnd();
      await this.send(ctx, `<pre>${htmlEscape(pane)}</pre>`);
    } catch (e) {
      await this.send(ctx, `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
    }
  }

  private async onDocument(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const doc = ctx.message?.document;
    if (!doc) return;
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File not downloadable.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, doc.file_name ?? `doc-${Date.now()}`);
    await this.send(ctx, `📄 File saved: <code>${htmlEscape(path)}</code>`);
    await this.routeMessageToSession(ctx, `[File attached: ${path}]`);
  }

  // Allinea l'indicatore "sta scrivendo…" allo stato della sessione attiva.
  private syncTyping(): void {
    const active = this.deps.manager.getActive();
    const s = active ? this.deps.manager.get(active) : undefined;
    if (s?.status === 'running') this.typing.start();
    else this.typing.stop();
  }

  private subscribeBus(): void {
    const bus = this.deps.bus;
    // constraint 8: da disattivo nessun relay — ogni handler del bus è gated su armed.
    bus.on('session.updated', ({ sessionId }) => {
      // Esente di proposito dal gate/log di questo branch: non è instradato verso
      // Telegram (l'unico effetto è l'indicatore "sta scrivendo…"), ed è l'evento
      // a frequenza più alta sul bus — gatarlo e loggarlo raddoppierebbe il
      // volume dei log senza aggiungere nulla alla diagnosi. I due `return` qui
      // sotto assomigliano a quelli che questo branch esiste per eliminare, ma
      // non lo sono: non c'è consegna da tracciare.
      if (!this.deps.manager.isArmed()) return;
      if (sessionId !== this.deps.manager.getActive()) return;
      this.syncTyping();
    });
    bus.on('session.text', e => {
      const echo = e.role === 'user' && this.isInjectedEcho(e.sessionId, e.text);
      const gate = this.passes('text', e.sessionId, e.eventId, echo);
      if (!gate.deliver) {
        // Fix 1: l'echo di un testo iniettato dal bot non viene reinoltrato, e
        // solo in quel caso (motivo == 'injected-echo', non un qualunque
        // scarto) la bolla tool va chiusa — per un evento scartato per altro
        // motivo (disarmato, sessione non selezionata) questa sessione
        // potrebbe non essere quella in cui l'iniezione sta effettivamente
        // avvenendo.
        if (gate.reason === 'injected-echo') {
          void this.toolBurst(e.sessionId).collapse();
          this.toolBurst(e.sessionId).close();
        }
        return;
      }
      // Text of a subagent: if its card exists, it stays there. If it does NOT
      // exist (missing tool_use_id, or task_started never arrived) the event
      // flows to the main stream instead of vanishing: losing the ordering is
      // better than losing visibility.
      if (e.parentToolUseId && this.agentCards.has(e.parentToolUseId)) return;
      if (e.role === 'assistant') this.typing.stop(); // il testo è già l'indicatore
      const burst = this.toolBurst(e.sessionId);
      // Any text — the user's or the model's — ends the tool burst: the model's
      // narration is its own message, and the next tool call opens a fresh
      // bubble (see ToolBurstAggregator).
      void burst.collapse();
      burst.close();
      log().info('event delivering', { eventId: e.eventId, sessionId: e.sessionId, kind: 'text', role: e.role });
      // Both headless and terminal transcripts arrive as raw markdown:
      // forwardText accumulates and converts (see forwardText). The gate chain
      // serializes the sends and lets prompts wait for the text that precedes them.
      this.textOrder.record(e.sessionId, () => this.forwardText(e.sessionId, e.text, e.role, e.eventId, e.delta));
    });
    bus.on('session.prompt', async ({ sessionId, questions, eventId, toolUseId, source }) => {
      if (!this.passes('prompt', sessionId, eventId).deliver) return;
      // Task 8, punto 4: la stessa domanda arriva due volte — dall'hook e poi
      // dal transcript (stessa tool_use, due sorgenti). La chiave è SOLO la
      // firma di contenuto (promptDedupeKey): l'hook di 2.1.227 non porta il
      // tool_use_id, quindi la firma è l'unica chiave condivisa fra le due
      // copie. Chi arriva prima la registra come vista e passa, chi arriva
      // dopo la trova già vista e viene scartato. Verso verificato sul CLI
      // reale: in 2.1.227 il transcript scrive la tool_use PRIMA che l'hook
      // scatti (la copia transcript arriva ~9ms prima, non dopo) — la prima
      // occorrenza è quindi quella del transcript, e 'duplicate-prompt' cade
      // sulla copia (redundante) dell'hook. Nessun ramo qui sceglie in base a
      // `source`: è l'ordine di arrivo reale a decidere.
      const dedupeKey = promptDedupeKey(sessionId, questions);
      if (this.isDuplicatePrompt(sessionId, dedupeKey)) {
        log().info('event dropped', { eventId, sessionId, kind: 'prompt', reason: 'duplicate-prompt', toolUseId, source });
        // La copia transcript porta il tool_use_id che la copia hook di 2.1.227
        // non ha (l'hook scatta prima che la tool_use esista). Se la copia hook
        // ha vinto la dedupe, il toolUseId del set è rimasto undefined: lo si
        // registra qui, così il tool_result (scritto quando l'utente risponde al
        // terminale) può essere correlato alla domanda e marcarla come risolta.
        // Il set va trovato per firma di contenuto, non per setIndex: in un flow
        // multi-set il duplicato può riferirsi a un set non corrente.
        if (source === 'transcript' && toolUseId) {
          const flow = this.questionFlows.get(sessionId);
          if (flow) {
            const idx = flow.sets.findIndex((set, i) => flow.toolUseIds[i] === undefined && promptDedupeKey(sessionId, set) === dedupeKey);
            if (idx !== -1) flow.toolUseIds[idx] = toolUseId;
          }
        }
        return;
      }
      // L'evento va SEMPRE registrato (mai scartato, a differenza di
      // session.text/session.tool che restano solo sulla sessione attiva): a
      // differenza dei permessi/dialoghi, AskUserQuestion non ha timeout, quindi
      // può restare in coda senza rischio — ma se viene silenziosamente
      // ignorato per una sessione non selezionata, quella sessione resta
      // bloccata per sempre senza modo di rispondere da Telegram. onSessionPrompt
      // decide se mostrarla subito (sessione attiva) o lasciarla in pending
      // (mostrata quando l'utente ci seleziona sopra, vedi sess:select).
      void this.toolBurst(sessionId).collapse();
      this.toolBurst(sessionId).close();
      // C2: 'event delivering' NON viene più loggato qui — a questo punto non è
      // ancora vero: onSessionPrompt può accodare il set invece di mostrarlo
      // (sessione non selezionata, o un'altra domanda già a schermo). Il log
      // onesto per questo bivio è dentro onSessionPrompt stesso: 'event
      // delivering' (via showQuestion, solo quando la domanda è DAVVERO mostrata)
      // oppure 'event queued' con il motivo.
      // Fix 2: flusso domande multiple — accoda il set e mostra una domanda alla
      // volta (single-select, multi-select con toggle+Done, "Other" a testo libero).
      // The text preceding the question must arrive FIRST in chat. A hook
      // question can beat its text on the bus (already in the transcript but not
      // yet polled): wait for quiet. A transcript/headless question has its text
      // emitted in the same drain: just wait for it to be sent. The quiet
      // threshold is derived from the poll interval so it cannot be shorter than
      // one poll tick (a shorter wait would break immediately and let the
      // question precede the final text chunk).
      if (sessionId === this.deps.manager.getActive()) {
        if (source === 'hook') await this.textOrder.waitForPrecedingText(sessionId, Math.max(300, this.deps.config.pollIntervalMs + 100));
        else await this.textOrder.flush(sessionId);
      }
      this.track(this.onSessionPrompt(sessionId, questions, eventId, source, toolUseId), 'prompt flow');
    });
    bus.on('session.tool', e => {
      // L'utente ha risposto a una domanda AskUserQuestion al terminale: il
      // tool_result della tool_use arriva quando il turno si sblocca. Va
      // gestito PRIMA del gate — il gate scarta i tool per le sessioni non
      // attive, ma la domanda è stata mostrata comunque (i prompt passano
      // sempre) e non deve restare appesa coi bottoni. Il check su
      // `answers[...]` esclude il caso in cui la domanda corrente è già stata
      // risposta via Telegram (il flow è avanzato o sta avanzando).
      if (e.kind === 'tool_result' && e.toolUseId) {
        const flow = this.questionFlows.get(e.sessionId);
        if (flow && flow.toolUseIds[flow.setIndex] === e.toolUseId && !flow.answers[flow.setIndex][flow.qIndex]) {
          this.track(this.markQuestionAnsweredAtTerminal(flow), 'question answered at terminal');
        }
      }
      if (!this.passes('tool', e.sessionId, e.eventId).deliver) return;
      if (e.parentToolUseId) {
        // Activity of a subagent: it does not enter the main stream nor the
        // tool bubble, it goes to its own card.
        if (e.kind === 'tool_use' && e.input) {
          const session = this.deps.manager.get(e.sessionId);
          const line = renderToolLine(describeTool(e.toolName, e.input, session?.projectDir));
          const entry = this.agentCards.get(e.parentToolUseId);
          if (entry) { entry.card.lines.push(line); void this.refreshAgentCard(e.parentToolUseId); }
          else {
            const buf = this.orphanAgentLines.get(e.parentToolUseId) ?? [];
            buf.push(line);
            this.orphanAgentLines.set(e.parentToolUseId, buf);
          }
        }
        return;
      }
      if (e.kind === 'tool_result') {
        if (e.isError && e.toolUseId) {
          const text = typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '');
          void this.toolBurst(e.sessionId).markFailed(e.toolUseId, text);
        }
        return;
      }
      if (e.kind !== 'tool_use' || !e.input) return;
      this.typing.start(); // il modello sta lavorando di nuovo
      const session = this.deps.manager.get(e.sessionId);
      const line = renderToolLine(describeTool(e.toolName, e.input, session?.projectDir));
      void this.toolBurst(e.sessionId).push(line, e.toolUseId);
    });
    bus.on('session.agent', e => {
      if (!this.passes('tool', e.sessionId, e.eventId).deliver) return;
      const key = e.toolUseId ?? e.taskId;
      if (e.phase === 'started') {
        const card: AgentCard = {
          subagentType: e.subagentType, description: e.description,
          lines: this.orphanAgentLines.get(key) ?? [], expanded: false, status: 'running',
        };
        this.orphanAgentLines.delete(key);
        this.agentCards.set(key, { taskId: e.taskId, card });
        void this.refreshAgentCard(key);
        return;
      }
      // task_updated carries no tool_use_id: fall back to the task id stored on
      // the card, or the card would never learn about its completion.
      let cardKey: string | undefined = this.agentCards.has(key) ? key : undefined;
      if (!cardKey) {
        for (const [k, v] of this.agentCards) if (v.taskId === e.taskId) { cardKey = k; break; }
      }
      if (!cardKey) return;
      const entry = this.agentCards.get(cardKey);
      if (!entry) return;
      if (e.phase === 'progress') {
        entry.card.toolUses = e.toolUses ?? entry.card.toolUses;
        entry.card.durationMs = e.durationMs ?? entry.card.durationMs;
        entry.card.lastToolName = e.lastToolName ?? entry.card.lastToolName;
      } else {
        entry.card.status = e.status ?? 'completed';
        entry.card.error = e.error;
      }
      void this.refreshAgentCard(cardKey);
    });
    bus.on('session.permission', ({ permission }) => {
      if (!this.passes('permission', permission.sessionId, undefined).deliver) return;
      void this.toolBurst(permission.sessionId).collapse();
      this.toolBurst(permission.sessionId).close();
      // Stessa logica delle domande (onSessionPrompt): mostrata subito solo se
      // la sessione è quella selezionata, altrimenti in coda — ma qui il
      // countdown NON parte finché non viene davvero mostrata (arm(), dentro
      // showPermission), quindi restare in coda non rischia una scadenza al buio.
      // Una sessione non tracciata (es. race all'avvio: il permesso arriva prima
      // che il TmuxWatcher l'abbia registrata) non compare in /sessions → non
      // sarebbe mai selezionabile per sbloccarla: va mostrata subito.
      const known = this.deps.manager.get(permission.sessionId);
      if (!known || permission.sessionId === this.deps.manager.getActive()) {
        this.showPermission(permission);
      } else {
        const q = this.pendingPermissions.get(permission.sessionId) ?? [];
        q.push(permission);
        this.pendingPermissions.set(permission.sessionId, q);
      }
    });
    bus.on('session.dialog', ({ sessionId, dialog }) => {
      if (!this.passes('dialog', sessionId, undefined).deliver) return;
      void this.toolBurst(sessionId).collapse();
      this.toolBurst(sessionId).close();
      const known = this.deps.manager.get(sessionId);
      if (!known || sessionId === this.deps.manager.getActive()) {
        this.track(this.showDialog(sessionId, dialog), 'dialog send');
      } else {
        const q = this.pendingDialogs.get(sessionId) ?? [];
        q.push(dialog);
        this.pendingDialogs.set(sessionId, q);
      }
    });
    bus.on('session.result', e => {
      if (!this.passes('result', e.sessionId, undefined).deliver) return;
      this.typing.stop(); // fine turno: niente più "sta scrivendo"
      void this.toolBurst(e.sessionId).collapse();
      this.toolBurst(e.sessionId).close(); // fine turno headless: chiude la raffica di tool
      this.closeAgentCards();
      // solo segnale di completamento: il testo della risposta è già arrivato
      // streammato (session.text → mdToHtml). Re-inviarlo qui (come faceva la
      // vecchia notifica `✅ <result>`) duplicava l'ultimo messaggio, e senza
      // rendering markdown (htmlEscape soltanto).
      this.notify('✅ Turn complete.');
    });
    bus.on('session.error', e => {
      if (!this.passes('error', e.sessionId, e.eventId).deliver) return;
      this.typing.stop(); // errore: niente più "sta scrivendo"
      void this.toolBurst(e.sessionId).collapse();
      this.toolBurst(e.sessionId).close();
      this.closeAgentCards();
      const flow = this.questionFlows.get(e.sessionId);
      if (flow) this.deleteFlow(flow); // errore: niente domande pendenti
      this.pendingPlanEdits.delete(e.sessionId);
      this.notify(`❌ <b>${htmlEscape(e.message.slice(0, 500))}</b>`);
    });
  }
}
