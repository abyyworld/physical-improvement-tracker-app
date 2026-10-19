// @vitest-environment jsdom
// scripts/local-ai-mac.sh, the one command that sets up "Your computer's AI" on a Mac, run with
// stand-ins for the Mac's own commands (launchctl, Ollama, curl and so on): it lets Arise in
// without dropping addresses already there, keeps it so at every login, starts Ollama again, and
// downloads a model that fits the Mac's memory.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SETUP_SCRIPT, SITE_ORIGIN } from './local-ai';

const SCRIPT = join(__dirname, '../../scripts/local-ai-mac.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const stub = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};

interface Mac {
  gb?: number;
  installed?: boolean; // the ollama command is there
  app?: boolean; // the Ollama app, and it's running
  origins?: string; // OLLAMA_ORIGINS already set
  models?: string[]; // already downloaded
  code?: number; // what Ollama answers Arise's address with, once started
  os?: string;
  extra?: string[]; // arguments
}

function run(mac: Mac = {}) {
  const root = mkdtempSync(join(tmpdir(), 'arise-local-ai-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const app = join(root, 'Ollama.app');
  mkdirSync(bin);
  mkdirSync(home);
  const log = join(root, 'log');
  writeFileSync(log, '');
  const note = `echo "$(basename "$0") $*" >>"${log}"`;
  const ollama = `${note}
if [ "$1" = list ]; then echo "NAME ID SIZE MODIFIED"; for m in ${(mac.models || []).join(' ')}; do echo "$m abc 9GB now"; done; fi`;
  if (mac.app) {
    mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
    stub(join(app, 'Contents/Resources'), 'ollama', ollama);
  }
  if (mac.installed) stub(bin, 'ollama', ollama);
  stub(bin, 'uname', `echo ${mac.os || 'Darwin'}`);
  stub(bin, 'sysctl', `echo $((${mac.gb ?? 16} * 1073741824))`);
  stub(bin, 'sleep', ':');
  stub(bin, 'launchctl', `${note}\nif [ "$1" = getenv ]; then ${mac.origins ? `echo '${mac.origins}'` : ':'}; fi`);
  stub(bin, 'plutil', note);
  // The app runs until it's told to stop.
  stub(bin, 'pgrep', `[ "${mac.app ? 'yes' : ''}" = yes ] && [ ! -e "${root}/stopped" ]`);
  stub(bin, 'pkill', `${note}\ntouch "${root}/stopped"`);
  stub(bin, 'open', note);
  // ollama.com's installer puts the ollama command in place.
  stub(
    bin,
    'curl',
    `${note}
case "$*" in
  *ollama.com/install.sh*) printf '%s\\n' 'cat >"${bin}/ollama" <<"X"' '#!/bin/bash' '${note.replace(/'/g, "'\\''")}' 'X' 'chmod +x "${bin}/ollama"' 'echo "installer OLLAMA_NO_START=$OLLAMA_NO_START" >>"${log}"' ;;
  *http_code*) echo ${mac.code ?? 200} ;;
esac`,
  );
  const r = spawnSync('bash', [SCRIPT, ...(mac.extra || [])], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ARISE_OLLAMA_APP: app },
    encoding: 'utf8',
  });
  const agent = join(home, 'Library/LaunchAgents/io.github.abyyworld.arise-ollama.plist');
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    plist: existsSync(agent) ? readFileSync(agent, 'utf8') : '',
  };
}

