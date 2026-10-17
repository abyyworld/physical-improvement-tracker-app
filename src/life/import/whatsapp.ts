// WhatsApp: a chat exported with "Export chat" (a .txt, or a .zip with _chat.txt inside).
// Each message starts a line with the date and time the way the phone writes them:
//   iPhone:  [31/12/23, 21:15:04] Anna: Hello        [12/31/23, 9:15:04 PM] Anna: Hello
//   Android: 31/12/2023, 21:15 - Anna: Hello        12/31/23, 9:15 PM - Anna: Hello
//            31.12.23, 21:15 - Anna: Hallo          2023-12-31, 21:15 - Anna: Hola
//   Korean, Chinese and Japanese put the AM/PM word before the time:
//            2024. 1. 15. 오후 9:15 - Anna: hi       [2024/1/15 下午9:15:04] Anna: hi
// Lines without a date carry on the message above. One event per day of the chat:
// "Chatted with Anna: 12 messages", with the first few messages, cut short, as the detail.

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { Lines } from './text-stream';
import { clean, drain, guessOrder, hashId, localMs, ymdOf } from './util';

export const DETAIL_MAX = 280;
const PER_MESSAGE = 80;

// [ date , time AM/PM ] or date, time AM/PM - (or the AM/PM word before the time)
const LINE = /^(\[)?(\d{1,4})\s*([./-])\s*(\d{1,2})\s*\3\s*(\d{1,4})\.?,?\s+(?:klo\s+)?(?:(오전|오후|上午|下午|午前|午後|凌晨|早上|中午|晚上|[AaPp]\.?\s?[Mm]\.?)\s*)?(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\s*(\]\s*|[-–—]\s+)/;
const AM = new Set(['am', '오전', '上午', '午前', '凌晨', '早上']);
const PM = new Set(['pm', '오후', '下午', '午後', '中午', '晚上']);

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
  if (!m || !!m[1] !== m[11].startsWith(']')) return null;
  const rest = line.slice(m[0].length);
  const ampm = (m[10] ?? m[6])?.replace(/[.\s]/g, '').toLowerCase() ?? '';
  const colon = rest.indexOf(': ');
  const r: ChatLine = {
    date: [+m[2], +m[4], +m[5]],
    h: +m[7],
    m: +m[8],
    s: +(m[9] ?? 0),
    sender: colon > 0 ? clean(rest.slice(0, colon), 60) : rest.endsWith(':') ? clean(rest.slice(0, -1), 60) : '',
    text: colon > 0 ? rest.slice(colon + 2) : '',
  };
  if (PM.has(ampm)) r.pm = true;
  if (AM.has(ampm)) r.am = true;
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

// iPhone writes its system lines ("Messages and calls are end-to-end encrypted…", "Anna created
// group", "Anna added you") as if the chat itself sent them, with this mark before the text.
// Photos and other media ("‎image omitted", "‎<attached: …>") have it too, from the real sender.
const MARK = '‎';

interface Day {
  date: [number, number, number];
  first: number; // seconds into the day of the first and last message (lines without the mark)
  last: number;
  n: number;
  senders: Map<string, number>;
  marked: Map<string, number[]>; // lines with the mark, by sender: their times (seconds)
  detail: { who: string; marked: boolean; text: string }[];
  detailLen: number;
}

const to24 = (h: number, pm?: boolean, am?: boolean) => (pm && h < 12 ? h + 12 : am && h === 12 ? 0 : h);
const secondsOf = (c: ChatLine) => to24(c.h, c.pm, c.am) * 3600 + c.m * 60 + c.s;

export async function* parseWhatsApp(input: TextInput, opts: { chat?: string } = {}): AsyncGenerator<LifeEvent[]> {
  const lines = new Lines();
  const days = new Map<string, Day>();
  let day: Day | null = null;
  let lastText: { day: Day; i: number } | null = null; // where a carried-on line goes
  let slash = 0;
  let total = 0;
  let ampm = false;
  const plain = new Set<string>(); // senders with a line without the mark
  const take = (raw: string) => {
    const c = chatLine(raw);
    if (!c) {
      // More of the message above, for the detail only.
      if (lastText && raw.trim()) {
        const d = lastText.day;
        const x = d.detail[lastText.i];
        const room = DETAIL_MAX - d.detailLen;
        if (room > 10 && x.text.length < PER_MESSAGE) {
          const add = clean(raw, PER_MESSAGE - x.text.length);
          x.text += ` ${add}`;
          d.detailLen += add.length + 1;
        }
      }
      return;
    }
    if (!c.sender) return; // a system line (Android writes them without a sender)
    const marked = c.text.startsWith(MARK);
    // The end-to-end notice every iPhone chat starts with.
    if (marked && !total) {
      lastText = null;
      return;
    }
    total++;
    if (c.pm || c.am) ampm = true;
    if (raw.includes('/')) slash++;
    if (!marked) plain.add(c.sender);
    const key = c.date.join('-');
    day = days.get(key) ?? null;
    if (!day) {
      day = { date: c.date, first: Infinity, last: -Infinity, n: 0, senders: new Map(), marked: new Map(), detail: [], detailLen: 0 };
      days.set(key, day);
    }
    const t = secondsOf(c);
    day.n++;
    day.senders.set(c.sender, (day.senders.get(c.sender) ?? 0) + 1);
    if (marked) {
      const times = day.marked.get(c.sender);
      if (times) times.push(t);
      else day.marked.set(c.sender, [t]);
    } else {
      day.first = Math.min(day.first, t);
      day.last = Math.max(day.last, t);
    }
    lastText = null;
    if (day.detailLen < DETAIL_MAX - 10) {
      const piece = `${c.sender}: ${clean(c.text, PER_MESSAGE)}`;
      const cut = clean(piece, Math.max(12, DETAIL_MAX - day.detailLen));
      day.detail.push({ who: c.sender, marked, text: cut });
      day.detailLen += cut.length + 3;
      lastText = { day, i: day.detail.length - 1 };
    }
  };
  for await (const chunk of input.text) for (const l of lines.push(chunk)) take(l);
  for (const l of lines.end()) take(l);
  if (!total) return;

  // Day and month order, from all the dates (a day over 12 tells). Nothing tells: phones that
  // write "/" with AM/PM are mostly month first, the rest day first.
  const order = guessOrder([...days.values()].map((d) => d.date), slash > total / 2 && ampm ? 'mdy' : 'dmy');
  // A sender whose every line has the mark is the chat itself (a group's name, on an iPhone):
  // those are system lines, not messages. When the file's name says the chat, only that name.
  const named = opts.chat || chatName(input.name);
  const system = new Set<string>();
  for (const d of days.values()) for (const s of d.marked.keys()) if (!plain.has(s) && (!named || s === named)) system.add(s);
  // Who: the file's name says; else the people in it.
  const everyone = new Map<string, number>();
  for (const d of days.values()) for (const [s, n] of d.senders) if (!system.has(s)) everyone.set(s, (everyone.get(s) ?? 0) + n);
  const people = [...everyone].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const chat = named || (people.length <= 3 ? people.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${people.slice(0, 2).join(', ')} and others`);

  const out: LifeEvent[] = [];
  for (const d of days.values()) {
    let n = d.n;
    let first = d.first;
    let last = d.last;
    for (const [s, times] of d.marked) {
      if (system.has(s)) n -= times.length;
      else for (const t of times) (first = Math.min(first, t)), (last = Math.max(last, t));
    }
    if (n <= 0) continue;
    const [y, mo, da] = ymdOf(d.date, order);
    const clock = (t: number) => localMs(y, mo, da, Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60);
    const at = clock(first);
    const end = clock(last);
    if (!Number.isFinite(at)) continue;
    const dayKey = `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    const e: LifeEvent = {
      id: `whatsapp:${hashId(chat, dayKey)}`,
      source: 'whatsapp',
      kind: 'message',
      at,
      title: `Chatted with ${chat}: ${n} ${n === 1 ? 'message' : 'messages'}`,
      value: n,
      unit: 'messages',
      tier: 3,
      meta: { chat, day: dayKey },
    };
    if (Number.isFinite(end) && end > at) e.end = end;
    const detail = clean(
      d.detail
        .filter((x) => !(x.marked && system.has(x.who)))
        .map((x) => x.text)
        .join(' · '),
      DETAIL_MAX,
    );
    if (detail) e.detail = detail;
    out.push(e);
    yield* drain(out);
  }
  yield* drain(out, true);
}
