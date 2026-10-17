// The signed program: what it takes from outside (nothing but its first word), its one script, the
// Node.js options and the entitlement built into it, and the workflow that builds and signs it.
// The program itself is built and tried out on real Macs by .github/workflows/mac-helper.yml
// (test/program.sh); here its script runs with Node.js.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SAFE_PATH, safeEnv, scrubEnv } from '../src/env.mjs';
import { COMMANDS, run } from '../src/main.mjs';
import { runCommand } from '../src/service.mjs';
import { SCRIPT, buildHelper, unsafeParts } from '../../scripts/build-mac-helper.mjs';
import { tempDir } from './fixtures';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');
const me = { homedir: '/Users/me', username: 'me' };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// What an attacker running as the same user could put in its environment.
const HOSTILE = {
  NODE_OPTIONS: '--require /tmp/evil.js',
  NODE_COMPILE_CACHE: '/tmp/cache',
  NODE_ICU_DATA: '/tmp/icu',
  NODE_PATH: '/tmp/modules',
  NODE_DEBUG: 'http',
  OPENSSL_CONF: '/tmp/evil.cnf',
  DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
  ARISE_HELPER_HOME: '/tmp/elsewhere',
  ARISE_ORIGINS: 'https://evil.example',
  HOME: '/tmp/fake-home',
  PATH: '/tmp/bin:/usr/bin',
  __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
};

