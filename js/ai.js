// Claude inside the app: "the System", the AI coach.
//
// Uses Anthropic's official JavaScript SDK (bundled in vendor/anthropic-sdk.mjs) and only loads it
// when an AI feature is used. Your API key is stored on this device only (never in backups) and
// requests go straight from this device to Anthropic.

import { EXERCISES } from './program.js';
import * as S from './store.js';

export const MODEL = 'claude-opus-5-5';
export const MODEL_LABEL = 'Claude Opus 5.5';
// If a request is declined by a safety classifier, the API retries it on the model Anthropic
// recommends for that case instead of returning the refusal.
const BETAS = ['server-side-fallback-2026-07-01'];
const KEY_STORE = 'arise-claude-key';
// USD per million tokens (Claude Opus 5.5), used for the running cost estimate in Settings.
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export class AIError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- key + client

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
}

export function setKey(key) {
  try {
    if (key && key.trim()) localStorage.setItem(KEY_STORE, key.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch {}
  client = null;
}

export const hasKey = () => !!getKey();

let sdk = null;
let client = null;
let clientKey = '';

async function getClient() {
  const key = getKey();
  if (!key) throw new AIError('no-key', 'Connect Claude in Settings first.');
  if (!sdk) {
    try {
      sdk = await import('../vendor/anthropic-sdk.mjs');
    } catch {
      throw new AIError('offline', 'Could not load the AI module. Check your internet connection and reopen the app.');
    }
  }
  if (!client || clientKey !== key) {
    client = new sdk.Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

// Turn SDK errors into short, human messages. Most specific classes first.
function friendly(err) {
  if (err instanceof AIError) return err;
  const A = sdk?.Anthropic;
  if (A) {
    if (err instanceof A.AuthenticationError) return new AIError('auth', 'Claude rejected the API key. Check it in Settings.');
    if (err instanceof A.PermissionDeniedError) return new AIError('permission', `This API key can't use ${MODEL_LABEL}.`);
    if (err instanceof A.RateLimitError) return new AIError('rate', 'Too many requests right now. Try again in a minute.');
    if (err instanceof A.BadRequestError) return new AIError('bad-request', `Claude couldn't take that request: ${err.message}`);
    if (err instanceof A.NotFoundError) return new AIError('not-found', `${MODEL_LABEL} isn't available for this API key.`);
    if (err instanceof A.APIUserAbortError) return new AIError('aborted', 'Stopped.');
    if (err instanceof A.APIConnectionError) return new AIError('offline', "Couldn't reach Claude. Check your internet connection.");
    if (err instanceof A.APIError) return new AIError('server', `Claude is having trouble right now${err.status ? ` (${err.status})` : ''}. Try again soon.`);
  }
  return new AIError('unknown', err?.message || 'Something went wrong.');
}

function track(message) {
  const u = message?.usage;
  if (!u) return;
  const a = S.state.ai.usage;
  a.input += u.input_tokens || 0;
  a.output += u.output_tokens || 0;
  a.cacheWrite += u.cache_creation_input_tokens || 0;
  a.cacheRead += u.cache_read_input_tokens || 0;
  a.calls += 1;
  S.save();
}

export function usageCost() {
  const u = S.state.ai.usage;
  return (u.input * PRICE.input + u.output * PRICE.output + u.cacheWrite * PRICE.cacheWrite + u.cacheRead * PRICE.cacheRead) / 1e6;
}

function checkStop(message) {
  if (message.stop_reason === 'refusal') throw new AIError('refusal', 'Claude declined to answer that one. Try asking in a different way.');
}

// Nothing the Player reads should contain long dashes: they read as machine-written.
export function plain(text) {
  return String(text ?? '')
    .replace(/^([ \t]*)[\u2014\u2013][ \t]*/gm, '$1- ')
    .replace(/(\d)[ \t]*[\u2013\u2014][ \t]*(\d)/g, '$1-$2')
    .replace(/[ \t]*\u2014[ \t]*/g, ', ')
    .replace(/[ \t]+\u2013[ \t]+/g, ', ')
    .replace(/[\u2013\u2014]/g, '-');
}

const textOf = (message) =>
  message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

// ---------- prompts

const LIBRARY = Object.entries(EXERCISES)
  .map(([id, ex]) => `- ${id}: ${ex.name} (${ex.kind === 'big' ? 'big exercise' : 'band/core'}${ex.timed ? ', timed hold in seconds' : ''}). Harder: ${ex.harder}`)
  .join('\n');

// Kept byte-for-byte stable so it can be cached between requests.
const SYSTEM = `You are "the System", the AI coach inside Arise, a daily physical-improvement app styled after the System in Solo Leveling. The person using it is the Player. Your job is to help them lock in every single day, reach their long-term goal, and stay consistent wherever they are: at home, travelling, or in a chaotic week.

Action over talk
- This app exists to make the Player do the work, every day, for years. Talking is never the goal. If today's quest is not done and it is not a rest day, steer them to start it (or the smallest version of it) before anything else.
- Keep replies short: about 120 words at most, unless they ask for a review or a plan. No long essays, no repeating what they said.
- End every reply with one line that starts with "**Next action:**", naming one concrete thing they can do today, ideally within the next hour.
- If they are clearly procrastinating by chatting, say so kindly and send them to the quest.

How you talk
- Calm, direct and motivating, with a light touch of the System's voice ("[Quest]", "Level up", "Player") but always human underneath. Follow the tone the Player chose in their profile.
- Many ambitious people using this app have ADHD or get distracted easily. Keep answers concrete and lead with the single next action. Use short paragraphs, and bullets only when they help.
- Be honest. Don't flatter. Point out the patterns you see in their data, including uncomfortable ones, then give a clear way forward.
- Use only facts from the context below. If something isn't in the data, say you don't know. Quote real numbers (reps, dates, streaks) when they help.
- If the Player mentions faith (for example Islam), respect it; use it for encouragement only if their chosen tone includes it, and never preach.
- Write like a real coach texting the Player: plain everyday words, short sentences, contractions are fine. Never use em dashes or en dashes; use a comma, a full stop or the word "to" instead. No filler like "Great question", "Let's dive in", "Here's the thing" or "I hope this helps", and don't open with praise.
- Format with simple Markdown only: **bold**, short bullet or numbered lists. No tables, no headings, no links.

Safety
- You are not a doctor. For pain, injury, dizziness, or eating or sleep problems that sound serious, tell them to stop that exercise and see a professional. Never tell them to push through sharp pain.
- Progress gradually: add reps first, then load (backpack weight, thicker band), then the next variation, exactly as the rules say.
- If they mention self-harm or not wanting to live, respond with care and urge them to contact someone they trust, local emergency services or a crisis line right away.

The app
- Home workouts that need only a pull-up bar (a doorway bar like the Iron Gym works), resistance bands with a door anchor, a backpack with weight in it, a bed, a chair and a step.
- Two kinds of plan: a rotation (the default is A/B: sessions done in order, A, B, A, B…, on any day, with a weekly target of 4-6 sessions and the rest as rest days the Player logs) or a weekly split with fixed weekdays. The current plan, its rules and the weekly target are in the context.
- On a football day, if the next session is a legs session, the Player does the next upper-body session instead and the legs session stays next. The default C session trains acceleration, top speed, hamstrings (Nordic curls) and groin (Copenhagen planks) for football.
- The Player may be in a bulk, a cut or maintenance, and logs weigh-ins (weight, waist, shoulders). Training stays the same across phases; food decides the direction. Targets: bulk +0.25-0.5% of bodyweight a week, cut -0.5-1% a week, protein about 1.6-2.2 g per kg a day. Shoulders divided by waist is their V-taper number.
- Players earn XP for sets, workouts, football, weigh-ins and daily log entries. Levels rise with XP; ranks go E, D, C, B, A, S.
- Exercise library (id: name):
${LIBRARY}`;

function systemBlocks(context) {
  return [
    { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
  ];
}

function slotText(sl) {
  let r = sl.amrap ? 'max reps' : sl.min === sl.max ? `${sl.min}` : `${sl.min}-${sl.max}`;
  if (sl.unit && sl.unit !== 'reps') r += ` ${sl.unit}`;
  if (sl.perLeg) r += ' per leg';
  return `${sl.sets}x${r}`;
}

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);

// Everything the coach knows, as compact text. Recent weeks in detail; older history by month.
export function buildContext({ full = false } = {}) {
  const st = S.state;
  const k = S.todayKey();
  const out = [];
  const dateText = S.parseKey(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const planned = S.plannedFor(k);
  const sug = S.suggestedFor(k);
  const w = S.workouts();

  out.push('# Player data from the app (up to date)');
  out.push(`Today is ${dateText} (${k}), training week ${S.programWeek(k)}.`);
  out.push(
    `Today's quest: ${planned === 'rest' ? 'rest day' : w[planned].name}${sug !== planned ? ` (switched to ${w[sug].name} because they played football)` : ''}${S.planMode() === 'rotation' && planned !== 'rest' && S.isFootball(k) ? ' (leg exercises skipped because they played football)' : ''}. ` +
      `Done today: ${S.sessionsOn(k).map((s) => S.workoutName(s.workout, s)).join(', ') || 'nothing yet'}. ` +
      `Football today: ${S.isFootball(k) ? 'yes' : 'no'}. Easy week: ${S.isEasy(k) ? 'yes' : 'no'}.`,
  );

  const p = st.profile;
  out.push('', '## Profile');
  if (!p) out.push('The Player has not filled in their profile yet.');
  else {
    out.push(`Name: ${p.name || st.settings.name || 'not given'}`);
    out.push(`Long-term goal: ${p.goal || 'not given'}${p.deadline ? ` (by: ${p.deadline})` : ''}`);
    if (p.why) out.push(`Why it matters: ${p.why}`);
    const start = [p.pullups != null ? `${p.pullups} pull-ups` : '', p.pushups != null ? `${p.pushups} push-ups` : '', p.pistol ? `pistol squat: ${p.pistol}` : ''].filter(Boolean);
    if (start.length) out.push(`Starting point: ${start.join(', ')}`);
    if (p.equipment?.length) out.push(`Equipment: ${p.equipment.join(', ')}`);
    if (p.time) out.push(`Prefers training: ${p.time}`);
    if (p.travel) out.push(`Travels: ${p.travel}`);
    if (p.obstacles?.length || p.obstaclesNote) out.push(`What gets in the way: ${[...(p.obstacles || []), p.obstaclesNote].filter(Boolean).join('; ')}`);
    if (p.tone?.length) out.push(`Preferred tone: ${p.tone.join(', ')}`);
  }

  const L = S.levelInfo();
  const stt = S.stats();
  const cons = S.consistency();
  out.push('', '## Status');
  out.push(`Level ${L.level}, rank ${L.rank} (${L.title}), ${L.xp} XP. STR ${stt.str}, AGI ${stt.agi}, VIT ${stt.vit}.`);
  out.push(
    `Current streak ${S.currentStreak()} days (best ${S.bestStreak()}). ${cons == null ? 'No training yet.' : `Training days done in the last 4 weeks: ${cons}%.`} ` +
      `Total workouts: ${st.sessions.length}. Football days: ${st.football.length}.`,
  );

  const rot = S.planMode() === 'rotation';
  out.push('', `## Current plan (${S.isCustomPlan() ? 'personalised by the System' : rot ? 'A/B rotation template' : 'original weekly split'})`);
  if (rot) {
    out.push(`Type: rotation, done in this order on any day: ${S.workoutOrder().map((id) => `${w[id].name} [${id}]`).join(' → ')}, then repeat.`);
    out.push(`Weekly target: ${S.perWeek()} sessions and up to ${S.restAllowance()} rest days. This week so far: ${S.weekSummary(k).done} sessions, ${S.restsUsed(k)} rest days. Next session: ${w[S.nextWorkout()].name}.`);
  } else {
    out.push(`Type: weekly split. ${S.week().map((id, i) => `${DAYS[i]}: ${id === 'rest' || !w[id] ? 'rest' : `${w[id].name} [${id}]`}`).join(' | ')}`);
  }
  out.push(`Rules: ${S.planRules().map((r, i) => `(${i + 1}) ${r}`).join(' ')}`);
  for (const id of S.workoutOrder()) {
    out.push(`${w[id].name} [${id}]: ${w[id].slots.map((sl) => `${EXERCISES[sl.ex].name} ${slotText(sl)}${sl.note ? ` (${sl.note})` : ''}`).join('; ')}`);
  }

  // Recent 4 weeks in detail.
  const from = S.addDays(k, -27);
  const recent = st.sessions.filter((s) => s.date >= from).reverse();
  out.push('', '## Workouts in the last 4 weeks (newest first; numbers are reps or seconds per set)');
  if (!recent.length) out.push('None.');
  for (const s of recent) {
    const mins = Math.max(1, Math.round((s.finished - s.started) / 60000));
    const items = s.items
      .filter((it) => it.sets.length)
      .map((it) => `${EXERCISES[it.ex]?.name || it.ex} ${it.sets.map((x) => x.r).join('/')}${it.setup ? ` [${it.setup}]` : ''}`)
      .join('; ');
    out.push(`${s.date} ${S.workoutName(s.workout, s)} (${mins} min${s.easy ? ', easy week' : ''}): ${items}`);
  }
  const first = S.firstDay();
  const missed = [];
  for (let d = first && first > from ? first : from; first && d < k; d = S.addDays(d, 1)) {
    if (!S.covered(d)) missed.push(d);
  }
  out.push(`Missed days in the last 4 weeks (no workout, football or rest day logged): ${missed.length ? missed.join(', ') : 'none'}.`);
  const restRecent = st.rests.filter((d) => d >= from);
  if (rot && restRecent.length) out.push(`Rest days taken in the last 4 weeks: ${restRecent.join(', ')}.`);
  const fbRecent = st.football.filter((d) => d >= from);
  if (fbRecent.length) out.push(`Football in the last 4 weeks: ${fbRecent.join(', ')}.`);

  // Per-exercise trend, all time.
  const trends = S.exercisesWithData().map((id) => {
    const h = S.exerciseHistory(id);
    const firstE = h[0];
    const lastE = h[h.length - 1];
    const best = h.reduce((b, e) => Math.max(b, S.itemTotal(e.item)), 0);
    return `${EXERCISES[id].name}: ${h.length} times; first ${firstE.session.date} total ${S.itemTotal(firstE.item)}${firstE.item.setup ? ` [${firstE.item.setup}]` : ''}; latest ${lastE.session.date} total ${S.itemTotal(lastE.item)}${lastE.item.setup ? ` [${lastE.item.setup}]` : ''}; best total ${best}`;
  });
  if (trends.length) out.push('', '## Exercise trends (all time, totals per workout)', ...trends);

  // Older history, one line per month.
  const older = st.sessions.filter((s) => s.date < from);
  if (older.length || st.football.some((d) => d < from)) {
    out.push('', '## Older history by month');
    const months = new Map();
    const bump = (m, key) => {
      if (!months.has(m)) months.set(m, { workouts: 0, sets: 0, football: 0, energy: [] });
      months.get(m)[key]++;
    };
    for (const s of older) {
      bump(s.date.slice(0, 7), 'workouts');
      months.get(s.date.slice(0, 7)).sets += s.items.reduce((n, it) => n + it.sets.length, 0);
    }
    for (const d of st.football) if (d < from) bump(d.slice(0, 7), 'football');
    for (const [d, l] of Object.entries(st.logs)) {
      if (d < from && l.e) {
        if (!months.has(d.slice(0, 7))) months.set(d.slice(0, 7), { workouts: 0, sets: 0, football: 0, energy: [] });
        months.get(d.slice(0, 7)).energy.push(l.e);
      }
    }
    for (const [m, v] of [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const avg = v.energy.length ? (v.energy.reduce((a, b) => a + b, 0) / v.energy.length).toFixed(1) : null;
      out.push(`${m}: ${v.workouts} workouts, ${v.sets} sets, ${v.football} football days${avg ? `, average energy ${avg}/5` : ''}`);
    }
  }

  // Body.
  const b = st.body;
  const bs = S.bodyStats(k);
  if (b.phase || b.entries.length) {
    out.push('', '## Body');
    out.push(`Phase: ${b.phase ? `${S.PHASES[b.phase].label} since ${b.phaseSince}` : 'not set'}.`);
    if (bs.last) {
      out.push(
        `Latest: weight ${bs.weight ?? '?'} kg, waist ${bs.waist ?? '?'} cm, shoulders ${bs.shoulders ?? '?'} cm, V-taper ratio ${bs.ratio ?? '?'}. ` +
          `Trend: ${bs.ratePerWeek != null ? `${bs.ratePerWeek} kg/week (${bs.ratePct}%/week)` : 'not enough weigh-ins yet'}${bs.verdict ? `, which is ${bs.verdict === 'ok' ? 'on target' : bs.verdict === 'fast' ? 'above the target range' : 'below the target range'}` : ''}.`,
      );
      out.push(`Weigh-ins (oldest first): ${b.entries.slice(-12).map((e) => `${e.date} ${[e.weight != null ? `${e.weight}kg` : '', e.waist != null ? `waist ${e.waist}` : '', e.shoulders != null ? `shoulders ${e.shoulders}` : ''].filter(Boolean).join(' ')}`).join('; ')}`);
    }
  }

  // Daily log.
  const logs = Object.entries(st.logs)
    .filter(([, l]) => l.e || (l.t && l.t.trim()))
    .sort(([a], [b]) => (a < b ? 1 : -1));
  const limit = full ? logs.length : 45;
  const perEntry = full ? 2000 : 700;
  out.push('', `## Daily log (${full ? 'every entry' : `latest ${Math.min(limit, logs.length)} of ${logs.length}`}, newest first)`);
  if (!logs.length) out.push('No entries yet.');
  let chars = 0;
  let shown = 0;
  for (const [d, l] of logs.slice(0, limit)) {
    const line = `${d}${l.e ? ` energy ${l.e}/5` : ''}: ${l.t && l.t.trim() ? clip(l.t.trim().replace(/\s+/g, ' '), perEntry) : '(no notes)'}`;
    if (chars + line.length > 400000) break; // keeps a years-long journal inside one request
    out.push(line);
    chars += line.length;
    shown++;
  }
  if (shown < logs.length) out.push(`(${logs.length - shown} older entries not included here; their energy is summarised by month above.)`);
  return out.join('\n');
}

// ---------- features

const BRIEFING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'focus'],
  properties: {
    message: { type: 'string', description: "2-3 short sentences in the System's voice, personal to the Player and grounded in their data." },
    focus: { type: 'string', description: 'One concrete action or cue for today, at most 15 words.' },
  },
};

// Today's personal System message. Cached per day.
export async function dailyBriefing({ force = false } = {}) {
  const k = S.todayKey();
  const cached = S.state.ai.daily[k];
  if (cached && !force) return cached;
  const c = await getClient();
  try {
    const msg = await c.beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      betas: BETAS,
      fallbacks: 'default',
      output_config: { effort: 'low', format: sdk.jsonSchemaOutputFormat(BRIEFING_SCHEMA) },
      system: systemBlocks(buildContext()),
      messages: [
        {
          role: 'user',
          content:
            "Write today's System message for the top of the Today screen. Speak to me directly. Mention something real from my data (streak, a missed day, an exercise that is improving, my energy, my goal). If today is a rest day, make it about recovery. Make it different from a generic pep talk.",
        },
      ],
    });
    track(msg);
    checkStop(msg);
    const out = msg.parsed_output;
    if (!out || typeof out.message !== 'string') throw new AIError('format', 'Claude sent an unexpected answer. Try again.');
    const entry = { message: plain(out.message).trim(), focus: plain(out.focus || '').trim(), at: Date.now() };
    S.state.ai.daily[k] = entry;
    for (const d of Object.keys(S.state.ai.daily)) if (d < S.addDays(k, -30)) delete S.state.ai.daily[d];
    S.save();
    return entry;
  } catch (err) {
    throw friendly(err);
  }
}

// Stream a text answer. onText receives the full text so far.
async function streamText({ context, messages, effort, onText, signal }) {
  const c = await getClient();
  try {
    const stream = c.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        betas: BETAS,
        fallbacks: 'default',
        output_config: { effort },
        system: systemBlocks(context),
        messages,
      },
      { signal },
    );
    let text = '';
    stream.on('text', (delta) => {
      text += delta;
      onText?.(plain(text));
    });
    const msg = await stream.finalMessage();
    track(msg);
    checkStop(msg);
    return plain(textOf(msg) || text).trim();
  } catch (err) {
    throw friendly(err);
  }
}

