// Study: question packs for university modules, played as short rounds with spaced repetition.
//
// A pack is made outside Arise (from the Player's own course materials) and published as a
// sealed file: AES-GCM with a key that only travels in their study link, `<id>.<key>`, the same
// way a share link works (lib/share.ts). The pack itself stays on each device; what syncs is the
// small `study` part of the state: the link, how well each card is known, and the rounds played.

import { isDate, str } from './clean';

export const STUDY_FORMAT = 'arise.study/v1';
const LINK = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_CARDS = 5000;

// ---------- the link

// The link as pasted: just `<id>.<key>`, or a whole Arise address ending in `#study=<id>.<key>`.
export function parseLink(text: unknown): { id: string; key: string } | null {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^.*#study=/, '');
  const m = LINK.exec(t);
  return m ? { id: m[1], key: m[2] } : null;
}
export const isStudyHash = (hash: string) => /^#study=/.test(hash);
export const packAad = (id: string) => `study/${id}`;

// ---------- the pack

export interface Card {
  id: string;
  topic: string;
  type: 'mcq' | 'recall';
  q: string;
  code?: string;
  choices?: string[];
  answer?: number;
  back?: string;
  explain: string;
  source: string;
}
export interface Topic {
  id: string;
  week: number;
  title: string;
}
export interface Test {
  title: string;
  date: string;
  covers: string;
  note: string;
  source: string;
}
export interface Module {
  id: string;
  module: string;
  short: string;
  tests: Test[];
  topics: Topic[];
  cards: Card[];
}
export interface Pack {
  updated: string;
  modules: Module[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown, max: number) => str(v, max).trim();

function cleanCard(raw: unknown, topics: Set<string>): Card | null {
  const c = obj(raw);
  const id = text(c.id, 48);
  const topic = text(c.topic, 48);
  const q = text(c.q, 600);
  if (!CARD_ID.test(id) || !topics.has(topic) || !q) return null;
  const card: Card = { id, topic, type: c.type === 'recall' ? 'recall' : 'mcq', q, explain: text(c.explain, 800), source: text(c.source, 200) };
  const code = str(c.code, 1500).replace(/\s+$/, '');
  if (code) card.code = code;
  if (card.type === 'mcq') {
    const choices = arr(c.choices)
      .slice(0, 6)
      .map((x) => text(x, 300))
      .filter(Boolean);
    const answer = typeof c.answer === 'number' && Number.isInteger(c.answer) ? c.answer : -1;
    if (choices.length < 2 || answer < 0 || answer >= choices.length) return null;
    card.choices = choices;
    card.answer = answer;
  } else {
    card.back = text(c.back, 800);
    if (!card.back) return null;
  }
  return card;
}

function cleanModule(raw: unknown): Module | null {
  const m = obj(raw);
  const id = text(m.id, 48);
  if (!CARD_ID.test(id)) return null;
  const topics: Topic[] = [];
  for (const t of arr(m.topics).slice(0, 200)) {
    const x = obj(t);
    const tid = text(x.id, 48);
    if (CARD_ID.test(tid) && !topics.some((y) => y.id === tid)) topics.push({ id: tid, week: Math.max(0, Math.min(52, Math.round(Number(x.week)) || 0)), title: text(x.title, 120) || tid });
  }
  const ids = new Set(topics.map((t) => t.id));
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const c of arr(m.cards).slice(0, MAX_CARDS)) {
    const card = cleanCard(c, ids);
    if (card && !seen.has(card.id)) {
      seen.add(card.id);
      cards.push(card);
    }
  }
  const tests: Test[] = arr(m.tests)
    .slice(0, 20)
    .map((t) => obj(t))
    .filter((t) => isDate(t.date))
    .map((t) => ({ title: text(t.title, 120) || 'Test', date: t.date as string, covers: text(t.covers, 200), note: text(t.note, 400), source: text(t.source, 200) }));
  return { id, module: text(m.module, 120) || id, short: text(m.short, 40) || text(m.module, 40) || id, tests, topics, cards };
}

// A pack from outside the app: every field checked, anything unknown dropped. Text is kept as
// text; the screens escape it.
export function cleanPack(raw: unknown): Pack | null {
  const p = obj(raw);
  if (p.format !== STUDY_FORMAT) return null;
  const seen = new Set<string>();
  const modules = arr(p.modules)
    .slice(0, 20)
    .map(cleanModule)
    .filter((m): m is Module => !!m && !seen.has(m.id) && !!seen.add(m.id));
  return modules.length ? { updated: isDate(p.updated) ? p.updated : '', modules } : null;
}

// ---------- what syncs

// b: the card's box (0 is new or just missed), due: when it's next asked, at: when it was last
// answered (the later answer wins in a merge), r and w: times right and wrong.
export interface CardState {
  b: number;
  due: string;
  at: number;
  r: number;
  w: number;
}
// One day's rounds: how many, and first answers right out of all.
export interface RoundDay {
  n: number;
  right: number;
  total: number;
  at: number;
}
export interface Study {
  link: string;
  linkAt: number;
  cards: Record<string, CardState>;
  rounds: Record<string, RoundDay>;
}

const count = (v: unknown, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(hi, Math.round(v))) : 0);
const stampOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? v : 0);

