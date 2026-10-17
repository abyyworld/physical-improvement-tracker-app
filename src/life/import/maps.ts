// Google Maps Timeline: places and trips.
//
// Timeline.json, exported from Google Maps on the phone since 2024. On Android:
// {"semanticSegments": [{"startTime": "2024-06-15T09:00:00.000+02:00", "endTime": "…",
//   "visit": {"hierarchyLevel": 0, "topCandidate": {"placeId": "…", "semanticType": "HOME",
//   "placeLocation": {"latLng": "48.8566°, 2.3522°"}}}},
//  {"startTime": "…", "endTime": "…", "activity": {"start": {"latLng": "…"}, "end": {"latLng": "…"},
//   "distanceMeters": 1234.5, "topCandidate": {"type": "WALKING"}}},
//  {"startTime": "…", "endTime": "…", "timelinePath": [{"point": "…", "time": "…"}]}],
//  "rawSignals": […], "userLocationProfile": {…}}
// On iPhone, the same segments in a top-level array, with "geo:48.8566,2.3522" strings,
// "placeID", numbers as strings and lower-case types ("walking").
//
// Semantic Location History, from Takeout before 2024 ("2019_JANUARY.json"):
// {"timelineObjects": [{"placeVisit": {"location": {"name": "…", "address": "…", "placeId": "…",
//   "latitudeE7": 525200000, "longitudeE7": 134050000, "semanticType": "TYPE_HOME"},
//   "duration": {"startTimestamp": "…", "endTimestamp": "…"}}},
//  {"activitySegment": {"activityType": "WALKING", "distance": 550, "duration": {…}}}]}
//
// The paths (timelinePath, raw signals) are too fine to keep: places and trips are what matter.

import type { LifeEvent } from '../types';
import type { TextInput } from './types';
import { JsonItems } from './json-stream';
import { clean, drain, fixed1, hashId, isoMs, num, round1, str } from './util';

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | undefined => (v && typeof v === 'object' ? (v as Rec) : undefined);

// "48.8566°, 2.3522°", "geo:48.8566,2.3522" or {"latLng": …} → [lat, lng].
export function latLng(v: unknown): [number, number] | undefined {
  const s = typeof v === 'string' ? v : str(obj(v)?.latLng);
  if (!s) return undefined;
  const m = s.replace(/^geo:/, '').replace(/°/g, '').split(/\s*,\s*/);
  const lat = Number(m[0]);
  const lng = Number(m[1]);
  return m.length >= 2 && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : undefined;
}

function placeTitle(name: string, semantic: string): string {
  const t = semantic.toUpperCase();
  if (/HOME/.test(t)) return name ? `At home (${name})` : 'At home';
  if (/WORK/.test(t)) return name ? `At work (${name})` : 'At work';
  return name ? `At ${name}` : 'At a place';
}

const TRIPS: [RegExp, string][] = [
  [/WALK|ON_FOOT/, 'Walk'],
  [/RUN/, 'Run'],
  [/MOTORCYCL/, 'Motorbike ride'],
  [/CYCL|BICYCLE|BIKING/, 'Bike ride'],
  [/BUS/, 'Bus ride'],
  [/SUBWAY|METRO|UNDERGROUND/, 'Subway ride'],
  [/TRAM|STREETCAR/, 'Tram ride'],
  [/TRAIN|RAIL/, 'Train ride'],
  [/FLY|PLANE|FLIGHT/, 'Flight'],
  [/FERRY|BOAT/, 'Ferry ride'],
  [/SAIL/, 'Sailing'],
  [/SKI/, 'Skiing'],
  [/VEHICLE|CAR|DRIV|TAXI/, 'Car trip'],
];

function tripTitle(type: string, meters: number): string {
  const t = type.toUpperCase().replace(/\s+/g, '_');
  const name = TRIPS.find(([re]) => re.test(t))?.[1] ?? 'Trip';
  return meters > 0 ? `${name}, ${fixed1(meters / 1000)} km` : name;
}

function mapsUrl(ll: [number, number] | undefined, placeId: string): string | undefined {
  if (!ll) return undefined;
  return `https://www.google.com/maps/search/?api=1&query=${ll[0]},${ll[1]}${placeId ? `&query_place_id=${encodeURIComponent(placeId)}` : ''}`;
}

