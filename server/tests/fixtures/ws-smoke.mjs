// CI-only smoke test for the Apache/nginx reverse-proxy WebSocket setup
// (.github/workflows/server-ci.yml). Proves the /v1/ws upgrade handshake and
// bidirectional message flow survive the proxy — not an application-level
// auth test (that's covered by tests/integration/realtime.test.ts against
// the app directly). Sending a non-"auth" message first deterministically
// gets an {type:"error"} reply from the app, which is all this needs.
//
// Usage: node ws-smoke.mjs <ws-url>
// Exits 0 on a received reply, 1 on error/timeout.

const url = process.argv[2];
if (!url) {
  console.error("usage: node ws-smoke.mjs <ws-url>");
  process.exit(1);
}

const ws = new WebSocket(url);
const timeout = setTimeout(() => {
  console.error("ws-smoke: timed out waiting for a reply");
  process.exit(1);
}, 10_000);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", tile: "871f200d3ffffff" }));
});

ws.addEventListener("message", (event) => {
  console.log("ws-smoke: received reply through the proxy:", event.data);
  clearTimeout(timeout);
  ws.close();
  process.exit(0);
});

ws.addEventListener("error", (event) => {
  console.error("ws-smoke: connection error", event.message ?? event);
  clearTimeout(timeout);
  process.exit(1);
});
