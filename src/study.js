// Study on screen: the Today card (the next test and a round to play), the Study page (each
// module, how much of it is known, its topics), a round of questions, and the Settings panel
// that holds the study link.
//
// Everything here shows only once the Player has a study link. The pack it opens is kept on this
// device (it can be large and it's only course material); what syncs is lib/study.ts's `study`.

import * as S from './store';
import * as ST from './lib/study';
import { linkKey, open } from './lib/crypto';
import { STUDY_PACKS } from './study-config';
import { esc, icon, openSheet, closeSheet, toast, xpPop, fmt } from './ui.js';
import './styles/study.css';

const PACK = 'arise-study-pack';
const STALE = 30 * 60 * 1000;

let app = { go: () => {}, render: () => {}, view: () => 'today' };
export function initStudy(hooks) {
  app = { ...app, ...hooks };
  document.addEventListener('keydown', onKey);
  if (S.state.study.link) refreshPack().catch(() => {});
}

// ---------- the pack, kept on this device

let cache = readCache();
let loading = null;
let problem = '';

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(PACK) || 'null');
    return c && typeof c.link === 'string' ? { link: c.link, at: Number(c.at) || 0, pack: ST.cleanPack(c.pack) } : null;
  } catch {
    return null;
  }
}

export function pack() {
  const link = S.state.study.link;
  if (!link || !cache || cache.link !== link) return null;
  return cache.pack;
}