export function cleanStudy(raw: unknown): Study {
  const s = obj(raw);
  const link = typeof s.link === 'string' && parseLink(s.link) ? s.link : '';
  const cards: Record<string, CardState> = {};
  for (const [id, c] of Object.entries(obj(s.cards)).slice(0, MAX_CARDS * 4)) {
    const x = obj(c);
    if (!CARD_ID.test(id) || !isDate(x.due)) continue;
    cards[id] = { b: count(x.b, BOXES.length - 1), due: x.due, at: stampOf(x.at), r: count(x.r, 1e6), w: count(x.w, 1e6) };
  }
  const rounds: Record<string, RoundDay> = {};
  for (const [k, d] of Object.entries(obj(s.rounds))) {
    const x = obj(d);
    if (!isDate(k)) continue;
    const total = count(x.total, 1e5);
    rounds[k] = { n: count(x.n, 1000), right: Math.min(count(x.right, 1e5), total), total, at: stampOf(x.at) };
  }
  return { link, linkAt: stampOf(s.linkAt), cards, rounds };
}

// Two devices' study: the later link, and for each card and each day the later answer.
export function mergeStudy(a: Study, b: Study): Study {
  const out = structuredClone(a);
  if (b.linkAt > a.linkAt) {
    out.link = b.link;
    out.linkAt = b.linkAt;
  }
  for (const [id, c] of Object.entries(b.cards)) if (!out.cards[id] || c.at > out.cards[id].at) out.cards[id] = c;
  for (const [k, d] of Object.entries(b.rounds)) if (!out.rounds[k] || d.at > out.rounds[k].at) out.rounds[k] = d;
  return out;
}

export const hasStudy = (s: Study) => !!s.link || !!Object.keys(s.cards).length || !!Object.keys(s.rounds).length;

// ---------- spaced repetition

// Days until a card in each box comes back: a miss brings it back today, each right answer
// spaces it out further. Box 3 and up counts as known.
export const BOXES = [0, 1, 3, 7, 14, 30];
export const KNOWN_BOX = 3;

const addDays = (k: string, n: number) => {
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};
export const daysUntil = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function answer(prev: CardState | undefined, right: boolean, today: string, at: number): CardState {
  const b = right ? Math.min(BOXES.length - 1, (prev?.b ?? 0) + 1) : 0;
  return { b, due: addDays(today, right ? BOXES[b] : 0), at, r: (prev?.r ?? 0) + (right ? 1 : 0), w: (prev?.w ?? 0) + (right ? 0 : 1) };
}

export const ROUND = 10;
const NEW_A_ROUND = 6;

// A round: cards due (the longest waiting first), then new ones in the order of the course,
// at most six new so a round never feels like a wall. With nothing due and nothing new, the
// least known cards, so there's always a round to play.
export function pickRound(cards: Card[], state: Record<string, CardState>, today: string, n = ROUND): Card[] {
  const seen = cards.filter((c) => state[c.id]);
  const due = seen.filter((c) => state[c.id].due <= today).sort((x, y) => (state[x.id].due < state[y.id].due ? -1 : state[x.id].due > state[y.id].due ? 1 : state[x.id].b - state[y.id].b));
  const fresh = cards.filter((c) => !state[c.id]);
  const out = due.slice(0, n);
  out.push(...fresh.slice(0, Math.min(NEW_A_ROUND, n - out.length)));
  if (out.length < n) {
    const rest = seen.filter((c) => !out.includes(c)).sort((x, y) => state[x.id].b - state[y.id].b || (state[x.id].due < state[y.id].due ? -1 : 1));
    out.push(...rest.slice(0, n - out.length));
  }
  return out;
}

// How far along a set of cards is: known (box 3+), seen, due today, and all.
export function progress(cards: Card[], state: Record<string, CardState>, today: string) {
  let known = 0;
  let seen = 0;
  let due = 0;
  for (const c of cards) {
    const s = state[c.id];
    if (!s) continue;
    seen++;
    if (s.b >= KNOWN_BOX) known++;
    if (s.due <= today) due++;
  }
  return { known, seen, due, all: cards.length, pct: cards.length ? Math.round((known / cards.length) * 100) : 0 };
}

// Tests still to come, the nearest first.
export function upcoming(pack: Pack | null, today: string) {
  if (!pack) return [];
  return pack.modules
    .flatMap((m) => m.tests.map((t) => ({ ...t, module: m.short, moduleId: m.id, days: daysUntil(today, t.date) })))
    .filter((t) => t.days >= 0)
    .sort((a, b) => a.days - b.days);
}

// The module to play when none is picked: the one with the nearest test in the next three
// weeks, or else the one with most cards due.
export function nextModule(pack: Pack, state: Record<string, CardState>, today: string): Module {
  const soon = upcoming(pack, today).find((t) => t.days <= 21);
  const m = soon && pack.modules.find((x) => x.id === soon.moduleId);
  if (m) return m;
  return [...pack.modules].sort((a, b) => progress(b.cards, state, today).due - progress(a.cards, state, today).due)[0];
}

// ---------- XP

// 20 XP a round (up to four a day count) and 2 per first answer right (up to 40 a day).
export const ROUND_XP = 20;
export const RIGHT_XP = 2;
const ROUNDS_A_DAY = 4;
const RIGHT_A_DAY = 40;
export const roundXP = (right: number) => ROUND_XP + RIGHT_XP * right;
export const studyXP = (s: Study) => Object.values(s.rounds).reduce((t, d) => t + Math.min(d.n, ROUNDS_A_DAY) * ROUND_XP + Math.min(d.right, RIGHT_A_DAY) * RIGHT_XP, 0);
export const roundsOn = (s: Study, k: string) => s.rounds[k]?.n || 0;
