import type { WebSocket } from "ws";
import type { SubscriptionRegistry } from "./registry.js";
import type { appendEvent } from "../../db/append-event.js";
import { stripReporterIds } from "../web/redact.js";
import { classifyEvent, zoneEvent } from "../cameras/policy/events.js";
import { tilesSpeakingForCell } from "../cameras/policy/cells.js";

type AppendedEvent = Awaited<ReturnType<typeof appendEvent>>;

/** The row as it goes on the wire: everything the log row had before the camera policy, and no internal country set. */
function wireEvent(event: AppendedEvent): Omit<AppendedEvent, "cameraCountries"> {
  const wire: Partial<AppendedEvent> = { ...event };
  delete wire.cameraCountries;
  return wire as Omit<AppendedEvent, "cameraCountries">;
}

function send(registry: SubscriptionRegistry, connections: Iterable<WebSocket>, event: unknown): void {
  const message = JSON.stringify({ type: "event", event });
  // Anonymous web sessions get the same event minus other devices' pseudonymous reporter ids (built once, on demand).
  let webMessage: string | undefined;
  for (const ws of connections) {
    if (ws.readyState !== ws.OPEN) continue;
    if (registry.isWebSession(ws)) {
      webMessage ??= JSON.stringify({ type: "event", event: stripReporterIds(event) });
      ws.send(webMessage);
    } else {
      ws.send(message);
    }
  }
}

/**
 * Called by each write-path route handler after its transaction has committed —
 * never from inside the transaction itself, so a client is never notified of a
 * write that could still roll back. See modules/hazard-reports/routes.ts and
 * modules/cameras/routes.ts. Takes the raw appendEvent() return value directly
 * rather than re-shaping it, since every field it needs (regionTile) plus
 * everything else is already there for the JSON payload sent to subscribers.
 *
 * Camera events go through the camera policy (modules/cameras/policy/events.ts): pushed as they are at level `full`,
 * as a zone event at level `zones` (state of the cell, sent to whoever listens to a tile the cell touches — not to
 * whoever listens to the tile the camera is in), and not at all otherwise.
 */
export function publishEvent(registry: SubscriptionRegistry, event: AppendedEvent): void {
  const gate = registry.cameraGate;
  const disposition = classifyEvent(gate.current(), event);
  if (disposition.kind === "withhold") return;
  if (disposition.kind === "zone") {
    void publishZoneEvent(registry, event, disposition.cell).catch((err: unknown) => gate.onError?.(err));
    return;
  }
  send(registry, registry.connectionsFor(event.regionTile), wireEvent(event));
}

async function publishZoneEvent(registry: SubscriptionRegistry, event: AppendedEvent, cell: string): Promise<void> {
  const [zone] = await registry.cameraGate.zoneStates([cell]);
  if (!zone) return;
  const wire = zoneEvent(zone, { sequence: event.sequence, occurredAt: event.occurredAt.toISOString() });
  // Events about persistent devices are global (no tile), like the devices themselves; events about live reports go by cell.
  const connections =
    event.regionTile === null
      ? registry.connectionsFor(null)
      : registry.connectionsForTiles(tilesSpeakingForCell(cell, registry.cameraGate.regionTileResolution));
  send(registry, connections, wire);
}