// A short reflection on one day's log entry, saved with the entry.
export async function reflect(k, { onText, signal } = {}) {
  const log = S.state.logs[k] || {};
  const entry = `${log.e ? `Energy ${log.e}/5. ` : ''}${log.t && log.t.trim() ? log.t.trim() : '(no notes written)'}`;
  const text = await streamText({
    context: buildContext(),
    effort: 'low',
    onText,
    signal,
    messages: [
      {
        role: 'user',
        content: `Here is my daily log for ${k}:\n"""\n${entry}\n"""\nReflect on it in 2-4 short sentences: one thing you notice (connect it to my recent data if you can), one concrete suggestion for tomorrow, and optionally one short question for me. Don't repeat my words back to me.`,
      },
    ],
  });
  S.setLog(k, { ai: text });
  return text;
}

const CHAT_KEEP = 30; // messages sent with each chat request

// Coach chat. The conversation lives in S.state.ai.chat.
export async function chat(userText, { full = false, onText, signal } = {}) {
  const log = S.state.ai.chat;
  log.push({ role: 'user', text: userText, at: Date.now() });
  S.save();
  // Failed replies stay on screen but are never sent back to Claude.
  let history = log
    .filter((m) => !m.error)
    .slice(-CHAT_KEEP)
    .map((m) => ({ role: m.role, content: m.text }));
  while (history.length && history[0].role !== 'user') history = history.slice(1);
  // Cache the conversation so far, so follow-up questions are cheaper.
  const last = history[history.length - 1];
  history[history.length - 1] = { role: 'user', content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }] };
  try {
    const text = await streamText({ context: buildContext({ full }), effort: full ? 'high' : 'medium', messages: history, onText, signal });
    log.push({ role: 'assistant', text, at: Date.now() });
    if (log.length > 200) log.splice(0, log.length - 200);
    S.save();
    return text;
  } catch (err) {
    // Keep the question so it can be retried, but mark that no answer came back.
    log.push({ role: 'assistant', text: `⚠️ ${err.message}`, error: true, at: Date.now() });
    S.save();
    throw err;
  }
}

