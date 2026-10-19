// Arise Private on screen: the plan line under the private AI in Settings, AI coach, and the
// button to get it, which also shows next to the message when today's free private questions are
// used up (in the chat and wherever the coach's errors show). The plan itself: src/plan.ts.

import * as AI from './ai.js';
import * as PLAN from './plan';
import { esc, icon } from './ui.js';

const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// The way to get Arise Private, for someone on the free plan. Nothing while the plan isn't known.
export function upgradeHTML() {
  const p = PLAN.plan();
  if (!p || p.plan !== 'free') return '';
  const monthly = PLAN.checkoutUrl('monthly');
  const yearly = PLAN.checkoutUrl('yearly');
  if (!monthly && !yearly) return '<p class="muted small plan-soon">Arise Private is coming soon.</p>';
  const go = (url, text, cls) => `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener" data-act="plan-checkout">${text}</a>`;
  return `<div class="plan-buy">
      ${monthly ? go(monthly, `${icon('lock')} Get Arise Private · $5 a month`, 'btn primary small') : ''}
      ${yearly ? go(yearly, monthly ? 'or $48 a year' : `${icon('lock')} Get Arise Private · $48 a year`, monthly ? 'link small' : 'btn primary small') : ''}
    </div>`;
}

// Next to an error: the way to get Arise Private, when the error is today's free private
// questions being used up.
export const upgradeFor = (message) => (PLAN.isUsedUp(message) ? upgradeHTML() : '');

// Settings, AI coach, under the private AI: which plan, how many questions are left today, and
// the way to get or manage Arise Private.
export function planRowHTML() {
  if (!AI.privateConfigured() || !AI.privateSignedIn()) return '';
  const p = PLAN.plan();
  if (!p) return '';
  if (p.plan === 'private') {
    const until = p.endsAt ? ` · ends ${esc(day(p.endsAt))}` : p.renewsAt ? ` · renews ${esc(day(p.renewsAt))}` : '';
    return `<div class="plan-row on">
      <p class="small"><b>${icon('lock')} Arise Private</b>${until}</p>
      <p class="muted small">The private AI all day, and Arise learns from your days with it.</p>
      ${p.portal ? `<a class="link small" href="${esc(p.portal)}" target="_blank" rel="noopener">Manage subscription ${icon('ext')}</a>` : ''}
    </div>`;
  }
  return `<div class="plan-row">
      <p class="small"><b>Free:</b> ${p.limit} private question${p.limit === 1 ? '' : 's'} a day (${p.left} left today)</p>
      <p class="muted small">Arise Private gives you the private AI all day, and Arise learns from your days with it.</p>
      ${upgradeHTML()}
      ${p.portal ? `<a class="link small" href="${esc(p.portal)}" target="_blank" rel="noopener">Manage subscription ${icon('ext')}</a>` : ''}
    </div>`;
}

export function handlePlanAction(act) {
  if (act !== 'plan-checkout') return false;
  // The link opens Lemon Squeezy's checkout by itself; coming back, the app looks for the plan.
  PLAN.openedCheckout();
  return true;
}
