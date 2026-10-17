import { describe, expect, it } from 'vitest';
import { appleTime, parseAppleHealth, sleepSessions, unionMs, workoutName } from './health';
import { input, run, titles, wellFormed } from '../../test/life-fixtures';

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 13 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord|Audiogram|VisionPrescription)*)>
<!ATTLIST HealthData
  locale CDATA #REQUIRED
>
<!ELEMENT Record ((MetadataEntry|HeartRateVariabilityMetadataList)*)>
<!ATTLIST Record
  type          CDATA #REQUIRED
  unit          CDATA #IMPLIED
  value         CDATA #IMPLIED
  sourceName    CDATA #REQUIRED
  startDate     CDATA #REQUIRED
  endDate       CDATA #REQUIRED
>
]>
<HealthData locale="en_GB">
 <ExportDate value="2024-03-05 08:00:00 +0000"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1995-02-02" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
`;
const DEVICE = 'device="&lt;&lt;HKDevice: 0x283b2c1e0&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:10.2&gt;"';
const rec = (type: string, start: string, end: string, value: string, unit = 'count', source = 'iPhone', extra = '') =>
  ` <Record type="${type}" sourceName="${source}" sourceVersion="17.2" ${source === 'Apple Watch' ? DEVICE : ''} unit="${unit}" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}"${extra ? `>\n  ${extra}\n </Record>` : '/>'}\n`;
const sleep = (start: string, end: string, value: string, source = 'Apple Watch') =>
  ` <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${source}" sourceVersion="10.2" startDate="${start}" endDate="${end}" value="HKCategoryValueSleepAnalysis${value}">\n  <MetadataEntry key="HKTimeZone" value="Europe/London"/>\n </Record>\n`;

