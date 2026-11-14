// Your most-visited sites, on Today: the sites you went to most in the last two weeks, from what
// the browser extension, a Chrome history import or the Mac helper (Safari) put in the life log.
// Counted on this device; nothing is fetched from the sites (no icons), so opening Today tells them
// nothing. Only shown once there are some.

import * as L from './log';
import { hasLifeStore } from './store-port';
import { esc, icon } from '../ui.js';

const DAYS = 14;
const SHOW = 6;
const $ = (sel) => globalThis.document?.querySelector(sel) ?? null;

// A site's name from an event: the extension's own, or the address's host, without "www.".
export function siteOf(e) {
  let host = typeof e.meta?.site === 'string' ? e.meta.site : '';
  if (!host && typeof e.url === 'string') {
    try {
      const u = new URL(e.url);
      if (u.protocol === 'http:' || u.protocol === 'https:') host = u.host;
    } catch {}
  }
  host = host.toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9.-]+(:\d+)?$/.test(host) && host.includes('.') ? host : '';
}

// The sites visited most, with how many times, the most first (ties: the latest first).
export function rankSites(events, n = SHOW) {
  const by = new Map();
  for (const e of events) {
    if (e.kind !== 'visit') continue;
    const site = siteOf(e);
    if (!site) continue;
    const x = by.get(site) || { site, visits: 0, last: 0 };
    x.visits++;
    x.last = Math.max(x.last, e.at);
    by.set(site, x);
  }
  return [...by.values()].sort((a, b) => b.visits - a.visits || b.last - a.last).slice(0, n);
}

export async function topSites(now = Date.now()) {
  if (!hasLifeStore()) return [];
  const events = await L.eventsBetween(now - DAYS * 86_400_000, now + 1, { kinds: ['visit'], limit: 5000, newest: true });
  return rankSites(events);
}

// Where the card goes on Today; filled once counted.
export const slot = () => '<div id="topSites"></div>';

function cardHTML(list) {
  if (!list.length) return '';
  return `<section class="panel top-sites">
    <div class="panel-title">${icon('globe')}<span>Your most-visited sites</span></div>
    <ul class="site-list">${list
      .map(
        (s) => `<li><a class="site" href="https://${esc(s.site)}" target="_blank" rel="noopener noreferrer">
        <span class="site-tile" aria-hidden="true">${esc(s.site[0].toUpperCase())}</span>
        <span class="site-text"><b>${esc(s.site)}</b><small>${s.visits} ${s.visits === 1 ? 'visit' : 'visits'} in two weeks</small></span>
      </a></li>`,
      )
      .join('')}</ul>
    <p class="muted small">From the sites you visit, counted on this device only.</p>
  </section>`;
}

export async function fill() {
  let list = [];
  try {
    list = await topSites();
  } catch {}
  const el = $('#topSites');
  if (el) el.innerHTML = cardHTML(list);
}
