// Line charts for progress: totals per workout, bodyweight, and any goal's measure.

import { esc } from './ui.js';

const $ = (sel, root = document) => root.querySelector(sel);

function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// pts: [{ t: time in ms, y: value, changed?: true }], oldest first.
// opts.fit: zoom the y-axis to the data (for bodyweight) instead of starting at 0.
// opts.tip(point) returns the tooltip HTML; opts.caption the line above the chart.
export function drawChart(host, pts, unit, opts = {}) {
  const W = Math.max(260, host.clientWidth || 320);
  const H = 210;
  const m = { l: 40, r: 16, t: 16, b: 28 };
  let lo = 0;
  let hi;
  let step;
  if (opts.fit) {
    let mn = Math.min(...pts.map((p) => p.y));
    let mx = Math.max(...pts.map((p) => p.y));
    if (mx - mn < 2) {
      mn -= 1;
      mx += 1;
    }
    step = niceStep((mx - mn) / 4);
    lo = Math.floor(mn / step) * step;
    hi = Math.ceil(mx / step) * step;
  } else {
    const maxY = Math.max(...pts.map((p) => p.y), 1);
    step = niceStep(maxY / 4);
    hi = Math.ceil((maxY * 1.05) / step) * step;
  }
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t) => (t1 === t0 ? m.l + (W - m.l - m.r) / 2 : m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r));
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  let grid = '';
  for (let v = lo; v <= hi + step / 1000; v += step) {
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${m.l - 8}" y="${y(v) + 4}" class="yl">${Number(v.toFixed(2))}</text>`;
  }
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const dots = pts.map((p) => `<circle cx="${x(p.t)}" cy="${y(p.y)}" r="${p.changed ? 5 : 4}" class="${p.changed ? 'pt changed' : 'pt'}"/>`).join('');
  const lab = (t, anchor) => `<text x="${x(t)}" y="${H - 8}" class="xl" text-anchor="${anchor}">${esc(new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</text>`;
  const xl = t1 === t0 ? lab(t0, 'middle') : lab(t0, 'start') + lab(t1, 'end');
  const anyChanged = pts.some((p) => p.changed);
  host.innerHTML = `<p class="chart-cap">${esc(opts.caption || `Total ${unit} each time`)}</p>
    <div class="chart">
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.caption || `Line chart of total ${unit} per workout`)}">
        ${grid}${xl}
        <line class="xh" y1="${m.t}" y2="${H - m.b}" x1="0" x2="0" visibility="hidden"/>
        <path d="${d}" class="ln"/>
        ${dots}
        <circle class="hl-pt" r="6" visibility="hidden"/>
        <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="hit"/>
      </svg>
      <div class="tip" hidden></div>
    </div>
    ${anyChanged ? '<p class="muted small legend-note"><i class="ring"></i> Hollow dot: you changed the setup (e.g. heavier backpack or thicker band)</p>' : ''}`;
  const svg = $('svg', host);
  const tip = $('.tip', host);
  const xh = $('.xh', svg);
  const hp = $('.hl-pt', svg);
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    const cx = x(best.t);
    xh.setAttribute('x1', cx);
    xh.setAttribute('x2', cx);
    xh.setAttribute('visibility', 'visible');
    hp.setAttribute('cx', cx);
    hp.setAttribute('cy', y(best.y));
    hp.setAttribute('visibility', 'visible');
    tip.innerHTML = opts.tip ? opts.tip(best) : `<b>${esc(new Date(best.t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}</b><span>${esc(best.y)} ${esc(unit)}</span>`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, cx - tw / 2), W - tw)}px`;
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    tip.hidden = true;
    xh.setAttribute('visibility', 'hidden');
    hp.setAttribute('visibility', 'hidden');
  });
}
