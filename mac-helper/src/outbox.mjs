// Events waiting for Arise. Each gets a number in order; Arise takes a page, saves it in its life
// log, then says up to which number it has them, and those go. An event already handed over isn't
// queued again (sources are read with some overlap), and the queue has a cap, oldest out first, so
// a Mac where Arise is never opened doesn't fill up.

import { readOwn, writeOwn } from './files.mjs';

export class Outbox {
  /** @param {{ max?: number, remember?: number }} [opts] @param {any} [saved] */
  constructor({ max = 20000, remember = 20000 } = {}, saved) {
    this.max = max;
    this.remember = remember;
    /** @type {{ seq: number, ev: any }[]} */
    this.items = [];
    this.seq = 0;
    this.dropped = 0;
    /** @type {string[]} */
    this.recent = [];
    if (saved && typeof saved === 'object') {
      this.seq = Number(saved.seq) || 0;
      this.dropped = Number(saved.dropped) || 0;
      if (Array.isArray(saved.items)) this.items = saved.items.filter((i) => i && Number.isFinite(i.seq) && i.ev && typeof i.ev.id === 'string');
      if (Array.isArray(saved.recent)) this.recent = saved.recent.filter((id) => typeof id === 'string');
    }
    this.known = new Set([...this.recent, ...this.items.map((i) => i.ev.id)]);
  }

  // Queues the events it hasn't seen; returns how many were new.
  add(events) {
    let n = 0;
    for (const ev of events) {
      if (!ev || typeof ev.id !== 'string' || this.known.has(ev.id)) continue;
      this.items.push({ seq: ++this.seq, ev });
      this.known.add(ev.id);
      this.recent.push(ev.id);
      n++;
    }
    this.trim();
    return n;
  }

  // Queues events that take the place of what Arise has under the same id (a calendar event that
  // moved, or one gone), even when that id went before. One still waiting is taken out: the new
  // one goes at the end, with a new number, so Arise can't acknowledge it with a page it read
  // before. Returns how many were queued.
  put(events) {
    /** @type {Map<string, any>} */
    const fresh = new Map();
    for (const ev of events) if (ev && typeof ev.id === 'string') fresh.set(ev.id, ev);
    if (!fresh.size) return 0;
    this.items = this.items.filter((i) => !fresh.has(i.ev.id));
    for (const [id, ev] of fresh) {
      this.items.push({ seq: ++this.seq, ev });
      if (!this.known.has(id)) {
        this.known.add(id);
        this.recent.push(id);
      }
    }
    this.trim();
    return fresh.size;
  }

  trim() {
    if (this.items.length > this.max) this.dropped += this.items.splice(0, this.items.length - this.max).length;
    if (this.recent.length > this.remember * 1.5) {
      const keep = this.recent.slice(-this.remember);
      this.recent = keep;
      this.known = new Set([...keep, ...this.items.map((i) => i.ev.id)]);
    }
  }

  // Up to `limit` events after number `after`, and the number to acknowledge them with.
  page(after = 0, limit = 500) {
    const rest = this.items.filter((i) => i.seq > after);
    const take = rest.slice(0, Math.max(1, Math.min(limit, 1000)));
    return { events: take.map((i) => i.ev), next: take.length ? take[take.length - 1].seq : after, more: rest.length > take.length };
  }

  // Arise has everything up to `upTo`: those go. Returns how many went.
  ack(upTo) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.seq > upTo);
    return before - this.items.length;
  }

  // Drops waiting events that match (a source turned off), or changes them (text turned off).
  // Arise never got the dropped ones, so they're forgotten too: if the source comes back on, they
  // can be queued again.
  drop(match) {
    const gone = new Set();
    this.items = this.items.filter((i) => !(match(i.ev) && gone.add(i.ev.id)));
    if (gone.size) {
      this.recent = this.recent.filter((id) => !gone.has(id));
      for (const id of gone) this.known.delete(id);
    }
    return gone.size;
  }
  update(change) {
    this.items = this.items.map((i) => ({ seq: i.seq, ev: change(i.ev) }));
  }

  // How many wait, per kind of event (or per what `by` says of each).
  /** @param {(ev: any) => string} [by] */
  waiting(by = (ev) => ev.kind) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const i of this.items) {
      const k = by(i.ev);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  toJSON() {
    return { seq: this.seq, dropped: this.dropped, items: this.items, recent: this.recent.slice(-this.remember) };
  }
}

// ---------- files

export function readJson(file, fallback) {
  try {
    return JSON.parse(readOwn(file));
  } catch {
    return fallback;
  }
}

// Written whole and swapped in, so a crash never leaves half a file, never through a link (see
// src/files.mjs). Only this user can read it.
export function writeJson(file, value) {
  writeOwn(file, JSON.stringify(value));
}
