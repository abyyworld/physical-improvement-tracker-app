import { describe, expect, it } from 'vitest';
import { latLng, parseSemanticHistory, parseTimeline } from './maps';
import { input, run, titles, wellFormed } from '../../test/life-fixtures';

// Timeline.json as Google Maps on Android exports it (Settings, Location, Timeline, Export).
const android = {
  semanticSegments: [
    {
      startTime: '2024-06-15T09:00:00.000+02:00',
      endTime: '2024-06-15T10:00:00.000+02:00',
      startTimeTimezoneUtcOffsetMinutes: 120,
      endTimeTimezoneUtcOffsetMinutes: 120,
      visit: { hierarchyLevel: 0, probability: 0.85, topCandidate: { placeId: 'ChIJhome', semanticType: 'INFERRED_HOME', probability: 0.95, placeLocation: { latLng: '48.8566°, 2.3522°' } } },
    },
    {
      startTime: '2024-06-15T10:00:00.000+02:00',
      endTime: '2024-06-15T10:30:00.000+02:00',
      activity: { start: { latLng: '48.8566°, 2.3522°' }, end: { latLng: '48.8606°, 2.3376°' }, distanceMeters: 1234.5, probability: 0.9, topCandidate: { type: 'WALKING', probability: 0.85 } },
    },
    {
      startTime: '2024-06-15T10:30:00.000+02:00',
      endTime: '2024-06-15T11:00:00.000+02:00',
      timelinePath: [
        { point: '48.8606°, 2.3376°', time: '2024-06-15T10:35:00.000+02:00' },
        { point: '48.8620°, 2.3350°', time: '2024-06-15T10:40:00.000+02:00' },
      ],
    },
    {
      startTime: '2024-06-15T11:00:00.000+02:00',
      endTime: '2024-06-15T12:30:00.000+02:00',
      visit: { hierarchyLevel: 0, topCandidate: { placeId: 'ChIJcafe', semanticType: 'UNKNOWN', placeLocation: { latLng: '48.8606°, 2.3376°' } } },
    },
    {
      startTime: '2024-06-15T13:00:00.000+02:00',
      endTime: '2024-06-15T13:40:00.000+02:00',
      activity: { distanceMeters: 15200, topCandidate: { type: 'IN_PASSENGER_VEHICLE' } },
    },
  ],
  rawSignals: [{ position: { LatLng: '48.8566°, 2.3522°', accuracyMeters: 15, timestamp: '2024-06-15T09:05:00.000Z' } }, { wifiScan: { deliveryTime: '2024-06-06T11:44:37.000+01:00', devicesRecords: [{ mac: 1, rawRssi: -76 }] } }],
  userLocationProfile: { frequentPlaces: [{ placeId: 'ChIJhome', placeLocation: '48.8566, 2.3522', label: 'HOME' }] },
};

// The iPhone export: a top-level array, "geo:" strings, numbers as strings, lower-case types.
const iphone = [
  { endTime: '2025-07-07T14:45:10.000-04:00', startTime: '2025-07-07T13:30:00.000-04:00', visit: { hierarchyLevel: '0', topCandidate: { placeID: 'ChIJtimes', name: 'Times Square', placeLocation: 'geo:40.758895,-73.985131', probability: '0.95' }, probability: '0.95' } },
  { endTime: '2025-07-07T15:00:25.000-04:00', startTime: '2025-07-07T14:45:10.000-04:00', activity: { start: 'geo:40.758895,-73.985131', end: 'geo:40.754738,-73.983793', distanceMeters: '550.0', topCandidate: { type: 'walking', probability: '0.92' } } },
  { endTime: '2025-07-07T15:40:50.000-04:00', startTime: '2025-07-07T15:18:00.000-04:00', activity: { distanceMeters: '2400.0', topCandidate: { type: 'in subway', probability: '0.85' } } },
  { startTime: '2025-07-07T14:45:10.000-04:00', endTime: '2025-07-07T15:46:15.000-04:00', timelinePath: [{ point: 'geo:40.758895,-73.985131', durationMinutesOffsetFromStartTime: '0' }] },
  { endTime: '2025-07-07T23:00:00.000-04:00', startTime: '2025-07-07T18:00:00.000-04:00', visit: { topCandidate: { placeID: 'ChIJwork', semanticType: 'Work', placeLocation: 'geo:40.7,-73.9' } } },
];

