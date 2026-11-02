import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { augmentPath } from '../src/path.js';

describe('augmentPath', () => {
  it('prepends existing user bin dirs (~/.local/bin, ~/bin) to PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'orc-home-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    mkdirSync(join(home, 'bin'), { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home, PATH: '/usr/bin:/bin' };
    augmentPath(env);
    expect(env.PATH).toBe(`${join(home, '.local', 'bin')}:${join(home, 'bin')}:/usr/bin:/bin`);
  });
  it('adds ~/.cargo/bin, where cargo installs zellij', () => {
    const home = mkdtempSync(join(tmpdir(), 'orc-home-'));
    mkdirSync(join(home, '.cargo', 'bin'), { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home, PATH: '/usr/bin:/bin' };
    augmentPath(env);
    expect(env.PATH).toBe(`${join(home, '.cargo', 'bin')}:/usr/bin:/bin`);
  });
  it('does not duplicate dirs already on PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'orc-home-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home, PATH: `${join(home, '.local', 'bin')}:/usr/bin` };
    augmentPath(env);
    expect(env.PATH).toBe(`${join(home, '.local', 'bin')}:/usr/bin`);
  });
  it('leaves PATH untouched when no user bin dir exists', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/nonexistent-home-xyz', PATH: '/usr/bin:/bin' };
    augmentPath(env);
    expect(env.PATH).toBe('/usr/bin:/bin');
  });
  it('leaves PATH untouched when HOME is unset', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    augmentPath(env);
    expect(env.PATH).toBe('/usr/bin:/bin');
  });
});
