import Capacitor
import CoreLocation
import CoreMotion
import EventKit
import HealthKit
import UIKit

// Arise's own native code for the life log (src/life/sense.ts): permission for Apple Health,
// moods from Health, motion, the calendar, places, and what Shortcuts automations logged. The
// rest of Health (workouts, sleep, steps…) is read through the Health plugin
// (@capgo/capacitor-health). Nothing here sends anything anywhere: it all goes to the web app.
//
// This code isn't a plugin from npm, so the web app can't tell by itself that it changed. If you
// change what the web app can call here, raise OWN_NATIVE in vite.config.ts, so an older
// Arise.ipa isn't sent web code it can't run.

// The app's screen: Capacitor's, plus this plugin.
class AriseBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AriseSensePlugin())
    }
}

@objc(AriseSensePlugin)
public class AriseSensePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AriseSensePlugin"
    public let jsName = "AriseSense"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "healthAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "moods", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "motionStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "motionAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "motion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "calendarStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "calendarAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "calendarEvents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "calendarAdd", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "placesStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "placesStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "placesStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "placeName", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inboxTake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inboxClear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    // Added to the notes of every event Arise puts in the calendar, so it isn't read back in.
    static let calendarMark = "Added by Arise"

    private lazy var healthStore = HKHealthStore()
    private lazy var motionManager = CMMotionActivityManager()
    private lazy var geocoder = CLGeocoder()
    private var eventStore = EKEventStore()
    private let calendarQueue = DispatchQueue(label: "arise.calendar")

    private static func ms(_ date: Date) -> Double {
        return date.timeIntervalSince1970 * 1000
    }

    private static func date(_ call: CAPPluginCall, _ key: String, _ fallback: Date) -> Date {
        guard let value = call.getDouble(key) else { return fallback }
        return Date(timeIntervalSince1970: value / 1000)
    }

    @objc func info(_ call: CAPPluginCall) {
        var out: [String: Any] = [
            "version": 1,
            "health": HKHealthStore.isHealthDataAvailable(),
            "motion": CMMotionActivityManager.isActivityAvailable(),
            "shortcuts": false,
            "moods": false,
        ]
        if #available(iOS 16.0, *) {
            out["shortcuts"] = true
        }
        if #available(iOS 18.0, *) {
            out["moods"] = true
        }
        call.resolve(out)
    }

    // ---------- Apple Health

    // One question for everything the life log reads from Health. Health never tells an app what
    // the Player said no to; it just gives it nothing.
    @objc func healthAccess(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health isn't on this device.", "UNAVAILABLE")
            return
        }
        var read: Set<HKObjectType> = [HKObjectType.workoutType()]
        let quantities: [HKQuantityTypeIdentifier] = [.stepCount, .distanceWalkingRunning, .activeEnergyBurned, .restingHeartRate, .heartRateVariabilitySDNN, .bodyMass]
        for id in quantities {
            if let type = HKObjectType.quantityType(forIdentifier: id) {
                read.insert(type)
            }
        }
        let categories: [HKCategoryTypeIdentifier] = [.sleepAnalysis, .mindfulSession]
        for id in categories {
            if let type = HKObjectType.categoryType(forIdentifier: id) {
                read.insert(type)
            }
        }
        if #available(iOS 18.0, *) {
            read.insert(HKSampleType.stateOfMindType())
        }
        healthStore.requestAuthorization(toShare: nil, read: read) { done, error in
            if let error = error {
                call.reject(error.localizedDescription, "FAILED")
            } else {
                call.resolve(["asked": done])
            }
        }
    }

    // State of Mind (iOS 18 and later): moods and feelings logged in Health or on the Watch.
    // Labels, what they were about, and the kind are HealthKit's own numbers; the web app names them.
    @objc func moods(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else {
            let none: [[String: Any]] = []
            call.resolve(["moods": none])
            return
        }
        let now = Date()
        let from = AriseSensePlugin.date(call, "from", now.addingTimeInterval(-86400))
        let to = AriseSensePlugin.date(call, "to", now)
        let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [])
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        let query = HKSampleQuery(sampleType: HKSampleType.stateOfMindType(), predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
            if let error = error {
                call.reject(error.localizedDescription, "FAILED")
                return
            }
            var list: [[String: Any]] = []
            for sample in samples ?? [] {
                guard let mood = sample as? HKStateOfMind else { continue }
                list.append([
                    "id": mood.uuid.uuidString,
                    "at": AriseSensePlugin.ms(mood.startDate),
                    "kind": mood.kind.rawValue,
                    "valence": mood.valence,
                    "feeling": mood.valenceClassification.rawValue,
                    "labels": mood.labels.map { $0.rawValue },
                    "about": mood.associations.map { $0.rawValue },
                ])
            }
            call.resolve(["moods": list])
        }
        healthStore.execute(query)
    }

    // ---------- motion

    private static func motionStatusName() -> String {
        guard CMMotionActivityManager.isActivityAvailable() else { return "unavailable" }
        switch CMMotionActivityManager.authorizationStatus() {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    @objc func motionStatus(_ call: CAPPluginCall) {
        call.resolve(["status": AriseSensePlugin.motionStatusName()])
    }

    // iOS has no separate question for motion: the first read asks it.
    @objc func motionAccess(_ call: CAPPluginCall) {
        guard AriseSensePlugin.motionStatusName() == "prompt" else {
            call.resolve(["status": AriseSensePlugin.motionStatusName()])
            return
        }
        DispatchQueue.main.async {
            AriseAsk.afterPrompt({
                let now = Date()
                self.motionManager.queryActivityStarting(from: now.addingTimeInterval(-60), to: now, to: OperationQueue.main) { _, _ in }
            }, then: {
                call.resolve(["status": AriseSensePlugin.motionStatusName()])
            })
        }
    }

    private static func motionKind(_ activity: CMMotionActivity) -> String {
        if activity.automotive { return "drive" }
        if activity.cycling { return "cycle" }
        if activity.running { return "run" }
        if activity.walking { return "walk" }
        if activity.stationary { return "still" }
        return "unknown"
    }

    // What the iPhone noticed (walking, driving…) between two times, at most the last 7 days.
    // Only the changes: t is when it started, k what it was, c how sure iOS is (0 to 2).
    @objc func motion(_ call: CAPPluginCall) {
        guard CMMotionActivityManager.isActivityAvailable() else {
            call.reject("Motion isn't on this device.", "UNAVAILABLE")
            return
        }
        let now = Date()
        let from = AriseSensePlugin.date(call, "from", now.addingTimeInterval(-86400))
        let to = min(now, AriseSensePlugin.date(call, "to", now))
        motionManager.queryActivityStarting(from: from, to: to, to: OperationQueue.main) { activities, error in
            if let error = error {
                call.reject(error.localizedDescription, "FAILED")
                return
            }
            var list: [[String: Any]] = []
            var last = ""
            for activity in activities ?? [] {
                let kind = AriseSensePlugin.motionKind(activity)
                let sure = activity.confidence.rawValue
                let key = "\(kind)\(sure)"
                if key == last { continue }
                last = key
                list.append(["t": AriseSensePlugin.ms(activity.startDate), "k": kind, "c": sure])
            }
            call.resolve(["activities": list, "to": AriseSensePlugin.ms(to)])
        }
    }

    // ---------- calendar

    private static func calendarStatusName() -> String {
        // 3 is full access (called "authorized" before iOS 17), 4 is "add events only" (iOS 17).
        switch EKEventStore.authorizationStatus(for: .event).rawValue {
        case 3: return "granted"
        case 4: return "writeOnly"
        case 2: return "denied"
        case 1: return "restricted"
        default: return "prompt"
        }
    }

    @objc func calendarStatus(_ call: CAPPluginCall) {
        call.resolve(["status": AriseSensePlugin.calendarStatusName()])
    }

    @objc func calendarAccess(_ call: CAPPluginCall) {
        let done: EKEventStoreRequestAccessCompletionHandler = { _, _ in
            self.calendarQueue.async {
                // A new store sees the calendars it may read now.
                self.eventStore = EKEventStore()
                call.resolve(["status": AriseSensePlugin.calendarStatusName()])
            }
        }
        calendarQueue.async {
            if #available(iOS 17.0, *) {
                self.eventStore.requestFullAccessToEvents(completion: done)
            } else {
                self.eventStore.requestAccess(to: .event, completion: done)
            }
        }
    }

    @objc func calendarEvents(_ call: CAPPluginCall) {
        let now = Date()
        let from = AriseSensePlugin.date(call, "from", now.addingTimeInterval(-86400))
        let to = AriseSensePlugin.date(call, "to", now)
        calendarQueue.async {
            guard AriseSensePlugin.calendarStatusName() == "granted" else {
                call.reject("Arise can't read your calendar.", "DENIED")
                return
            }
            let store = self.eventStore
            let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
            var list: [[String: Any]] = []
            for event in store.events(matching: predicate) {
                guard let start = event.startDate, let end = event.endDate else { continue }
                var item: [String: Any] = [
                    "id": event.calendarItemIdentifier,
                    "title": event.title ?? "",
                    "start": AriseSensePlugin.ms(start),
                    "end": AriseSensePlugin.ms(end),
                    "allDay": event.isAllDay,
                    "calendar": event.calendar?.title ?? "",
                    "type": event.calendar?.type.rawValue ?? 0,
                ]
                if let place = event.location, !place.isEmpty {
                    item["place"] = place
                }
                if let notes = event.notes, notes.contains(AriseSensePlugin.calendarMark) {
                    item["arise"] = true
                }
                list.append(item)
            }
            call.resolve(["events": list])
        }
    }

    // Puts an event in the Player's default calendar (their workouts, say).
    @objc func calendarAdd(_ call: CAPPluginCall) {
        guard let title = call.getString("title"), let start = call.getDouble("start"), let end = call.getDouble("end") else {
            call.reject("The event needs a title, a start and an end.", "BAD_INPUT")
            return
        }
        let notes = call.getString("notes") ?? ""
        calendarQueue.async {
            let status = AriseSensePlugin.calendarStatusName()
            guard status == "granted" || status == "writeOnly" else {
                call.reject("Arise can't add to your calendar.", "DENIED")
                return
            }
            let store = self.eventStore
            let event = EKEvent(eventStore: store)
            event.title = title
            event.startDate = Date(timeIntervalSince1970: start / 1000)
            event.endDate = Date(timeIntervalSince1970: end / 1000)
            event.notes = notes.isEmpty ? AriseSensePlugin.calendarMark : "\(notes)\n\n\(AriseSensePlugin.calendarMark)"
            event.calendar = store.defaultCalendarForNewEvents
            do {
                try store.save(event, span: .thisEvent, commit: true)
                call.resolve(["id": event.calendarItemIdentifier])
            } catch {
                call.reject(error.localizedDescription, "FAILED")
            }
        }
    }

    // ---------- places (ArisePlaces, in AriseInbox.swift)

    @objc func placesStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["status": ArisePlaces.shared.status, "on": ArisePlaces.shared.isOn])
        }
    }

    @objc func placesStart(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let places = ArisePlaces.shared
            places.isOn = true
            places.ask {
                places.update()
                call.resolve(["status": places.status, "on": places.isOn])
            }
        }
    }

    @objc func placesStop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let places = ArisePlaces.shared
            places.isOn = false
            places.update()
            call.resolve(["status": places.status, "on": false])
        }
    }

    // The name of a place, from Apple Maps.
    @objc func placeName(_ call: CAPPluginCall) {
        guard let lat = call.getDouble("lat"), let lon = call.getDouble("lon") else {
            call.reject("The place needs a latitude and a longitude.", "BAD_INPUT")
            return
        }
        DispatchQueue.main.async {
            self.geocoder.reverseGeocodeLocation(CLLocation(latitude: lat, longitude: lon)) { places, error in
                if let error = error {
                    call.reject(error.localizedDescription, "FAILED")
                    return
                }
                var out: [String: Any] = [:]
                if let place = places?.first {
                    if let value = place.areasOfInterest?.first { out["poi"] = value }
                    if let value = place.name { out["name"] = value }
                    if let value = place.thoroughfare { out["street"] = value }
                    if let value = place.subLocality { out["area"] = value }
                    if let value = place.locality { out["city"] = value }
                    if let value = place.country { out["country"] = value }
                }
                call.resolve(out)
            }
        }
    }

    // ---------- the inbox (AriseInbox.swift)

    @objc func inboxTake(_ call: CAPPluginCall) {
        do {
            let text = try AriseInbox.take()
            call.resolve(["text": text])
        } catch {
            call.reject(error.localizedDescription, "FAILED")
        }
    }

    @objc func inboxClear(_ call: CAPPluginCall) {
        AriseInbox.clear()
        call.resolve()
    }

    // Arise's page in the Settings app, to change what it may use.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }
}
