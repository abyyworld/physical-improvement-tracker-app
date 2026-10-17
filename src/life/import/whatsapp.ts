// WhatsApp: a chat exported with "Export chat" (a .txt, or a .zip with _chat.txt inside).
// Each message starts a line with the date and time the way the phone writes them:
//   iPhone:  [31/12/23, 21:15:04] Anna: Hello        [12/31/23, 9:15:04 PM] Anna: Hello
//   Android: 31/12/2023, 21:15 - Anna: Hello        12/31/23, 9:15 PM - Anna: Hello
//            31.12.23, 21:15 - Anna: Hallo          2023-12-31, 21:15 - Anna: Hola
// Lines without a date carry on the message above. One event per day of the chat:
// "Chatted with Anna: 12 messages", with the first few messages, cut short, as the detail.

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { Lines } from './text-stream';
import { clean, drain, guessOrder, hashId, localMs, ymdOf } from './util';

export const DETAIL_MAX = 280;
const PER_MESSAGE = 80;

// [ date , time AM/PM ] or date, time AM/PM -
const LINE = /^(\[)?(\d{1,4})\s*([./-])\s*(\d{1,2})\s*\3\s*(\d{1,4})\.?,?\s+(?:klo\s+)?(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\s*(\]\s*|[-–—]\s+)/;

export interface ChatLine {
  date: [number, number, number];
  h: number;
  m: number;
  s: number;
  sender: string; // '' for a system line ("Messages are end-to-end encrypted…")
  text: string;
  pm?: boolean;
  am?: boolean;
}

// One line that starts a message, or null.
export function chatLine(raw: string): ChatLine | null {
  const line = raw.replace(/^[﻿‎‏‪-‮]+/, '');
  const m = line.match(LINE);
  // A bracket must close; without one, a dash comes after the time.
  if (!m || !!m[1] !== m[10].startsWith(']')) return null;
  const rest = line.slice(m[0].length);
  const ampm = m[9]?.replace(/[.\s]/g, '').toLowerCase();
  const colon = rest.indexOf(': ');
  const r: ChatLine = {
    date: [+m[2], +m[4], +m[5]],
    h: +m[6],
    m: +m[7],
    s: +(m[8] ?? 0),
    sender: colon > 0 ? clean(rest.slice(0, colon), 60) : rest.endsWith(':') ? clean(rest.slice(0, -1), 60) : '',
    text: colon > 0 ? rest.slice(colon + 2) : '',
  };
  if (ampm === 'pm') r.pm = true;
  if (ampm === 'am') r.am = true;
  return r;
}

// Who the chat is with, from the file's name: "WhatsApp Chat with Anna.txt",
// "WhatsApp Chat - Anna.zip", "WhatsApp-Chat mit Anna.txt", "Chat de WhatsApp con Anna.txt"…
export function chatName(fileName: string): string {
  const base = fileName.split('/').pop()!.replace(/\.(txt|zip)$/i, '').trim();
  if (/^_?chat$/i.test(base)) return '';
  const m =
    base.match(/whats\s*app[\s-]*(?:chat|chatt|czat|sohbeti?|conversa|discussion|conversación|conversazione|gesprek)?[\s-]*(?:with|mit|con|com|avec|met|med|z|ile|с|-|–|:)\s+(.+)$/i) ??
    base.match(/^(?:chat|conversa|discussion|conversación|conversazione|gesprek)\s+(?:de|di|do|du|van)?\s*whats\s*app\s+(?:with|con|com|avec|met|med|z|ile|с)\s+(.+)$/i) ??
    base.match(/^(.+?)\s+(?:ile\s+)?whats\s*app\s+(?:sohbeti|chat)$/i);
  return m ? clean(m[1], 60) : '';
}

interface Day {
  date: [number, number, number];
  first: [number, number, number, boolean?, boolean?];
  last: [number, number, number, boolean?, boolean?];
  n: number;
  senders: Map<string, number>;
  detail: string[];
  detailLen: number;
}

const to24 = (h: number, pm?: boolean, am?: boolean) => (pm && h < 12 ? h + 12 : am && h === 12 ? 0 : h);

export async function* parseWhatsApp(input: TextInput, opts: { chat?: string } = {}): AsyncGenerator<LifeEvent[]> {
  const lines = new Lines();
  const days = new Map<string, Day>();
  let day: Day | null = null;
  let lastText: { day: Day; i: number } | null = null; // where a carried-on line goes
  let slash = 0;
  let total = 0;
  const take = (raw: string) => {
    const c = chatLine(raw);
    if (!c) {
      // More of the message above, for the detail only.
      if (lastText && raw.trim()) {
        const d = lastText.day;
        const room = DETAIL_MAX - d.detailLen;
        if (room > 10 && d.detail[lastText.i].length < PER_MESSAGE) {
          const add = clean(raw, PER_MESSAGE - d.detail[lastText.i].length);
          d.detail[lastText.i] += ` ${add}`;
          d.detailLen += add.length + 1;
        }
      }
      return;
    }
    if (!c.sender) return; // a system line
    total++;
    if (raw.includes('/')) slash++;
    const key = c.date.join('-');
    day = days.get(key) ?? null;
    if (!day) {
      day = { date: c.date, first: [c.h, c.m, c.s, c.pm, c.am], last: [c.h, c.m, c.s, c.pm, c.am], n: 0, senders: new Map(), detail: [], detailLen: 0 };
      days.set(key, day);
    }
    day.n++;
    day.last = [c.h, c.m, c.s, c.pm, c.am];
    day.senders.set(c.sender, (day.senders.get(c.sender) ?? 0) + 1);
    lastText = null;
    if (day.detailLen < DETAIL_MAX - 10) {
      const piece = `${c.sender}: ${clean(c.text, PER_MESSAGE)}`;
      const cut = clean(piece, Math.max(12, DETAIL_MAX - day.detailLen));
      day.detail.push(cut);
      day.detailLen += cut.length + 3;
      lastText = { day, i: day.detail.length - 1 };
    }
  };
  for await (const chunk of input.text) for (const l of lines.push(chunk)) take(l);
  for (const l of lines.end()) take(l);
  if (!total) return;

  // Day and month order, from all the dates (a day over 12 tells). Nothing tells: phones that
  // write "/" with AM/PM are mostly month first, the rest day first.
  const anyPm = [...days.values()].some((d) => d.first[3] || d.first[4] || d.last[3] || d.last[4]);
  const order = guessOrder([...days.values()].map((d) => d.date), slash > total / 2 && anyPm ? 'mdy' : 'dmy');
  // Who: the file's name says; else the people in it.
  const everyone = new Map<string, number>();
  for (const d of days.values()) for (const [s, n] of d.senders) everyone.set(s, (everyone.get(s) ?? 0) + n);
  const people = [...everyone].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const chat = opts.chat || chatName(input.name) || (people.length <= 3 ? people.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${people.slice(0, 2).join(', ')} and others`);

  const out: LifeEvent[] = [];
  for (const d of days.values()) {
    const [y, mo, da] = ymdOf(d.date, order);
    const at = localMs(y, mo, da, to24(d.first[0], d.first[3], d.first[4]), d.first[1], d.first[2]);
    const end = localMs(y, mo, da, to24(d.last[0], d.last[3], d.last[4]), d.last[1], d.last[2]);
    if (!Number.isFinite(at)) continue;
    const dayKey = `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    const e: LifeEvent = {
      id: `whatsapp:${hashId(chat, dayKey)}`,
      source: 'whatsapp',
      kind: 'message',
      at,
      title: `Chatted with ${chat}: ${d.n} ${d.n === 1 ? 'message' : 'messages'}`,
      value: d.n,
      unit: 'messages',
      tier: 3,
      meta: { chat, day: dayKey },
    };
    if (Number.isFinite(end) && end > at) e.end = end;
    const detail = clean(d.detail.join(' · '), DETAIL_MAX);
    if (detail) e.detail = detail;
    out.push(e);
    yield* drain(out);
  }
  yield* drain(out, true);
}
