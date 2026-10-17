// Arise as "me" for other apps, the parts that don't need the app: the words (an About me in the
// Player's voice), what goes in for each choice and tier, fitting a page in the cloud, and the
// round trip from sealing a payload to the reader app makers use (public/me.js).

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { FIREBASE } from '../firebase-config.js';
import { cloud, resetCloud, restFetch } from '../test/fake-firebase';
import { readMe, parseMeLink as readerParse, MeLinkError } from '../../public/me.js';
import * as C from './crypto';
import * as ME from './me';
import { newShareRef, sealSnapshot, MAX_CT, SHARE_OFF } from './share';
import { cleanAboutChoice, cleanMeLinks, cleanOffLater } from './validate';

const SRC: ME.MeSource = {
  name: 'Sam',
  goals: [
    { title: 'Run a half marathon', why: 'I want to feel strong at 40', streak: 12 },
    { title: 'Learn Spanish', why: '', streak: 0 },
  ],
  facts: [
    { text: 'You run on Sunday mornings.', since: '2026-09-02', tier: 1 },
    { text: 'You love jazz and old films.', since: '2026-09-10', tier: 2 },
    { text: 'Short check-ins help you keep going.', since: '2026-09-12', tier: 2 },
    { text: 'You live in Leeds with your partner.', since: '2026-08-01', tier: 2 },
    { text: 'You look up knee pain treatments most weeks.', since: '2026-10-01', tier: 3 },
  ],
  today: { day: '2026-10-17', quests: [{ title: 'Run 5 km', done: false }, { title: 'Stretch', done: true }] },
  days: [
    { day: '2026-10-16', text: 'You ran 8 km and called your sister.', tier: 3 },
    { day: '2026-10-15', text: 'You watched Dark and read in the evening.', tier: 2 },
  ],
};
const choice = (sections: ME.Section[], tier: 1 | 2 | 3 = 2): ME.MeChoice => ({ sections, tier });
const ALL = [...ME.SECTIONS];

// Text that doesn't compress, like a page full of different facts.
const noise = (n: number) => C.toB64(C.randomBytes(Math.ceil((n * 3) / 4))).slice(0, n);

describe('in the Player’s own voice', () => {
  it('turns what Arise says to them into what they say about themselves', () => {
    const cases: [string, string][] = [
      ['You run on Sunday mornings.', 'I run on Sunday mornings.'],
      ["You're training for your first race.", "I'm training for my first race."],
      ['Your sister calls you on Sundays.', 'My sister calls me on Sundays.'],
      ['Coffee helps you focus when you study.', 'Coffee helps me focus when I study.'],
      ['On weekends, you hike with Sam.', 'On weekends, I hike with Sam.'],
      ['You are a night owl.', 'I am a night owl.'],
      ["You aren't a fan of crowds.", "I'm not a fan of crowds."],
      ['You treat yourself after a long week.', 'I treat myself after a long week.'],
      ['The bike is yours, and you ride it daily.', 'The bike is mine, and I ride it daily.'],
      ['I wrote this one myself.', 'I wrote this one myself.'],
    ];
    for (const [from, to] of cases) expect(ME.firstPerson(from), from).toBe(to);
  });

  it('sorts facts into routines, likes, what helps and the rest', () => {
    expect(ME.sectionOf('You run every morning before work.')).toBe('routines');
    expect(ME.sectionOf('You love jazz.')).toBe('likes');
    expect(ME.sectionOf('You listen to podcasts on walks.')).toBe('likes');
    expect(ME.sectionOf('Short check-ins help you keep going.')).toBe('helps');
    expect(ME.sectionOf('You live in Leeds.')).toBe('other');
  });
});

