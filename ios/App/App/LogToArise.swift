import AppIntents
import Foundation

// "Log to Arise": an action in the Shortcuts app, so personal automations (an app is opened, the
// Player arrives home, a message comes in…) can add a line to the life log. It runs in the
// background without opening Arise, and only writes to the app's own inbox file (AriseInbox);
// the web app adds it to the life log the next time it opens (src/life/sense.ts).
//
// If you change this file in a way the web app relies on (a new kind, say), raise OWN_NATIVE in
// vite.config.ts, so an older Arise.ipa isn't sent web code it can't run.

@available(iOS 16.0, *)
enum AriseLogKind: String, AppEnum {
    case appOpened
    case appClosed
    case arrived
    case left
    case message
    case email
    case focus
    case alarm
    case sleep
    case charging
    case wifi
    case carplay
    case other

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Kind"
    static let caseDisplayRepresentations: [AriseLogKind: DisplayRepresentation] = [
        .appOpened: "App opened",
        .appClosed: "App closed",
        .arrived: "Arrived",
        .left: "Left",
        .message: "Message",
        .email: "Email",
        .focus: "Focus",
        .alarm: "Alarm",
        .sleep: "Sleep",
        .charging: "Charger",
        .wifi: "Wi-Fi",
        .carplay: "CarPlay",
        .other: "Other",
    ]
}

@available(iOS 16.0, *)
struct LogToAriseIntent: AppIntent {
    static let title: LocalizedStringResource = "Log to Arise"
    static let openAppWhenRun: Bool = false

    @Parameter(title: "What happened")
    var what: String?

    @Parameter(title: "Kind", default: .other)
    var kind: AriseLogKind

    @Parameter(title: "Detail")
    var detail: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Log \(\.$what) to Arise as \(\.$kind)") {
            \.$detail
        }
    }

    func perform() async throws -> some IntentResult {
        try AriseInbox.append([
            "type": "log",
            "id": UUID().uuidString,
            "at": Date().timeIntervalSince1970 * 1000,
            "kind": kind.rawValue,
            "what": what ?? "",
            "detail": detail ?? "",
        ])
        return .result()
    }
}
