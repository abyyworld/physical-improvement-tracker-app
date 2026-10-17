// The installer (install.sh: bash and zsh, as on a Mac) and the helper's own commands.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { plist } from '../helper.mjs';
import { LABEL } from '../src/config.mjs';
import { tempDir } from './fixtures';

const script = fileURLToPath(new URL('../install.sh', import.meta.url));
const helper = fileURLToPath(new URL('../helper.mjs', import.meta.url));
const has = (sh: string) => spawnSync('sh', ['-c', `command -v ${sh}`]).status === 0;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const sandbox = () => {
  const home = tempDir();
  dirs.push(home);
  return { home, env: { ...process.env, HOME: home, ARISE_HELPER_HOME: path.join(home, '.arise-helper') } };
};

describe('install.sh', () => {
  it('is valid bash', () => {
    const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.skipIf(!has('zsh'))('is valid zsh', () => {
    const r = spawnSync('zsh', ['-n', script], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(spawnSync('zsh', [script, 'help'], { encoding: 'utf8' }).stdout).toMatch(/^Usage: bash install.sh/);
  });

  it('shows how to use it', () => {
    const r = spawnSync('bash', [script, 'help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/install \| uninstall \| code \| new-code \| status \| restart/);
    expect(spawnSync('bash', [script, 'nonsense'], { encoding: 'utf8' }).status).toBe(1);
  });

  it("has no variable called path (zsh ties it to PATH)", () => {
    const text = fs.readFileSync(script, 'utf8');
    expect(text).not.toMatch(/(^|[\s;(])(local\s+)?path=/m);
    expect(text).not.toMatch(/\$\{?path\b/);
  });

  it.skipIf(process.platform === 'darwin')('installs only on a Mac', () => {
    const { env } = sandbox();
    const r = spawnSync('bash', [script], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/for Macs/);
  });

  it("says so when it isn't installed", () => {
    const { env } = sandbox();
    for (const cmd of ['code', 'status', 'restart']) {
      const r = spawnSync('bash', [script, cmd], { encoding: 'utf8', env });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/isn't installed/);
    }
  });

  it('uninstall removes the helper, its LaunchAgent and everything it kept', () => {
    const { home, env } = sandbox();
    const dir = path.join(home, '.arise-helper');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), '{}');
    const agent = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    fs.writeFileSync(agent, '<plist/>');
    const r = spawnSync('bash', [script, 'uninstall'], { encoding: 'utf8', env: { ...env, PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } });
    expect(r.status).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(agent)).toBe(false);
    expect(r.stdout).toMatch(/Full Disk Access/);
    expect(fs.existsSync(home)).toBe(true);
  });

  it("won't remove the home folder itself", () => {
    const { home, env } = sandbox();
    const r = spawnSync('bash', [script, 'uninstall'], { encoding: 'utf8', env: { ...env, ARISE_HELPER_HOME: home } });
    expect(r.status).toBe(1);
    expect(fs.existsSync(home)).toBe(true);
  });
});

describe('the helper program', () => {
  it('makes a LaunchAgent that runs it at login and keeps it running', () => {
    const xml = plist('/Users/me/.arise-helper/node/bin/node', '/Users/me/.arise-helper/app/helper.mjs', '/Users/me/.arise-helper');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain(`<string>${LABEL}</string>`);
    expect(xml).toContain('<string>/Users/me/.arise-helper/node/bin/node</string>\n    <string>--disable-warning=ExperimentalWarning</string>\n    <string>/Users/me/.arise-helper/app/helper.mjs</string>\n    <string>serve</string>');
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toContain('<string>/Users/me/.arise-helper/logs/helper.log</string>');
    expect(plist('/a&b/node', '/x<y>/h.mjs', '/d')).toContain('<string>/a&amp;b/node</string>');
    // Every tag that opens, closes.
    for (const tag of ['plist', 'dict', 'array']) expect(xml.split(`<${tag}`).length).toBe(xml.split(`</${tag}>`).length);
  });

  it('shows the same pairing code until a new one is made', () => {
    const { env } = sandbox();
    const run = (cmd: string) => spawnSync(process.execPath, [helper, cmd], { encoding: 'utf8', env });
    const first = run('code').stdout.trim();
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(run('code').stdout.trim()).toBe(first);
    const next = run('new-code').stdout.trim();
    expect(next).not.toBe(first);
    expect(run('code').stdout.trim()).toBe(next);
    expect(fs.statSync(path.join(env.ARISE_HELPER_HOME, 'data', 'code')).mode & 0o777).toBe(0o600);
    expect(run('nonsense').status).toBe(1);
  });
});
