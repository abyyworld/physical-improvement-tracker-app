// The installer (install.sh: bash and zsh, as on a Mac) and the helper's own commands. The install
// itself runs on a pretend Mac: small stand-ins for macOS's programs (uname, sw_vers, curl, ditto,
// codesign, launchctl, open, gh) in front of PATH, and a pretend helper program.

import { createHash } from 'node:crypto';
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
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const write = (file: string, text: string, mode = 0o755) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};

// A home folder, run as an ordinary user (uid 501, like a Mac's first account) whoever runs the tests.
const sandbox = () => {
  const home = tempDir();
  dirs.push(home);
  const stubs = path.join(home, 'stubs');
  write(path.join(stubs, 'id'), `#!/bin/sh\nif [ "$1" = -u ]; then echo "\${FAKE_UID:-501}"; else exec /usr/bin/id "$@"; fi\n`);
  return { home, stubs, env: { ...process.env, HOME: home, ARISE_HELPER_HOME: path.join(home, '.arise-helper'), PATH: `${stubs}:${process.env.PATH}` } as Record<string, string> };
};

// What the stand-ins were asked to do, one line each.
const calls = (home: string) => {
  try {
    return fs.readFileSync(path.join(home, 'calls.log'), 'utf8');
  } catch {
    return '';
  }
};

const RELEASE = 'https://github.com/abyyworld/physical-improvement-tracker-app/releases/download/mac-helper-latest';

// A pretend Mac, with build 7 of the helper on the release page and an installer that names it.
function fakeMac({ pins = true }: { pins?: boolean } = {}) {
  const box = sandbox();
  const { home, stubs } = box;
  const log = path.join(home, 'calls.log');
  const release = path.join(home, 'release');
  const state = path.join(home, 'state');
  fs.mkdirSync(state);
  const zips = { arm64: 'the arm64 helper, zipped', x64: 'the x64 helper, zipped' };
  for (const [arch, text] of Object.entries(zips)) write(path.join(release, `arise-helper-macos-${arch}-b7.zip`), text, 0o644);
  // The helper program itself: says its version, makes its LaunchAgent, answers status and code.
  const program = path.join(home, 'program', 'arise-helper');
  write(
    program,
    `#!/bin/bash
case "$1" in
  version) echo "Arise helper 1, build b7, Node.js 26.10.0" ;;
  plist) printf '<?xml version="1.0"?>\\n<plist version="1.0"><dict><key>ProgramArguments</key><array><string>%s</string><string>serve</string></array></dict></plist>\\n' "$0" ;;
  status) [ -e "${state}/running" ] || { echo "The helper isn't running."; exit 1; }; echo "The helper is running."; echo "Full Disk Access: \${FAKE_FDA:-not yet}" ;;
  code) cat "$HOME/.arise-helper/data/code" 2>/dev/null || echo "AAAAA-BBBBB-CCCCC-DDDDD" ;;
  *) exit 1 ;;
esac
`,
  );
  const stub = (name: string, body: string) => write(path.join(stubs, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`);
  stub('uname', 'case "$1" in -s) echo Darwin ;; -m) echo "${FAKE_ARCH:-arm64}" ;; *) echo Darwin ;; esac');
  stub('sw_vers', 'echo "${FAKE_MACOS:-15.1}"');
  stub('sleep', 'exit 0');
  stub('plutil', 'exit 0');
  stub('open', 'exit 0');
  stub(
    'curl',
    `out=; url=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
case "$url" in ${RELEASE}/*) ;; *) exit 22 ;; esac
f="${release}/\${url##*/}"
[ -f "$f" ] || exit 22
cp "$f" "$out"`,
  );
  stub('ditto', `[ "$1 $2" = "-x -k" ] || exit 1\nmkdir -p "$4"\ncp "${program}" "$4/arise-helper"`);
  stub(
    'codesign',
    `case "$1" in
  --verify) exit "\${FAKE_SIG:-0}" ;;
  -dv) printf 'Executable=%s\\nIdentifier=%s\\nFormat=Mach-O thin (arm64)\\nCodeDirectory v=20500 size=1 flags=%s hashes=1+0 location=embedded\\nSignature=adhoc\\n' "$2" "\${FAKE_IDENT:-io.github.abyyworld.arise-helper}" "\${FAKE_FLAGS:-0x10002(adhoc,runtime)}" >&2 ;;
