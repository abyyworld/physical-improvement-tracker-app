// Arise as the Player's "me" for other apps: the parts that don't need the app, so the tests, the
// reader for app makers (public/me.js) and the MCP server (mcp/) all follow one format.
//
// Two ways out, and nothing goes either way unless the Player chooses it:
//   - About me: a short text the Player reads, changes and copies into any AI app's "about you"
//     field (aboutText).
//   - A me link for one app: like a shared goal (lib/share.ts), a page in the cloud sealed with a
//     key that's only in the link (<site>#me=<id>.<key>), kept up to date by the app (me.ts). It
//     holds the "arise.me/v1" payload (MePayload), with only what the Player picked for that app.
//     Same place and shape as a shared goal's page (shares/<id>, firestore.rules), so the rules
//     need nothing new; it's sealed for "me/<id>" instead of "share/<id>", so neither kind of page
//     opens as the other.

// Only small modules: the page that shows a me link (share-view.ts) loads this, and none of the app.
import { linkKey, open, seal, type Sealed } from './crypto';
import { MAX_CT, newShareRef } from './share';
import type { LifeTier } from '../life/types';

export const FORMAT = 'arise.me/v1';

// ---------- what the Player picks

export const SECTIONS = ['name', 'goals', 'routines', 'likes', 'helps', 'other', 'today', 'days'] as const;
export type Section = (typeof SECTIONS)[number];
// The parts of an About me text (today's quests and recent days are for a link that updates).
export const ABOUT_SECTIONS: readonly Section[] = ['name', 'goals', 'routines', 'likes', 'helps', 'other'];
// Kinds of facts: Arise's facts are free text, sorted by their words (sectionOf).
export type FactSection = 'routines' | 'likes' | 'helps' | 'other';

export const SECTION_LABELS: Record<Section, string> = {
  name: 'Your first name',
  goals: 'Your goals',
  routines: 'Your routines',
  likes: 'What you like',
  helps: 'What helps you',
  other: 'Other facts',
  today: "Today's quests",
  days: 'Your last 7 days',
};

// How private, as the life log's tiers for sharing (life/tiers.ts shareTier): 1 only Arise's own
// goals, quests and workouts, 2 everyday things too (the journal among them), 3 sensitive things
// too (weigh-ins, energy and questions to the coach among them).
export const TIER_LABELS: Record<LifeTier, string> = { 1: 'Goals only', 2: 'Everyday', 3: 'Sensitive too' };
export const TIER_TEXT: Record<LifeTier, string> = {
  1: 'Only what comes from your goals, quests and workouts in Arise.',
  2: 'Also everyday things, like what you watch, play and write in your journal. Nothing sensitive.',
  3: 'Also sensitive things, like searches, places, messages, money and health, your weigh-ins and energy, and what you ask the coach.',
};

export interface MeChoice {
  sections: Section[];
  tier: LifeTier;
}

// Sensitive things are left out until the Player puts them in.
export const ABOUT_DEFAULT: MeChoice = { sections: [...ABOUT_SECTIONS], tier: 2 };
export const LINK_DEFAULT: MeChoice = { sections: [...ABOUT_SECTIONS], tier: 2 };

const isTier = (v: unknown): v is LifeTier => v === 1 || v === 2 || v === 3;

// A choice as it comes from this device's storage, or the default.
export function cleanChoice(raw: unknown, dflt: MeChoice = ABOUT_DEFAULT): MeChoice {
  if (!raw || typeof raw !== 'object') return { sections: [...dflt.sections], tier: dflt.tier };
  const r = raw as Record<string, unknown>;
  const given = Array.isArray(r.sections) ? r.sections : dflt.sections;
  return { sections: SECTIONS.filter((s) => given.includes(s)), tier: isTier(r.tier) ? r.tier : dflt.tier };
}

const CHOICE_WORDS: Record<Section, string> = {
  name: 'first name',
  goals: 'goals',
  routines: 'routines',
  likes: 'likes',
  helps: 'what helps you',
  other: 'other facts',
  today: "today's quests",
  days: 'last 7 days',
};

// What the Player picked, in a few plain words: "First name, goals, routines. No sensitive things."
export function choiceText(c: MeChoice): string {
  const parts = SECTIONS.filter((s) => c.sections.includes(s)).map((s) => CHOICE_WORDS[s]);
  const list = parts.length ? parts.join(', ').replace(/^./, (x) => x.toUpperCase()) : 'Nothing';
  return `${list}. ${c.tier === 3 ? 'Sensitive things too.' : c.tier === 2 ? 'No sensitive things.' : 'Only what comes from your goals and quests.'}`;
}

