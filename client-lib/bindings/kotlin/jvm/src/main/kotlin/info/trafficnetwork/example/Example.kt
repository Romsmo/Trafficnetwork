// Minimal Kotlin example - see client-lib/docs/integration-android.md. The
// same calls as inside an Android Activity, on a plain JVM so it can be run
// (and is, in CI) against a server:
//
//     gradle installDist
//     TN_NODE=http://localhost:3000 TN_CLIENT_ID=... TN_CLIENT_SECRET=... \
//         java -Djna.library.path=<dir of libtrafficnetwork_uniffi.so> \
//         -cp 'build/install/trafficnetwork-kotlin-jvm/lib/*' info.trafficnetwork.example.ExampleKt
package info.trafficnetwork.example

import info.trafficnetwork.client.TrafficNetworkClient
import info.trafficnetwork.client.libraryVersion
import org.json.JSONArray
import org.json.JSONObject
import java.nio.file.Files

private const val BERLIN_LAT = 52.52
private const val BERLIN_LNG = 13.405

/** One API call: `{"ok": ...}` opened, or an exception for `{"error": ...}`. */
private fun TrafficNetworkClient.ask(method: String, args: JSONObject = JSONObject()): Any? {
    val envelope = JSONObject(call(method, args.toString()))
    if (envelope.has("error")) {
        val error = envelope.getJSONObject("error")
        throw IllegalStateException("${error.getString("code")}: ${error.getString("message")}")
    }
    return envelope.get("ok")
}

fun main() {
    println("native library ${libraryVersion()}")

    // A directory this client keeps its database and secrets in; reuse the same
    // one next time and it carries on where it left off.
    val storagePath = Files.createTempDirectory("trafficnetwork-example").toString()

    val options = JSONObject()
        .put("storagePath", storagePath)
        .put("discovery", false)
        .put("nodes", JSONArray().put(System.getenv("TN_NODE") ?: "http://localhost:3000"))
        .put(
            "credentials",
            JSONObject()
                .put("type", "client")
                .put("clientId", System.getenv("TN_CLIENT_ID"))
                .put("clientSecret", System.getenv("TN_CLIENT_SECRET")),
        )

    // `use` releases the client at the end; its data stays on disk.
    TrafficNetworkClient(options.toString(), null).use { client ->
        val here = JSONObject().put("lat", BERLIN_LAT).put("lng", BERLIN_LNG)

        client.ask("updatePosition", here) // which map tiles to watch
        val report = client.ask("sync") as JSONObject // fetch what is around
        println("sync ok: ${report.getBoolean("ok")}, pending writes: ${report.getInt("pendingWrites")}")

        // Reads never touch the network - they answer from the local copy.
        println("speed limit here: ${client.ask("getSpeedLimitAt", here)}")
        val nearby = client.ask("getNearby", JSONObject(here.toString()).put("radiusMeters", 2000))
        println("${(nearby as JSONObject).getJSONArray("items").length()} things within 2 km")

        // Queued locally first (getNearby shows it at once), sent by the next sync.
        val queued = client.ask("submitReport", JSONObject(here.toString()).put("type", "accident"))
        val localId = (queued as JSONObject).get("localId")
        val sent = client.ask("sync") as JSONObject
        println("queued report $localId; sync ok: ${sent.getBoolean("ok")}")
    }
}
