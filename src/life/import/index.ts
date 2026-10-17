// Bringing in years of history from the exports services give people. The file is read here,
// on the device (in a Web Worker: see client.ts and worker.ts), and nothing is uploaded.
//
//   detect(file)          what the file (or zip) holds, and anything to ask before reading it
//   importFile(file, …)   reads it, handing over events about 500 at a time
//
// Both work on any Blob with a name (a File), anywhere: the worker, the page, or a test.

import type { LifeEvent } from '../types';
import type { Detection, Found, ImportChoices, ImportKind, ImportOptions, ImportResult, Progress, TextInput } from './types';
import { entryBytes, entryHead, isZip, listZip, ZipError, type ZipEntry } from './zip';
import { parseChromeHistory, parseMyActivity } from './google';
import { parseSemanticHistory, parseTimeline } from './maps';
import { parseSpotify } from './spotify';
import { netflixProfiles, parseNetflixActivity, parseNetflixHistory } from './netflix';
import { parseAppleHealth } from './health';
import { chatLine, chatName, parseWhatsApp } from './whatsapp';
import { guessCsv, parseBankCsv } from './bank';

export type * from './types';

type Named = Blob & { name?: string };

const CHUNK = 1 << 20;
const SNIFF = 8192;
const CSV_HEAD = 256 << 10;

// ---------- reading

async function* fileBytes(blob: Blob, onRead?: (n: number) => void, limit = Infinity): AsyncGenerator<Uint8Array> {
  const end = Math.min(blob.size, limit);
  for (let at = 0; at < end; at += CHUNK) {
    const b = new Uint8Array(await blob.slice(at, Math.min(end, at + CHUNK)).arrayBuffer());
    onRead?.(b.length);
    yield b;
  }
}

async function* decode(bytes: AsyncIterable<Uint8Array>, encoding = 'utf-8'): AsyncGenerator<string> {
  const d = new TextDecoder(encoding);
  for await (const b of bytes) {
    const s = d.decode(b, { stream: true });
    if (s) yield s;
  }
  const t = d.decode();
  if (t) yield t;
}

// Some banks still write Windows-1252: if the start isn't UTF-8, read it as that.
function encodingOf(head: Uint8Array): string | undefined {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return undefined;
  } catch {
    return 'windows-1252';
  }
}

async function text(it: AsyncIterable<string>, max = Infinity): Promise<string> {
  let s = '';
  for await (const c of it) {
    s += c;
    if (s.length >= max) break;
  }
  return s;
}

// ---------- what a file is

export const KIND_LABEL: Record<ImportKind, string> = {
  'google-activity': 'Google activity',
  'chrome-history': 'Chrome history',
  'maps-timeline': 'Google Maps Timeline',
  'maps-semantic': 'Google Maps Timeline (older export)',
  'spotify-account': 'Spotify listening (last year)',
  'spotify-extended': 'Spotify listening (all years)',
  'netflix-activity': 'Netflix viewing',
  'netflix-history': 'Netflix viewing (days only)',
  'apple-health': 'Apple Health',
  whatsapp: 'WhatsApp chat',
  'bank-csv': 'Bank statement',
};

const isChat = (head: string) => {
  const lines = head.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 15);
  const hits = lines.filter((l) => chatLine(l)?.sender).length;
  return hits >= Math.min(2, lines.length) && hits > 0;
};

