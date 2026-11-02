import { join } from 'node:path';
import { existsSync } from 'node:fs';

// Il daemon gira sotto launchd con un PATH minimale
// (/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin) che non
// include le dir utente: ~/.local/bin (uv, pipx) e ~/bin. `ollama-usage` e
// `claude` ci vivono — senza, spawn() fallisce con ENOENT anche se il tool è
// installato. Prependi le dir esistenti al PATH, senza duplicare quelle già
// presenti. Idempotente: chiamabile a ogni avvio. Senza HOME non c'è nulla da
// aggiungere (il daemon sotto launchd ce l'ha sempre).
// ~/.cargo/bin is where `cargo install zellij` puts zellij (MULTIPLEXER=zellij).
export function augmentPath(env: NodeJS.ProcessEnv = process.env): void {
  const home = env.HOME;
  if (!home) return;
  const extra = [join(home, '.local', 'bin'), join(home, 'bin'), join(home, '.cargo', 'bin')].filter(p => existsSync(p));
  if (!extra.length) return;
  const parts = (env.PATH ?? '').split(':').filter(Boolean);
  const missing = extra.filter(p => !parts.includes(p));
  if (!missing.length) return;
  env.PATH = [...missing, ...parts].join(':');
}
