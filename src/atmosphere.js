// The Night sky atmosphere (look.ts BACKGROUNDS): a field of stars behind the Arise look that
// twinkle and drift very slowly, with a shooting star now and then. Drawn on one canvas fixed
// behind the page, about 24 times a second, and only while the page is showing. With less motion
// (Settings, or the device's own setting) it's drawn once and stays still. In light mode the stars
// are warm specks of dust in the light instead.
//
// The other atmospheres are CSS only (styles/arise.css).

const FPS = 24;
let canvas = null;
let ctx = null;
let stars = [];
let shooting = null;
let raf = 0;
let last = 0;
let watching = false;

const root = () => document.documentElement;
const wanted = () => root().dataset.theme === 'arise' && root().dataset.bg === 'stars';
const still = () => root().dataset.motion === 'less' || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const dark = () => root().dataset.mode === 'dark' || (root().dataset.mode !== 'light' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);

// A fixed set for a size, so the sky doesn't jump when it's drawn again.
function seed(w, h) {
  let s = 1234567;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const n = Math.round(Math.min(320, (w * h) / 4200));
  stars = Array.from({ length: n }, () => {
    const big = rand() < 0.08;
    return { x: rand() * w, y: rand() * h, r: big ? 1.6 + rand() * 1.2 : 0.5 + rand() * 1.1, big, a: 0.5 + rand() * 0.5, tw: 0.4 + rand() * 1.6, ph: rand() * Math.PI * 2, dx: (rand() - 0.5) * 0.05, warm: rand() < 0.3 };
  });
}

function size() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  seed(w, h);
}

function draw(t) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  const night = dark();
  const moving = !still();
  for (const st of stars) {
    if (moving) {
      st.x += st.dx;
      if (st.x < 0) st.x += w;
      if (st.x > w) st.x -= w;
    }
    const glow = moving ? 0.55 + 0.45 * Math.sin(st.ph + (t / 1000) * st.tw) : 0.8;
    ctx.globalAlpha = st.a * glow * (night ? 1 : 0.6);
    const color = night ? (st.warm ? '#ffe2a8' : '#f4f8ff') : '#d98a2b';
    // The bright ones get a soft halo.
    if (st.big) {
      const halo = ctx.createRadialGradient(st.x, st.y, 0, st.x, st.y, st.r * 5);
      halo.addColorStop(0, night ? 'rgba(255,240,210,0.35)' : 'rgba(232,140,40,0.25)');
      halo.addColorStop(1, 'rgba(255,240,210,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r * 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Now and then, at night, a shooting star.
  if (moving && night) {
    if (!shooting && Math.random() < 0.0025) shooting = { x: Math.random() * w * 0.7, y: Math.random() * h * 0.4, life: 1 };
    if (shooting) {
      const len = 90;
      const g = ctx.createLinearGradient(shooting.x, shooting.y, shooting.x - len, shooting.y - len * 0.35);
      g.addColorStop(0, `rgba(255,246,224,${0.9 * shooting.life})`);
      g.addColorStop(1, 'rgba(255,246,224,0)');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(shooting.x, shooting.y);
      ctx.lineTo(shooting.x - len, shooting.y - len * 0.35);
      ctx.stroke();
      shooting.x += 9;
      shooting.y += 3.2;
      shooting.life -= 0.03;
      if (shooting.life <= 0) shooting = null;
    }
  }
  ctx.globalAlpha = 1;
}

function loop(t) {
  raf = 0;
  if (!canvas || document.visibilityState === 'hidden') return;
  if (t - last >= 1000 / FPS) {
    last = t;
    draw(t);
  }
  if (!still()) raf = requestAnimationFrame(loop);
}

function start() {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'atmo-sky';
    canvas.setAttribute('aria-hidden', 'true');
    ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas = null;
      return;
    }
    document.body.prepend(canvas);
    size();
  }
  if (!raf) raf = requestAnimationFrame(loop);
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  canvas?.remove();
  canvas = null;
  ctx = null;
}

// Shows or hides the sky to match <html> now. Called after any change of look or atmosphere.
export function syncAtmosphere() {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  if (wanted()) start();
  else stop();
}

export function initAtmosphere() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  try {
    new MutationObserver(syncAtmosphere).observe(document.documentElement, { attributes: true, attributeFilter: ['data-bg', 'data-theme', 'data-mode', 'data-motion'] });
  } catch {}
  window.addEventListener('resize', () => {
    if (!canvas) return;
    size();
    if (still()) draw(performance.now()); // (sizing clears it; a still sky isn't drawn again by the loop)
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && canvas && !raf) raf = requestAnimationFrame(loop);
  });
  syncAtmosphere();
}
