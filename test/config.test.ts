import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies spec defaults', () => {
    const c = loadConfig({});
    expect(c.telegramBotToken).toBe('');
    expect(c.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(c.defaultModel).toBe('deepseek-v4-flash:cloud');
    expect(c.apiPort).toBe(4123);
    expect(c.maxHeadlessSessions).toBe(2);
    expect(c.permissionTimeoutSeconds).toBe(120);
    expect(c.armedOnStart).toBe(false);
    expect(c.defaultPermissionMode).toBe('standard'); // safe-by-default: /new chiede

    expect(c.stateDir).toBe(`${process.env.HOME}/.claude-omni-rc`);
    expect(c.inboxDir).toBe(`${process.env.HOME}/.claude-omni-rc/inbox`);
  });
  it('parses overrides', () => {
    const c = loadConfig({
      TELEGRAM_BOT_TOKEN: 'abc',
      ALLOWED_USER_IDS: '111, 222',
      PAIRING_CODE: 'secret',
      MAX_HEADLESS_SESSIONS: '5',
      PERMISSION_TIMEOUT_SECONDS: '30',
      ARMED_ON_START: 'true',
      WORKSPACE_DIRS: '~/proj1:/tmp/proj2',
    });
    expect(c.allowedUserIds).toEqual([111, 222]);
    expect(c.pairingCode).toBe('secret');
    expect(c.maxHeadlessSessions).toBe(5);
    expect(c.permissionTimeoutSeconds).toBe(30);
    expect(c.armedOnStart).toBe(true);
    expect(c.workspaceDirs).toEqual([`${process.env.HOME}/proj1`, '/tmp/proj2']);
  });
  it('drives tmux unless zellij is asked for explicitly', () => {
    expect(loadConfig({}).multiplexer).toBe('tmux'); // existing installs keep working unchanged
    expect(loadConfig({ MULTIPLEXER: '' }).multiplexer).toBe('tmux'); // blank in .env means default
    expect(loadConfig({ MULTIPLEXER: 'zellij' }).multiplexer).toBe('zellij');
    expect(loadConfig({ MULTIPLEXER: ' Zellij ' }).multiplexer).toBe('zellij');
    expect(loadConfig({ MULTIPLEXER: 'screen' }).multiplexer).toBe('tmux');
  });
  it('accepts an explicit automode default', () => {
    expect(loadConfig({ DEFAULT_PERMISSION_MODE: 'auto' }).defaultPermissionMode).toBe('auto');
  });
  it('ignores a bogus permission mode and stays on standard', () => {
    expect(loadConfig({ DEFAULT_PERMISSION_MODE: 'yolo' }).defaultPermissionMode).toBe('standard');
  });
  it('falls back on malformed numbers', () => {
    expect(loadConfig({ MAX_HEADLESS_SESSIONS: 'nope' }).maxHeadlessSessions).toBe(2);
  });
});

describe('loadConfig — logging', () => {
  it('defaults to info level and a jsonl file under the state dir', () => {
    const c = loadConfig({});
    expect(c.logLevel).toBe('info');
    expect(c.logFile).toBe(`${process.env.HOME}/.claude-omni-rc/logs/daemon.jsonl`);
    expect(c.logMaxBytes).toBe(5_000_000);
    expect(c.logKeep).toBe(3);
  });
  it('follows STATE_DIR', () => {
    expect(loadConfig({ STATE_DIR: '/tmp/orc' }).logFile).toBe('/tmp/orc/logs/daemon.jsonl');
  });
  it('parses overrides', () => {
    const c = loadConfig({ LOG_LEVEL: 'debug', LOG_FILE: '/tmp/x.jsonl', LOG_MAX_BYTES: '1000', LOG_KEEP: '5' });
    expect(c.logLevel).toBe('debug');
    expect(c.logFile).toBe('/tmp/x.jsonl');
    expect(c.logMaxBytes).toBe(1000);
    expect(c.logKeep).toBe(5);
  });
  it('ignores a bogus level and stays on info', () => {
    expect(loadConfig({ LOG_LEVEL: 'chatty' }).logLevel).toBe('info');
  });
});

describe('loadConfig — settings.json layer', () => {
  it('lets settings override env, and env override defaults', () => {
    const c = loadConfig({ DEFAULT_MODEL: 'from-env', DEFAULT_PERMISSION_MODE: 'standard' }, { defaultModel: 'from-settings', maxHeadlessSessions: 7 });
    expect(c.defaultModel).toBe('from-settings');
    expect(c.maxHeadlessSessions).toBe(7);
    expect(c.defaultPermissionMode).toBe('standard'); // non toccato dal settings → .env
  });
  it('ignores invalid settings values and falls back to env/default', () => {
    const c = loadConfig({ DEFAULT_MODEL: 'from-env' }, { defaultPermissionMode: 'yolo', defaultEffort: 'ultra' } as never);
    expect(c.defaultPermissionMode).toBe('standard');
    expect(c.defaultEffort).toBe('medium');
    expect(c.defaultModel).toBe('from-env');
  });
  it('defaults defaultEffort to medium and parses a valid env value', () => {
    expect(loadConfig({}).defaultEffort).toBe('medium');
    expect(loadConfig({ DEFAULT_EFFORT: 'high' }).defaultEffort).toBe('high');
    expect(loadConfig({ DEFAULT_EFFORT: 'max' }).defaultEffort).toBe('medium'); // 'max' non è esposto
  });
  it('applies settings to every curated key', () => {
    const c = loadConfig({}, {
      defaultPermissionMode: 'auto', permissionTimeoutSeconds: 45, armedOnStart: true, noUpdateCheck: true, defaultEffort: 'low',
    });
    expect(c.defaultPermissionMode).toBe('auto');
    expect(c.permissionTimeoutSeconds).toBe(45);
    expect(c.armedOnStart).toBe(true);
    expect(c.noUpdateCheck).toBe(true);
    expect(c.defaultEffort).toBe('low');
  });
  it('exposes the settings file path under the state dir', () => {
    expect(loadConfig({}).settingsFile).toBe(`${process.env.HOME}/.claude-omni-rc/settings.json`);
    expect(loadConfig({ STATE_DIR: '/tmp/orc' }).settingsFile).toBe('/tmp/orc/settings.json');
  });
});