export function clearChat() {
  S.state.ai.chat = [];
  S.save();
}

// ---------- personalised plan

const EX_IDS = Object.keys(EXERCISES);

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'changes', 'mode', 'order', 'perWeek', 'week', 'workouts'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences explaining the plan and why it fits this Player.' },
    changes: { type: 'array', items: { type: 'string' }, description: 'Short bullet points: what changed compared to the current plan, and why. Empty if nothing changed.' },
    mode: { type: 'string', enum: ['rotation', 'week'], description: 'rotation = sessions done in order on any day; week = fixed weekdays.' },
    order: { type: 'array', items: { type: 'string' }, description: 'For a rotation: the workout ids in the order they are done, e.g. ["a","b"]. For a weekly split: all workout ids.' },
    perWeek: { type: 'integer', description: 'For a rotation: sessions per week, 3 to 6. For a weekly split: the number of training days.' },
    week: {
      type: 'array',
      items: { type: 'string' },
      description: 'For a weekly split: exactly 7 entries, Monday to Sunday, each a workout id or "rest". For a rotation: an empty array.',
    },
    workouts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'tag', 'legs', 'slots'],
        properties: {
          id: { type: 'string', description: 'Short lowercase id with letters, digits or underscores, e.g. a, b, travel, back, push.' },
          name: { type: 'string', description: 'Display name, e.g. "A · Pull & hinge" or "Back & width".' },
          tag: { type: 'string', description: 'A few words describing the session.' },
          legs: { type: 'boolean', description: 'True if this is a leg-focused session (skipped on football days).' },
          slots: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['ex', 'sets', 'min', 'max', 'amrap', 'perLeg', 'unit', 'note'],
              properties: {
                ex: { type: 'string', enum: EX_IDS },
                sets: { type: 'integer', description: 'Number of sets, 1 to 6.' },
                min: { type: 'integer', description: 'Bottom of the rep range (or seconds for timed holds). Use 0 when amrap is true.' },
                max: { type: 'integer', description: 'Top of the rep range (or seconds). Use 0 when amrap is true.' },
                amrap: { type: 'boolean', description: 'True for "as many reps as possible" sets.' },
                perLeg: { type: 'boolean' },
                unit: { type: 'string', enum: ['reps', 'sec', 'sprints'] },
                note: { type: 'string', description: 'Short setup cue, or an empty string.' },
              },
            },
          },
        },
      },
    },
  },
};