describe('About me', () => {
  it('says who they are, what they work toward and what Arise knows, nothing sensitive by default', () => {
    const text = ME.aboutText(SRC, ME.ABOUT_DEFAULT);
    expect(text).toBe(
      [
        'My name is Sam.',
        "What I'm working toward:\n- Run a half marathon. Why: I want to feel strong at 40.\n- Learn Spanish.",
        'My routines:\n- I run on Sunday mornings.',
        'What I like:\n- I love jazz and old films.',
        'What helps me:\n- Short check-ins help me keep going.',
        'More about me:\n- I live in Leeds with my partner.',
      ].join('\n\n'),
    );
    expect(ME.ABOUT_DEFAULT.tier).toBe(2);
    expect(text).not.toContain('knee');
  });

  it('puts sensitive things in only when the Player asks, and leaves out what they unpick', () => {
    expect(ME.aboutText(SRC, choice(['routines'], 3))).toBe('My routines:\n- I run on Sunday mornings.\n- I look up knee pain treatments most weeks.');
    const goalsOnly = ME.aboutText(SRC, choice(['name', 'goals', 'routines', 'likes', 'helps', 'other'], 1));
    expect(goalsOnly).toContain('I run on Sunday mornings.'); // learned from quests: tier 1
    expect(goalsOnly).not.toContain('jazz');
    const noName = ME.aboutText(SRC, choice(['likes']));
    expect(noName).toBe('What I like:\n- I love jazz and old films.');
    expect(ME.aboutText(SRC, choice([]))).toBe('');
  });

  it('fits in an "about you" box, keeping the facts Arise is surest of', () => {
    const many: ME.MeSource = { ...SRC, facts: Array.from({ length: 80 }, (_, i) => ({ text: `You keep habit number ${i} going every day without fail.`, since: '2026-09-01', tier: 1 as const })) };
    const text = ME.aboutText(many, ME.ABOUT_DEFAULT);
    expect(text.length).toBeLessThanOrEqual(ME.ABOUT_MAX);
    expect(text).toContain('habit number 0 ');
    expect(text).not.toContain('habit number 79 ');
  });
});

describe('what an app gets', () => {
  it('holds only what was picked, in a small versioned format', () => {
    const p = ME.buildMe(SRC, ME.LINK_DEFAULT, 1000);
    for (const k of Object.keys(p)) expect(ME.PAYLOAD_FIELDS, k).toContain(k);
    expect(p.format).toBe('arise.me/v1');
    expect(p.name).toBe('Sam');
    expect(p.goals).toEqual([
      { title: 'Run a half marathon', why: 'I want to feel strong at 40', streak: 12 },
      { title: 'Learn Spanish', why: '', streak: 0 },
    ]);
    expect(p.facts).toEqual([
      { text: 'I run on Sunday mornings.', since: '2026-09-02' },
      { text: 'I love jazz and old films.', since: '2026-09-10' },
      { text: 'Short check-ins help me keep going.', since: '2026-09-12' },
      { text: 'I live in Leeds with my partner.', since: '2026-08-01' },
    ]);
    expect(p.about).toBe(ME.aboutText(SRC, ME.LINK_DEFAULT));
    expect(p).not.toHaveProperty('today');
    expect(p).not.toHaveProperty('days');
    expect(JSON.stringify(p)).not.toContain('knee');
    expect(p.updated).toBe(1000);
  });

  it("adds today's quests and the last days when picked, each day only within the tier", () => {
    const p = ME.buildMe(SRC, choice(['today', 'days']), 1);
    expect(p).toEqual({ format: 'arise.me/v1', facts: [], goals: [], today: SRC.today, days: [{ day: '2026-10-15', text: 'I watched Dark and read in the evening.' }], updated: 1 });
    expect(ME.buildMe(SRC, choice(['days'], 3), 1).days?.map((d) => d.day)).toEqual(['2026-10-16', '2026-10-15']);
    expect(ME.buildMe(SRC, choice(['likes'], 3), 1)).toEqual({ format: 'arise.me/v1', about: 'What I like:\n- I love jazz and old films.', facts: [{ text: 'I love jazz and old films.', since: '2026-09-10' }], goals: [], updated: 1 });
  });

  it('says in plain words what an app gets', () => {
    expect(ME.choiceText(ME.LINK_DEFAULT)).toBe('First name, goals, routines, likes, what helps you, other facts. No sensitive things.');
    expect(ME.choiceText(choice(['goals', 'days'], 3))).toBe('Goals, last 7 days. Sensitive things too.');
    expect(ME.choiceText(choice([], 1))).toBe('Nothing. Only what comes from your goals and quests.');
  });
});

