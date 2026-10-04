// The Swift side of conformance/bridge-client.mjs's protocol - the same one
// the Kotlin bridge speaks (bindings/kotlin/jvm/.../Bridge.kt): one JSON
// request per line on stdin, one JSON reply per line on stdout.
//
//   {"op":"new","options":"<options json>","hostSecureStore":false}
//        -> {"ok":true}   or   {"error":{"code":"...","message":"..."}}
//   {"op":"call","method":"sync","args":"{}"}  -> {"result":"<result envelope>"}
//   {"op":"events"}                            -> {"count":N}
//   {"op":"free"}                              -> {"ok":true}, then the process ends
//
// Nothing here knows what a scenario is; it only moves strings across the
// boundary the way an app would.
import Foundation
import TrafficNetwork

/// A secret store kept in memory - stands in for the Keychain.
final class MemorySecureStore: SecureStore, @unchecked Sendable {
    private var values: [String: String] = [:]
    private let lock = NSLock()

    func get(key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    func set(key: String, value: String) throws {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }

    func delete(key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        values[key] = nil
    }
}

/// Counts events - proves the listener direction (library -> Swift) works.
final class CountingListener: EventListener, @unchecked Sendable {
    private var count = 0
    private let lock = NSLock()

    func onEvent(eventJson: String) throws {
        lock.lock()
        count += 1
        lock.unlock()
    }

    var total: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

func reply(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func failure(_ code: String, _ message: String) -> [String: Any] {
    ["error": ["code": code, "message": message]]
}

var client: TrafficNetworkClient?
let listener = CountingListener()

while let line = readLine() {
    guard
        let request = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
        let op = request["op"] as? String
    else {
        reply(failure("internal", "unreadable request"))
        continue
    }
    switch op {
    case "new":
        do {
            let hosted = request["hostSecureStore"] as? Bool ?? false
            let store: SecureStore? = hosted ? MemorySecureStore() : nil
            let created = try TrafficNetworkClient(
                optionsJson: request["options"] as! String, secureStore: store)
            created.setEventListener(listener: listener)
            client = created
            reply(["ok": true])
        } catch ClientError.Failed(let errorCode, let detail) {
            reply(failure(errorCode, detail))
        } catch {
            reply(failure("internal", "\(error)"))
        }
    case "call":
        let result = client!.call(
            method: request["method"] as! String, argsJson: request["args"] as! String)
        reply(["result": result])
    case "events":
        reply(["count": listener.total])
    case "free":
        client = nil
        reply(["ok": true])
        exit(0)
    default:
        reply(failure("internal", "unknown op"))
    }
}