function placeEvent(start: number, end: number, ll: [number, number] | undefined, placeId: string, name: string, semantic: string, address: string): LifeEvent | null {
  if (!Number.isFinite(start)) return null;
  const e: LifeEvent = {
    id: `maps:${hashId('place', start, placeId || (ll ? ll.join(',') : name))}`,
    source: 'maps',
    kind: 'place',
    at: start,
    title: placeTitle(name, semantic),
    tier: 3,
  };
  if (Number.isFinite(end) && end > start) e.end = end;
  const detail = address || (ll ? `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}` : '');
  if (detail) e.detail = detail;
  const url = mapsUrl(ll, placeId);
  if (url) e.url = url;
  const meta: Record<string, string | number> = {};
  if (ll) [meta.lat, meta.lng] = ll;
  if (placeId) meta.placeId = placeId;
  if (Object.keys(meta).length) e.meta = meta;
  return e;
}

function tripEvent(start: number, end: number, type: string, meters: number): LifeEvent | null {
  if (!Number.isFinite(start)) return null;
  const e: LifeEvent = { id: `maps:${hashId('trip', start, type)}`, source: 'maps', kind: 'trip', at: start, title: tripTitle(type, meters), tier: 3 };
  if (Number.isFinite(end) && end > start) e.end = end;
  if (meters > 0) {
    e.value = round1(meters / 1000);
    e.unit = 'km';
  }
  return e;
}

// One segment of Timeline.json (Android or iPhone).
export function segmentEvent(seg: unknown): LifeEvent | null {
  const s = obj(seg);
  if (!s) return null;
  const start = isoMs(s.startTime);
  const end = isoMs(s.endTime);
  const visit = obj(s.visit);
  if (visit) {
    const top = obj(visit.topCandidate) ?? {};
    return placeEvent(start, end, latLng(top.placeLocation), str(top.placeId) ?? str(top.placeID) ?? '', clean(top.name, 120), String(top.semanticType ?? ''), '');
  }
  const act = obj(s.activity);
  if (act) {
    const top = obj(act.topCandidate) ?? {};
    const meters = num(act.distanceMeters);
    return tripEvent(start, end, String(top.type ?? ''), Number.isFinite(meters) ? meters : 0);
  }
  return null; // timelinePath, timelineMemory
}

export async function* parseTimeline(input: TextInput): AsyncGenerator<LifeEvent[]> {
  const items = new JsonItems(['semanticSegments']);
  const out: LifeEvent[] = [];
  for await (const chunk of input.text) {
    for (const it of items.push(chunk)) {
      const e = segmentEvent(it.value);
      if (e) out.push(e);
    }
    yield* drain(out);
  }
  yield* drain(out, true);
}

// The start or end of a Semantic Location History duration: ISO, or milliseconds.
function stamp(d: Rec | undefined, key: 'start' | 'end'): number {
  if (!d) return NaN;
  const iso = isoMs(d[`${key}Timestamp`]);
  if (Number.isFinite(iso)) return iso;
  const ms = num(d[`${key}TimestampMs`] ?? d[`${key}Timestamp`]);
  return Number.isFinite(ms) ? ms : NaN;
}

const e7 = (v: unknown) => num(v) / 1e7;

export function timelineObjectEvent(o: unknown): LifeEvent | null {
  const t = obj(o);
  if (!t) return null;
  const pv = obj(t.placeVisit);
  if (pv) {
    const loc = obj(pv.location) ?? {};
    const lat = e7(loc.latitudeE7);
    const lng = e7(loc.longitudeE7);
    const ll: [number, number] | undefined = Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : undefined;
    const d = obj(pv.duration);
    return placeEvent(stamp(d, 'start'), stamp(d, 'end'), ll, str(loc.placeId) ?? '', clean(loc.name, 120), String(loc.semanticType ?? ''), clean(loc.address, 200));
  }
  const as = obj(t.activitySegment);
  if (as) {
    const d = obj(as.duration);
    const first = Array.isArray(as.activities) ? obj(as.activities[0]) : undefined;
    const type = String(as.activityType ?? first?.activityType ?? '');
    let meters = num(as.distance);
    if (!Number.isFinite(meters)) meters = num(obj(as.waypointPath)?.distanceMeters);
    return tripEvent(stamp(d, 'start'), stamp(d, 'end'), type, Number.isFinite(meters) ? meters : 0);
  }
  return null;
}

export async function* parseSemanticHistory(input: TextInput): AsyncGenerator<LifeEvent[]> {
  const items = new JsonItems(['timelineObjects']);
  const out: LifeEvent[] = [];
  for await (const chunk of input.text) {
    for (const it of items.push(chunk)) {
      const e = timelineObjectEvent(it.value);
      if (e) out.push(e);
    }
    yield* drain(out);
  }
  yield* drain(out, true);
}
