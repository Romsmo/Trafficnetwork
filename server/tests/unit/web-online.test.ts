import { describe, expect, it } from "vitest";
import { createTranslator } from "../../web/public/assets/js/i18n.js";
import { OnlineStatsPoller, REFRESH_MS, detailLines, isSwitchedOff, parseOnlineStats, summaryText } from "../../web/public/assets/js/online-badge.js";

/**
 * The "N online" display reads GET /v1/stats/online (contract: server/docs/api.md, add-on O-A) — these tests pin down
 * what the page accepts, and that anything else hides the display.
 */
const PROPOSED = {
  node: { online: 12, windowSeconds: 300 },
  network: { online: 87, nodes: 4, estimated: true, asOf: "2026-09-24T10:15:00.000Z" },
  minDisplayThreshold: 5,
};

const de = createTranslator("de");
const en = createTranslator("en");

describe("parseOnlineStats", () => {
  it("reads the documented shape", () => {
    expect(parseOnlineStats(PROPOSED)).toEqual({
      node: { exact: 12 },
      network: { exact: 87, nodes: 4, asOf: "2026-09-24T10:15:00.000Z" },
    });
  });

  it("reads the below-threshold form, with or without its own `below`", () => {
    expect(parseOnlineStats({ node: { online: null, below: 5 }, minDisplayThreshold: 5 })).toEqual({ node: { below: 5 }, network: null });
    expect(parseOnlineStats({ node: { online: null }, minDisplayThreshold: 10 })).toEqual({ node: { below: 10 }, network: null });
    expect(parseOnlineStats({ node: { online: 30 }, network: { online: null, below: 5, nodes: 2 }, minDisplayThreshold: 5 })).toEqual({
      node: { exact: 30 },
      network: { below: 5, nodes: 2, asOf: null },
    });
  });

  it("never shows an exact number under the threshold, even if a server sent one (one online = one person)", () => {
    expect(parseOnlineStats({ node: { online: 1 }, network: { online: 3 }, minDisplayThreshold: 5 })).toEqual({
      node: { below: 5 },
      network: { below: 5, nodes: null, asOf: null },
    });
    expect(parseOnlineStats({ node: { online: 5 }, minDisplayThreshold: 5 })!.node).toEqual({ exact: 5 });
  });

  it("works without a network part (single node, no federation)", () => {
    expect(parseOnlineStats({ node: { online: 40 } })).toEqual({ node: { exact: 40 }, network: null });
  });

  it("ignores an unusable network part but keeps the node's own number", () => {
    expect(parseOnlineStats({ node: { online: 40 }, network: { online: "many" } })).toEqual({ node: { exact: 40 }, network: null });
    expect(parseOnlineStats({ node: { online: 40 }, network: { online: 90, asOf: "yesterday-ish" } })!.network!.asOf).toBeNull();
  });

  it.each([null, undefined, 7, "12", [], {}, { node: null }, { node: {} }, { node: { online: "12" } }, { node: { online: -1 } }, { node: { online: 1.5 } }, { node: { online: null } }])(
    "shows nothing for an answer it does not understand: %j",
    (payload) => {
      expect(parseOnlineStats(payload)).toBeNull();
    },
  );

  it("treats { enabled: false } as switched off", () => {
    expect(isSwitchedOff({ enabled: false })).toBe(true);
    expect(isSwitchedOff({ enabled: true, node: { online: 9 } })).toBe(false);
    expect(isSwitchedOff(null)).toBe(false);
    expect(parseOnlineStats({ enabled: false, node: { online: 12 } })).toBeNull();
  });
});

describe("texts", () => {
  it("shows this node's figure as the visible text, the exact number or the below-threshold wording", () => {
    const exact = parseOnlineStats(PROPOSED)!;
    expect(summaryText(exact, de)).toBe("12 online");
    expect(summaryText(exact, en)).toBe("12 online");
    const below = parseOnlineStats({ node: { online: null, below: 5 } })!;
    expect(summaryText(below, de)).toBe("weniger als 5 online");
    expect(summaryText(below, en)).toBe("fewer than 5 online");
  });

  it("always labels the network figure as an estimate and says it is not verified", () => {
    const lines = detailLines(parseOnlineStats(PROPOSED)!, de);
    const network = lines.find((line) => line.startsWith("Im Netzwerk"))!;
    expect(network).toContain("geschätzt");
    expect(network).toContain("87");
    expect(network).toContain("4 Knoten");
    expect(lines.join("\n")).toContain("nicht überprüft");
    expect(lines.join("\n")).toMatch(/Stand: \d{2}:\d{2} Uhr/);
    expect(detailLines(parseOnlineStats(PROPOSED)!, en).join("\n")).toContain("estimated");
    const below = detailLines(parseOnlineStats({ node: { online: 20 }, network: { online: null, below: 5 } })!, de);
    expect(below.find((line) => line.startsWith("Im Netzwerk"))).toBe("Im Netzwerk (geschätzt): weniger als 5 online");
  });

  it("says that only counting happens, and shows no network lines for a single node", () => {
    const lines = detailLines(parseOnlineStats({ node: { online: 40 } })!, en);
    expect(lines).toEqual(["On this node: 40 online", "This only counts – no people, addresses or locations are stored for it."]);
  });
});