esac`,
  );
  stub('launchctl', `case "$1" in bootstrap) touch "${state}/running" ;; bootout) rm -f "${state}/running" ;; esac`);
  stub(
    'gh',
    `case "$1 $2" in
  "auth status") [ -n "\${FAKE_GH:-}" ] ;;
  "attestation verify") case "$3" in --help) exit 0 ;; esac; [ "\${FAKE_GH:-}" = ok ] ;;
  *) exit 1 ;;
esac`,
  );
  // This copy of the installer names build 7 and its checksums (or no build at all).
  const installer = path.join(home, 'repo', 'mac-helper', 'install.sh');
  let text = fs.readFileSync(script, 'utf8');
  const set = (name: string, value: string) => (text = text.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`));
  set('helper_build', pins ? '7' : '');
  set('helper_sha_arm64', pins ? sha256(zips.arm64) : '');
  set('helper_sha_x64', pins ? sha256(zips.x64) : '');
  write(installer, text);
  const env = { ...box.env, PATH: `${stubs}:/usr/bin:/bin`, ARISE_HELPER_NO_OPEN: '' } as Record<string, string>;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const dir = path.join(home, '.arise-helper');
  const run = (extra: Record<string, string> = {}, args: string[] = []) => spawnSync('bash', [installer, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  return { home, dir, installer, program, release, run, bin: path.join(dir, 'bin', 'arise-helper'), agent: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`) };
}

// The helper as it was before: its own Node.js and its scripts, with a pairing code and switches.
function olderHelper(dir: string) {
  write(path.join(dir, 'node', 'bin', 'node'), '#!/bin/sh\n');
  write(path.join(dir, 'app', 'helper.mjs'), '// old', 0o644);
  write(path.join(dir, 'app', 'src', 'service.mjs'), '// old', 0o644);
  write(path.join(dir, 'data', 'code'), 'ABCDE12345FGHJK67890', 0o600);
  write(path.join(dir, 'data', 'config.json'), '{"settings":{"calls":true,"messages":true},"since":{}}', 0o600);
  write(path.join(dir, 'data', 'state.json'), '{"cursors":{"calls":{"after":42}}}', 0o600);
  write(path.join(dir, 'arise-helper.sh'), '# the old installer', 0o700);
}

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

  it('gets one exact build of the helper, checked against checksums written in it, not ones from the same server', () => {
    const text = fs.readFileSync(script, 'utf8');
    expect(text).toMatch(/^helper_build=\d*$/m);
    expect(text).toMatch(/^helper_sha_arm64=([0-9a-f]{64})?$/m);
    expect(text).toMatch(/^helper_sha_x64=([0-9a-f]{64})?$/m);
    // Either a build with both checksums, or none yet.
    const named = (k: string) => !!text.match(new RegExp(`^${k}=(\\S+)$`, 'm'));
    expect(named('helper_sha_arm64')).toBe(named('helper_build'));
    expect(named('helper_sha_x64')).toBe(named('helper_build'));
    expect(text).toContain('https://github.com/$repo/releases/download/mac-helper-latest/$file');
    expect(text).not.toMatch(/curl[^\n]*\.sha256/);
    // No Node.js of its own any more, and no scripts to run with one.
    expect(text).not.toMatch(/nodejs\.org|node_version|helper\.mjs/);
  });

  it('says plainly what Full Disk Access is tied to now, and what other programs can still do', () => {
    const text = fs.readFileSync(script, 'utf8');
    expect(text).not.toMatch(/and nothing else/);
    expect(text).toMatch(/Full Disk Access belongs to this one signed program, which runs only the\s+helper's own code\. If anything changes it, macOS takes the permission away\./);
    expect(text).toMatch(/Other apps you\s+run can still read the pairing code/);
    const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toMatch(/runs only the helper's own code/);
    expect(readme).toMatch(/can still read the pairing code/);
    expect(readme).not.toMatch(/node\/bin\/node`/);
    const panel = fs.readFileSync(new URL('../../src/life/mac-panel.js', import.meta.url), 'utf8');
    expect(panel).toMatch(/runs only its own code/);
    expect(panel).toMatch(/can still read the pairing code/);
    expect(panel).not.toMatch(/Any app you run on this Mac could use it/);
  });

  it('has no variable called path (zsh ties it to PATH)', () => {
    for (const f of [script, fileURLToPath(new URL('./program.sh', import.meta.url))]) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text).not.toMatch(/(^|[\s;(])(local\s+)?path=/m);
      expect(text).not.toMatch(/\$\{?path\b/);
    }
  });

  it.skipIf(process.platform === 'darwin')('installs only on a Mac', () => {
    const { env } = sandbox();
    const r = spawnSync('bash', [script], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/for Macs/);
  });

  it("says so when it isn't installed, or when it's the older helper", () => {
    const { home, env } = sandbox();
    for (const cmd of ['code', 'status', 'restart']) {
      const r = spawnSync('bash', [script, cmd], { encoding: 'utf8', env });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/isn't installed/);
    }
    olderHelper(path.join(home, '.arise-helper'));
    const r = spawnSync('bash', [script, 'code'], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/older Arise helper\. Run the install command again/);
  });

  it('refuses to run as root', () => {
    const { env } = sandbox();
    for (const cmd of ['install', 'uninstall', 'code', 'new-code', 'status', 'restart']) {
      const r = spawnSync('bash', [script, cmd], { encoding: 'utf8', env: { ...env, FAKE_UID: '0' } });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/as yourself, without sudo/);
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
    const r = spawnSync('bash', [script, 'uninstall'], { encoding: 'utf8', env: { ...env, PATH: `${path.join(home, 'bin')}:${env.PATH}` } });
    expect(r.status).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(agent)).toBe(false);
    expect(r.stdout).toMatch(/Full Disk Access: select "arise-helper" \(or "node"/);
    expect(fs.existsSync(home)).toBe(true);
  });

  it("won't remove the home folder itself", () => {
    const { home, env } = sandbox();
    const r = spawnSync('bash', [script, 'uninstall'], { encoding: 'utf8', env: { ...env, ARISE_HELPER_HOME: home } });
    expect(r.status).toBe(1);
    expect(fs.existsSync(home)).toBe(true);
  });
});