// What a file holds, from its name and its first few kilobytes. 'html' for a Google Takeout
// made with HTML instead of JSON. null for anything else.
export function classify(name: string, head: string, inZip: boolean): ImportKind | 'html' | null {
  const t = head.replace(/^﻿/, '').trimStart();
  const lower = name.toLowerCase();
  if (t.startsWith('<')) {
    if (/<HealthData[\s>]|<!DOCTYPE HealthData/.test(t)) return 'apple-health';
    if (/<html/i.test(t) && /outer-cell|content-cell|mdl-grid/.test(t)) return 'html';
    return null;
  }
  // JSON: an object, or an array of objects (an iPhone WhatsApp chat starts with "[13/01/24" too).
  if (/^\{|^\[\s*([[{"\]]|$)/.test(t)) {
    if (/"semanticSegments"\s*:/.test(t)) return 'maps-timeline';
    if (/^\[\s*\{/.test(t) && /"(startTime|endTime)"\s*:/.test(t) && /"(visit|activity|timelinePath|timelineMemory)"\s*:/.test(t)) return 'maps-timeline';
    if (/"timelineObjects"\s*:/.test(t)) return 'maps-semantic';
    if (/"Browser History"\s*:/.test(t)) return 'chrome-history';
    if (/"ms_played"\s*:|"master_metadata_track_name"\s*:/.test(t)) return 'spotify-extended';
    if (/"msPlayed"\s*:/.test(t)) return 'spotify-account';
    if (/^\[\s*\{/.test(t) && /"header"\s*:/.test(t) && /"title"\s*:/.test(t) && /"time"\s*:/.test(t)) return 'google-activity';
    return null;
  }
  const first = (t.split(/\r\n|\n|\r/, 1)[0] ?? '').toLowerCase().replace(/"/g, '').trim();
  if (/^profile name,start time,duration\b/.test(first)) return 'netflix-activity';
  if (/^title,date$/.test(first)) return 'netflix-history';
  // The same files with the column names in another language: known by their names.
  const columns = first.split(',').length;
  if (/netflixviewinghistory[^/]*\.csv$/.test(lower) && columns === 2) return 'netflix-history';
  if (/viewingactivity\.csv$/.test(lower) && columns >= 7) return 'netflix-activity';
  if ((lower.endsWith('.txt') || !/\.\w{2,4}$/.test(lower)) && isChat(t)) return 'whatsapp';
  if (!inZip && /\.(csv|tsv|txt)$/.test(lower)) return 'bank-csv';
  return null;
}

function labelFor(kind: ImportKind, path: string, outer: string): string {
  if (kind === 'google-activity') {
    if (/youtube/i.test(path)) return /search/i.test(path) ? 'YouTube searches' : 'YouTube history';
    const parts = path.split('/');
    const product = parts.length >= 3 ? parts[parts.length - 2] : '';
    return product ? `Google activity: ${product}` : KIND_LABEL[kind];
  }
  if (kind === 'whatsapp') {
    const who = chatName(path) || chatName(outer);
    return who ? `WhatsApp chat with ${who}` : KIND_LABEL[kind];
  }
  return KIND_LABEL[kind];
}

// Google Photos and the like put a JSON next to every photo: never worth a look.
const SKIP = /\.(jpe?g|png|heic|heif|gif|webp|mp4|mov|avi|3gp|m4v|dng|raw)\.json$|supplemental-metadata|archive_browser\.html$/i;
const LOOK = /\.(json|csv|tsv|txt|xml|html?)$/i;

// What's in a file: which sources, and what to ask before reading them.
export async function detect(file: Named): Promise<Detection> {
  const name = file.name ?? 'file';
  const d: Detection = { name, size: file.size, zip: false, found: [] };
  if (!file.size) return { ...d, problem: 'empty' };
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (magic[0] === 0x1f && magic[1] === 0x8b) return { ...d, problem: 'tgz' };
  let html = 0;
  if (await isZip(file)) {
    d.zip = true;
    let entries: ZipEntry[];
    try {
      entries = await listZip(file);
    } catch {
      return { ...d, problem: 'unknown' };
    }
    let unopenable = 0;
    for (const e of entries) {
      if (!e.size || SKIP.test(e.name) || !LOOK.test(e.name)) continue;
      let head: Uint8Array;
      try {
        head = await entryHead(file, e, SNIFF);
      } catch (err) {
        if (err instanceof ZipError && err.code === 'method') unopenable++;
        continue;
      }
      const encoding = encodingOf(head);
      const kind = classify(e.name, new TextDecoder(encoding ?? 'utf-8').decode(head), true);
      if (kind === 'html') html++;
      else if (kind) d.found.push(await describe(kind, e.name, e.packed, name, encoding, () => decode(entryBytes(file, e), encoding)));
    }
    if (!d.found.length) d.problem = html ? 'html' : unopenable ? 'zip-method' : 'unknown';
  } else {
    const head = new Uint8Array(await file.slice(0, SNIFF).arrayBuffer());
    const encoding = encodingOf(head);
    const kind = classify(name, new TextDecoder(encoding ?? 'utf-8').decode(head), false);
    if (kind === 'html') html++;
    else if (kind) {
      const f = await describe(kind, name, file.size, name, encoding, () => decode(fileBytes(file), encoding));
      if (f.kind !== 'bank-csv' || f.csv?.ok) d.found.push(f);
    }
    if (!d.found.length) d.problem = html ? 'html' : 'unknown';
  }
  if (html && d.found.length) d.html = html;
  return d;
}

async function describe(kind: ImportKind, path: string, size: number, outer: string, encoding: string | undefined, read: () => AsyncIterable<string>): Promise<Found> {
  const f: Found = { kind, path, size, label: labelFor(kind, path, outer) };
  if (encoding) f.encoding = encoding;
  if (kind === 'netflix-activity') f.profiles = await netflixProfiles({ name: path, text: read() });
  if (kind === 'bank-csv') f.csv = guessCsv(await text(read(), CSV_HEAD));
  if (kind === 'whatsapp') {
    const who = chatName(path) || chatName(outer);
    if (who) f.chat = who;
  }
  return f;
}

// ---------- reading it in

class Cancelled extends Error {}

function parserFor(f: Found, input: TextInput, choices: ImportChoices): AsyncGenerator<LifeEvent[]> {
  switch (f.kind) {
    case 'google-activity':
      return parseMyActivity(input);
    case 'chrome-history':
      return parseChromeHistory(input);
    case 'maps-timeline':
      return parseTimeline(input);
    case 'maps-semantic':
      return parseSemanticHistory(input);
    case 'spotify-account':
    case 'spotify-extended':
      return parseSpotify(input);
    case 'netflix-activity':
      return parseNetflixActivity(input, { profiles: choices.profiles });
    case 'netflix-history':
      return parseNetflixHistory(input);
    case 'apple-health':
      return parseAppleHealth(input);
    case 'whatsapp':
      return parseWhatsApp(input, { chat: f.chat });
    case 'bank-csv':
      return parseBankCsv(input, choices.csv ?? f.csv!.mapping);
  }
}

export async function importFile(file: Named, opts: ImportOptions): Promise<ImportResult> {
  const detection = opts.detection ?? (await detect(file));
  const parts = detection.found.filter((f) => !opts.paths || opts.paths.includes(f.path));
  const result: ImportResult = { found: 0, added: 0, labels: [] };
  if (detection.problem) result.problem = detection.problem;
  if (!parts.length) return result;
  const total = parts.reduce((s, f) => s + f.size, 0);
  const entries = detection.zip ? new Map((await listZip(file)).map((e) => [e.name, e])) : null;
  let read = 0;
  let label = '';
  let last = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!opts.onProgress || (!force && now - last < 100)) return;
    last = now;
    const p: Progress = { read: Math.min(read, total), total, found: result.found, label };
    opts.onProgress(p);
  };
  const onRead = (n: number) => {
    read += n;
    report();
  };
  const signal = opts.signal;
  // Every piece read is a chance to stop.
  async function* guard(it: AsyncIterable<string>): AsyncGenerator<string> {
    for await (const s of it) {
      if (signal?.aborted) throw new Cancelled();
      yield s;
    }
  }
  try {
    for (const f of parts) {
      if (signal?.aborted) throw new Cancelled();
      label = f.label;
      report(true);
      const before = read;
      const entry = entries?.get(f.path);
      if (entries && !entry) continue;
      const bytes = entry ? entryBytes(file, entry, onRead) : fileBytes(file, onRead);
      const input: TextInput = { name: f.path, text: guard(decode(bytes, f.encoding)) };
      for await (const batch of parserFor(f, input, opts)) {
        if (!batch.length) continue;
        for (const e of batch) {
          if (result.from === undefined || e.at < result.from) result.from = e.at;
          if (result.to === undefined || e.at > result.to) result.to = e.at;
        }
        result.found += batch.length;
        const added = await opts.onEvents(batch);
        result.added += typeof added === 'number' && Number.isFinite(added) ? added : batch.length;
        if (signal?.aborted) throw new Cancelled();
        report();
      }
      read = before + f.size;
      if (!result.labels.includes(f.label)) result.labels.push(f.label);
    }
  } catch (err) {
    if (err instanceof Cancelled) result.cancelled = true;
    else if (err instanceof ZipError) result.problem = err.code === 'method' ? 'zip-method' : 'unknown';
    else throw err;
  }
  report(true);
  return result;
}