const xml =
  HEAD +
  // Steps from the phone and the watch: the same walking counted twice, so the bigger one counts.
  rec('HKQuantityTypeIdentifierStepCount', '2024-03-01 09:00:00 +0000', '2024-03-01 09:10:00 +0000', '1200') +
  rec('HKQuantityTypeIdentifierStepCount', '2024-03-01 18:00:00 +0000', '2024-03-01 18:30:00 +0000', '3000') +
  rec('HKQuantityTypeIdentifierStepCount', '2024-03-01 09:00:00 +0000', '2024-03-01 09:10:00 +0000', '1300', 'count', 'Apple Watch') +
  rec('HKQuantityTypeIdentifierStepCount', '2024-03-01 18:00:00 +0000', '2024-03-01 18:30:00 +0000', '2900', 'count', 'Apple Watch') +
  rec('HKQuantityTypeIdentifierStepCount', '2024-03-02 23:30:00 +0100', '2024-03-02 23:40:00 +0100', '500') +
  rec('HKQuantityTypeIdentifierDistanceWalkingRunning', '2024-03-01 09:00:00 +0000', '2024-03-01 09:10:00 +0000', '0.9', 'km') +
  rec('HKQuantityTypeIdentifierDistanceWalkingRunning', '2024-03-01 18:00:00 +0000', '2024-03-01 18:30:00 +0000', '2.2', 'km') +
  rec('HKQuantityTypeIdentifierActiveEnergyBurned', '2024-03-01 18:00:00 +0000', '2024-03-01 18:30:00 +0000', '210.5', 'kcal', 'Apple Watch') +
  rec('HKQuantityTypeIdentifierActiveEnergyBurned', '2024-03-01 19:00:00 +0000', '2024-03-01 19:30:00 +0000', '1000', 'kJ', 'Apple Watch') +
  rec('HKQuantityTypeIdentifierHeartRate', '2024-03-01 18:05:00 +0000', '2024-03-01 18:05:00 +0000', '128', 'count/min', 'Apple Watch', '<MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="2"/>') +
  rec('HKQuantityTypeIdentifierRestingHeartRate', '2024-03-01 00:00:00 +0000', '2024-03-01 23:59:00 +0000', '56', 'count/min', 'Apple Watch') +
  rec('HKQuantityTypeIdentifierRestingHeartRate', '2024-03-01 12:00:00 +0000', '2024-03-01 23:59:00 +0000', '60', 'count/min', 'Apple Watch') +
  rec('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', '2024-03-01 03:00:00 +0000', '2024-03-01 03:01:00 +0000', '48.6', 'ms', 'Apple Watch', '<HeartRateVariabilityMetadataList>\n   <InstantaneousBeatsPerMinute bpm="61" time="3:00:01.32 AM"/>\n  </HeartRateVariabilityMetadataList>') +
  rec('HKQuantityTypeIdentifierBodyMass', '2024-03-01 07:00:00 +0000', '2024-03-01 07:00:00 +0000', '72.4', 'kg', 'Withings') +
  rec('HKQuantityTypeIdentifierBodyMass', '2024-03-01 21:00:00 +0000', '2024-03-01 21:00:00 +0000', '160', 'lb', 'Withings') +
  ` <Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="Headspace" startDate="2024-03-01 07:30:00 +0000" endDate="2024-03-01 07:40:00 +0000"/>\n` +
  // A night on the Watch, in stages, and the phone's own "in bed" for the same night.
  sleep('2024-02-29 23:10:00 +0000', '2024-03-01 01:00:00 +0000', 'AsleepCore') +
  sleep('2024-03-01 01:00:00 +0000', '2024-03-01 01:20:00 +0000', 'Awake') +
  sleep('2024-03-01 01:20:00 +0000', '2024-03-01 02:30:00 +0000', 'AsleepDeep') +
  sleep('2024-03-01 02:30:00 +0000', '2024-03-01 06:40:00 +0000', 'AsleepREM') +
  sleep('2024-02-29 22:50:00 +0000', '2024-03-01 06:45:00 +0000', 'InBed', 'iPhone') +
  // A nap that afternoon.
  sleep('2024-03-01 14:00:00 +0000', '2024-03-01 14:40:00 +0000', 'AsleepUnspecified') +
  // An older night, from the phone only: time in bed.
  sleep('2019-05-01 23:00:00 +0200', '2019-05-02 07:00:00 +0200', 'InBed', 'iPhone') +
  // A workout the old way (totals as attributes), and the iOS 16 way (WorkoutStatistics).
  ` <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" durationUnit="min" totalDistance="5.01" totalDistanceUnit="km" totalEnergyBurned="310" totalEnergyBurnedUnit="kcal" sourceName="Apple Watch" sourceVersion="10.2" ${DEVICE} creationDate="2024-03-01 18:31:00 +0000" startDate="2024-03-01 18:00:00 +0000" endDate="2024-03-01 18:30:30 +0000">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutEvent type="HKWorkoutEventTypeSegment" date="2024-03-01 18:00:00 +0000" duration="10" durationUnit="min"/>
  <WorkoutRoute sourceName="Apple Watch" sourceVersion="10.2" creationDate="2024-03-01 18:31:00 +0000" startDate="2024-03-01 18:00:00 +0000" endDate="2024-03-01 18:30:00 +0000">
   <FileReference path="/workout-routes/route_2024-03-01_6.30pm.gpx"/>
  </WorkoutRoute>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45" durationUnit="min" sourceName="Apple Watch" sourceVersion="10.2" creationDate="2024-03-02 19:00:00 +0000" startDate="2024-03-02 18:10:00 +0000" endDate="2024-03-02 18:55:00 +0000">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2024-03-02 18:10:00 +0000" startDate="2024-03-02 18:55:00 +0000" sum="250.4" unit="kcal"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierBasalEnergyBurned" startDate="2024-03-02 18:10:00 +0000" endDate="2024-03-02 18:55:00 +0000" sum="80" unit="kcal"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="1800" durationUnit="s" sourceName="iPhone" startDate="2024-03-03 08:00:00 -0500" endDate="2024-03-03 08:30:00 -0500">
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="2024-03-03 08:00:00 -0500" endDate="2024-03-03 08:30:00 -0500" sum="1.6" unit="mi"/>
 </Workout>
 <ActivitySummary dateComponents="2024-03-01" activeEnergyBurned="449.5" activeEnergyBurnedGoal="500" activeEnergyBurnedUnit="kcal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="35" appleExerciseTimeGoal="30" appleStandHours="11" appleStandHoursGoal="12"/>
</HealthData>
`;

