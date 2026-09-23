/** Error from the node's API, with the fields the UI needs to explain what happened. */
export class ApiError extends Error {
  constructor(status, code, message, details, retryAfterSeconds) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const REFRESH_MARGIN_MS = 60_000;

/**
 * Talks to this node's /v1 API with an anonymous web session (POST /v1/web/session): no credentials are stored or shipped,
 * the token lives in memory only and is renewed shortly before it expires. Everything the browser needs goes through here.
 */
export class ApiClient {
  #token = null;
  #expiresAt = 0;
  #minting = null;

  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), now = Date.now, baseUrl = "" } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.baseUrl = baseUrl;
  }

  async ensureToken(force = false) {
    if (!force && this.#token && this.#expiresAt - this.now() > REFRESH_MARGIN_MS) return this.#token;
    this.#minting ??= this.#mint().finally(() => {
      this.#minting = null;
    });
    return this.#minting;
  }

  async #mint() {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/web/session`, { method: "POST" });
    if (!response.ok) throw await toApiError(response);
    const body = await response.json();
    this.#token = body.accessToken;
    this.#expiresAt = this.now() + body.expiresIn * 1000;
    return this.#token;
  }

  async request(method, path, { query, body } = {}) {
    const url = `${this.baseUrl}${path}${buildQuery(query)}`;
    const send = async (token) =>
      this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

    let response = await send(await this.ensureToken());
    if (response.status === 401) response = await send(await this.ensureToken(true));
    if (!response.ok) throw await toApiError(response);
    const data = await response.json();
    return { status: response.status, data };
  }

  get(path, query) {
    return this.request("GET", path, { query });
  }

  post(path, body) {
    return this.request("POST", path, { body: body ?? {} });
  }
}

export function buildQuery(query) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

async function toApiError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // not JSON (proxy error page, …) — fall back to the status line
  }
  const error = payload?.error ?? {};
  const header = Number(response.headers?.get?.("retry-after"));
  const retryAfterSeconds = error.details?.retryAfterSeconds ?? (Number.isFinite(header) && header > 0 ? header : undefined);
  return new ApiError(response.status, error.code ?? "HTTP_ERROR", error.message ?? `HTTP ${response.status}`, error.details, retryAfterSeconds);
}