describe('install.sh on a Mac', () => {
  it('installs the signed program from the build it names, and starts it with no interpreter', () => {
    const mac = fakeMac();
    const r = mac.run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(calls(mac.home)).toContain(`curl -fsSL ${RELEASE}/arise-helper-macos-arm64-b7.zip -o `);
    expect(fs.readFileSync(mac.bin, 'utf8')).toBe(fs.readFileSync(mac.program, 'utf8'));
    expect(fs.statSync(mac.bin).mode & 0o777).toBe(0o700);
    expect(fs.statSync(mac.dir).mode & 0o777).toBe(0o700);
    // Its LaunchAgent runs the program itself.
    const agent = fs.readFileSync(mac.agent, 'utf8');
    expect(agent).toContain(`<array><string>${mac.bin}</string><string>serve</string></array>`);
    expect(agent).not.toMatch(/node|\.mjs/);
    expect(calls(mac.home)).toMatch(/launchctl bootout gui\/501\/io\.github\.abyyworld\.arise-helper\n(.*\n)*launchctl bootstrap gui\/501 /);
    // A copy of the installer for the commands later.
    expect(fs.readFileSync(path.join(mac.dir, 'arise-helper.sh'), 'utf8')).toBe(fs.readFileSync(mac.installer, 'utf8'));
    // Full Disk Access: where to find it, and the page opened.
    expect(r.stdout).toContain(`       ${mac.bin}\n`);
    expect(r.stdout).not.toMatch(/minus button/);
    expect(calls(mac.home)).toContain('open x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    expect(calls(mac.home)).toContain(`open -R ${mac.bin}`);
    expect(r.stdout).toMatch(/Pairing code: {3}AAAAA-BBBBB-CCCCC-DDDDD/);
    expect(r.stdout).toMatch(/Other apps you\s+run can still read the pairing code/);
  });

  it('gets the Intel build on an Intel Mac', () => {
    const mac = fakeMac();
    const r = mac.run({ FAKE_ARCH: 'x86_64' });
    expect(r.status).toBe(0);
    expect(calls(mac.home)).toContain(`${RELEASE}/arise-helper-macos-x64-b7.zip`);
    expect(mac.run({ FAKE_ARCH: 'ppc' }).stderr).toMatch(/isn't one the helper is made for/);
  });

  it('moves the older helper to the signed one, keeping its pairing code and switches', () => {
    const mac = fakeMac();
    olderHelper(mac.dir);
    const before = ['code', 'config.json', 'state.json'].map((f) => fs.readFileSync(path.join(mac.dir, 'data', f), 'utf8'));
    const r = mac.run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(mac.dir, 'node'))).toBe(false);
    expect(fs.existsSync(path.join(mac.dir, 'app'))).toBe(false);
    expect(['code', 'config.json', 'state.json'].map((f) => fs.readFileSync(path.join(mac.dir, 'data', f), 'utf8'))).toEqual(before);
    expect(fs.existsSync(mac.bin)).toBe(true);
    expect(fs.readFileSync(path.join(mac.dir, 'arise-helper.sh'), 'utf8')).not.toBe('# the old installer');
    // The old one stopped before the new one started.
    expect(calls(mac.home).indexOf('launchctl bootout')).toBeLessThan(calls(mac.home).indexOf('launchctl bootstrap'));
    // Full Disk Access moves from the old Node.js to the program, at the exact path.
    expect(r.stdout).toMatch(/Replaced the older helper/);
    expect(r.stdout).toMatch(/Select "node" \(the older helper's\) and click the minus button/);
    expect(r.stdout).toContain(`       ${mac.bin}\n`);
    expect(calls(mac.home)).toContain('open x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    expect(r.stdout).toMatch(/Pairing code: {3}ABCDE12345FGHJK67890/);
  });

  it('after an update, asks for Full Disk Access again for the new build, unless it still has it', () => {
    const mac = fakeMac();
    expect(mac.run().status).toBe(0);
    const again = mac.run();
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/If "arise-helper" is in the list, select it and click the minus button: macOS ties the permission to one exact build/);
    const fine = mac.run({ FAKE_FDA: 'yes' });
    expect(fine.stdout).toMatch(/It has Full Disk Access already/);
    expect(fine.stdout).not.toMatch(/Command-Shift-G/);
  });

  it("changes nothing when the download doesn't match its checksum, or isn't signed as the helper", () => {
    for (const [extra, why] of [
      [{}, /didn't match its checksum/],
      [{ FAKE_SIG: '1' }, /signature didn't check out/],
      [{ FAKE_IDENT: 'com.example.other' }, /isn't the Arise helper/],
      [{ FAKE_FLAGS: '0x2(adhoc)' }, /isn't signed with the hardened runtime/],
    ] as const) {
      const mac = fakeMac();
      olderHelper(mac.dir);
      if (!Object.keys(extra).length) fs.writeFileSync(path.join(mac.release, 'arise-helper-macos-arm64-b7.zip'), 'something else');
      const r = mac.run(extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(why);
      expect(fs.existsSync(mac.bin)).toBe(false);
      expect(fs.existsSync(path.join(mac.dir, 'node', 'bin', 'node'))).toBe(true);
      expect(fs.existsSync(path.join(mac.dir, 'app', 'helper.mjs'))).toBe(true);
      expect(calls(mac.home)).not.toMatch(/launchctl/);
    }
  });

  it("checks GitHub's record of where it was built when gh is logged in", () => {
    const ok = fakeMac();
    const r = ok.run({ FAKE_GH: 'ok' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/GitHub's record says Arise's own workflow built it/);
    expect(calls(ok.home)).toMatch(/gh attestation verify \S+arise-helper-macos-arm64-b7\.zip --repo abyyworld\/physical-improvement-tracker-app --signer-workflow abyyworld\/physical-improvement-tracker-app\/\.github\/workflows\/mac-helper\.yml --source-ref refs\/heads\/main/);
    const bad = fakeMac();
    const no = bad.run({ FAKE_GH: 'bad' });
    expect(no.status).toBe(1);
    expect(no.stderr).toMatch(/GitHub's record of where the helper was built didn't check out/);
    expect(fs.existsSync(bad.bin)).toBe(false);
    // Not logged in: the checksum alone.
    const plain = fakeMac();
    expect(plain.run().stdout).not.toMatch(/GitHub's record/);
  });

  it('needs a build named, macOS 13.5 or newer, and its own folder', () => {
    const none = fakeMac({ pins: false });
    const r = none.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/doesn't name a build of the helper yet/);
    expect(calls(none.home)).not.toMatch(/curl/);
    const mac = fakeMac();
    expect(mac.run({ FAKE_MACOS: '13.4' }).stderr).toMatch(/needs macOS 13\.5 or newer\. This Mac has 13\.4/);
    expect(mac.run({ FAKE_MACOS: '12' }).stderr).toMatch(/needs macOS 13\.5/);
    expect(mac.run({ ARISE_HELPER_HOME: path.join(mac.home, 'elsewhere') }).stderr).toMatch(/always lives in ~\/\.arise-helper/);
    expect(calls(mac.home)).not.toMatch(/curl/);
    expect(mac.run({ FAKE_MACOS: '13.5' }).status).toBe(0);
  });

  it.skipIf(!has('zsh'))('installs in zsh too', () => {
    const mac = fakeMac();
    olderHelper(mac.dir);
    const r = spawnSync('zsh', [mac.installer], { encoding: 'utf8', env: { ...process.env, HOME: mac.home, PATH: `${path.join(mac.home, 'stubs')}:/usr/bin:/bin` } });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(fs.existsSync(mac.bin)).toBe(true);
    expect(fs.existsSync(path.join(mac.dir, 'node'))).toBe(false);
  });
});

describe('the helper program', () => {
  it('makes a LaunchAgent that runs the program itself at login and keeps it running', () => {
    const xml = plist('/Users/me/.arise-helper/bin/arise-helper', '/Users/me/.arise-helper');
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain(`<string>${LABEL}</string>`);
    expect(xml).toContain('<key>ProgramArguments</key>\n  <array>\n    <string>/Users/me/.arise-helper/bin/arise-helper</string>\n    <string>serve</string>\n  </array>');
    // No interpreter, no script, no environment of its own.
    expect(xml).not.toMatch(/node|\.mjs|EnvironmentVariables|ARISE_/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toContain('<string>/Users/me/.arise-helper/logs/helper.log</string>');
    expect(plist('/a&b/arise-helper', '/d')).toContain('<string>/a&amp;b/arise-helper</string>');
    // Every tag that opens, closes.
    for (const tag of ['plist', 'dict', 'array']) expect(xml.split(`<${tag}`).length).toBe(xml.split(`</${tag}>`).length);
  });

  it('shows the same pairing code until a new one is made', () => {
    const { env } = sandbox();
    const run = (...args: string[]) => spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', env });
    const first = run('code').stdout.trim();
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(run('code').stdout.trim()).toBe(first);
    // Whatever comes after the command is ignored.
    expect(run('code', '--require', './nothing.js', '-e', 'x').stdout.trim()).toBe(first);
    const next = run('new-code').stdout.trim();
    expect(next).not.toBe(first);
    expect(run('code').stdout.trim()).toBe(next);
    expect(fs.statSync(path.join(env.ARISE_HELPER_HOME, 'data', 'code')).mode & 0o777).toBe(0o600);
    expect(run('nonsense').status).toBe(1);
    expect(run('version').stdout).toMatch(/^Arise helper 1, build dev, Node\.js \d+/);
  });

  it("won't make a LaunchAgent for Node.js: an installer from before is told to install again", () => {
    const { env } = sandbox();
    const r = spawnSync(process.execPath, [helper, 'plist'], { encoding: 'utf8', env });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/now one signed program\. To update it, run the install command again/);
  });
});