describe('Apple Health', () => {
  it('reads workouts, nights and daily totals, never one event per sample', async () => {
    const { events } = await run(parseAppleHealth(input('apple_health_export/export.xml', xml)));
    expect(events.every(wellFormed)).toBe(true);
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));
    const workouts = events.filter((e) => e.kind === 'workout');
    expect(titles(workouts)).toEqual(['Running · 31 min · 5 km · 310 kcal', 'Traditional strength training · 45 min · 250 kcal', 'Walking · 30 min · 1.6 mi']);
    expect(workouts[0]).toMatchObject({ source: 'health', tier: 2, at: Date.UTC(2024, 2, 1, 18), end: Date.UTC(2024, 2, 1, 18, 30, 30), value: 31, unit: 'min', meta: { activity: 'Running', km: 5, kcal: 310 } });
    expect(workouts[2].meta).toMatchObject({ km: 2.6 });

    // Steps: the phone counted 4,200 and the watch 4,200 of the same walking: not 8,400.
    expect(byId['health:steps:2024-03-01']).toMatchObject({ kind: 'steps', title: '4,200 steps', value: 4200, unit: 'steps', tier: 2, at: Date.UTC(2024, 2, 1), end: Date.UTC(2024, 2, 2) });
    // A day is the day on the clock where it happened (23:30 in UTC+1 is still 2 March).
    expect(byId['health:steps:2024-03-02']).toMatchObject({ value: 500, at: Date.UTC(2024, 2, 1, 23) });
    expect(byId['health:distance:2024-03-01']).toMatchObject({ title: 'Walked and ran 3.1 km', value: 3.1, unit: 'km', tier: 2 });
    expect(byId['health:energy:2024-03-01']).toMatchObject({ title: '450 kcal of active energy', value: 450 });
    expect(byId['health:resting-hr:2024-03-01']).toMatchObject({ title: 'Resting heart rate 58 bpm', tier: 3 });
    expect(byId['health:hrv:2024-03-01']).toMatchObject({ title: 'Heart rate variability 49 ms', unit: 'ms', tier: 3 });
    expect(byId['health:weight:2024-03-01']).toMatchObject({ title: 'Weighed 72.6 kg', unit: 'kg', tier: 3 });
    expect(byId['health:mindful:2024-03-01']).toMatchObject({ title: 'Mindful for 10 min', value: 10 });
    expect(events.some((e) => /heart rate 128/i.test(e.title))).toBe(false);

    // The night: asleep from 23:10 to 06:40, less 20 minutes awake; the phone's "in bed" isn't added.
    expect(byId['health:sleep:2024-03-01']).toMatchObject({ kind: 'sleep', title: 'Slept 7 h 10 min', value: 430, at: Date.UTC(2024, 1, 29, 23, 10), end: Date.UTC(2024, 2, 1, 6, 40), tier: 2 });
    expect(byId['health:sleep:2024-03-01:1']).toMatchObject({ title: 'Napped 40 min' });
    expect(byId['health:sleep:2019-05-02']).toMatchObject({ title: 'In bed 8 h', meta: { day: '2019-05-02', inBedOnly: true } });
    expect(events.filter((e) => e.kind === 'sleep').length).toBe(3);
  });

  it('adds up a day like the Health app: the Watch first where both counted, the iPhone where only it did', async () => {
    const steps = 'HKQuantityTypeIdentifierStepCount';
    const mindful = (source: string, start: string, end: string) => ` <Record type="HKCategoryTypeIdentifierMindfulSession" sourceName="${source}" startDate="${start}" endDate="${end}"/>\n`;
    const day =
      HEAD +
      rec(steps, '2024-03-01 09:00:00 +0000', '2024-03-01 09:10:00 +0000', '3000', 'count', 'Apple Watch') +
      rec(steps, '2024-03-01 18:00:00 +0000', '2024-03-01 18:10:00 +0000', '3000', 'count', 'Apple Watch') +
      rec(steps, '2024-03-01 09:00:00 +0000', '2024-03-01 09:10:00 +0000', '2900') +
      // The Watch was charging.
      rec(steps, '2024-03-01 07:00:00 +0000', '2024-03-01 07:10:00 +0000', '2500') +
      // Two apps at different times, then two at the same time.
      mindful('Apple Watch', '2024-03-01 08:00:00 +0000', '2024-03-01 08:05:00 +0000') +
      mindful('Headspace', '2024-03-01 21:00:00 +0000', '2024-03-01 21:10:00 +0000') +
      mindful('Calm', '2024-03-01 21:05:00 +0000', '2024-03-01 21:15:00 +0000') +
      '</HealthData>\n';
    const { events } = await run(parseAppleHealth(input('export.xml', day)));
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));
    expect(byId['health:steps:2024-03-01']).toMatchObject({ title: '8,500 steps', value: 8500 });
    expect(byId['health:mindful:2024-03-01']).toMatchObject({ title: 'Mindful for 20 min', value: 20 });
  });

  it('gives the same ids in pieces of any size', async () => {
    const a = await run(parseAppleHealth(input('export.xml', xml, 4096)));
    const b = await run(parseAppleHealth(input('export.xml', xml, 1)));
    expect(b.events.map((e) => e.id).sort()).toEqual(a.events.map((e) => e.id).sort());
    expect(new Set(a.events.map((e) => e.id)).size).toBe(a.events.length);
  });

  it('copes with an empty export and one cut off in the middle', async () => {
    expect((await run(parseAppleHealth(input('export.xml', '')))).events).toEqual([]);
    expect((await run(parseAppleHealth(input('export.xml', `${HEAD}</HealthData>`)))).events).toEqual([]);
    const cut = xml.slice(0, xml.indexOf('<Workout workoutActivityType="HKWorkoutActivityTypeWalking"') + 60);
    const { events } = await run(parseAppleHealth(input('export.xml', cut)));
    expect(events.filter((e) => e.kind === 'workout').length).toBe(2);
    expect(events.some((e) => e.id === 'health:steps:2024-03-01')).toBe(true);
  });

  it('streams a big export: many thousand samples become one event a day', async () => {
    async function* big() {
      yield HEAD;
      const day0 = Date.UTC(2023, 0, 1);
      for (let i = 0; i < 50_000; i++) {
        const t = new Date(day0 + i * 15 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
        yield rec('HKQuantityTypeIdentifierStepCount', `${t} +0000`, `${t} +0000`, '10');
        yield rec('HKQuantityTypeIdentifierHeartRate', `${t} +0000`, `${t} +0000`, '70', 'count/min', 'Apple Watch');
      }
      yield '</HealthData>\n';
    }
    const { events } = await run(parseAppleHealth({ name: 'export.xml', text: big() }));
    const days = Math.ceil((50_000 * 15) / (24 * 60));
    expect(events.length).toBe(days);
    expect(events[0]).toMatchObject({ title: '960 steps', value: 960 });
  });

  it('reads Apple times, names and spans', () => {
    expect(appleTime('2024-03-02 23:30:00 +0100')).toEqual({ ms: Date.UTC(2024, 2, 2, 22, 30), day: '2024-03-02', offset: 60 });
    expect(appleTime('2024-03-02 08:00:00 -0530')?.ms).toBe(Date.UTC(2024, 2, 2, 13, 30));
    expect(appleTime('nonsense')).toBeNull();
    expect(workoutName('HKWorkoutActivityTypeHighIntensityIntervalTraining')).toBe('HIIT');
    expect(workoutName('HKWorkoutActivityTypeOther')).toBe('Workout');
    expect(workoutName('HKWorkoutActivityTypeMixedCardio')).toBe('Mixed cardio');
    expect(unionMs([[0, 10], [5, 15], [20, 30]])).toBe(25);
    expect(sleepSessions([[0, 60 * 60_000, 0], [2 * 3600_000, 3 * 3600_000, 0], [10 * 3600_000, 11 * 3600_000, 0]]).map((s) => s.ms / 60_000)).toEqual([120, 60]);
  });
});
