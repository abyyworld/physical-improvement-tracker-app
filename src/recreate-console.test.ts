// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloud, resetCloud } from './test/fake-firebase';

vi.mock('./lib/firebase', () => import('./test/fake-firebase'));
vi.mock('./lib/crypto', async (orig) => {
  const real = await orig<typeof import('./lib/crypto')>();
  return { ...real, deriveMaster: (p: string, id: string) => real.deriveMaster(p, id, 1000) };
});

type Store = typeof import('./store');
type Sync = typeof import('./sync');
interface Device {
  S: Store;
  SYNC: Sync;
  name: string;
}

const storage = new Map<string, Map<string, string>>();
let current = '';

function use(name: string) {
  if (current) storage.set(current, new Map(Object.entries({ ...localStorage })));
  localStorage.clear();
  for (const [k, v] of storage.get(name) || []) localStorage.setItem(k, v);
  current = name;
}

async function device(name: string): Promise<Device> {
  use(name);
  vi.resetModules();
  const S = await import('./store');
  const SYNC = await import('./sync');
  await SYNC.initSync({ render: () => {}, changed: () => {}, checkForUpdate: () => {} });
  return { S, SYNC, name };
}

async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  use(d.name);
  return fn();
}

const PW = 'correct horse battery';
const log = (...x: unknown[]) => process.stdout.write(`\n${JSON.stringify(x)}`);

beforeEach(() => {
  resetCloud();
  storage.clear();
  current = '';
  localStorage.clear();
  document.body.innerHTML = '<div id="sheet" hidden><div class="sheet-panel"><button class="sheet-close"></button><div class="sheet-body"></div></div></div><div id="toast"></div><main id="app"></main><nav id="tabs"></nav>';
});

describe('probe', () => {
  it('probe', async () => {
    const a = await device('phone');
    const aA = await import('./account');
    const aF = await import('./lib/firebase');
    await a.SYNC.submit('up', { email: 'me@example.com', password: PW, password2: PW });
    const b = await device('laptop');
    const bA = await import('./account');
    const bF = await import('./lib/firebase');
    log('accounts same?', aA === bA, 'fakes same?', aF === bF);
    log('before b signin: a uid', aA.currentUid(), 'b uid', bA.currentUid());
    await b.SYNC.submit('in', { id: 'me@example.com', password: PW });
    log('after b signin: a uid', aA.currentUid(), 'b uid', bA.currentUid());
    await on(a, () => a.SYNC.handleAction('sync-out'));
    log('after a signout: a uid', aA.currentUid(), 'b uid', bA.currentUid(), a.SYNC.status.user, b.SYNC.status.user);
    expect(1).toBe(1);
  });
});
