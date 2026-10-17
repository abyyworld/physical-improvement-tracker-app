import CoreLocation
import Foundation
import UIKit

// What happens while the web app isn't running (a Shortcuts automation ran "Log to Arise", the
// Player arrived somewhere or left) goes into a small file, one JSON object per line. The web app
// takes it when it opens, adds it to the life log, then clears it (src/life/sense.ts).
//
// If you change this file in a way the web app relies on, raise OWN_NATIVE in vite.config.ts, so
// an older Arise.ipa isn't sent web code it can't run.
enum AriseInbox {
    private static let lock = NSLock()

    private static var folder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Arise", isDirectory: true)
    }
    private static var inbox: URL { folder.appendingPathComponent("inbox.jsonl") }
    // Taken by the web app but not cleared yet: given again next time, so nothing is lost if the
    // app closes halfway.
    private static var taking: URL { folder.appendingPathComponent("inbox-taking.jsonl") }

    static func append(_ entry: [String: Any]) throws {
        var line = try JSONSerialization.data(withJSONObject: entry, options: [])
        line.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        let files = FileManager.default
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        if files.fileExists(atPath: inbox.path) {
            let handle = try FileHandle(forWritingTo: inbox)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } else {
            try line.write(to: inbox, options: .atomic)
        }
    }

    // Everything waiting, as text.
    static func take() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let files = FileManager.default
        if files.fileExists(atPath: inbox.path) {
            if files.fileExists(atPath: taking.path) {
                let more = try Data(contentsOf: inbox)
                let handle = try FileHandle(forWritingTo: taking)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: more)
                try files.removeItem(at: inbox)
            } else {
                try files.moveItem(at: inbox, to: taking)
            }
        }
        guard files.fileExists(atPath: taking.path) else { return "" }
        return try String(decoding: Data(contentsOf: taking), as: UTF8.self)
    }

    // The web app has kept what take() gave it.
    static func clear() {
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.removeItem(at: taking)
    }
}

// Places: iOS tells the app when the Player arrives somewhere and when they leave (visit
// monitoring). It does this even while Arise is closed, by starting it in the background for a
// moment, so this is set up when the app starts (AppDelegate). Only while Places is on in Arise.
final class ArisePlaces: NSObject, CLLocationManagerDelegate {
    static let shared = ArisePlaces()
    private static let onKey = "arise.places.on"
    private let manager = CLLocationManager()

    private override init() {
        super.init()
        manager.delegate = self
    }

    var isOn: Bool {
        get { UserDefaults.standard.bool(forKey: ArisePlaces.onKey) }
        set { UserDefaults.standard.set(newValue, forKey: ArisePlaces.onKey) }
    }

    var status: String {
        switch manager.authorizationStatus {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    // Starts or stops watching, to match the switch and what the Player allowed.
    func update() {
        let allowed = manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse
        if isOn && allowed {
            manager.startMonitoringVisits()
        } else {
            manager.stopMonitoringVisits()
        }
    }

    // Asks for While Using first, then for Always. iOS shows each question at most once.
    func ask(_ done: @escaping () -> Void) {
        switch manager.authorizationStatus {
        case .notDetermined:
            AriseAsk.afterPrompt({ self.manager.requestWhenInUseAuthorization() }, then: {
                // The answer can reach the location manager a moment after the app is back.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if self.manager.authorizationStatus == .authorizedWhenInUse {
                        AriseAsk.afterPrompt({ self.manager.requestAlwaysAuthorization() }, then: done)
                    } else {
                        done()
                    }
                }
            })
        case .authorizedWhenInUse:
            AriseAsk.afterPrompt({ self.manager.requestAlwaysAuthorization() }, then: done)
        default:
            done()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        update()
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        guard isOn else { return }
        var entry: [String: Any] = [
            "type": "visit",
            "id": UUID().uuidString,
            "lat": visit.coordinate.latitude,
            "lon": visit.coordinate.longitude,
            "acc": visit.horizontalAccuracy,
        ]
        // iOS uses these two for "not known": arrived before watching began, or not left yet.
        if visit.arrivalDate != Date.distantPast {
            entry["arrive"] = visit.arrivalDate.timeIntervalSince1970 * 1000
        }
        if visit.departureDate != Date.distantFuture {
            entry["depart"] = visit.departureDate.timeIntervalSince1970 * 1000
        }
        try? AriseInbox.append(entry)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

// Runs `ask`, which may show one of iOS's permission questions, then `then` once the Player has
// answered: the question makes the app inactive until it's answered. When iOS shows nothing
// (it already asked once), `then` runs soon after. Main thread only.
final class AriseAsk {
    private var shown = false
    private var finished = false
    private var observers: [NSObjectProtocol] = []
    private let then: () -> Void

    private init(then: @escaping () -> Void) {
        self.then = then
    }

    static func afterPrompt(_ ask: () -> Void, then: @escaping () -> Void) {
        let watch = AriseAsk(then: then)
        let center = NotificationCenter.default
        watch.observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            watch.shown = true
        })
        watch.observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            if watch.shown { watch.finish() }
        })
        ask()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            if !watch.shown { watch.finish() }
        }
    }

    private func finish() {
        if finished { return }
        finished = true
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers = []
        then()
    }
}