// Fetch and open the pack for the current link (at most every half hour, unless asked).
export function refreshPack({ force = false } = {}) {
  const link = S.state.study.link;
  if (!link) {
    cache = null;
    try {
      localStorage.removeItem(PACK);
    } catch {}
    return Promise.resolve(null);
  }
  if (!force && cache?.link === link && cache.pack && Date.now() - cache.at < STALE) return Promise.resolve(cache.pack);
  if (loading) return loading;
  loading = (async () => {
    try {
      const { id, key } = ST.parseLink(link);
      const res = await fetch(`${STUDY_PACKS}${id}.json`, { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw new Error(res.status === 404 ? 'gone' : 'network');
      const sealed = await res.json();
      const p = ST.cleanPack(JSON.parse(await open(await linkKey(key), sealed, ST.packAad(id))));
      if (!p) throw new Error('bad');
      cache = { link, at: Date.now(), pack: p };
      try {
        localStorage.setItem(PACK, JSON.stringify({ ...cache, pack: { format: ST.STUDY_FORMAT, ...p } }));
      } catch {}
      problem = '';
      return p;
    } catch (e) {
      problem = e?.message === 'gone' ? "This study link's pack isn't there. Check the link." : e?.message === 'network' || e instanceof TypeError ? "Couldn't reach your study pack. Check your connection." : "This study link doesn't open its pack. Check the link.";
      return null;
    } finally {
      loading = null;
      const v = app.view();
      if (v === 'today' || v === 'study' || v === 'settings') app.render();
    }
  })();
  return loading;
}

const today = () => S.todayKey();
const allCards = (p) => p.modules.flatMap((m) => m.cards);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const whenText = (days) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);

function bar(pct) {
  return `<div class="st-bar" role="img" aria-label="${pct}% known"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`;
}

function testLine(t) {
  return `<li class="st-test${t.days <= 7 ? ' soon' : ''}"><b>${esc(t.module)}</b> · ${esc(t.title)} <span class="st-when">${whenText(t.days)}</span>${t.covers ? `<div class="small muted">${esc(t.covers)}${t.note ? `. ${esc(t.note)}` : ''}</div>` : ''}</li>`;
}

// ---------- Today

export function todayCard() {
  if (!S.state.study.link) return '';
  const p = pack();
  if (!p) {
    if (!loading && !problem) refreshPack().catch(() => {});
    return `<section class="panel st-today"><div class="panel-title">${icon('study')}<span>Study</span></div><p class="muted small">${esc(problem || 'Opening your study pack…')}</p></section>`;
  }
  const k = today();
  const tests = ST.upcoming(p, k).slice(0, 2);
  const m = ST.nextModule(p, S.state.study.cards, k);
  const pr = ST.progress(m.cards, S.state.study.cards, k);
  const done = ST.roundsOn(S.state.study, k);
  return `<section class="panel st-today">
    <div class="panel-title">${icon('study')}<span>Study</span>${done ? `<span class="tag">${plural(done, 'round')} today</span>` : ''}</div>
    ${tests.length ? `<ul class="st-tests">${tests.map(testLine).join('')}</ul>` : ''}
    <p class="small">${esc(m.short)}: ${pr.known} of ${pr.all} known${pr.due ? `, ${pr.due} due` : ''}.</p>
    ${bar(pr.pct)}
    <div class="row st-actions">
      <button class="btn primary" data-act="study-play" data-m="${esc(m.id)}">${icon('play')}<span>${done ? 'Another round' : 'Play a round'}</span></button>
      <button class="btn ghost" data-act="nav" data-v="study">All modules</button>
    </div>
  </section>`;
}

// ---------- the Study page

export function renderStudy(root) {
  const k = today();
  const p = pack();
  const head = `<header class="page-head"><div><p class="kicker">Your modules</p><h1 class="display">Study</h1></div></header>`;
  if (!S.state.study.link) {
    root.innerHTML = `${head}<section class="panel"><p>Add your study link in Settings, under Study, to get your modules here.</p><button class="btn primary" data-act="nav" data-v="settings">Open Settings</button></section>`;
    return;
  }
  if (!p) {
    if (!loading) refreshPack().catch(() => {});
    root.innerHTML = `${head}<section class="panel"><p class="muted">${esc(problem || 'Opening your study pack…')}</p>${problem ? `<button class="btn" data-act="study-refresh">Try again</button>` : ''}</section>`;
    return;
  }
  const tests = ST.upcoming(p, k);
  const day = S.state.study.rounds[k];
  root.innerHTML = `${head}
    <div class="cols">
      <div class="col">
        ${p.modules.map((m) => moduleCard(m, k)).join('')}
      </div>
      <div class="col">
        <section class="panel">
          <div class="panel-title">${icon('timer')}<span>Coming up</span></div>
          ${tests.length ? `<ul class="st-tests">${tests.map(testLine).join('')}</ul>` : '<p class="muted small">No tests in your pack yet.</p>'}
        </section>
        <section class="panel">
          <div class="panel-title">${icon('flame')}<span>Today</span></div>
          <p>${day ? `${plural(day.n, 'round')}, ${day.right} of ${day.total} right first time.` : 'No rounds yet today. One round is about five minutes.'}</p>
          <p class="small muted">Each round: ${ST.ROUND_XP} XP, plus ${ST.RIGHT_XP} for each answer right first time. Cards you miss come back sooner.</p>
        </section>
      </div>
    </div>`;
}

function moduleCard(m, k) {
  const st = S.state.study.cards;
  const pr = ST.progress(m.cards, st, k);
  const weeks = [...new Set(m.topics.map((t) => t.week))].sort((a, b) => a - b);
  return `<section class="panel st-module">
    <div class="panel-head"><div><div class="h3">${esc(m.module)}</div><p class="small muted">${pr.known} of ${pr.all} known · ${pr.due} due · ${pr.all - pr.seen} new</p></div>
      <button class="btn primary small" data-act="study-play" data-m="${esc(m.id)}">${icon('play')}<span>Play</span></button></div>
    ${bar(pr.pct)}
    <details class="st-topics"><summary>Topics</summary>
      ${weeks
        .map(
          (wk) => `<div class="label">${wk ? `Week ${wk}` : 'Other'}</div>
        ${m.topics
          .filter((t) => t.week === wk)
          .map((t) => {
            const cards = m.cards.filter((c) => c.topic === t.id);
            if (!cards.length) return '';
            const tp = ST.progress(cards, st, k);
            return `<button class="st-topic" data-act="study-play" data-m="${esc(m.id)}" data-t="${esc(t.id)}"><span>${esc(t.title)}</span><span class="small muted">${tp.known}/${tp.all}</span>${bar(tp.pct)}</button>`;
          })
          .join('')}`,
        )
        .join('')}
    </details>
  </section>`;
}

// ---------- a round

let round = null;
let lastModule = ''; // the module of the round just finished, for "Another round"

const shuffle = (a) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

function startRound(moduleId, topicId) {
  const p = pack();
  if (!p) return;
  const m = p.modules.find((x) => x.id === moduleId) || ST.nextModule(p, S.state.study.cards, today());
  const cards = topicId ? m.cards.filter((c) => c.topic === topicId) : m.cards;
  const picked = ST.pickRound(cards, S.state.study.cards, today());
  if (!picked.length) return toast('No questions here yet.');
  round = {
    module: m,
    queue: picked.map((card) => ({ card, order: card.choices ? shuffle(card.choices.map((_, i) => i)) : null, retry: false })),
    i: 0,
    first: new Map(),
    shown: null, // the answer picked (mcq), or 'shown' (recall, answer side up)
    graded: false,
    total: picked.length,
    xpBefore: S.levelInfo().level,
  };
  app.go('quiz');
}

export function renderQuiz(root) {
  if (!round) return app.go('study');
  const item = round.queue[round.i];
  const { card } = item;
  const topic = round.module.topics.find((t) => t.id === card.topic);
  const pct = Math.round((round.i / round.queue.length) * 100);
  const answered = round.graded;
  let body = '';
  if (card.type === 'mcq') {
    body = `<div class="st-choices">${item.order
      .map((ci, n) => {
        const cls = answered ? (ci === card.answer ? ' right' : ci === round.shown ? ' wrong' : ' dim') : '';
        return `<button class="st-choice${cls}" data-act="study-answer" data-i="${ci}" ${answered ? 'disabled' : ''}><span class="st-key">${n + 1}</span><span>${esc(card.choices[ci])}</span></button>`;
      })
      .join('')}</div>`;
  } else if (!round.shown) {
    body = `<button class="btn primary block" data-act="study-reveal">Show the answer</button>`;
  } else {
    body = `<div class="st-back">${esc(card.back)}</div>${answered ? '' : `<p class="small muted">Did you know it?</p><div class="row st-actions"><button class="btn primary" data-act="study-grade" data-ok="1">${icon('check')}<span>I knew it</span></button><button class="btn" data-act="study-grade" data-ok="0">Not yet</button></div>`}`;
  }
  const right = answered && round.lastRight;
  root.innerHTML = `
    <div class="wk-head st-head">
      <button class="icon-btn" data-act="study-end" aria-label="End the round">${icon('close')}</button>
      <div class="st-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <span class="small muted">${round.i + 1}/${round.queue.length}</span>
    </div>
    <section class="panel st-card">
      <p class="kicker">${esc(round.module.short)}${topic ? ` · ${esc(topic.title)}` : ''}${item.retry ? ' · again' : ''}</p>
      <h2 class="st-q">${esc(card.q)}</h2>
      ${card.code ? `<pre class="st-code"><code>${esc(card.code)}</code></pre>` : ''}
      ${body}
      ${
        answered
          ? `<div class="st-explain ${right ? 'right' : 'wrong'}" role="status"><b>${right ? 'Right.' : 'Not quite.'}</b> ${esc(card.explain)}${card.source ? `<div class="small muted st-source">From ${esc(card.source)}</div>` : ''}</div>
      <button class="btn primary block" data-act="study-next" id="studyNext">${round.i + 1 < round.queue.length ? 'Next' : 'Finish'}${icon('next')}</button>`
          : ''
      }
    </section>`;
  if (answered) document.getElementById('studyNext')?.focus();
}

function grade(right) {
  const item = round.queue[round.i];
  round.graded = true;
  round.lastRight = right;
  // The first answer to a card counts; a card missed comes back once at the end of the round.
  if (!item.retry) {
    round.first.set(item.card.id, right);
    S.studyAnswer(item.card.id, right);
    if (!right) round.queue.push({ ...item, order: item.order ? shuffle(item.order) : null, retry: true });
  }
  app.render();
}

function next() {
  round.i++;
  round.shown = null;
  round.graded = false;
  if (round.i < round.queue.length) return app.render();
  finish();
}

function finish() {
  const right = [...round.first.values()].filter(Boolean).length;
  const total = round.first.size;
  const before = ST.studyXP(S.state.study);
  S.studyRound(right, total);
  const gained = ST.studyXP(S.state.study) - before;
  const L = S.levelInfo();
  const up = L.level > round.xpBefore;
  const name = round.module.short;
  lastModule = round.module.id;
  round = null;
  app.go('study');
  if (gained) xpPop(`+${gained} XP`);
  openSheet(`<div class="summary">
    <p class="kicker">${esc(name)}</p>
    <h2 class="display">${right === total ? 'Perfect round' : 'Round done'}</h2>
    <p class="xp-gain">${right} of ${total} right first time${gained ? ` · +${gained} XP` : ''}</p>
    ${up ? `<p class="lvl-change">Level up! Level ${L.level}</p>` : ''}
    <p class="small muted">The ones you missed come back sooner. Streak: ${plural(S.currentStreak(), 'day')}.</p>
    <div class="row st-actions"><button class="btn primary" data-act="study-again">Another round</button><button class="btn ghost" data-act="sheet-close">Done</button></div>
  </div>`);
}

function onKey(e) {
  if (app.view() !== 'quiz' || !round || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
  const item = round.queue[round.i];
  if (!round.graded && item.card.type === 'mcq' && /^[1-6]$/.test(e.key)) {
    const ci = item.order[Number(e.key) - 1];
    if (ci != null) {
      e.preventDefault();
      round.shown = ci;
      grade(ci === item.card.answer);
    }
  } else if (!round.graded && item.card.type === 'recall' && !round.shown && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    round.shown = 'shown';
    app.render();
  }
}

// ---------- Settings

export function settingsPanel() {
  const link = S.state.study.link;
  const p = pack();
  return `<section class="panel" id="studyPanel">
    <div class="panel-title">${icon('study')}<span>Study</span></div>
    ${
      link
        ? `<p class="small">${p ? `Your study pack: ${p.modules.map((m) => esc(m.short)).join(', ')}. ${plural(allCards(p).length, 'question')}${p.updated ? `, updated ${esc(fmt(p.updated, { day: 'numeric', month: 'short' }))}` : ''}.` : esc(problem || 'Opening your study pack…')}</p>
      <div class="row"><button class="btn small" data-act="study-refresh">${icon('refresh')}<span>Check for new questions</span></button><button class="btn small ghost" data-act="study-unlink">Remove the study link</button></div>
      <p class="small muted">The link syncs to your other devices. Removing it keeps what you've learned, in case you add it again.</p>`
        : `<p class="small">Paste the study link made from your course materials, to play short rounds of questions and see your tests coming up.</p>
      <div class="field"><label for="studyLink">Study link</label><input id="studyLink" autocomplete="off" spellcheck="false" placeholder="Paste your study link"></div>
      <button class="btn primary small" data-act="study-link">Add</button>`
    }
  </section>`;
}

// A study link opened from outside (#study=<id>.<key>): kept, and the Study page opens.
export function takeLink(hash) {
  const l = ST.parseLink(hash);
  if (!l) return false;
  S.setStudyLink(`${l.id}.${l.key}`);
  refreshPack({ force: true }).catch(() => {});
  return true;
}

// ---------- the coach

// A few lines about study for the coach: tests coming up, how much is known, today's rounds and
// the week's, and the topics with most misses. Nothing without a pack on this device.
export function coachLines(compact = false) {
  const p = pack();
  if (!p) return [];
  const k = today();
  const st = S.state.study;
  const out = ['', '## Study'];
  for (const t of ST.upcoming(p, k).slice(0, compact ? 2 : 5)) out.push(`- ${t.module}: ${t.title} on ${t.date} (${whenText(t.days)}), covers ${t.covers || 'not said'}.`);
  for (const m of p.modules) {
    const pr = ST.progress(m.cards, st.cards, k);
    const weak = m.topics
      .map((t) => {
        const cs = m.cards.filter((c) => c.topic === t.id).map((c) => st.cards[c.id]).filter(Boolean);
        return { title: t.title, w: cs.reduce((n, c) => n + c.w, 0), r: cs.reduce((n, c) => n + c.r, 0) };
      })
      .filter((t) => t.w > 0)
      .sort((a, b) => b.w / (b.w + b.r) - a.w / (a.w + a.r))
      .slice(0, 3);
    out.push(`- ${m.module}: ${pr.known} of ${pr.all} questions known, ${pr.due} due, ${pr.all - pr.seen} not tried yet.${weak.length ? ` Most missed: ${weak.map((t) => `${t.title} (${t.w} wrong, ${t.r} right)`).join('; ')}.` : ''}`);
  }
  let n = 0;
  let right = 0;
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = st.rounds[S.addDays(k, -i)];
    if (d) {
      n += d.n;
      right += d.right;
      total += d.total;
    }
  }
  out.push(`Rounds today: ${ST.roundsOn(st, k)}. Last 7 days: ${n} rounds${total ? `, ${Math.round((right / total) * 100)}% right first time` : ''}.`);
  return out;
}

// ---------- actions

export function handleAction(act, el) {
  switch (act) {
    case 'study-play':
      startRound(el.dataset.m, el.dataset.t);
      return true;
    case 'study-again': {
      const p = pack();
      closeSheet();
      if (pack()) startRound(lastModule);
      return true;
    }
    case 'study-answer': {
      if (!round || round.graded) return true;
      const ci = Number(el.dataset.i);
      round.shown = ci;
      grade(ci === round.queue[round.i].card.answer);
      return true;
    }
    case 'study-reveal':
      if (round) {
        round.shown = 'shown';
        app.render();
      }
      return true;
    case 'study-grade':
      if (round && !round.graded) grade(el.dataset.ok === '1');
      return true;
    case 'study-next':
      if (round) next();
      return true;
    case 'study-end':
      // What was answered is kept; the round just isn't counted.
      round = null;
      app.go('study');
      return true;
    case 'study-refresh':
      refreshPack({ force: true }).then((p) => toast(p ? 'Your study pack is up to date.' : problem));
      return true;
    case 'study-link': {
      const input = document.getElementById('studyLink');
      const l = ST.parseLink(input?.value);
      if (!l) {
        toast("That isn't a study link. It looks like a long code with a dot in the middle.");
        return true;
      }
      S.setStudyLink(`${l.id}.${l.key}`);
      refreshPack({ force: true }).then((p) => p && toast('Study link added. Your modules are on the Study page.'));
      app.render();
      return true;
    }
    case 'study-unlink':
      S.setStudyLink('');
      refreshPack().catch(() => {});
      app.render();
      return true;
  }
  return false;
}
