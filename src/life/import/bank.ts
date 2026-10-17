// A bank or card statement saved as CSV. Every bank writes its own, so the columns are guessed
// from their names (in several languages) and their contents, and the Player checks the guess:
// which column is the date, the description, and the amount (or money out and money in).

import type { LifeEvent } from '../types';
import type { CsvGuess, CsvMapping, TextInput } from './types';
import { CsvRows, sniffDelimiter } from './text-stream';
import { clean, drain, guessOrder, hashId, localMs, Repeats, ymdOf } from './util';

const DATE_NAMES = /(^|\b)(date|datum|fecha|data|tarih|sana|дата|booking|buchung|posted|posting|transaction date|trans\.? date|value date|valuta|wertstellung|completed|started|time)/i;
const DESC_NAMES = /(description|details|payee|merchant|name|memo|narrative|reference|particulars|counterparty|verwendungszweck|beschreibung|buchungstext|empfänger|auftraggeber|concepto|descripci|libell|descri|tavsif|назначение|описание|получатель|transaction)/i;
const AMOUNT_NAMES = /^(.*\s)?(amount|betrag|importe|montant|valor|valore|bedrag|kwota|сумма|summa|tutar|value|sum)(\s.*)?$/i;
const OUT_NAMES = /(debit|money out|paid out|withdrawal|outgoing|spent|soll|ausgang|lastschrift|cargo|débit|расход|списание)/i;
const IN_NAMES = /(credit|money in|paid in|deposit|incoming|received|haben|eingang|gutschrift|abono|crédit|приход|зачисление)/i;
const NOT_AMOUNT = /\b(balance|saldo|kontostand|solde|currency|währung|rate|fee|id|number|nr)\b|остаток/i;

// "12.30", "-1,234.56", "1.234,56 €", "(12.30)", "12.30-", "£12.30 DR" → a number. NaN if not one.
export function amountOf(v: string | undefined): number {
  if (!v) return NaN;
  let s = v.trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) (neg = true), (s = s.slice(1, -1));
  if (/\bDR\b|\bDebit\b/i.test(s)) neg = true;
  s = s.replace(/\b(CR|DR|Credit|Debit)\b/gi, '');
  if (/-\s*$/.test(s)) (neg = true), (s = s.replace(/-\s*$/, ''));
  s = s.replace(/[^\d,.\-+]/g, '');
  if (s.startsWith('-')) (neg = !neg), (s = s.slice(1));
  else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d[\d,.]*$/.test(s)) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both: the last one is the decimal point.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Only commas: "12,30" is a decimal comma; "1,234" and "1,234,567" are thousands.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    if ((s.match(/\./g) ?? []).length > 1) return NaN;
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, ''); // "1.234.567"
  }
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

// A date at the start of a cell: three numbers ("31/12/2024", "2024-12-31", "31.12.24") or
// "31 Dec 2024" / "Dec 31, 2024", maybe with a time after it.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export interface CellDate {
  parts?: [number, number, number]; // numbers, order still to be worked out
  ymd?: [number, number, number]; // already certain (month written as a word, or 8 digits)
  h?: number;
  m?: number;
}

export function dateCell(v: string | undefined): CellDate | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  let r: CellDate | null = null;
  let rest = '';
  let m = s.match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})(.*)$/);
  if (m) {
    r = { parts: [+m[1], +m[2], +m[3]] };
    rest = m[4];
  } else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(\s.*)?$/))) {
    r = { ymd: [+m[1], +m[2], +m[3]] };
    rest = m[4] ?? '';
  } else if ((m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*\.?[\s-]+(\d{2,4})(.*)$/))) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    if (mo) r = { ymd: [+m[3] < 100 ? 2000 + +m[3] : +m[3], mo, +m[1]] };
    rest = m[4];
  } else if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(.*)$/))) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (mo) r = { ymd: [+m[3], mo, +m[2]] };
    rest = m[4];
  }
  if (!r) return null;
  const t = rest.match(/(\d{1,2}):(\d{2})/);
  if (t) (r.h = +t[1]), (r.m = +t[2]);
  return r;
}

