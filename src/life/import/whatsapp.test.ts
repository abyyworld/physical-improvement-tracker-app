import { describe, expect, it } from 'vitest';
import { chatLine, chatName, DETAIL_MAX, parseWhatsApp } from './whatsapp';
import { input, run, titles, wellFormed } from '../../test/life-fixtures';

const local = (y: number, m: number, d: number, h: number, mi: number, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime();

// iPhone export (_chat.txt inside "WhatsApp Chat - Anna.zip"), day first, with seconds.
const iphone = `[13/01/24, 21:15:04] Anna: Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
[13/01/24, 21:15:04] Anna: Hey! Are we still on for the gym tomorrow?
[13/01/24, 21:16:30] Me: Yes, 7am
[13/01/24, 21:17:02] Anna: Great.
Bring the bands please
[13/01/24, 21:20:11] Me: ‎image omitted
[14/01/24, 06:58:00] Anna: Here
`;

// Android, US: month first, AM/PM with the narrow space newer phones use.
const android = `1/13/24, 9:15 PM - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.
1/13/24, 9:15 PM - Anna: Hey! Are we still on for the gym tomorrow?
1/13/24, 9:16 PM - Me: Yes, 7am
1/14/24, 12:05 AM - Anna: Sorry, still up
1/14/24, 6:58 AM - Anna: Here
`;

describe('WhatsApp', () => {
  it('reads an iPhone export: one event per day, with the first messages as the detail', async () => {
    const { events } = await run(parseWhatsApp(input('_chat.txt', iphone), { chat: 'Anna' }));
    expect(titles(events)).toEqual(['Chatted with Anna: 5 messages', 'Chatted with Anna: 1 message']);
    expect(events.every(wellFormed)).toBe(true);
    expect(events[0]).toMatchObject({ source: 'whatsapp', kind: 'message', tier: 3, value: 5, unit: 'messages', at: local(2024, 1, 13, 21, 15, 4), end: local(2024, 1, 13, 21, 20, 11), meta: { chat: 'Anna', day: '2024-01-13' } });
    expect(events[0].detail).toContain('Anna: Hey! Are we still on for the gym tomorrow?');
    expect(events[0].detail).toContain('Anna: Great. Bring the bands please');
    expect(events[0].detail!.length).toBeLessThanOrEqual(DETAIL_MAX);
  });

  it('reads an Android export in the US way, and system lines are not messages', async () => {
    const { events } = await run(parseWhatsApp(input('WhatsApp Chat with Anna.txt', android)));
    expect(titles(events)).toEqual(['Chatted with Anna: 2 messages', 'Chatted with Anna: 2 messages']);
    expect(events[0].at).toBe(local(2024, 1, 13, 21, 15));
    expect(events[1].at).toBe(local(2024, 1, 14, 0, 5));
    expect(events[1].end).toBe(local(2024, 1, 14, 6, 58));
  });

  it('leaves out the system lines an iPhone writes as if the chat sent them', async () => {
    const group = [
      '[15/01/2024, 10:00:00] Friends: ‎Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
      '‎[15/01/2024, 10:00:00] Friends: ‎Anna created group “Friends”',
      '‎[15/01/2024, 10:00:01] Friends: ‎Anna added you',
      '[15/01/2024, 10:05:00] Anna: Welcome!',
    ].join('\n');
    const g = await run(parseWhatsApp(input('_chat.txt', group)));
    expect(titles(g.events)).toEqual(['Chatted with Anna: 1 message']);
    expect(g.events[0].detail).toBe('Anna: Welcome!');
    expect(g.events[0].at).toBe(local(2024, 1, 15, 10, 5));
    const named = await run(parseWhatsApp(input('_chat.txt', group), { chat: 'Friends' }));
    expect(titles(named.events)).toEqual(['Chatted with Friends: 1 message']);
    // One to one: the notice isn't a message, but photos (marked too) are.
    const anna = [
      '[15/01/2024, 10:00:00] Anna: ‎Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.',
      '[15/01/2024, 10:05:00] Anna: Hi',
      '[15/01/2024, 10:06:00] Anna: ‎image omitted',
      '[15/01/2024, 10:07:00] Me: Nice',
    ].join('\n');
    const one = await run(parseWhatsApp(input('WhatsApp Chat - Anna.txt', anna)));
    expect(titles(one.events)).toEqual(['Chatted with Anna: 3 messages']);
    expect(one.events[0].detail).not.toContain('encrypted');
  });

  it('reads German and other day-first exports, and names a chat from its people when the file name does not', async () => {
    // The same name every day (so the ids stay the same), from everyone in the chat.
    const de = '15.04.16, 15:04 - Ash: Hey!\n15.04.16, 15:05 - Brock: Hallo\n16.04.16, 09:00 - Misty: Morgen\n';
    const { events } = await run(parseWhatsApp(input('_chat.txt', de, 3)));
    expect(titles(events)).toEqual(['Chatted with Ash, Brock and Misty: 2 messages', 'Chatted with Ash, Brock and Misty: 1 message']);
    expect(events[0].at).toBe(local(2016, 4, 15, 15, 4));
  });

  it('keeps the detail short however long the day', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `[01/02/2024, 10:${String(i % 60).padStart(2, '0')}:00] Anna: ${'long words '.repeat(30)}${i}`).join('\n');
    const { events } = await run(parseWhatsApp(input('_chat.txt', lines), { chat: 'Anna' }));
    expect(events[0].value).toBe(300);
    expect(events[0].detail!.length).toBeLessThanOrEqual(DETAIL_MAX);
  });

  it('gives a stable id per chat and day, and copes with empty and broken files', async () => {
    const a = await run(parseWhatsApp(input('_chat.txt', iphone), { chat: 'Anna' }));
    const b = await run(parseWhatsApp(input('_chat.txt', iphone.replace(/\n/g, '\r\n'), 1), { chat: 'Anna' }));
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
    expect(a.events[0].id).not.toBe(a.events[1].id);
    expect((await run(parseWhatsApp(input('_chat.txt', '')))).events).toEqual([]);
    expect((await run(parseWhatsApp(input('_chat.txt', 'just some text\nnothing here\n')))).events).toEqual([]);
  });

  it('reads the lines and file names WhatsApp writes', () => {
    expect(chatLine('[13/01/24, 21:15:04] Anna: Hi')).toMatchObject({ date: [13, 1, 24], h: 21, m: 15, s: 4, sender: 'Anna', text: 'Hi' });
    expect(chatLine('12/31/23, 9:15 PM - John Doe: Hi: there')).toMatchObject({ sender: 'John Doe', text: 'Hi: there', pm: true });
    expect(chatLine('31/12/2023, 21:15 - +44 7700 900123: Hi')).toMatchObject({ sender: '+44 7700 900123' });
    expect(chatLine('2023-12-31, 21:15 - Ana: Hola')).toMatchObject({ date: [2023, 12, 31] });
    expect(chatLine('[31.12.23, 21:15:04] Anna: Hallo')).toMatchObject({ date: [31, 12, 23] });
    expect(chatLine('31/12/2023, 9:15 p. m. - Ana: Hola')).toMatchObject({ pm: true });
    expect(chatLine('‎[13/01/24, 21:20:11] Me: ‎image omitted')).toMatchObject({ sender: 'Me' });
    expect(chatLine('31/12/2023, 21:15 - You created group "Gym"')).toMatchObject({ sender: '' });
    expect(chatLine('Just text 12/12/2023 here')).toBeNull();
    expect(chatLine('[13/01/24, 21:15:04 - Anna: no closing bracket')).toBeNull();
    expect(chatName('WhatsApp Chat with Anna Smith.txt')).toBe('Anna Smith');
    expect(chatName('WhatsApp Chat - Gym Buddies.zip')).toBe('Gym Buddies');
    expect(chatName('WhatsApp-Chat mit Anna.txt')).toBe('Anna');
    expect(chatName('Chat de WhatsApp con Ana.txt')).toBe('Ana');
    expect(chatName('_chat.txt')).toBe('');
    expect(chatName('notes.txt')).toBe('');
  });
});
