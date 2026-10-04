/* Minimal C example - see client-lib/docs/integration-c.md.
 *
 * Every call is  tn_client_call(client, method, argsJson) -> resultJson,
 * {"ok": ...} or {"error": {...}}; every string the library returns is freed
 * with tn_free_string, never with free().
 *
 *     TN_NODE=http://localhost:3000 TN_CLIENT_ID=... TN_CLIENT_SECRET=... ./example
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "trafficnetwork.h"

/* Runs one API method, prints what came back under `label`, returns the result text (free it with tn_free_string). */
static char *ask(void *client, const char *label, const char *method, const char *args) {
    char *result = tn_client_call(client, method, args);
    printf("%s: %s\n", label, result);
    return result;
}

int main(void) {
    const char *node = getenv("TN_NODE") ? getenv("TN_NODE") : "http://localhost:3000";
    const char *id = getenv("TN_CLIENT_ID") ? getenv("TN_CLIENT_ID") : "";
    const char *secret = getenv("TN_CLIENT_SECRET") ? getenv("TN_CLIENT_SECRET") : "";

    char *version = tn_library_version();
    printf("native library %s\n", version);
    tn_free_string(version);

    /* storagePath is the directory the client keeps its database and secrets in;
       reuse the same one next time and it carries on where it left off. */
    char options[1024];
    snprintf(options, sizeof options,
             "{\"storagePath\": \"trafficnetwork-example-data\", \"discovery\": false,"
             " \"nodes\": [\"%s\"],"
             " \"credentials\": {\"type\": \"client\", \"clientId\": \"%s\", \"clientSecret\": \"%s\"}}",
             node, id, secret);

    char *error = NULL;
    void *client = tn_client_new(options, &error);
    if (client == NULL) {
        fprintf(stderr, "could not create the client: %s\n", error ? error : "(no message)");
        tn_free_string(error);
        return 1;
    }

    const char *here = "{\"lat\": 52.52, \"lng\": 13.405}";
    tn_free_string(ask(client, "update position", "updatePosition", here)); /* which map tiles to watch */

    char *sync = ask(client, "sync", "sync", "{}"); /* fetch what is around */
    int synced = strstr(sync, "\"ok\":true") != NULL;
    printf("sync ok: %s\n", synced ? "true" : "false");
    tn_free_string(sync);

    /* Reads never touch the network - they answer from the local copy. */
    tn_free_string(ask(client, "speed limit here", "getSpeedLimitAt", here));
    tn_free_string(ask(client, "nearby", "getNearby",
                       "{\"lat\": 52.52, \"lng\": 13.405, \"radiusMeters\": 2000}"));

    /* Queued locally first (getNearby shows it at once), sent by the next sync. */
    char *queued = ask(client, "queued report", "submitReport",
                       "{\"type\": \"accident\", \"lat\": 52.52, \"lng\": 13.405}");
    tn_free_string(queued);
    char *sent = ask(client, "sync again", "sync", "{}");
    printf("queued report; sync ok: %s\n", strstr(sent, "\"ok\":true") ? "true" : "false");
    tn_free_string(sent);

    tn_client_free(client); /* the data stays on disk */
    return synced ? 0 : 1;
}