// The LaunchAgent, read as macOS would: its arguments, in order.
function agentArgs(plist: string) {
  const doc = new DOMParser().parseFromString(plist, 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  const keys = [...doc.querySelectorAll('dict > key')].map((k) => k.textContent);
  expect(keys).toEqual(['Label', 'ProgramArguments', 'RunAtLoad']);
  return [...doc.querySelectorAll('array > string')].map((s) => s.textContent || '');
}

describe('the Mac setup command', () => {
  it("is the script Settings shows, and lets in the address Arise's website really has", () => {
    expect(SETUP_SCRIPT.endsWith('/main/scripts/local-ai-mac.sh')).toBe(true);
    expect(readFileSync(SCRIPT, 'utf8')).toContain(`site=${SITE_ORIGIN}\n`);
    expect(readFileSync(SCRIPT, 'utf8')).toContain(SETUP_SCRIPT);
  });

  it('on a new Mac: installs Ollama, lets Arise in now and at every login, and downloads a model that fits', () => {
    const r = run({ gb: 32 });
    expect(r.status, r.out).toBe(0);
    expect(r.log).toContain('installer OLLAMA_NO_START=1'); // it's started once Arise may talk to it
    expect(r.log).toContain('launchctl setenv OLLAMA_ORIGINS https://abyyworld.github.io,capacitor://localhost*');
    // Ollama refuses an address of a kind it doesn't know unless it ends in *: the iPhone app's does.
    const args = agentArgs(r.plist);
    expect(args.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(args.slice(3)).toEqual(['arise-ollama', 'https://abyyworld.github.io,capacitor://localhost*', 'https://abyyworld.github.io']);
    expect(args[2]).toContain('launchctl setenv OLLAMA_ORIGINS "$1"');
    expect(args[2]).toContain('-H "Origin: $2"');
    // It checks Ollama really lets Arise in, then downloads the model for 32 GB.
    expect(r.log.some((l) => l.startsWith('curl') && l.includes('Origin: https://abyyworld.github.io') && l.includes('/api/tags'))).toBe(true);
    expect(r.log).toContain('ollama pull qwen2.5:14b');
    expect(r.out).toContain('All set.');
  });

  it("keeps addresses already there, adds another copy of Arise's, starts the app again, and skips a model it has", () => {
    const r = run({ gb: 8, installed: true, app: true, origins: 'https://other.example,capacitor://localhost*', models: ['qwen2.5:7b'], extra: ['https://arise.example.com'] });
    expect(r.status, r.out).toBe(0);
    expect(r.log.filter((l) => l.startsWith('curl') && l.includes('install.sh'))).toEqual([]);
    expect(r.log).toContain('launchctl setenv OLLAMA_ORIGINS https://other.example,capacitor://localhost*,https://abyyworld.github.io,https://arise.example.com');
    expect(r.log).toContain('pkill -x Ollama');
    expect(r.log).toContain('open -a Ollama --args hidden');
    expect(r.log.filter((l) => l.includes(' pull '))).toEqual([]);
    expect(r.out).toContain("It's already here.");
  });

  it('picks the model by the Mac\'s memory, or the one asked for', () => {
    const pulled = (gb: number) => run({ gb, installed: true }).log.find((l) => l.startsWith('ollama pull'));
    expect(pulled(8)).toBe('ollama pull qwen2.5:7b');
    expect(pulled(16)).toBe('ollama pull qwen2.5:7b');
    expect(pulled(24)).toBe('ollama pull qwen2.5:14b');
    expect(pulled(64)).toBe('ollama pull qwen2.5:32b');
    expect(pulled(128)).toBe('ollama pull qwen2.5:72b');
  });

  it('says plainly when Ollama still refuses Arise, or this is not a Mac, or the address is wrong', () => {
    const refused = run({ installed: true, code: 403 });
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("Ollama is running, but doesn't let Arise in yet.");
    expect(refused.log.filter((l) => l.includes(' pull '))).toEqual([]);

    const linux = run({ os: 'Linux' });
    expect(linux.status).not.toBe(0);
    expect(linux.out).toContain('This is for a Mac.');
    expect(linux.log).toEqual([]);

    const odd = run({ installed: true, extra: ['https://x.example; rm -rf ~'] });
    expect(odd.status).not.toBe(0);
    expect(odd.out).toContain("That isn't a website's address");
    expect(odd.log).toEqual([]);
  });
});
