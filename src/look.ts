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
