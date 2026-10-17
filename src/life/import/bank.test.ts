import { describe, expect, it } from 'vitest';
import { amountOf, dateCell, guessCsv, parseBankCsv } from './bank';
import { input, run, titles, wellFormed } from '../../test/life-fixtures';

const local = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

describe('bank statements (CSV)', () => {
  it('guesses the columns of a UK statement with money out and in', async () => {
    const csv = `Date,Type,Description,Paid Out,Paid In,Balance
02/01/2024,DEB,TESCO STORES 3297,£12.30,,"£1,000.00"
03/01/2024,BGC,ACME LTD SALARY,,"£2,100.00","£3,087.70"
03/01/2024,DEB,COSTA COFFEE,£3.10,,"£3,084.60"
03/01/2024,DEB,COSTA COFFEE,£3.10,,"£3,081.50"
`;
    const g = guessCsv(csv);
    expect(g.ok).toBe(true);
    expect(g.columns).toEqual(['Date', 'Type', 'Description', 'Paid Out', 'Paid In', 'Balance']);
    expect(g.mapping).toMatchObject({ delimiter: ',', headerRow: 0, date: 0, description: 2, out: 3, in: 4, dateOrder: 'dmy', currency: 'GBP' });
    expect(g.mapping.amount).toBeUndefined();
    const { events } = await run(parseBankCsv(input('statement.csv', csv), g.mapping));
    expect(titles(events)).toEqual(['Spent 12.30 GBP at TESCO STORES 3297', 'Received 2,100.00 GBP: ACME LTD SALARY', 'Spent 3.10 GBP at COSTA COFFEE', 'Spent 3.10 GBP at COSTA COFFEE']);
    expect(events[0]).toMatchObject({ source: 'bank', kind: 'purchase', tier: 3, value: -12.3, unit: 'GBP', at: local(2024, 1, 2) });
    expect(events[1]).toMatchObject({ value: 2100, meta: { in: true } });
    // Two coffees the same day at the same price stay two, with ids that stay the same next time.
    expect(new Set(events.map((e) => e.id)).size).toBe(4);
    const again = await run(parseBankCsv(input('statement.csv', csv, 2), g.mapping));
    expect(again.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(events.every(wellFormed)).toBe(true);
  });

  it('reads a German statement: semicolons, decimal commas, day first, lines above the table', async () => {
    const csv = `Konto;DE12 3456 7890 1234 5678 90
Zeitraum;01.01.2024 - 31.01.2024

Buchungstag;Valuta;Auftraggeber/Empfänger;Verwendungszweck;Betrag (EUR)
15.01.2024;15.01.2024;REWE Markt GmbH;Lastschrift Einkauf;-45,67
16.01.2024;16.01.2024;Arbeitgeber AG;Gehalt Januar;2.500,00
`;
    const g = guessCsv(csv);
    expect(g.ok).toBe(true);
    expect(g.mapping).toMatchObject({ delimiter: ';', headerRow: 2, date: 0, amount: 4, dateOrder: 'dmy', spending: 'minus' });
    const { events } = await run(parseBankCsv(input('umsaetze.csv', csv), g.mapping));
    expect(events.map((e) => e.value)).toEqual([-45.67, 2500]);
    expect(events[0].at).toBe(local(2024, 1, 15));
  });

  it('reads a US card statement where spending is a plus', async () => {
    const csv = `Transaction Date,Post Date,Description,Category,Type,Amount
01/15/2024,01/16/2024,STARBUCKS #123,Food & Drink,Sale,5.75
01/20/2024,01/21/2024,AMAZON MKTPL,Shopping,Sale,23.99
01/22/2024,01/22/2024,UBER TRIP,Travel,Sale,14.20
01/25/2024,01/25/2024,Payment Thank You,,Payment,-500.00
`;
    const g = guessCsv(csv);
    expect(g.mapping).toMatchObject({ date: 0, description: 2, amount: 5, dateOrder: 'mdy' });
    // Four rows are too few to tell how spending shows, so the Player says: as a plus.
    const m = { ...g.mapping, spending: 'plus' as const };
    const { events } = await run(parseBankCsv(input('card.csv', csv), m));
    expect(titles(events)[0]).toBe('Spent 5.75 at STARBUCKS #123');
    expect(events[3].title).toBe('Received 500.00: Payment Thank You');
    expect(events[1].at).toBe(local(2024, 1, 20));
  });

  it('doesn’t take descriptions with numbers in them for the amount', async () => {
    const csv = `日付,摘要,金額
2024/03/01,ローソン 店舗 1234,-450
2024/03/02,セブンイレブン 店 0815,-320
2024/03/25,給与 2024年3月,250000
2024/03/26,ファミリーマート 5521,-180
`;
    const g = guessCsv(csv);
    expect(g.mapping).toMatchObject({ headerRow: 0, date: 0, description: 1, amount: 2, dateOrder: 'ymd' });
    const { events } = await run(parseBankCsv(input('meisai.csv', csv), g.mapping));
    expect(titles(events).slice(0, 3)).toEqual(['Spent 450.00 at ローソン 店舗 1234', 'Spent 320.00 at セブンイレブン 店 0815', 'Received 250,000.00: 給与 2024年3月']);
  });

  it('picks the column that says who was paid, not an id or the bank’s own text', async () => {
    const monzo = `Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In
tx_0000AbCdEf,15/01/2024,08:15:00,Card payment,Pret A Manger,,Eating out,-4.50,GBP,-4.50,GBP,,1 Main St,,PRET A MANGER LONDON GBR,,-4.50,
tx_0000AbCdEg,16/01/2024,12:00:00,Faster payment,Anna Smith,,Transfers,20.00,GBP,20.00,GBP,,,,Lunch money,,,20.00
`;
    const m = guessCsv(monzo);
    expect(m.columns[m.mapping.description]).toBe('Name');
    expect(titles((await run(parseBankCsv(input('monzo.csv', monzo), m.mapping))).events)[0]).toBe('Spent 4.50 at Pret A Manger');

    const sparkasse = `Auftragskonto;Buchungstag;Valutadatum;Buchungstext;Verwendungszweck;Glaeubiger ID;Mandatsreferenz;Kundenreferenz (End-to-End);Sammlerreferenz;Lastschrift Ursprungsbetrag;Auslagenersatz Ruecklastschrift;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;BIC (SWIFT-Code);Betrag;Waehrung;Info
DE12345678901234567890;15.01.24;15.01.24;KARTENZAHLUNG;2024-01-14 Debitk.1;;;;;;;REWE SAGT DANKE;DE00123456780000000000;COBADEFFXXX;-12,30;EUR;Umsatz gebucht
DE12345678901234567890;16.01.24;16.01.24;GUTSCHRIFT;Gehalt Januar;;;;;;;Arbeitgeber AG;DE00987654320000000000;COBADEFFXXX;2.500,00;EUR;Umsatz gebucht
`;
    const s = guessCsv(sparkasse);
    expect(s.columns[s.mapping.description]).toBe('Beguenstigter/Zahlungspflichtiger');
    expect(s.columns[s.mapping.amount!]).toBe('Betrag');

    const chase = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,01/15/2024,STARBUCKS STORE 123,-4.50,DEBIT_CARD,1000.00,
CREDIT,01/16/2024,ACME PAYROLL,2000.00,ACH_CREDIT,3000.00,
`;
    const c = guessCsv(chase);
    expect(c.columns[c.mapping.description]).toBe('Description');
  });

  it('says when it finds no dates or amounts, and copes with empty files', async () => {
    expect(guessCsv('name,city\nAnna,London\n').ok).toBe(false);
    expect(guessCsv('').ok).toBe(false);
    const g = guessCsv('Date,Description,Amount\n');
    expect((await run(parseBankCsv(input('x.csv', ''), g.mapping))).events).toEqual([]);
  });

  it('reads amounts and dates written every way', () => {
    expect(amountOf('12.30')).toBe(12.3);
    expect(amountOf('-1,234.56')).toBe(-1234.56);
    expect(amountOf('1.234,56 €')).toBe(1234.56);
    expect(amountOf('(12.30)')).toBe(-12.3);
    expect(amountOf('12.30-')).toBe(-12.3);
    expect(amountOf('£12.30 DR')).toBe(-12.3);
    expect(amountOf('12,30')).toBe(12.3);
    expect(amountOf('1,234')).toBe(1234);
    expect(amountOf('1 234,50')).toBe(1234.5);
    expect(amountOf('abc')).toBeNaN();
    expect(amountOf('')).toBeNaN();
    // Currency names and marks around the number are fine…
    expect(amountOf('USD 12.30')).toBe(12.3);
    expect(amountOf('12,30 zł')).toBe(12.3);
    expect(amountOf('R$ 1.234,56')).toBe(1234.56);
    expect(amountOf('1,234円')).toBe(1234);
    expect(amountOf('12.30CR')).toBe(12.3);
    // …but other words make it a description with a number in it, not an amount.
    expect(amountOf('STARBUCKS STORE 123')).toBeNaN();
    expect(amountOf('給与 2024年3月')).toBeNaN();
    expect(amountOf('ローソン 店舗 1234')).toBeNaN();
    expect(amountOf('DEBIT_CARD')).toBeNaN();
    expect(dateCell('2024-01-31 14:05:00')).toEqual({ parts: [2024, 1, 31], h: 14, m: 5 });
    expect(dateCell('31 Jan 2024')).toEqual({ ymd: [2024, 1, 31] });
    expect(dateCell('Jan 31, 2024')).toEqual({ ymd: [2024, 1, 31] });
    expect(dateCell('20240131')).toEqual({ ymd: [2024, 1, 31] });
    expect(dateCell('Tesco')).toBeNull();
  });
});
