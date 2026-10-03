// Minimal Swift example - see client-lib/docs/integration-ios.md.
//
//     TN_NODE=http://localhost:3000 TN_CLIENT_ID=... TN_CLIENT_SECRET=... \
//         swift run
import Foundation
import TrafficNetwork

let berlinLat = 52.52
let berlinLng = 13.405
let environment = ProcessInfo.processInfo.environment

struct ApiFailure: Error {
    let description: String
}

/// One API call: the `ok` value of the result, or an error for an `error`.
func ask(_ client: TrafficNetworkClient, _ method: String, _ args: [String: Any] = [:]) throws -> Any {
    let argsJson = String(data: try JSONSerialization.data(withJSONObject: args), encoding: .utf8)!
    let text = client.call(method: method, argsJson: argsJson)
    let envelope = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
    if let error = envelope["error"] as? [String: Any] {
        throw ApiFailure(description: "\(error["code"] ?? "internal"): \(error["message"] ?? "")")
    }
    return envelope["ok"] as Any
}

print("native library \(libraryVersion())")

// A directory this client keeps its database and secrets in; reuse the same
// one next time and it carries on where it left off.
let storagePath = FileManager.default.temporaryDirectory
    .appendingPathComponent("trafficnetwork-example-\(UUID().uuidString)").path

let options: [String: Any] = [
    "storagePath": storagePath,
    "discovery": false,
    "nodes": [environment["TN_NODE"] ?? "http://localhost:3000"],
    "credentials": [
        "type": "client",
        "clientId": environment["TN_CLIENT_ID"] ?? "",
        "clientSecret": environment["TN_CLIENT_SECRET"] ?? "",
    ],
]
let optionsJson = String(data: try JSONSerialization.data(withJSONObject: options), encoding: .utf8)!

do {
    let client = try TrafficNetworkClient(optionsJson: optionsJson, secureStore: nil)
    let here: [String: Any] = ["lat": berlinLat, "lng": berlinLng]

    _ = try ask(client, "updatePosition", here) // which map tiles to watch
    let report = try ask(client, "sync") as! [String: Any] // fetch what is around
    print("sync ok: \((report["ok"] as? Bool) ?? false), pending writes: \(report["pendingWrites"] ?? "?")")

    // Reads never touch the network - they answer from the local copy.
    print("speed limit here: \(try ask(client, "getSpeedLimitAt", here))")
    var around = here
    around["radiusMeters"] = 2000
    let nearby = try ask(client, "getNearby", around) as! [String: Any]
    print("\((nearby["items"] as! [Any]).count) things within 2 km")

    // Queued locally first (getNearby shows it at once), sent by the next sync.
    var accident = here
    accident["type"] = "accident"
    let queued = try ask(client, "submitReport", accident) as! [String: Any]
    let sent = try ask(client, "sync") as! [String: Any]
    print("queued report \(queued["localId"] ?? "?"); sync ok: \((sent["ok"] as? Bool) ?? false)")
} catch ClientError.Failed(let errorCode, let detail) {
    print("could not create the client: \(errorCode): \(detail)")
    exit(1)
} catch {
    print("failed: \(error)")
    exit(1)
}
