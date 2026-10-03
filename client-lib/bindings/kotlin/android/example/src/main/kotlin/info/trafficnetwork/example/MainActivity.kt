// Minimal Android example - see client-lib/docs/integration-android.md.
package info.trafficnetwork.example

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import info.trafficnetwork.client.TrafficNetworkClient
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

// Replace these with a Trafficnetwork server and a credential of scope `client`.
private const val NODE = "https://node.example.org"
private const val CLIENT_ID = "REPLACE_WITH_CLIENT_ID"
private const val CLIENT_SECRET = "REPLACE_WITH_CLIENT_SECRET"

private const val BERLIN_LAT = 52.52
private const val BERLIN_LNG = 13.405

class MainActivity : Activity() {
    private lateinit var output: TextView
    private var client: TrafficNetworkClient? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        output = TextView(this).apply { text = "Working..." }
        setContentView(ScrollView(this).apply { addView(output) })

        // A call that talks to the network blocks until it is done, so it
        // runs off the UI thread. (A coroutine can call `callAsync` instead.)
        thread {
            val text = try {
                run()
            } catch (error: Exception) {
                "Failed: ${error.message}"
            }
            runOnUiThread { output.text = text }
        }
    }

    private fun run(): String {
        val options = JSONObject()
            // The directory the client keeps its database and secrets in; the
            // app's private files are the right place.
            .put("storagePath", filesDir.resolve("trafficnetwork").path)
            .put("discovery", false)
            .put("nodes", JSONArray().put(NODE))
            .put(
                "credentials",
                JSONObject()
                    .put("type", "client")
                    .put("clientId", CLIENT_ID)
                    .put("clientSecret", CLIENT_SECRET),
            )
        val created = TrafficNetworkClient(options.toString(), null)
        client = created

        val here = JSONObject().put("lat", BERLIN_LAT).put("lng", BERLIN_LNG)
        created.ask("updatePosition", here) // which map tiles to watch
        val sync = created.ask("sync") // fetch what is around

        // Reads never touch the network - they answer from the local copy.
        val limit = created.ask("getSpeedLimitAt", here)
        val nearby = created.ask("getNearby", JSONObject(here.toString()).put("radiusMeters", 2000))
        return "sync: $sync\nspeed limit here: $limit\nnearby: $nearby"
    }

    override fun onDestroy() {
        // Releases the client; its data stays on disk.
        client?.close()
        super.onDestroy()
    }
}

/** One API call: the `ok` value of the result, or an exception for an `error`. */
private fun TrafficNetworkClient.ask(method: String, args: JSONObject = JSONObject()): Any? {
    val envelope = JSONObject(call(method, args.toString()))
    if (envelope.has("error")) {
        val error = envelope.getJSONObject("error")
        throw IllegalStateException("${error.getString("code")}: ${error.getString("message")}")
    }
    return envelope.get("ok")
}