/** A fake clock: timers are collected and fired by hand. */
function fakeClock() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  return {
    setTimeoutImpl: (fn: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutImpl: (id: number) => {
      pending.delete(id);
    },
    pendingDelays: () => [...pending.values()].map((timer) => timer.ms),
    async fireNext() {
      const [id, timer] = [...pending.entries()][0] ?? [];
      if (id === undefined || !timer) throw new Error("no timer pending");
      pending.delete(id);
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function setup(responses: Array<() => Promise<Response> | Response>, options: { visible?: () => boolean } = {}) {
  const clock = fakeClock();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const states: Array<[string, unknown]> = [];
  const poller = new OnlineStatsPoller({
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return next();
    }) as unknown as typeof fetch,
    setTimeoutImpl: clock.setTimeoutImpl as unknown as typeof setTimeout,
    clearTimeoutImpl: clock.clearTimeoutImpl as unknown as typeof clearTimeout,
    isVisible: options.visible ?? (() => true),
    onState: (state: string, stats: unknown) => states.push([state, stats]),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { poller, clock, calls, states, settle };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("OnlineStatsPoller", () => {
  it("reads the public endpoint without credentials, reports the numbers and asks again every 30 seconds", async () => {
    const { poller, clock, calls, states, settle } = setup([json(PROPOSED), json({ ...PROPOSED, node: { online: 15 } })]);
    poller.start();
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/v1/stats/online");
    expect(calls[0]!.init).toMatchObject({ cache: "no-store", credentials: "omit" });
    expect(JSON.stringify(calls[0]!.init)).not.toMatch(/authorization/i);
    expect(states[0]![0]).toBe("ready");
    expect(REFRESH_MS).toBe(30_000);
    expect(clock.pendingDelays()).toEqual([30_000]);

    await clock.fireNext();
    expect(calls).toHaveLength(2);
    expect((states[1]![1] as { node: { exact: number } }).node.exact).toBe(15);
    poller.stop();
    expect(clock.pendingDelays()).toEqual([]);
  });

  it.each([404, 401, 403, 405, 410])("goes quiet for good when the node has no counter (HTTP %i): no error, no more requests", async (status) => {
    const { poller, clock, calls, states, settle } = setup([() => new Response("nope", { status })]);
    poller.start();
    await settle();
    expect(states).toEqual([["off", null]]);
    expect(clock.pendingDelays()).toEqual([]);
    await poller.refresh(); // e.g. the tab becoming visible again
    expect(calls).toHaveLength(1);
  });

  it("goes quiet for good when the node says the feature is switched off", async () => {
    const { poller, clock, states, settle } = setup([json({ enabled: false })]);
    poller.start();
    await settle();
    expect(states).toEqual([["off", null]]);
    expect(clock.pendingDelays()).toEqual([]);
  });

  it("hides on a passing failure but keeps trying, and shows the number again once it works", async () => {
    const { poller, clock, states, settle } = setup([
      () => {
        throw new TypeError("network down");
      },
      () => new Response("oops", { status: 503 }),
      () => new Response("slow down", { status: 429 }),
      () => new Response("<html>", { status: 200 }),
      json({}),
      json(PROPOSED),
    ]);
    poller.start();
    await settle();
    for (let i = 0; i < 5; i += 1) await clock.fireNext();
    expect(states.map(([state]) => state)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable", "unavailable", "ready"]);
    expect(clock.pendingDelays()).toEqual([30_000]);
  });

  it("does not ask while the tab is hidden (once it has a number), and shares a read that is already running", async () => {
    let visible = true;
    const { poller, clock, calls, settle } = setup([json(PROPOSED), json(PROPOSED)], { visible: () => visible });
    poller.start();
    await settle();
    visible = false;
    await clock.fireNext();
    expect(calls).toHaveLength(1);
    expect(clock.pendingDelays()).toEqual([30_000]);
    visible = true;
    const first = poller.refresh();
    const second = poller.refresh();
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
  });

  it("does nothing after it was stopped", async () => {
    const { poller, calls, states, clock, settle } = setup([json(PROPOSED)]);
    await poller.refresh(); // never started
    expect(calls).toHaveLength(0);
    poller.start(); // the first read is on its way ...
    poller.stop(); // ... but nobody is interested in its answer any more
    await settle();
    await poller.refresh();
    expect(calls).toHaveLength(1);
    expect(states).toEqual([]);
    expect(clock.pendingDelays()).toEqual([]);
  });
});
