import type { SubscriptionRegistry } from "./registry.js";
import type { appendEvent } from "../../db/append-event.js";
import { stripReporterIds } from "../web/redact.js";

type AppendedEvent = Awaited<ReturnType<typeof appendEvent>>;

/**
 * Called by each write-path route handler after its transaction has committed —
 * never from inside the transaction itself, so a client is never notified of a
 * write that could still roll back. See modules/hazard-reports/routes.ts and
 * modules/cameras/routes.ts. Takes the raw appendEvent() return value directly
 * rather than re-shaping it, since every field it needs (regionTile) plus
 * everything else is already there for the JSON payload sent to subscribers.
 */
export function publishEvent(registry: SubscriptionRegistry, event: AppendedEvent): void {
  if (!registry.allowsEvent(event)) return;
  const message = JSON.stringify({ type: "event", event });
  // Anonymous web sessions get the same event minus other devices' pseudonymous reporter ids (built once, on demand).
  let webMessage: string | undefined;
  for (const ws of registry.connectionsFor(event.regionTile)) {
    if (ws.readyState !== ws.OPEN) continue;
    if (registry.isWebSession(ws)) {
      webMessage ??= JSON.stringify({ type: "event", event: stripReporterIds(event) });
      ws.send(webMessage);
    } else {
      ws.send(message);
    }
  }
}
