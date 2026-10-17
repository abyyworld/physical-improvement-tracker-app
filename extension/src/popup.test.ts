// @vitest-environment jsdom
// The extension's menu: the person's own sites to skip can be set before linking, since linking
// reads the last 90 days of history straight away.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PopupRequest, PopupState } from './lib/recorder';

const ext = vi.hoisted(() => ({ state: null as unknown as PopupState, sent: [] as PopupRequest[] }));

vi.mock('./api', () => ({
  ARISE: ['https://abyyworld.github.io/physical-improvement-tracker-app/'],
  api: {
    runtime: {
      sendMessage: async ({ msg }: { msg: PopupRequest }) => {
        ext.sent.push(msg);
        if (msg.t === 'skip') ext.state = { ...ext.state, skip: msg.text.split('\n').filter(Boolean) };
        return structuredClone(ext.state);
      },
    },
    tabs: { create: async () => ({}) },
  },
}));

const base: PopupState = {
  linked: false,
  linkedAt: 0,
  arise: '',
  browser: 'Chrome on macOS',
  version: '1.0.0',
  paused: false,
  skip: [],
  waiting: 0,
  sent: { at: 0, n: 0 },
  backfilling: false,
  pairing: null,
};

async function open(state: PopupState) {
  ext.state = state;
  ext.sent = [];
  document.body.innerHTML = '<header><span id="browserName"></span></header><main id="main"></main>';
  vi.resetModules();
  await import('./popup');
  await vi.waitFor(() => expect(document.getElementById('browserName')!.textContent).toBe('Chrome on macOS'));
}

async function saveSkip(text: string) {
  (document.getElementById('skip') as HTMLTextAreaElement).value = text;
  (document.querySelector('button[data-act="skip"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(ext.sent.some((m) => m.t === 'skip')).toBe(true));
}

describe('sites to skip in the menu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('can be set before the browser is linked', async () => {
    await open(base);
    expect(document.body.textContent).toContain('Not linked yet.');
    expect(document.body.textContent).toContain('linking also reads the last 90 days');
    await saveSkip('mytherapist.example');
    expect(ext.sent.at(-1)).toEqual({ t: 'skip', text: 'mytherapist.example' });
    await vi.waitFor(() => expect((document.getElementById('skip') as HTMLTextAreaElement).value).toBe('mytherapist.example'));
  });

  it('can be set in the window with the 4 words, before "They match"', async () => {
    await open({ ...base, pairing: { link: 'L'.repeat(22), code: ['apple', 'river', 'stone', 'cloud'] } });
    expect(document.body.textContent).toContain('apple · river · stone · cloud');
    await saveSkip('private-forum.example');
    expect(ext.sent.at(-1)).toEqual({ t: 'skip', text: 'private-forum.example' });
  });

  it('is still there once linked', async () => {
    await open({ ...base, linked: true, linkedAt: 1, skip: ['work.example'] });
    expect((document.getElementById('skip') as HTMLTextAreaElement).value).toBe('work.example');
  });
});