describe('sealing and reading a me link', () => {
  beforeEach(() => resetCloud());

  const put = async (p: ME.MePayload) => {
    const ref = await newShareRef();
    const { sealed, payload } = await ME.sealMe(ref, p);
    cloud.docs.set(`shares/${ref.id}`, { owner: 'uid1', iv: sealed.iv, ct: sealed.ct, v: 1, updated: p.updated });
    return { ref, link: ME.meLink('https://abyyworld.github.io/physical-improvement-tracker-app/#today', ref), sealed, payload };
  };
  const read = (link: string) => readMe(link, { fetch: restFetch as typeof fetch, projectId: 'p', apiKey: 'k' });
  const stored = (id: string) => cloud.docs.get(`shares/${id}`) as unknown as C.Sealed;

  it('opens with the reader app makers use, exactly as sent', async () => {
    const p = ME.buildMe(SRC, choice(ALL, 3), 1_792_224_000_000);
    const { ref, link } = await put(p);
    expect(link).toBe(`https://abyyworld.github.io/physical-improvement-tracker-app/#me=${ref.id}.${ref.key}`);
    expect(await read(link)).toEqual(p);
    // The #me= part alone, or just the id and key, work too.
    expect(await read(`#me=${ref.id}.${ref.key}`)).toEqual(p);
    expect(await read(`  ${ref.id}.${ref.key}\n`)).toEqual(p);
    expect(readerParse(link)).toEqual(ME.parseMeLink(link));
    // And with the app's own check.
    expect(await ME.openMe(ref, stored(ref.id))).toEqual(p);
  });

  it('says why it can’t read one', async () => {
    const p = ME.buildMe(SRC, ME.LINK_DEFAULT, 1);
    const { ref, link } = await put(p);
    const code = (link: string) => read(link).then(
      () => 'read',
      (err: MeLinkError) => err.code,
    );
    expect(await code('https://abyyworld.github.io/physical-improvement-tracker-app/#me=short.key')).toBe('bad-link');
    // Another key: it doesn't open.
    const other = await newShareRef();
    expect(await code(`#me=${ref.id}.${other.key}`)).toBe('bad-data');
    // Never made, or turned off.
    expect(await code(`#me=${other.id}.${other.key}`)).toBe('off');
    cloud.docs.set(`shares/${ref.id}`, { ...SHARE_OFF });
    expect(await code(link)).toBe('off');
    // No connection.
    await expect(readMe(link, { fetch: (() => Promise.reject(new TypeError('offline'))) as typeof fetch })).rejects.toMatchObject({ code: 'network' });
  });

  it("never opens a shared goal's page as a me link, or a me link as a goal", async () => {
    const goal = await newShareRef();
    const sealed = await sealSnapshot(goal, { v: 1, title: 'Hi', area: 'Fitness', status: 'active', streak: 1, quests: [], from: '2026-10-17', days: 't', measures: [], milestones: [], milestonesOf: 0, updated: 1 });
    cloud.docs.set(`shares/${goal.id}`, { owner: 'uid1', iv: sealed.iv, ct: sealed.ct, v: 1, updated: 1 });
    await expect(read(`#me=${goal.id}.${goal.key}`)).rejects.toMatchObject({ code: 'bad-data' });
    const { ref } = await put(ME.buildMe(SRC, ME.LINK_DEFAULT, 1));
    await expect(C.open(await C.linkKey(ref.key), stored(ref.id), `share/${ref.id}`)).rejects.toThrow();
  });

  it('fits the page the cloud keeps: the oldest days go first, then the facts Arise is least sure of', async () => {
    const big: ME.MeSource = {
      ...SRC,
      facts: Array.from({ length: 100 }, (_, i) => ({ text: `You ${i} ${noise(220)}`, since: '2026-09-01', tier: 1 as const })),
      days: Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(16 - i).padStart(2, '0')}`, text: noise(1400), tier: 1 as const })),
    };
    const full = ME.buildMe(big, choice(ALL, 3), 5);
    expect(full.facts).toHaveLength(100);
    const { ref, sealed, payload } = await put(full);
    expect(sealed.ct.length).toBeLessThanOrEqual(MAX_CT);
    expect(payload.days).toEqual([]);
    expect(payload.facts.length).toBeGreaterThan(20);
    expect(payload.facts.length).toBeLessThan(100);
    expect(payload.facts).toEqual(full.facts.slice(0, payload.facts.length)); // the best ones stay
    expect(payload.goals).toEqual(full.goals);
    expect(await read(`#me=${ref.id}.${ref.key}`)).toEqual(payload);
    // A little over: only some of the days go.
    const some = ME.buildMe({ ...SRC, days: big.days.map((d) => ({ ...d, text: noise(1490) })) }, choice(ALL, 3), 5);
    const fit = await ME.sealMe(ref, { ...some, about: noise(3000), facts: big.facts.slice(0, 50).map((f) => ({ text: f.text, since: f.since })) });
    expect(fit.sealed.ct.length).toBeLessThanOrEqual(MAX_CT);
    expect(fit.payload.facts).toHaveLength(50);
    expect(fit.payload.days!.length).toBeGreaterThan(0);
    expect(fit.payload.days!.length).toBeLessThan(7);
    expect(fit.payload.days).toEqual(some.days!.slice(0, fit.payload.days!.length)); // newest first, so the oldest went
  });

  it('cleans what comes back to what the format allows', () => {
    const raw = { ...ME.buildMe(SRC, choice(ALL, 3), 9), extra: 'x', facts: [{ text: 'ok', since: '2026-01-01', tier: 3 }, { text: '', since: '2026-01-01' }, { text: 'no date' }] };
    const c = ME.cleanMe(raw)!;
    expect(c).not.toHaveProperty('extra');
    expect(c.facts).toEqual([{ text: 'ok', since: '2026-01-01' }]);
    expect(ME.cleanMe({ ...raw, format: 'arise.me/v2' })).toBeNull();
  });
});

