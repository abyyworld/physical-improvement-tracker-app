// Your setup: every part of Arise that's worth setting up, where each stands, and what to do next.
// Pure: connect-hub.js gathers where things stand (Facts) from each module and draws this.

// The setup's steps on Connect (connect-hub.js).
export type Step = 'account' | 'ai' | 'connections' | 'review';
export const STEPS: readonly { id: Step; name: string }[] = [
  { id: 'account', name: 'Your account' },
  { id: 'ai', name: 'Your AI coach' },
  { id: 'connections', name: 'Connections' },
  { id: 'review', name: 'Review' },
];
// Which step each part is set up in.
export const STEP_OF: Record<string, Step> = { account: 'account', lock: 'account', ai: 'ai', reminders: 'account', phone: 'connections', accounts: 'connections', computer: 'connections', history: 'connections', apps: 'connections' };

export type SetupId = 'account' | 'ai' | 'reminders' | 'phone' | 'lock' | 'accounts' | 'computer' | 'history' | 'apps';

export interface Facts {
  configured: { sync: boolean; reminders: boolean };
  signedIn: boolean;
  ai: { engine: string | null; label: string; private: boolean };
  reminders: boolean; // web push on, or the phone app's own reminders
  native: 'ios' | 'android' | null; // in the iPhone or Android app
  lock: boolean;
  accounts: string[]; // names of linked accounts
  computer: { browser: boolean; mac: boolean };
  history: string[] | null; // sources brought in from files (null: not known yet)
  apps: { all: number; web: number };
}

export interface Item {
  id: SetupId;
  name: string;
  done: boolean;
  recommended: boolean;
  status: string; // where it stands, in a few words
  what: string; // what it gives you
  less?: boolean; // on, but less private
  go: { view: string; to: string; label: string; step?: Step }; // where to set it up (and the setup step, on Connect)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function items(f: Facts): Item[] {
  const out: Item[] = [];
  if (f.configured.sync) {
    out.push({
      id: 'account',
      name: 'Account and sync',
      done: f.signedIn,
      recommended: true,
      status: f.signedIn ? 'On, end-to-end encrypted' : 'Not yet',
      what: 'The same Arise on all your devices, and a copy in the cloud that only you can read.',
      go: { view: 'connect', step: 'account', to: 'accountPanel', label: f.signedIn ? 'Open' : 'Set it up' },
    });
  }
  out.push({
    id: 'ai',
    name: 'AI coach',
    done: !!f.ai.engine,
    recommended: true,
    status: f.ai.engine ? (f.ai.private ? f.ai.label : `${f.ai.label}, less private`) : 'Not picked yet',
    what: 'A coach that knows your days, writes your journal and learns what helps you.',
    ...(f.ai.engine && !f.ai.private ? { less: true } : {}),
    go: { view: 'connect', step: 'ai', to: 'aiSettings', label: f.ai.engine ? 'Change' : 'Pick one' },
  });
  if (f.native || f.configured.reminders) {
    out.push({
      id: 'reminders',
      name: 'Reminders',
      done: f.reminders,
      recommended: true,
      status: f.reminders ? 'On' : 'Off',
      what: 'A nudge in the morning and a check-in in the evening, at the times you pick.',
      go: { view: 'settings', to: f.native ? 'notifyPanel' : 'remindersPanel', label: f.reminders ? 'Change' : 'Turn on' },
    });
  }
  out.push({
    id: 'phone',
    name: 'Your phone',
    done: !!f.native,
    recommended: true,
    status: f.native === 'ios' ? 'In the iPhone app' : f.native === 'android' ? 'In the Android app' : 'Needs the phone app',
    what: 'Sleep, steps, workouts, places, calendar and more, written into your days by themselves.',
    // In the phone apps, that app's own panel takes this place on Connect.
    go: { view: 'connect', step: 'connections', to: f.native === 'ios' ? 'lifePanel' : f.native === 'android' ? 'androidLifePanel' : 'hubPhone', label: f.native ? 'Pick what it reads' : 'How to get it' },
  });
  out.push({
    id: 'lock',
    name: 'App lock',
    done: f.lock,
    recommended: false,
    status: f.lock ? 'On' : 'Off',
    what: 'A passcode, or Face ID or Touch ID, when Arise opens on this device.',
    go: { view: 'connect', step: 'account', to: 'lockPanel', label: f.lock ? 'Change' : 'Turn on' },
  });
  out.push({
    id: 'accounts',
    name: 'Linked accounts',
    done: f.accounts.length > 0,
    recommended: false,
    status: f.accounts.length ? list(f.accounts) : 'None yet',
    what: 'Your calendar, email and games from Google, Microsoft, Steam and PlayStation.',
    go: { view: 'connect', step: 'connections', to: 'accountsPanel', label: f.accounts.length ? 'Open' : 'Link one' },
  });
  const comp = [f.computer.browser ? 'browser' : '', f.computer.mac ? 'Mac helper' : ''].filter(Boolean);
  out.push({
    id: 'computer',
    name: 'This computer',
    done: comp.length > 0,
    recommended: false,
    status: comp.length ? `${list(comp).replace(/^./, (c) => c.toUpperCase())} linked` : 'Not linked',
    what: 'The sites you visit, and on a Mac your calls, messages and app use.',
    go: { view: 'connect', step: 'connections', to: 'hubComputer', label: comp.length ? 'Open' : 'Link it' },
  });
  out.push({
    id: 'history',
    name: 'Your history',
    done: !!f.history?.length,
    recommended: false,
    status: f.history === null ? 'Checking…' : f.history.length ? list(f.history) : 'Nothing brought in yet',
    what: 'Years of your life from Google, Spotify, Netflix, Apple Health and more, read on this device.',
    go: { view: 'connect', step: 'connections', to: 'hubHistory', label: f.history?.length ? 'Bring in more' : 'Bring it in' },
  });
  out.push({
    id: 'apps',
    name: 'AI apps and other apps',
    done: f.apps.all > 0,
    recommended: false,
    status: f.apps.all ? `${plural(f.apps.all, 'app')} connected${f.apps.web ? `, ${f.apps.web} on the web` : ''}` : 'None yet',
    what: 'Let Claude, ChatGPT, Gemini or another app know you, with only what you pick.',
    ...(f.apps.web ? { less: true } : {}),
    go: { view: 'knows', to: 'meApps', label: f.apps.all ? 'Open' : 'Connect one' },
  });
  return out;
}

// How far along: done of all, and the next thing to do (a recommended one first).
export function progress(list: Item[]): { done: number; all: number; next: Item | null } {
  const done = list.filter((i) => i.done).length;
  const next = list.find((i) => !i.done && i.recommended) || list.find((i) => !i.done) || null;
  return { done, all: list.length, next };
}