// ---------- what Arise knows, as the app hands it over (me.ts)

export interface MeSource {
  name: string; // first name, '' when they haven't said
  goals: { title: string; why: string; streak: number }[]; // active goals
  facts: { text: string; since: string; tier: LifeTier }[]; // what Arise knows, the best first; tier: how private to share
  today: MeToday | null;
  days: { day: string; text: string; tier: LifeTier }[]; // summaries of past days, newest first
}

// ---------- the payload an app gets (arise.me/v1)

export interface MeFact {
  text: string;
  since: string;
}
export interface MeGoal {
  title: string;
  why: string;
  streak: number; // days in a row it got done
}
export interface MeToday {
  day: string;
  quests: { title: string; done: boolean }[];
}
export interface MeDay {
  day: string;
  text: string;
}
export interface MePayload {
  format: typeof FORMAT;
  name?: string;
  about?: string;
  facts: MeFact[];
  goals: MeGoal[];
  today?: MeToday;
  days?: MeDay[];
  updated: number;
}
// Everything a payload may hold. Nothing else is ever sent (me.test.ts checks it).
export const PAYLOAD_FIELDS = ['format', 'name', 'about', 'facts', 'goals', 'today', 'days', 'updated'] as const;

const MAX = { facts: 100, goals: 20, quests: 30, days: 7, why: 400 };
// ChatGPT's "about you" box takes 1,500 characters.
export const ABOUT_MAX = 1500;

// ---------- words: "You run on Sundays." -> "I run on Sundays."

// Words after which "you" starts a clause ("when you run"), so it becomes "I", not "me".
const SUBJECT_AFTER = new Set(['when', 'whenever', 'if', 'and', 'but', 'or', 'because', 'that', 'while', 'before', 'after', 'so', 'as', 'since', 'until', 'unless', 'though', 'although', 'where', 'once', 'then', 'than', 'what', 'how', 'why', 'who', 'which']);
const keepCase = (from: string, to: string) => (/^[A-Z]/.test(from) ? to[0].toUpperCase() + to.slice(1) : to);