const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// Check and clean up a plan from Claude so the app can always use it safely.
export function normalizePlan(raw) {
  if (!raw || !Array.isArray(raw.workouts) || !Array.isArray(raw.week)) throw new AIError('format', 'Claude sent a plan the app could not read. Try again.');
  const workouts = {};
  const idMap = {};
  for (const wk of raw.workouts.slice(0, 8)) {
    if (!wk || !Array.isArray(wk.slots)) continue;
    const slots = [];
    for (const sl of wk.slots.slice(0, 10)) {
      const ex = EXERCISES[sl?.ex];
      if (!ex) continue;
      const unit = ex.timed ? 'sec' : ex.unit || 'reps';
      const amrap = !!sl.amrap && unit === 'reps';
      const slot = { ex: sl.ex, sets: int(sl.sets, 1, 6, 3) };
      if (amrap) slot.amrap = true;
      else {
        const hi = unit === 'sec' ? 180 : 100;
        slot.min = int(sl.min, 1, hi, unit === 'sec' ? 30 : 8);
        slot.max = int(sl.max, slot.min, hi, slot.min);
      }
      if (unit !== 'reps') slot.unit = unit;
      if (sl.perLeg) slot.perLeg = true;
      const note = plain(sl.note || '').trim().slice(0, 120);
      if (note) slot.note = note;
      slots.push(slot);
    }
    if (!slots.length) continue;
    let id = String(wk.id || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'session';
    const base = id;
    for (let n = 2; workouts[id]; n++) id = `${base}_${n}`;
    idMap[wk.id] = id;
    const name = plain(wk.name || '').trim().slice(0, 40) || 'Session';
    workouts[id] = { name, short: name.split(/[\s,&]+/)[0], tag: plain(wk.tag || '').trim().slice(0, 60), legs: !!wk.legs, slots };
  }
  if (!Object.keys(workouts).length) throw new AIError('format', 'Claude sent a plan with no usable exercises. Try again.');
  const resolve = (v) => {
    const id = idMap[v] ?? (workouts[v] ? v : null);
    return id && workouts[id] ? id : null;
  };
  const extra = {};
  if (raw.mode === 'rotation') {
    const order = [...new Set((Array.isArray(raw.order) ? raw.order : []).map(resolve).filter(Boolean))];
    extra.mode = 'rotation';
    extra.order = order.length ? order : Object.keys(workouts);
    extra.perWeek = int(raw.perWeek, 3, 6, 5);
  } else {
    const week = Array.from({ length: 7 }, (_, i) => (raw.week?.[i] === 'rest' ? 'rest' : resolve(raw.week?.[i]) || 'rest'));
    if (!week.some((d) => d !== 'rest')) throw new AIError('format', 'Claude sent a plan with no training days. Try again.');
    extra.mode = 'week';
    extra.week = week;
    extra.order = Object.keys(workouts);
  }
  return {
    workouts,
    ...extra,
    summary: plain(raw.summary || '').trim().slice(0, 800),
    changes: Array.isArray(raw.changes) ? raw.changes.map((c) => plain(c).trim().slice(0, 240)).filter(Boolean).slice(0, 12) : [],
  };
}

// Ask Claude for a personalised plan. Nothing changes until the Player applies it.
export async function proposePlan(request) {
  const c = await getClient();
  try {
    const msg = await c.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: BETAS,
      fallbacks: 'default',
      output_config: { effort: 'high', format: sdk.jsonSchemaOutputFormat(PLAN_SCHEMA) },
      system: systemBlocks(buildContext()),
      messages: [
        {
          role: 'user',
          content: `Design my weekly training plan.\nWhat I want: ${request && request.trim() ? request.trim() : 'Personalise the plan to my goal, starting level, equipment and schedule.'}\n\nRules for the plan:\n- Use only exercises from the library (by id). Keep the plan doable at home with my equipment.\n- Keep what already works: change the current plan only where my goal, data or request gives a clear reason, and explain each change.\n- Keep the current plan type (rotation or weekly split) unless I asked to change it. A rotation needs 4 to 6 sessions a week; a weekly split needs at least 1 rest day.\n- Keep the existing workout ids for sessions that stay similar, so my history lines up.\n- Every session should train the lats and side delts (the V-taper) unless I asked otherwise.\n- Rep ranges should end each set with 1-2 reps left in the tank. Timed holds (unit "sec") only for timed exercises.`,
        },
      ],
    });
    track(msg);
    checkStop(msg);
    if (msg.stop_reason === 'max_tokens') throw new AIError('format', 'The plan was cut off. Try again.');
    return normalizePlan(msg.parsed_output);
  } catch (err) {
    throw friendly(err);
  }
}

