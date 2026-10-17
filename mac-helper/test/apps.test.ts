// App use: what macOS says is in front, and the time added up per app and hour.

import { describe, expect, it } from 'vitest';
import { AppTracker, appName, findAppName, parseAppInfo, parseFront, parseIdle, rememberAppName } from '../src/apps.mjs';

const T0 = Date.parse('2025-06-01T10:00:00Z');
const safari = { bundle: 'com.apple.Safari', name: 'Safari' };
const xcode = { bundle: 'com.apple.dt.Xcode', name: 'Xcode' };

// Looks every 15 seconds from `from` (seconds after T0) with this app in front, until `to`, when
// nothing is (so exactly that stretch counts).
function run(t: AppTracker, from: number, to: number, app: { bundle: string; name: string } | null, idle = 1) {
  const out = [];
  for (let s = from; s < to; s += 15) out.push(...t.tick(T0 + s * 1000, app, idle));
  out.push(...t.tick(T0 + to * 1000, null, idle));
  return out;
}

describe('what macOS says', () => {
  it("reads lsappinfo's front app and its details", () => {
    expect(parseFront('ASN:0x0-0x2b02b:\n')).toBe('ASN:0x0-0x2b02b:');
    expect(parseFront('')).toBe('');
    expect(parseAppInfo('"CFBundleIdentifier"="com.apple.Safari"\n"LSDisplayName"="Safari"\n')).toEqual(safari);
    expect(parseAppInfo('"LSDisplayName"="Something"')).toBeNull();
    expect(parseAppInfo('"CFBundleIdentifier"="com.spotify.client"')).toEqual({ bundle: 'com.spotify.client', name: 'Spotify' });
  });

  it("reads ioreg's idle time in seconds", () => {
    const out = `+-o IOHIDSystem  <class IOHIDSystem, id 0x100000a1c, registered, matched, active, busy 0 (0 ms), retain 26>
    {
      "HIDIdleTime" = 12500000000
      "HIDParameters" = {"HIDDefaultParameters"=Yes}
    }`;
    expect(parseIdle(out)).toBe(12.5);
    expect(parseIdle('nothing')).toBeNull();
  });

  it('names apps', async () => {
    expect(appName('com.apple.MobileSMS')).toBe('Messages');
    expect(appName('com.spotify.client')).toBe('Spotify');
    expect(appName('org.example.coolapp')).toBe('Coolapp');
    rememberAppName('org.example.coolapp', 'Cool App');
    expect(appName('org.example.coolapp')).toBe('Cool App');
    const run = async (_cmd: string, args: string[]) => (args[0].includes("'com.tinyspeck.slackmacgap'") ? '/Applications/Slack.app\n' : '');
    expect(await findAppName('com.tinyspeck.slackmacgap', run)).toBe('Slack');
    expect(await findAppName("bad'id", run)).toBe('');
  });
});

describe('time per app and hour', () => {
  it('adds up the time in front, and hands an hour over once it ends', () => {
    const t = new AppTracker();
    expect(run(t, 0, 600, safari)).toEqual([]); // 10 minutes of Safari
    expect(run(t, 600, 900, xcode)).toEqual([]); // 5 of Xcode
    const out = run(t, 3600, 3615, safari);
    expect(out).toEqual([
      { id: `mac:app:com.apple.Safari:${T0}`, source: 'mac', kind: 'app', at: T0, end: T0 + 600_000, title: 'Used Safari for 10 min', value: 10, unit: 'min', tier: 2, meta: { app: 'com.apple.Safari' } },
      expect.objectContaining({ id: `mac:app:com.apple.dt.Xcode:${T0}`, title: 'Used Xcode for 5 min', value: 5 }),
    ]);
  });

  it('splits time across the hour', () => {
    const t = new AppTracker();
    // 10:55 to 11:05: the 10:00 hour is handed over at the first look after 11:00.
    const out = [...run(t, 3300, 3900, xcode), ...t.tick(T0 + 2 * 3600_000, null, 1)];
    expect(out.map((e) => [e.id, e.value])).toEqual([
      [`mac:app:com.apple.dt.Xcode:${T0}`, 5],
      [`mac:app:com.apple.dt.Xcode:${T0 + 3600_000}`, 5],
    ]);
  });

  it("doesn't count the lock screen, the screen saver, time away, or a sleeping Mac", () => {
    const t = new AppTracker();
    run(t, 0, 120, safari);
    run(t, 120, 600, { bundle: 'com.apple.loginwindow', name: 'loginwindow' });
    run(t, 600, 900, { bundle: 'com.apple.ScreenSaver.Engine', name: 'ScreenSaverEngine' });
    // In front, but no key press or mouse move for 10 minutes and more.
    run(t, 900, 1500, xcode, 600);
    // Asleep for 20 minutes between two looks: at most a minute counts (2 min + 1 min + 15 sec).
    t.tick(T0 + 1500_000, safari, 1);
    t.tick(T0 + 2700_000, safari, 1);
    t.tick(T0 + 2715_000, null, 1);
    const out = t.tick(T0 + 3600_000, null, 1);
    expect(out.map((e) => [e.meta?.app, e.title])).toEqual([['com.apple.Safari', 'Used Safari for 3 min']]);
  });

  it('stops counting from the last input once someone is away', () => {
    const t = new AppTracker();
    for (let s = 0; s <= 240; s += 15) t.tick(T0 + s * 1000, xcode, 1);
    // The next look comes late, and nobody has touched the Mac for 6 minutes: it stopped at 4:00.
    t.tick(T0 + 600_000, xcode, 360);
    const out = t.tick(T0 + 3600_000, null, 1);
    expect(out.map((e) => [e.value, e.end])).toEqual([[4, T0 + 240_000]]);
  });

  it('leaves out an app used under a minute in an hour', () => {
    const t = new AppTracker();
    run(t, 0, 45, safari);
    expect(t.tick(T0 + 3600_000, null, 1)).toEqual([]);
  });

  it('keeps its hour across a restart', () => {
    const t = new AppTracker();
    run(t, 0, 600, safari);
    const again = new AppTracker({}, JSON.parse(JSON.stringify(t)));
    run(again, 600, 1200, safari);
    expect(again.tick(T0 + 3600_000, null, 1)).toEqual([expect.objectContaining({ value: 20 })]);
    expect(new AppTracker({}, { buckets: { x: { bundle: 1 } }, prev: 'nope' }).toJSON()).toEqual({ buckets: {}, prev: null });
  });
});