describe('its environment', () => {
  it('keeps only who the user is, a safe PATH and the text encoding', () => {
    expect(safeEnv(HOSTILE, me)).toEqual({ HOME: '/Users/me', USER: 'me', LOGNAME: 'me', PATH: SAFE_PATH, __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' });
    expect(SAFE_PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    // Home comes from the user database, never from HOME.
    expect(safeEnv({ HOME: '/tmp/fake-home' }).HOME).toBe(os.userInfo().homedir);
    expect(safeEnv({ __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0; rm -rf ~' }, me)).not.toHaveProperty('__CF_USER_TEXT_ENCODING');
  });

  it('is thrown away as it starts', () => {
    const env: Record<string, string | undefined> = { ...HOSTILE, SOMETHING: 'else' };
    expect(scrubEnv(env, me)).toBe(env);
    expect(env).toEqual(safeEnv(HOSTILE, me));
  });

  it("the programs it runs don't get what it was started with", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, HOSTILE);
      const out = await runCommand('/usr/bin/env', []);
      const seen = Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      expect(seen).toEqual(safeEnv(process.env));
      expect(out).not.toMatch(/NODE_|DYLD_|OPENSSL|ARISE_|evil/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('its commands', () => {
  const ctx = () => {
    const base = tempDir();
    dirs.push(base);
    const lines: string[] = [];
    const errs: string[] = [];
    return { lines, errs, ctx: { base, userHome: base, origins: ['https://abyyworld.github.io'], program: '/Users/me/.arise-helper/bin/arise-helper', signed: true, out: (s: string) => lines.push(s), err: (s: string) => errs.push(s) } };
  };

  it('takes only its first word, and ignores everything after it', async () => {
    const { lines, ctx: c } = ctx();
    expect(await run(['code', '--require', '/tmp/evil.js', '-e', 'process.exit(9)', '--inspect'], c)).toBe(0);
    expect(lines[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(await run(['version', '--node-options=--require /tmp/evil.js'], c)).toBe(0);
    expect(lines[1]).toMatch(/^Arise helper 1, build dev, Node\.js /);
  });

  it("doesn't take an option or a file as a command", async () => {
    for (const first of ['--require', '-e', '--eval', '--inspect', '--node-options=--require x', '/tmp/evil.js', 'eval', 'SERVE', '']) {
      const { lines, ctx: c } = ctx();
      expect(await run([first, 'serve'], c)).toBe(1);
      expect(lines).toEqual([`Usage: arise-helper ${COMMANDS.join(' | ')}`]);
    }
    const { ctx: c } = ctx();
    expect(await run([], c)).toBe(0);
  });

  it('makes its LaunchAgent only as the signed program', async () => {
    const signed = ctx();
    expect(await run(['plist'], signed.ctx)).toBe(0);
    expect(signed.lines[0]).toContain('<string>/Users/me/.arise-helper/bin/arise-helper</string>\n    <string>serve</string>');
    const plain = ctx();
    expect(await run(['plist'], { ...plain.ctx, signed: false })).toBe(1);
    expect(plain.lines).toEqual([]);
    expect(plain.errs[0]).toMatch(/run the install command again/);
  });
});

describe('the signed entry point', () => {
  const entry = read('mac-helper/sea.mjs');

  it('takes where it keeps things from the user database, and allows only Arise', () => {
    expect(entry).toMatch(/const user = os\.userInfo\(\);\s*scrubEnv\(process\.env, user\);/);
    expect(entry).toContain("path.join(user.homedir, '.arise-helper')");
    expect(entry).toContain('origins: [ORIGIN]');
    expect(entry).toContain('signed: true');
    expect(entry).not.toMatch(/process\.env\.|os\.homedir|origins\(\)|home\(\)/);
  });
});

describe('its one script', () => {
  it('finds what the script must never do', () => {
    const bad = [
      'eval("1")',
      'new Function("return 1")',
      'require("./x.js")',
      'require(name)',
      'import("./x.mjs")',
      'import(name)',
      'const { createRequire } = require("node:module")',
      'require("node:vm")',
      'process.dlopen(m, f)',
      'node_child_process.spawn("sh")',
      'require("node:child_process").execSync("x")',
      'new Worker("x")',
      'WebAssembly.instantiate(b)',
      'require("node:inspector")',
      'v8.setFlagsFromString("--allow-natives-syntax")',
    ];
    for (const code of bad) expect(unsafeParts(code), code).not.toEqual([]);
    const fine = 'const fs = require("node:fs"); const s = require("node:sqlite"); (0, node_child_process.execFile)("/usr/bin/lsappinfo", ["front"]); /x/.exec(s); /** @param {import("node:sqlite").DatabaseSync} db */';
    expect(unsafeParts(fine)).toEqual([]);
  });

  it('is the helper in one file that loads only Node.js modules, and runs with Node.js', async () => {
    const out = tempDir();
    dirs.push(out);
    const { script } = await buildHelper({ out, buildName: 'b-test' });
    expect(path.basename(script)).toBe(SCRIPT);
    expect(fs.readdirSync(out).sort()).toEqual(['arise-helper.cjs', 'sea-config.json']);
    const code = fs.readFileSync(script, 'utf8');
    expect(unsafeParts(code)).toEqual([]);
    expect(code).not.toMatch(/__ARISE_HELPER_BUILD__|osascript|ARISE_HELPER_HOME/);
    expect(fs.readFileSync(path.join(out, 'sea-config.json'), 'utf8')).toBe(read('mac-helper/sea-config.json'));

    // As the program runs it (with plain Node.js here: nothing it's given becomes code).
    const mark = path.join(out, 'ran');
    fs.writeFileSync(path.join(out, 'evil.js'), `require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'x');`);
    const go = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { encoding: 'utf8', cwd: out, env: { ...process.env, ...HOSTILE, NODE_OPTIONS: '' } });
    const v = go('version', '--require', './evil.js', '-e', 'x');
    expect(v.stdout).toMatch(/^Arise helper 1, build b-test, Node\.js \d+/);
    expect(v.status).toBe(0);
    expect(go('--require', './evil.js').status).toBe(1);
    expect(go('./evil.js').status).toBe(1);
    expect(fs.existsSync(mark)).toBe(false);
    // Where it keeps things comes from the user database, whatever HOME and ARISE_HELPER_HOME say.
    const agent = go('plist');
    expect(agent.status).toBe(0);
    expect(agent.stdout).toContain(`<string>${path.join(os.userInfo().homedir, '.arise-helper', 'logs', 'helper.log')}</string>`);
    expect(agent.stdout).not.toMatch(/fake-home|elsewhere/);
  }, 60000);
});

describe('what is built into the program', () => {
  it('lets nothing outside add Node.js options, and turns off every way in', () => {
    const cfg = JSON.parse(read('mac-helper/sea-config.json'));
    expect(cfg).toEqual({
      main: 'arise-helper.cjs',
      output: 'arise-helper',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
      execArgv: ['--disable-sigusr1', '--disallow-code-generation-from-strings', '--no-addons', '--openssl-config=/dev/null', '--icu-data-dir=/dev/null', '--disable-warning=ExperimentalWarning'],
      execArgvExtension: 'none',
    });
  });

  it('asks macOS only for the JIT, nothing that lets other programs in', () => {
    const xml = read('mac-helper/entitlements.plist').replace(/<!--[\s\S]*?-->/g, '');
    expect([...xml.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1])).toEqual(['com.apple.security.cs.allow-jit']);
    expect(xml).not.toMatch(/get-task-allow|allow-dyld-environment-variables|disable-library-validation|allow-unsigned-executable-memory/);
  });
});

describe('the workflow that builds it', () => {
  const wf = read('.github/workflows/mac-helper.yml');
  // Each job's lines.
  const job = (name: string) => {
    const at = wf.indexOf(`\n  ${name}:\n`);
    expect(at, name).toBeGreaterThan(0);
    const next = wf.slice(at + 1).search(/\n {2}[\w-]+:\n/);
    return next < 0 ? wf.slice(at) : wf.slice(at, at + 1 + next);
  };

  it('pins every action by its full commit', () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(5);
    for (const u of uses) expect(u).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  });

  it('builds with one exact Node.js, checked against its SHA-256, with Node.js own builder', () => {
    expect(wf).toMatch(/^ {2}NODE_VERSION: \d+\.\d+\.\d+$/m);
    expect(wf).toMatch(/^ {2}NODE_SHA_ARM64: [0-9a-f]{64}$/m);
    expect(wf).toMatch(/^ {2}NODE_SHA_X64: [0-9a-f]{64}$/m);
    const program = job('program');
    expect(program).toContain('https://nodejs.org/dist/v$NODE_VERSION/$FILE');
    expect(program).toContain('"$NODE" "${FLAGS[@]}" --build-sea sea-config.json');
    // The settings from the repo, not from the job that ran npm.
    expect(program).toContain('cp ../mac-helper/sea-config.json sea-config.json');
    expect(program).toMatch(/codesign --force --sign - --options runtime \\\n\s+--entitlements mac-helper\/entitlements\.plist \\\n\s+--identifier io\.github\.abyyworld\.arise-helper/);
    expect(program).toContain('bash mac-helper/test/program.sh build/arise-helper');
    expect(program).toMatch(/runner: macos-15\n/);
    expect(program).toMatch(/runner: macos-15-intel\n/);
  });

  it('runs npm only where nothing is signed or published, and writes only from main', () => {
    expect(job('script')).toMatch(/npm ci/);
    const steps = (j: string) => job(j).replace(/^\s*#.*$/gm, '');
    for (const j of ['program', 'publish', 'pin']) expect(steps(j), j).not.toMatch(/\bnpm\b|\bnpx\b|setup-node/);
    expect(wf).toMatch(/^permissions:\n {2}contents: read\n/m);
    const publish = job('publish');
    expect(publish).toContain("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'");
    expect(publish).toMatch(/permissions:\n {6}contents: write\n {6}id-token: write\n {6}attestations: write/);
    expect(publish).toContain('actions/attest-build-provenance@');
    expect(publish).toContain('gh release upload mac-helper-latest');
    for (const j of ['script', 'program', 'pin']) expect(job(j), j).not.toMatch(/contents: write|id-token/);
  });

  it('checks the build the installer names', () => {
    const pin = job('pin');
    expect(pin).toContain('mac-helper/install.sh');
    expect(pin).toContain('gh attestation verify "$FILE" --repo "$REPO"');
    expect(pin).toContain('--signer-workflow "$REPO/.github/workflows/mac-helper.yml"');
    expect(pin).toContain('--source-ref refs/heads/main');
    // The names the installer downloads are the ones published.
    expect(read('mac-helper/install.sh')).toContain('file="arise-helper-macos-$arch-b$helper_build.zip"');
    expect(job('publish')).toContain('mv "arise-helper-macos-$ARCH.zip" "arise-helper-macos-$ARCH-$B.zip"');
  });

  it('tries the program out with a script that works in bash and zsh', () => {
    const sh = fileURLToPath(new URL('./program.sh', import.meta.url));
    expect(spawnSync('bash', ['-n', sh], { encoding: 'utf8' }).status).toBe(0);
    if (spawnSync('sh', ['-c', 'command -v zsh']).status === 0) expect(spawnSync('zsh', ['-n', sh], { encoding: 'utf8' }).status).toBe(0);
  });
});