// ---------- personalised reminder texts

const NUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messages'],
  properties: { messages: { type: 'array', items: { type: 'string' } } },
};

export async function writeReminders() {
  const c = await getClient();
  try {
    const msg = await c.beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: BETAS,
      fallbacks: 'default',
      output_config: { effort: 'low', format: sdk.jsonSchemaOutputFormat(NUDGE_SCHEMA) },
      system: systemBlocks(buildContext()),
      messages: [
        {
          role: 'user',
          content:
            'Write 40 different phone notification texts that remind me to do my daily quest. Each under 90 characters, in the System voice and my chosen tone, tied to my goal and what gets in my way. Vary them a lot: some short commands, some about my goal, some about streaks, some calm. Use {quest} where the name of that day\'s workout should go in about half of them.',
        },
      ],
    });
    track(msg);
    checkStop(msg);
    const list = (msg.parsed_output?.messages || []).map((m) => plain(m).replace(/\s+/g, ' ').trim()).filter((m) => m && m.length <= 140);
    if (list.length < 5) throw new AIError('format', 'Claude sent too few reminder texts. Try again.');
    S.state.ai.nudges = { messages: list.slice(0, 60), at: Date.now() };
    S.save();
    return S.state.ai.nudges;
  } catch (err) {
    throw friendly(err);
  }
}

// Quick check that the key works, with the smallest possible request.
export async function testKey() {
  const c = await getClient();
  try {
    const msg = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      betas: BETAS,
      fallbacks: 'default',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with exactly: System online.' }],
    });
    track(msg);
    checkStop(msg);
    return textOf(msg);
  } catch (err) {
    throw friendly(err);
  }
}
