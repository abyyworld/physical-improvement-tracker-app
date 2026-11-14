// How the app looks: the Arise look (light, dark, or following the device) or the System look,
// the original Solo Leveling one. The choice is a setting (settings.look) and syncs like the rest.
//
// The page shows it as two attributes on <html>, which the styles read:
//   data-theme="arise" | "system"   (src/styles/arise.css and src/styles/app.css)
//   data-mode="light" | "dark"      only when the Player picked one; without it the Arise look
//                                   follows the device (prefers-color-scheme).
// public/look.js sets the same before the page first paints, from a copy of the choice kept on
// this device (LOOK_KEY), so nobody sees the wrong look flash first. Keep the two in step.

import * as S from './store';
import type { Look } from './lib/validate';

export const LOOK_KEY = 'arise-look';
// The colour of the browser's bar and the iPhone's status bar area for each look.
export const BAR_COLOR = { light: '#f5f4f0', dark: '#121110', system: '#040507' } as const;

export type Theme = 'arise' | 'system';
export const isLook = (v: unknown): v is Look => v === 'auto' || v === 'light' || v === 'dark' || v === 'system';
export const currentLook = (): Look => (isLook(S.state.settings.look) ? S.state.settings.look : 'auto');
export const themeOf = (look: Look): Theme => (look === 'system' ? 'system' : 'arise');

const deviceDark = () => {
  try {
    return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
};

// Light or dark, as it shows right now.
export const schemeOf = (look: Look): 'light' | 'dark' => (look === 'system' || look === 'dark' || (look === 'auto' && deviceDark()) ? 'dark' : 'light');

const native = () => !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

function meta(name: string, content: string) {
  const all = document.head.querySelectorAll(`meta[name="${name}"]`);
  if (!all.length) {
    const m = document.createElement('meta');
    m.name = name;
    m.content = content;
    document.head.append(m);
    return;
  }
  for (const m of all) if (m.getAttribute('content') !== content) m.setAttribute('content', content);
}

let watching = false;

// Shows `look` (the setting by default). True when the theme changed, so screens that use its
// words (the tabs) are drawn again.
// ---------- a background and less motion, on this device only (like the look's copy above)
//
// Backgrounds are calm colour washes of Arise's own behind the Arise look (the System look keeps
// its own), drifting very slowly unless motion is reduced. "Less motion" stops that and the app's
// other animations, whatever the device says; the device's own "reduce motion" always counts too.
// Both are set on <html> as data-bg and data-motion; public/look.js does the same before the
// first paint.

export const BG_KEY = 'arise-bg';
export const MOTION_KEY = 'arise-motion';
export const BACKGROUNDS = [
  ['plain', 'Plain'],
  ['dawn', 'Dawn'],
  ['sea', 'Sea'],
  ['forest', 'Forest'],
  ['dusk', 'Dusk'],
] as const;
export type Background = (typeof BACKGROUNDS)[number][0];
export const isBackground = (v: unknown): v is Background => BACKGROUNDS.some(([b]) => b === v);

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};

export const currentBackground = (): Background => {
  const v = read(BG_KEY);
  return isBackground(v) ? v : 'plain';
};
export const lessMotion = () => read(MOTION_KEY) === 'less';

export function applyBackground(bg: Background = currentBackground(), less = lessMotion()) {
  const root = document.documentElement;
  if (bg === 'plain') delete root.dataset.bg;
  else root.dataset.bg = bg;
  if (less) root.dataset.motion = 'less';
  else delete root.dataset.motion;
}

export function setBackground(bg: Background) {
  write(BG_KEY, bg === 'plain' ? null : bg);
  applyBackground();
}

export function setLessMotion(on: boolean) {
  write(MOTION_KEY, on ? 'less' : null);
  applyBackground();
}

export function applyLook(look: Look = currentLook()): boolean {
  const root = document.documentElement;
  const theme = themeOf(look);
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  if (look === 'light' || look === 'dark') root.dataset.mode = look;
  else delete root.dataset.mode;
  try {
    if (localStorage.getItem(LOOK_KEY) !== look) localStorage.setItem(LOOK_KEY, look);
  } catch {}
  paintChrome(look);
  applyBackground();
  if (!watching) {
    watching = true;
    try {
      window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => paintChrome(currentLook()));
    } catch {}
  }
  return changed;
}

// What's around the page: the browser's bar colour, form controls, and in the iPhone app a strip
// behind the status bar when its text colour (which follows the phone) wouldn't show on the page.
function paintChrome(look: Look) {
  const scheme = schemeOf(look);
  const color = look === 'system' ? BAR_COLOR.system : BAR_COLOR[scheme];
  meta('theme-color', color);
  meta('color-scheme', look === 'auto' ? 'light dark' : scheme);
  const root = document.documentElement;
  if (native() && scheme !== (deviceDark() ? 'dark' : 'light')) root.dataset.statusbar = deviceDark() ? 'dark' : 'light';
  else delete root.dataset.statusbar;
}