// Arise's facts and summaries speak to the Player ("You…"); what they hand to an app speaks as
// them ("I…"). Text already in the first person stays as it is.
export function firstPerson(text: string): string {
  const t = text
    .replace(/\byou are not\b|\byou aren['’]t\b/gi, "I'm not")
    .replace(/\byou were not\b|\byou weren['’]t\b/gi, "I wasn't")
    .replace(/\byou are\b/gi, 'I am')
    .replace(/\byou['’]re\b/gi, "I'm")
    .replace(/\byou were\b/gi, 'I was')
    .replace(/\byou['’]ve\b/gi, "I've")
    .replace(/\byou['’]ll\b/gi, "I'll")
    .replace(/\byou['’]d\b/gi, "I'd")
    .replace(/\byourselves\b|\byourself\b/gi, (m) => keepCase(m, 'myself'))
    .replace(/\byours\b/gi, (m) => keepCase(m, 'mine'))
    .replace(/\byour\b/gi, (m) => keepCase(m, 'my'));
  return t.replace(/\byou\b/gi, (_m, at: number, whole: string) => {
    const before = whole.slice(0, at);
    if (/(^|[.!?:;,(]\s*|\n\s*|^\s*[-*]\s*)$/.test(before)) return 'I';
    const prev = /([A-Za-z']+)\W*$/.exec(before)?.[1]?.toLowerCase() || '';
    return SUBJECT_AFTER.has(prev) ? 'I' : 'me';
  });
}

// ---------- sorting facts

const HELPS = /\b(helps?|helped|helpful|works? (best|better|well)|motivat\w*|keeps? (you|me) going|easier|calms?|calmer|better when|feels? better|recharg\w*|energi[sz]\w*|gives? (you|me) energy)\b/i;
const LIKES = /\b(likes?|liked|love[sd]?|enjoy\w*|prefer\w*|favou?rite\w*|fan of|hates?|dislikes?|can['’]t stand|into)\b/i;
const ROUTINES = /\b(every|each|usually|often|always|most (days|mornings|evenings|nights|weekends|weeks)|daily|weekly|nightly|routines?|habits?|mornings?|evenings?|nights?|weekends?|weekdays?|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|wakes? up|go(es)? to bed|bedtime|commut\w*|before work|after work|lunch\w*|breakfast)\b/i;
const MEDIA = /\b(listen\w*|watch\w*|plays?|playing|reads?|reading|music|podcasts?|shows?|series|films?|movies?|games?|books?|songs?|artists?|bands?)\b/i;

export function sectionOf(text: string): FactSection {
  if (HELPS.test(text)) return 'helps';
  if (LIKES.test(text)) return 'likes';
  if (ROUTINES.test(text)) return 'routines';
  if (MEDIA.test(text)) return 'likes';
  return 'other';
}

// The facts a choice lets out, the best first, in the Player's own voice.
function pickFacts(src: MeSource, c: MeChoice): (MeFact & { section: FactSection })[] {
  return src.facts
    .filter((f) => f.tier <= c.tier)
    .map((f) => ({ text: firstPerson(f.text), since: f.since, section: sectionOf(f.text) }))
    .filter((f) => c.sections.includes(f.section));
}

// ---------- About me

const HEADINGS: Record<'goals' | FactSection, string> = {
  goals: "What I'm working toward",
  routines: 'My routines',
  likes: 'What I like',
  helps: 'What helps me',
  other: 'More about me',
};
const sentence = (t: string) => (/[.!?…]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
// A goal's why, on one line and as long as a reader keeps it (cleanMe).
const whyOf = (g: { why: string }) => line(g.why, MAX.why);

// The About me text for a choice, within `max` characters: the goals first, then the best facts
// that fit.
export function aboutText(src: MeSource, c: MeChoice, max = ABOUT_MAX): string {
  const has = (s: Section) => c.sections.includes(s);
  const intro = has('name') && src.name ? `My name is ${src.name}.` : '';
  const goals = has('goals')
    ? src.goals.slice(0, 6).map((g) => {
        const why = whyOf(g).replace(/[.!?…]+$/, '');
        return `- ${sentence(g.title)}${why ? ` Why: ${sentence(why)}` : ''}`;
      })
    : [];
  const lists = new Map<FactSection, string[]>();
  const render = () => {
    const parts = intro ? [intro] : [];
    if (goals.length) parts.push(`${HEADINGS.goals}:\n${goals.join('\n')}`);
    for (const s of ['routines', 'likes', 'helps', 'other'] as const) {
      const l = lists.get(s);
      if (l?.length) parts.push(`${HEADINGS[s]}:\n${l.join('\n')}`);
    }
    return parts.join('\n\n');
  };
  while (goals.length && render().length > max) goals.pop();
  for (const f of pickFacts(src, c)) {
    const list = lists.get(f.section) || [];
    lists.set(f.section, [...list, `- ${sentence(f.text)}`]);
    if (render().length > max) lists.set(f.section, list);
  }
  return render();
}

// ---------- the payload

export function buildMe(src: MeSource, c: MeChoice, now = Date.now()): MePayload {
  const has = (s: Section) => c.sections.includes(s);
  const about = aboutText(src, { ...c, sections: c.sections.filter((s) => ABOUT_SECTIONS.includes(s)) });
  return {
    format: FORMAT,
    ...(has('name') && src.name ? { name: src.name } : {}),
    ...(about ? { about } : {}),
    facts: pickFacts(src, c)
      .slice(0, MAX.facts)
      .map(({ text, since }) => ({ text, since })),
    goals: has('goals') ? src.goals.slice(0, MAX.goals).map((g) => ({ title: g.title, why: whyOf(g), streak: g.streak })) : [],
    ...(has('today') && src.today ? { today: { day: src.today.day, quests: src.today.quests.slice(0, MAX.quests).map((q) => ({ title: q.title, done: q.done })) } } : {}),
    ...(has('days')
      ? {
          days: src.days
            .filter((d) => d.tier <= c.tier)
            .slice(0, MAX.days)
            .map((d) => ({ day: d.day, text: firstPerson(d.text) })),
        }
      : {}),
    updated: now,
  };
}

// What a payload says, apart from when it was made: if that's the same, there's nothing to send.
export const bodyOf = (p: MePayload) => JSON.stringify({ ...p, updated: 0 });

// ---------- checking one that comes back

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const lines = (v: unknown, max: number) =>
  typeof v === 'string'
    ? v
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(100_000, Math.floor(v)) : 0);
const items = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');

// A payload as it came out of the cloud, rebuilt from what's allowed (and capped). Null if it
// isn't one.
export function cleanMe(raw: unknown): MePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.format !== FORMAT || !isTime(r.updated)) return null;
  const out: MePayload = {
    format: FORMAT,
    facts: items(r.facts, 200).flatMap((f) => {
      const text = line(f.text, 300);
      return text && isDay(f.since) ? [{ text, since: f.since }] : [];
    }),
    goals: items(r.goals, 30).flatMap((g) => {
      const title = line(g.title, 120);
      return title ? [{ title, why: line(g.why, 400), streak: count(g.streak) }] : [];
    }),
    updated: r.updated,
  };
  const name = line(r.name, 40);
  if (name) out.name = name;
  const about = lines(r.about, 3000);
  if (about) out.about = about;
  const t = r.today && typeof r.today === 'object' ? (r.today as Record<string, unknown>) : null;
  if (t && isDay(t.day)) out.today = { day: t.day, quests: items(t.quests, 50).flatMap((q) => (line(q.title, 120) ? [{ title: line(q.title, 120), done: q.done === true }] : [])) };
  if (Array.isArray(r.days)) out.days = items(r.days, 31).flatMap((d) => (isDay(d.day) && lines(d.text, 1500) ? [{ day: d.day, text: lines(d.text, 1500) }] : []));
  return out;
}

// ---------- the link

export const isMeHash = (hash: string) => /^#me=/.test(hash);
export const meLink = (site: string, ref: { id: string; key: string }) => `${site.split('#')[0]}#me=${ref.id}.${ref.key}`;
// The whole link, its #me= part, or just <id>.<key>.
export function parseMeLink(text: string): { id: string; key: string } | null {
  const m = /(?:^|#me=)([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(String(text || '').trim());
  return m ? { id: m[1], key: m[2] } : null;
}

// ---------- sealing it, within what the cloud keeps

const aad = (id: string) => `me/${id}`;

export class TooBig extends Error {
  code = 'too-big';
}

// The payload sealed with the link's key, trimmed until it fits in a page (firestore.rules): the
// oldest days go first, then the facts Arise is least sure of, then the About me text, today's
// quests and the last goals. Also returns what was sent, after any trimming.
export async function sealMe(ref: { id: string; key: string }, payload: MePayload): Promise<{ sealed: Sealed; payload: MePayload }> {
  const key = await linkKey(ref.key);
  let p: MePayload | null = payload;
  for (let i = 0; p && i < 200; i++) {
    const sealed = await seal(key, JSON.stringify(p), aad(ref.id));
    if (sealed.ct.length <= MAX_CT) return { sealed, payload: p };
    p = trimOnce(p);
  }
  throw new TooBig('This is too much to fit in a link. Pick less for this app.');
}

// What a page would hold of this payload once trimmed to fit (sealMe), and whether some was left
// out: what the Player is shown before an app gets it. Sealed with a key made for this and thrown
// away, only to measure.
export async function fitMe(payload: MePayload): Promise<{ payload: MePayload; trimmed: boolean }> {
  const { payload: fitted } = await sealMe(await newShareRef(), payload);
  return { payload: fitted, trimmed: fitted !== payload };
}

// A fifth of what goes first, or at least one.
const cut = <T>(list: T[]) => list.slice(0, list.length - Math.max(1, Math.ceil(list.length / 5)));
export function trimOnce(p: MePayload): MePayload | null {
  if (p.days?.length) return { ...p, days: cut(p.days) };
  if (p.facts.length) return { ...p, facts: cut(p.facts) };
  if (p.about) {
    const { about: _a, ...rest } = p;
    return rest;
  }
  if (p.today?.quests.length) return { ...p, today: { ...p.today, quests: cut(p.today.quests) } };
  if (p.goals.length) return { ...p, goals: cut(p.goals) };
  return null;
}

// Null when what's inside isn't a payload. Throws a CryptoError when it doesn't open with this
// key, or isn't this link's (a goal's page, or another link's put in its place).
export async function openMe(ref: { id: string; key: string }, sealed: Sealed): Promise<MePayload | null> {
  const text = await open(await linkKey(ref.key), sealed, aad(ref.id));
  try {
    return cleanMe(JSON.parse(text));
  } catch {
    return null;
  }
}