describe('Google Maps Timeline (phone export)', () => {
  it('reads places and trips from the Android file, and leaves out paths and raw signals', async () => {
    const { events } = await run(parseTimeline(input('Timeline.json', JSON.stringify(android, null, 2))));
    expect(titles(events)).toEqual(['At home', 'Walk, 1.2 km', 'At a place', 'Car trip, 15.2 km']);
    expect(events.every(wellFormed)).toBe(true);
    expect(events[0]).toMatchObject({ source: 'maps', kind: 'place', tier: 3, at: Date.parse('2024-06-15T07:00:00Z'), end: Date.parse('2024-06-15T08:00:00Z'), detail: '48.85660, 2.35220', meta: { lat: 48.8566, lng: 2.3522, placeId: 'ChIJhome' } });
    expect(events[0].url).toContain('query=48.8566,2.3522');
    expect(events[1]).toMatchObject({ kind: 'trip', value: 1.2, unit: 'km', tier: 3 });
  });

  it('reads the iPhone file', async () => {
    const { events } = await run(parseTimeline(input('Timeline.json', JSON.stringify(iphone), 7)));
    expect(titles(events)).toEqual(['At Times Square', 'Walk, 0.6 km', 'Subway ride, 2.4 km', 'At work']);
    expect(events[0].meta).toMatchObject({ placeId: 'ChIJtimes', lat: 40.758895, lng: -73.985131 });
  });

  it('gives a stable id per visit and per trip', async () => {
    const a = await run(parseTimeline(input('Timeline.json', JSON.stringify(android))));
    const b = await run(parseTimeline(input('Timeline.json', JSON.stringify(android), 1)));
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
    expect(new Set(a.events.map((e) => e.id)).size).toBe(a.events.length);
  });

  it('copes with an empty or broken file', async () => {
    expect((await run(parseTimeline(input('Timeline.json', '{"semanticSegments": []}')))).events).toEqual([]);
    expect((await run(parseTimeline(input('Timeline.json', '')))).events).toEqual([]);
    const cut = '{"semanticSegments":[{"startTime":"2024-01-01T10:00:00Z","endTime":"2024-01-01T11:00:00Z","visit":{"topCandidate":{"placeId":"a","placeLocation":{"latLng":"1°, 2°"}}}},{"startTime":"2024-01-01T12:00:00Z","visit":{"topCa';
    expect(titles((await run(parseTimeline(input('Timeline.json', cut)))).events)).toEqual(['At a place']);
  });

  it('reads coordinates in every way they are written', () => {
    expect(latLng('48.8566°, 2.3522°')).toEqual([48.8566, 2.3522]);
    expect(latLng('geo:29.725358,-95.482259')).toEqual([29.725358, -95.482259]);
    expect(latLng({ latLng: '-33.9°, 151.2°' })).toEqual([-33.9, 151.2]);
    expect(latLng('nonsense')).toBeUndefined();
    expect(latLng('91, 0')).toBeUndefined();
  });
});

describe('Google Maps Timeline (older Takeout: Semantic Location History)', () => {
  const month = {
    timelineObjects: [
      { placeVisit: { location: { latitudeE7: 407588950, longitudeE7: -739851310, placeId: 'ChIJmQJ', name: 'Times Square', address: 'Manhattan, NY 10036, USA', semanticType: 'TYPE_SEARCHED_ADDRESS' }, duration: { startTimestamp: '2019-07-07T17:30:00Z', endTimestamp: '2019-07-07T18:45:10Z' }, placeConfidence: 'HIGH_CONFIDENCE', visitConfidence: 95 } },
      { activitySegment: { startLocation: { latitudeE7: 407588950, longitudeE7: -739851310 }, endLocation: {}, duration: { startTimestamp: '2019-07-07T18:45:10Z', endTimestamp: '2019-07-07T19:00:25Z' }, distance: 550, activityType: 'WALKING', confidence: 'HIGH', activities: [{ activityType: 'WALKING', probability: 0.9 }] } },
      { activitySegment: { duration: { startTimestampMs: '1562528425000', endTimestampMs: '1562529000000' }, activities: [{ activityType: 'IN_BUS' }], waypointPath: { waypoints: [], distanceMeters: 2049.7, travelMode: 'DRIVE' } } },
      { placeVisit: { location: { latitudeE7: 525200000, longitudeE7: 134050000, placeId: 'ChIJhome', semanticType: 'TYPE_HOME' }, duration: { startTimestampMs: '1562540000000', endTimestampMs: '1562580000000' } } },
    ],
  };

  it('reads named places with addresses, and trips', async () => {
    const { events } = await run(parseSemanticHistory(input('Semantic Location History/2019/2019_JULY.json', JSON.stringify(month, null, 2))));
    expect(titles(events)).toEqual(['At Times Square', 'Walk, 0.6 km', 'Bus ride, 2 km', 'At home']);
    expect(events[0]).toMatchObject({ detail: 'Manhattan, NY 10036, USA', at: Date.parse('2019-07-07T17:30:00Z'), meta: { lat: 40.758895, lng: -73.985131 } });
    expect(events[2]).toMatchObject({ at: 1562528425000, end: 1562529000000 });
    expect(events.every(wellFormed)).toBe(true);
  });
});
