// The shapes the importers share: what a file holds (detect), how an import is asked for, and
// what it reports back. The events themselves are LifeEvents (../types).

import type { LifeEvent } from '../types';

// One kind of file Arise knows how to read.
export type ImportKind =
  | 'google-activity' // Takeout My Activity, and YouTube's watch-history.json / search-history.json
  | 'chrome-history' // Takeout Chrome BrowserHistory.json (or History.json)
  | 'maps-timeline' // Timeline.json exported from Google Maps on the phone (since 2024)
  | 'maps-semantic' // Takeout Semantic Location History (before 2024)
  | 'spotify-account' // StreamingHistory_music_*.json / StreamingHistory_podcast_*.json
  | 'spotify-extended' // Streaming_History_Audio_*.json / Streaming_History_Video_*.json
  | 'netflix-activity' // ViewingActivity.csv from the full data request
  | 'netflix-history' // NetflixViewingHistory.csv from the website
  | 'apple-health' // apple_health_export/export.xml
  | 'whatsapp' // an exported chat (.txt, or the .zip it comes in)
  | 'bank-csv'; // a bank or card statement saved as CSV

// Which column is which in a bank statement. Columns are counted from 0.
export interface CsvMapping {
  delimiter: string;
  headerRow: number; // the row with the column names, or -1 when there is none
  date: number;
  description: number;
  amount?: number; // one column, money out and in
  out?: number; // or two: money out…
  in?: number; // …and money in
  dateOrder: 'dmy' | 'mdy' | 'ymd';
  spending: 'minus' | 'plus'; // how money out shows in `amount`
  currency?: string;
}

export interface CsvGuess {
  mapping: CsvMapping;
  columns: string[]; // the names (or "Column 1"…) to choose from
  sample: string[][]; // the first few rows
  ok: boolean; // a date and an amount were found
}

// One file Arise can read: a whole file, or one entry of a zip.
export interface Found {
  kind: ImportKind;
  path: string; // the entry's path in the zip, or the file's name
  size: number; // bytes as stored (packed size in a zip)
  label: string; // plain words: "YouTube history"
  profiles?: string[]; // Netflix: the profiles in the file
  csv?: CsvGuess; // bank statements: the guessed columns
  chat?: string; // WhatsApp: who the chat is with, when the file name says
  encoding?: string; // when it isn't UTF-8 (some banks write Windows-1252)
}

export type Problem =
  | 'empty' // nothing in the file
  | 'html' // a Google Takeout made with HTML instead of JSON
  | 'tgz' // a Takeout saved as .tgz
  | 'zip-method' // a zip packed in a way this can't open
  | 'unknown'; // not a file Arise knows

export interface Detection {
  name: string;
  size: number;
  zip: boolean;
  found: Found[];
  problem?: Problem; // when nothing in it can be read
  html?: number; // parts saved as HTML (Takeout), which are left out
}

export interface Progress {
  read: number; // bytes read so far
  total: number; // bytes to read
  found: number; // events found so far
  label: string; // what it's reading now
}

// What a caller can choose before an import starts.
export interface ImportChoices {
  detection?: Detection; // from detect(), so the file isn't looked at twice
  paths?: string[]; // only these parts (Found.path); all of them when left out
  profiles?: string[]; // Netflix: only these profiles
  csv?: CsvMapping; // bank statements: the columns, as the Player confirmed them
}

export interface ImportOptions extends ImportChoices {
  // Each batch of events (about 500). The import waits for it, so a slow store slows the reading
  // instead of filling memory. It may return how many were new.
  onEvents(batch: LifeEvent[]): unknown;
  onProgress?(p: Progress): void;
  signal?: AbortSignal;
}

export interface ImportResult {
  found: number; // events read from the file
  added: number; // how many of them were new (what onEvents said), else the same as found
  from?: number; // the earliest event, ms
  to?: number; // the latest
  labels: string[]; // what was read, in plain words
  failed?: string[]; // parts that couldn't be read (a damaged zip), left out; the rest went on
  cancelled?: boolean;
  problem?: Problem;
}

// What each parser reads: the file's name and its text, a piece at a time.
export interface TextInput {
  name: string;
  text: AsyncIterable<string>;
}
