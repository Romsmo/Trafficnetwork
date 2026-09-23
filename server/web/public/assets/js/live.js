const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * Live updates over the node's WebSocket (/v1/ws): authenticates with the web-session token, subscribes to the H3 tile
 * around the map centre and reports events. Reconnects with backoff; after every reconnect `onResync` fires so the page
 * can re-read what it missed while the socket was down (pushed events are not replayed).
 */
export class LiveConnection {
  #ws = null;
  #connected = false;
  #stopped = true;
  #attempt = 0;
  #everConnected = false;
  #timer = null;
  #desired = null; // { tile, k }
  #sent = null; // subscription currently active on the server

  constructor({ api, url, WebSocketImpl = globalThis.WebSocket, setTimeoutImpl = globalThis.setTimeout.bind(globalThis), clearTimeoutImpl = globalThis.clearTimeout.bind(globalThis), onEvent, onStatus, onResync }) {
    this.api = api;
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.onEvent = onEvent ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onResync = onResync ?? (() => {});
  }

  get connected() {
    return this.#connected;
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.clearTimeoutImpl(this.#timer);
    try {
      this.#ws?.close();
    } catch {
      // already closed
    }
  }

  /** Desired subscription: tile + k-ring. Applied immediately when connected, re-applied after every reconnect. */
  subscribe(tile, k) {
    if (this.#desired?.tile === tile && this.#desired?.k === k) return;
    this.#desired = { tile, k };
    this.#applySubscription();
  }

  #applySubscription() {
    if (!this.#connected || !this.#ws || !this.#desired) return;
    const same = this.#sent && this.#sent.tile === this.#desired.tile && this.#sent.k === this.#desired.k;
    if (same) return;
    if (this.#sent) this.#ws.send(JSON.stringify({ type: "unsubscribe", tile: this.#sent.tile, k: this.#sent.k }));
    this.#ws.send(JSON.stringify({ type: "subscribe", tile: this.#desired.tile, k: this.#desired.k }));
    this.#sent = { ...this.#desired };
  }

  async #connect() {
    if (this.#stopped) return;
    let token;
    try {
      token = await this.api.ensureToken();
    } catch {
      this.#scheduleReconnect();
      return;
    }
    const ws = new this.WebSocketImpl(this.url);
    this.#ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
    ws.onmessage = (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      if (data.type === "auth_ok") {
        this.#connected = true;
        this.#sent = null;
        this.#attempt = 0;
        this.onStatus(true);
        this.#applySubscription();
        if (this.#everConnected) this.onResync();
        this.#everConnected = true;
      } else if (data.type === "event") {
        this.onEvent(data.event);
      }
    };
    ws.onclose = () => {
      const wasConnected = this.#connected;
      this.#connected = false;
      this.#sent = null;
      this.#ws = null;
      if (wasConnected || !this.#stopped) this.onStatus(false);
      this.#scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    };
  }

  #scheduleReconnect() {
    if (this.#stopped) return;
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)];
    this.#attempt += 1;
    this.clearTimeoutImpl(this.#timer);
    this.#timer = this.setTimeoutImpl(() => void this.#connect(), delay);
  }
}