describe("this device's storage", () => {
  const ref = { id: 'a'.repeat(22), key: 'b'.repeat(43) };
  it('keeps only whole links, with a choice that has nothing sensitive unless picked', () => {
    const links = cleanMeLinks([
      { ...ref, app: '  My   buddy\u0000 app ', at: 5, choice: { sections: ['goals', 'nope'], tier: 9 }, sig: 'x', sent: 6 },
      { ...ref, app: 'Twice', at: 5 },
      { id: 'short', key: ref.key, app: 'Bad', at: 5 },
      { id: 'c'.repeat(22), key: ref.key, at: 5 },
      'junk',
    ]);
    expect(links).toEqual([
      { ...ref, app: 'My buddy app', at: 5, choice: { sections: ['goals'], tier: 2 }, sig: 'x', sent: 6 },
      { id: 'c'.repeat(22), key: ref.key, app: 'An app', at: 5, choice: ME.LINK_DEFAULT },
    ]);
    expect(cleanMeLinks([{ ...ref, at: 5, owner: 'uid1' }, { id: 'c'.repeat(22), key: ref.key, at: 5, owner: 'no way' }]).map((l) => l.owner)).toEqual(['uid1', undefined]);
    expect(cleanAboutChoice(null)).toEqual(ME.ABOUT_DEFAULT);
    expect(cleanAboutChoice({ sections: ['days', 'name'], tier: 3 })).toEqual({ sections: ['name', 'days'], tier: 3 });
  });
});

describe('pages still to turn off', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(22));
  it('keeps whose each is, once known, and one entry each, the latest last', () => {
    expect(cleanOffLater([a, { id: b, owner: 'uid1' }, { id: a, owner: 'uid2' }, { id: b }, { id: 'short', owner: 'uid1' }, { id: c, owner: '<b>' }, 7, null])).toEqual([
      { id: a, owner: 'uid2' },
      { id: b, owner: 'uid1' },
      { id: c, owner: '' },
    ]);
    expect(cleanOffLater('junk')).toEqual([]);
  });
});

describe('the reader app makers load (public/me.js)', () => {
  const source = readFileSync(new URL('../../public/me.js', import.meta.url), 'utf8');

  it('needs nothing else, and reads the cloud the app writes to', () => {
    expect(source).not.toMatch(/^\s*(import|export \* from|export \{[^}]*\} from)\s/m);
    expect(source).toContain(`projectId: '${FIREBASE!.projectId}'`);
    expect(source).toContain(`apiKey: '${FIREBASE!.apiKey}'`);
    expect(source).toContain('`me/${ref.id}`'); // what the app seals each page for
  });
});
