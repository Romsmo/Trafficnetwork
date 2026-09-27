import { politeGet, type HttpOptions } from "../../http/polite.js";
import type { Logger } from "../../logging.js";
import { SIGN_PLATE_TYPE_ID, SKILTNUMMER_PROPERTY_ID, codeOfVerdi, type NvdbObject } from "./normalize.js";

/**
 * A polite client for NVDB API Les V4 (nvdbapiles.atlas.vegvesen.no) — read access needs no account, but the API refuses a
 * request without an `X-Client` header (HTTP 400, "X-Client må være satt") and publishes a rate limit in `x-ratelimit-remaining`
 * (a budget of 200 that was observed to refill within seconds). This client:
 *  - identifies itself (`X-Client`, and `X-Kontaktperson` when configured),
 *  - spaces requests (`minRequestIntervalMs`) and pauses when the remaining budget runs low,
 *  - retries 429/5xx with the server's Retry-After (http/polite.ts),
 *  - counts requests against an optional per-run budget, so an operator can cap a run.
 */

export interface NvdbClientOptions {
  baseUrl: string;
  clientId: string;
  contact?: string;
  minRequestIntervalMs: number;
  /** Stop with RequestBudgetExhausted after this many requests in one run (undefined = no cap). The run resumes where it stopped. */
  maxRequests?: number;
  http: Pick<HttpOptions, "timeoutMs" | "backoff" | "fetchImpl">;
  logger: Logger;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class RequestBudgetExhausted extends Error {}

/** The remaining-request budget below which the client waits before the next request. */
const LOW_WATERMARK = 15;
const LOW_WATERMARK_PAUSE_MS = 5_000;
/** The API caps a page by response size (800 objects were returned when 1000 were asked for, with properties). */
const PAGE_SIZE = 1000;
/** A guard against a cursor that never ends: no real municipality has this many pages. */
const MAX_PAGES_PER_SECTION = 20_000;

export interface Municipality {
  nummer: number;
  navn: string;
}

export interface SignPlateDefinition {
  /** enum id → code, for every allowed value of property 5530 "Skiltnummer". */
  enumCodes: Map<number, string>;
}

interface Page {
  objekter?: NvdbObject[];
  metadata?: { neste?: { start?: string } };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class NvdbClient {
  private requests = 0;
  private lastRequestAt = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(private readonly options: NvdbClientOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  get requestCount(): number {
    return this.requests;
  }

  private async getJson<T>(pathAndQuery: string): Promise<T> {
    if (this.options.maxRequests !== undefined && this.requests >= this.options.maxRequests) {
      throw new RequestBudgetExhausted(`NVDB_NO_MAX_REQUESTS (${this.options.maxRequests}) reached — stopping; the run resumes from its local progress state`);
    }
    const wait = this.lastRequestAt + this.options.minRequestIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.requests++;
    this.lastRequestAt = Date.now();

    const headers: Record<string, string> = { accept: "application/json", "x-client": this.options.clientId };
    if (this.options.contact) headers["x-kontaktperson"] = this.options.contact;
    const res = await politeGet(`${this.baseUrl}${pathAndQuery}`, { ...this.options.http, headers }, this.options.logger);

    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    if (res.headers.get("x-ratelimit-remaining") !== null && Number.isFinite(remaining) && remaining < LOW_WATERMARK) {
      this.options.logger.info({ remaining, pauseMs: LOW_WATERMARK_PAUSE_MS }, "NVDB rate-limit budget is low — pausing");
      await this.sleep(LOW_WATERMARK_PAUSE_MS);
    }
    return (await res.json()) as T;
  }

  /** The allowed values of property 5530 "Skiltnummer" of object type 96 "Skiltplate". */
  async signPlateDefinition(): Promise<SignPlateDefinition> {
    const type = await this.getJson<{ egenskapstyper?: { id?: number; tillatte_verdier?: { id?: number; verdi?: unknown }[] }[] }>(`/vegobjekttyper/${SIGN_PLATE_TYPE_ID}`);
    const property = type.egenskapstyper?.find((p) => p.id === SKILTNUMMER_PROPERTY_ID);
    if (!property?.tillatte_verdier || property.tillatte_verdier.length === 0) {
      throw new Error(`NVDB object type ${SIGN_PLATE_TYPE_ID} has no allowed values for property ${SKILTNUMMER_PROPERTY_ID} "Skiltnummer" — the data model changed; the importer must be adapted before it can run`);
    }
    const enumCodes = new Map<number, string>();
    for (const value of property.tillatte_verdier) {
      const code = typeof value.verdi === "string" ? codeOfVerdi(value.verdi) : undefined;
      if (typeof value.id === "number" && code) enumCodes.set(value.id, code);
    }
    return { enumCodes };
  }

  /** How many sign plates the municipality has in total (no series filter): `/statistikk` answers with one number and no cursor. */
  async signPlateCount(kommune: number): Promise<number | undefined> {
    const stats = await this.getJson<{ antall?: unknown }>(`/vegobjekter/${SIGN_PLATE_TYPE_ID}/statistikk?kommune=${kommune}`);
    return typeof stats.antall === "number" && Number.isFinite(stats.antall) ? stats.antall : undefined;
  }

  async municipalities(): Promise<Municipality[]> {
    const list = await this.getJson<{ nummer?: unknown; navn?: unknown }[]>("/omrader/kommuner");
    const result = list.filter((k): k is { nummer: number; navn: string } => typeof k.nummer === "number" && typeof k.navn === "string");
    if (result.length === 0) throw new Error("NVDB returned no municipalities — cannot split the import into sections");
    return result.sort((a, b) => a.nummer - b.nummer);
  }

  /**
   * All sign plates of one municipality, page by page, in the order the API gives them. `enumIds`, when given, restricts the
   * request to those Skiltnummer values on the server (a saving for the API, not a correctness matter — the caller still checks
   * every object).
   *
   * Real end-of-data behaviour: after the last object the API does NOT drop `metadata.neste`; it answers the same cursor with an
   * empty page, forever. The loop ends on an empty page (or an unchanged cursor), never on a missing `neste` alone.
   */
  async *signPlatePages(kommune: number, enumIds?: number[]): AsyncGenerator<NvdbObject[]> {
    let cursor: string | undefined;
    for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_SECTION; pageNumber++) {
      const query = new URLSearchParams({ kommune: String(kommune), inkluder: "egenskaper,geometri", srid: "4326", antall: String(PAGE_SIZE) });
      if (enumIds && enumIds.length > 0) query.set("egenskap", `egenskap(${SKILTNUMMER_PROPERTY_ID})in[${enumIds.join(",")}]`);
      if (cursor !== undefined) query.set("start", cursor);

      const page = await this.getJson<Page>(`/vegobjekter/${SIGN_PLATE_TYPE_ID}?${query.toString()}`);
      const objects = Array.isArray(page.objekter) ? page.objekter : [];
      if (objects.length === 0) return;
      yield objects;

      const next = page.metadata?.neste?.start;
      if (!next || next === cursor) return;
      cursor = next;
    }
    throw new Error(`municipality ${kommune}: more than ${MAX_PAGES_PER_SECTION} pages — the cursor does not end; refusing to continue`);
  }
}