const colName = (h: string[], i: number) => clean(h[i], 40) || `Column ${i + 1}`;

// Reads the start of a CSV and guesses its columns.
export function guessCsv(head: string): CsvGuess {
  const delimiter = sniffDelimiter(head);
  const p = new CsvRows(delimiter);
  const rows = [...p.push(head), ...p.end()].filter((r) => r.some((c) => c.trim())).slice(0, 200);
  // The most common number of columns (more than one) is the table; rows above it (account
  // details) are skipped.
  const freq = new Map<number, number>();
  for (const r of rows) if (r.length > 1) freq.set(r.length, (freq.get(r.length) ?? 0) + 1);
  let width = 0;
  for (const [w, f] of freq) if (f > (freq.get(width) ?? 0) || (f === freq.get(width) && w > width)) width = w;
  const first = rows.findIndex((r) => r.length === width);
  let headerRow = -1;
  let body = rows.slice(first);
  if (first >= 0 && rows[first].every((c) => !dateCell(c) && !Number.isFinite(amountOf(c)))) {
    headerRow = first; // counted without blank lines, as parseBankCsv counts
    body = rows.slice(first + 1);
  }
  const names = headerRow >= 0 ? rows[headerRow].map((c) => c.trim()) : [];
  const columns = Array.from({ length: width }, (_, i) => colName(names, i));
  const sample = body.filter((r) => r.length === width).slice(0, 50);

  const score = (i: number, test: (v: string) => boolean) => sample.filter((r) => test(r[i] ?? '')).length / Math.max(1, sample.length);
  const isDate = (v: string) => !!dateCell(v);
  const isAmount = (v: string) => Number.isFinite(amountOf(v)) && !dateCell(v);
  const idx = Array.from({ length: width }, (_, i) => i);
  const byName = (re: RegExp, skip: number[] = []) => idx.find((i) => !skip.includes(i) && re.test(names[i] ?? ''));

  let date = byName(DATE_NAMES);
  if (date === undefined || score(date, isDate) < 0.5) date = idx.find((i) => score(i, isDate) >= 0.8) ?? date;
  let out = byName(OUT_NAMES, [date ?? -1]);
  let inn = byName(IN_NAMES, [date ?? -1, out ?? -1]);
  let amount = byName(AMOUNT_NAMES, [date ?? -1]);
  if (amount !== undefined && NOT_AMOUNT.test(names[amount] ?? '')) amount = undefined;
  if (amount === undefined && (out === undefined || inn === undefined)) {
    amount = idx.find((i) => i !== date && !NOT_AMOUNT.test(names[i] ?? '') && score(i, isAmount) >= 0.8);
  }
  if (amount !== undefined && score(amount, isAmount) < 0.5) amount = undefined;
  if (amount !== undefined) out = inn = undefined;
  // The description: a named column, else the one with the longest text that isn't a number.
  let description = byName(DESC_NAMES, [date ?? -1, amount ?? -1, out ?? -1, inn ?? -1]);
  if (description === undefined) {
    let best = -1;
    for (const i of idx) {
      if ([date, amount, out, inn].includes(i)) continue;
      const avg = sample.reduce((s, r) => s + (isAmount(r[i] ?? '') ? 0 : (r[i] ?? '').trim().length), 0) / Math.max(1, sample.length);
      if (avg > best) (best = avg), (description = i);
    }
  }
  // Day or month first, from all the dates.
  const parts = sample.map((r) => dateCell(r[date ?? -1])?.parts).filter((x): x is [number, number, number] => !!x);
  const dateOrder = guessOrder(parts, 'dmy');
  // One amount column where nearly everything is plus: a card statement, where spending is plus.
  let spending: 'minus' | 'plus' = 'minus';
  if (amount !== undefined) {
    const vals = sample.map((r) => amountOf(r[amount!])).filter(Number.isFinite);
    const neg = vals.filter((v) => v < 0).length;
    if (vals.length >= 3 && neg / vals.length < 0.1) spending = 'plus';
  }
  const currency = currencyOf(sample.map((r) => [amount, out, inn].map((i) => (i === undefined ? '' : r[i] ?? '')).join(' ')).join(' '));
  const mapping: CsvMapping = { delimiter, headerRow, date: date ?? 0, description: description ?? 0, dateOrder, spending };
  if (amount !== undefined) mapping.amount = amount;
  if (out !== undefined) mapping.out = out;
  if (inn !== undefined) mapping.in = inn;
  if (currency) mapping.currency = currency;
  return { mapping, columns, sample: sample.slice(0, 5), ok: date !== undefined && (amount !== undefined || (out !== undefined && inn !== undefined)) && sample.length > 0 };
}

