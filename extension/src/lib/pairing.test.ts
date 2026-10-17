// Linking: the messages between Arise's page and the extension, and the 4 words both show.

import { describe, expect, it } from 'vitest';
import { CODE_WORDS, commitment, newLinkId, newNonce, pairCode, parseNote, parsePull, parsePush, parseRequest } from './pairing';
import { newKeyPair, sealBatch } from './seal';
import { WORDS } from './words';

describe('the 4-word code', () => {
  it('has 256 different plain words to pick from', () => {
    expect(WORDS).toHaveLength(256);
    expect(new Set(WORDS).size).toBe(256);
    for (const w of WORDS) expect(w, w).toMatch(/^[a-z]{3,8}$/);
  });

  it('is the same on both sides for the same exchange', async () => {
    const { pub } = await newKeyPair(false);
    const link = newLinkId();
    const page = newNonce();
    const ext = newNonce();
    const a = await pairCode(link, pub, page, ext);
    const b = await pairCode(link, pub, page, ext);
    expect(a).toEqual(b);
    expect(a).toHaveLength(CODE_WORDS);
    for (const w of a) expect(WORDS).toContain(w);
  });

  it('changes when anything in between swapped the key, the link or a number', async () => {
    const { pub } = await newKeyPair(false);
    const evil = (await newKeyPair(false)).pub;
    const [link, page, ext] = [newLinkId(), newNonce(), newNonce()];
    const real = (await pairCode(link, pub, page, ext)).join(' ');
    expect((await pairCode(link, evil, page, ext)).join(' ')).not.toBe(real);
    expect((await pairCode(newLinkId(), pub, page, ext)).join(' ')).not.toBe(real);
    expect((await pairCode(link, pub, newNonce(), ext)).join(' ')).not.toBe(real);
    expect((await pairCode(link, pub, page, newNonce())).join(' ')).not.toBe(real);
  });

  it('ties the page to its number before it sees the extension’s (the commitment)', async () => {
    const n = newNonce();
    expect(await commitment(n)).toBe(await commitment(n));
    expect(await commitment(n)).not.toBe(await commitment(newNonce()));
    expect(await commitment(n)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('makes new ids and numbers every time', () => {
    const ids = new Set(Array.from({ length: 200 }, newLinkId));
    expect(ids.size).toBe(200);
    expect(newNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('messages', () => {
  it('lets through the page’s requests in their exact shape', async () => {
    const { pub } = await newKeyPair(false);
    const link = newLinkId();
    const commit = await commitment(newNonce());
    expect(parseRequest({ t: 'hello', extra: 1 })).toEqual({ t: 'hello' });
    expect(parseRequest({ t: 'offer', link, pub, commit, junk: 'x' })).toEqual({ t: 'offer', link, pub, commit });
    expect(parseRequest({ t: 'reveal', link, nonce: newNonce() })).toMatchObject({ t: 'reveal', link });
    expect(parseRequest({ t: 'pull', link })).toEqual({ t: 'pull', link });
    expect(parseRequest({ t: 'status', link })).toEqual({ t: 'status', link });
    expect(parseRequest({ t: 'unlink', link })).toEqual({ t: 'unlink', link });
    expect(parseRequest({ t: 'ack', link, ids: [newLinkId()] })).toMatchObject({ t: 'ack', notes: [] });
  });

  it('turns away anything else', async () => {
    const link = newLinkId();
    const { pub } = await newKeyPair(false);
    for (const bad of [
      null,
      'hello',
      {},
      { t: 'nope' },
      { t: 'offer', link, pub: 'short', commit: link },
      { t: 'offer', link: 'x', pub, commit: link },
      { t: 'offer', link, pub },
      { t: 'reveal', link },
      { t: 'pull' },
      { t: 'pull', link: '../../etc' },
      { t: 'ack', link, ids: 'all' },
      { t: 'ack', link, ids: ['<script>'] },
      { t: 'ack', link, ids: Array.from({ length: 1001 }, newLinkId) },
      { t: 'ack', link, ids: [], notes: [1] },
    ]) {
      expect(parseRequest(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });

  it('checks what the extension tells the page', async () => {
    const link = newLinkId();
    expect(parsePush({ t: 'paired', link })).toEqual({ t: 'paired', link });
    expect(parsePush({ t: 'ready', link })).toEqual({ t: 'ready', link });
    expect(parsePush({ t: 'here' })).toBeNull();
    expect(parsePush({ t: 'paired', link: 'x' })).toBeNull();
    expect(parseNote({ id: link, t: 'forget', from: 1, to: 2 })).toEqual({ id: link, t: 'forget', from: 1, to: 2 });
    expect(parseNote({ id: link, t: 'forget', from: 3, to: 2 })).toBeNull();
    expect(parseNote({ id: link, t: 'delete-everything', from: 1, to: 2 })).toBeNull();

    const { pub } = await newKeyPair(false);
    const good = await sealBatch(pub, link, { id: newLinkId(), from: 1, to: 2, n: 1 }, { v: 1, events: [] });
    const pull = parsePull({ ok: true, batches: [good, { bad: 1 }], notes: [{ id: link, t: 'forget', from: 1, to: 2 }, 'x'], more: 1 });
    expect(pull).toEqual({ ok: true, batches: [good], notes: [{ id: link, t: 'forget', from: 1, to: 2 }], more: true });
    expect(parsePull({ ok: false })).toBeNull();
    expect(parsePull(null)).toBeNull();
  });
});
