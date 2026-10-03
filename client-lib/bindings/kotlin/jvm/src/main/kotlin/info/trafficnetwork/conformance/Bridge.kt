// A conformance bridge: lets conformance/run_bridge.mjs drive the generated
// Kotlin binding with the same scenarios every other binding runs, so "same
// behavior everywhere" is checked here too and not assumed. One request per
// line on stdin, one JSON reply per line on stdout:
//
//   {"op":"new","options":"<options json>","hostSecureStore":false}
//        -> {"ok":true}   or   {"error":{"code":"…","message":"…"}}
//   {"op":"call","method":"sync","args":"{}"}  -> {"result":"<result envelope>"}
//   {"op":"free"}                              -> {"ok":true}, then the process ends
//
// Nothing here knows what a scenario is; it only moves strings across the
// boundary the way a real app would.
package info.trafficnetwork.conformance

import info.trafficnetwork.client.ClientException
import info.trafficnetwork.client.EventListener
import info.trafficnetwork.client.SecureStore
import info.trafficnetwork.client.TrafficNetworkClient
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** A secret store kept in memory — stands in for the Android Keystore. */
private class MemorySecureStore : SecureStore {
    private val values = ConcurrentHashMap<String, String>()

    override fun get(key: String): String? = values[key]

    override fun set(key: String, value: String) {
        values[key] = value
    }

    override fun delete(key: String) {
        values.remove(key)
    }
}

/** Counts events — proves the listener direction (library -> Kotlin) works. */
private class CountingListener : EventListener {
    @Volatile var count = 0

    override fun onEvent(eventJson: String) {
        count += 1
    }
}

private fun reply(body: JSONObject) {
    println(body.toString())
    System.out.flush()
}

fun main() {
    var client: TrafficNetworkClient? = null
    val listener = CountingListener()
    val reader = System.`in`.bufferedReader()
    while (true) {
        val line = reader.readLine() ?: break
        val request = JSONObject(line)
        when (request.getString("op")) {
            "new" -> {
                try {
                    val store = if (request.optBoolean("hostSecureStore")) MemorySecureStore() else null
                    val created = TrafficNetworkClient(request.getString("options"), store)
                    created.setEventListener(listener)
                    client = created
                    reply(JSONObject().put("ok", true))
                } catch (error: ClientException.Failed) {
                    val failure = JSONObject().put("code", error.errorCode).put("message", error.detail)
                    reply(JSONObject().put("error", failure))
                }
            }
            "call" -> {
                val result = client!!.call(request.getString("method"), request.getString("args"))
                reply(JSONObject().put("result", result))
            }
            "events" -> reply(JSONObject().put("count", listener.count))
            "free" -> {
                client?.close()
                client = null
                reply(JSONObject().put("ok", true))
                return
            }
            else -> reply(JSONObject().put("error", JSONObject().put("code", "internal").put("message", "unknown op")))
        }
    }
}