const SYMBOLS: [RegExp, string][] = [
  [/£/, 'GBP'],
  [/€/, 'EUR'],
  [/\$/, 'USD'],
  [/₽/, 'RUB'],
  [/¥/, 'JPY'],
  [/₹/, 'INR'],
  [/₺/, 'TRY'],
  [/\b(GBP|EUR|USD|RUB|UZS|KZT|CHF|SEK|NOK|DKK|PLN|CZK|TRY|INR|JPY|CNY|AUD|CAD|NZD)\b/, ''],
];

function currencyOf(text: string): string | undefined {
  for (const [re, code] of SYMBOLS) {
    const m = text.match(re);
    if (m) return code || m[1];
  }
  return undefined;
}

export function money(n: number, currency?: string): string {
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${v} ${currency}` : v;
}

export async function* parseBankCsv(input: TextInput, mapping: CsvMapping): AsyncGenerator<LifeEvent[]> {
  const csv = new CsvRows(mapping.delimiter);
  const repeats = new Repeats();
  const out: LifeEvent[] = [];
  let row = -1;
  const take = (r: string[]) => {
    if (!r.some((c) => c.trim())) return; // blank lines don't count, as in guessCsv
    row++;
    if (row <= mapping.headerRow) return;
    const d = dateCell(r[mapping.date]);
    if (!d) return;
    const ymd = d.ymd ?? (d.parts ? ymdOf(d.parts, mapping.dateOrder) : null);
    if (!ymd) return;
    let amount: number;
    if (mapping.amount !== undefined) {
      amount = amountOf(r[mapping.amount]);
      if (mapping.spending === 'plus') amount = -amount;
    } else {
      const o = amountOf(r[mapping.out ?? -1]);
      const i = amountOf(r[mapping.in ?? -1]);
      amount = (Number.isFinite(i) ? Math.abs(i) : 0) - (Number.isFinite(o) ? Math.abs(o) : 0);
    }
    if (!Number.isFinite(amount) || amount === 0) return;
    const desc = clean(r[mapping.description], 120) || 'No description';
    const at = localMs(ymd[0], ymd[1], ymd[2], d.h ?? 12, d.m ?? 0);
    if (!Number.isFinite(at)) return;
    const key = `${ymd.join('-')}\u0001${desc}\u0001${amount}`;
    const n = repeats.next(key);
    const cur = mapping.currency;
    const e: LifeEvent = {
      id: `bank:${hashId(ymd.join('-'), desc, amount, n)}`,
      source: 'bank',
      kind: 'purchase',
      at,
      title: amount < 0 ? `Spent ${money(amount, cur)} at ${desc}` : `Received ${money(amount, cur)}: ${desc}`,
      value: Math.round(amount * 100) / 100,
      unit: cur ?? '',
      tier: 3,
    };
    if (amount > 0) e.meta = { in: true };
    out.push(e);
  };
  for await (const chunk of input.text) {
    for (const r of csv.push(chunk)) take(r);
    yield* drain(out);
  }
  for (const r of csv.end()) take(r);
  yield* drain(out, true);
}
