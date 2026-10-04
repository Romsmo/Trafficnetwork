import type { FastifyInstance, FastifyReply } from "fastify";
import type { CameraRecord } from "../../db/queries/camera-record.js";
import { answerForWrite } from "./policy/delivery.js";
import { acceptedBody, type CameraLike } from "./policy/projection.js";

/**
 * What the answer to a camera *write* may disclose (docs/camera-country-policy.md, 5.4). Writing is never blocked - but
 * an answer that says "merged with an existing camera", or returns the merged camera, is a read in disguise: probing a
 * country that is `off` at 800 m spacing would map its cameras. So for a camera whose country is not at level `full`
 * the answer is the same for a new and a merged camera: `202 { accepted: true }`, plus the zone at level `zones`.
 */
export async function respondToCameraCreate<T extends CameraLike>(
  app: FastifyInstance,
  reply: FastifyReply,
  record: CameraRecord<T>,
  merged: boolean,
  key: "camera" | "report",
): Promise<Record<string, unknown>> {
  const answer = await answerForWrite(app.deps.db, app.cameraPolicy.current(), record);
  if (answer.level === "full") {
    reply.status(merged ? 200 : 201);
    return { [key]: record.item, merged };
  }
  reply.status(202);
  return acceptedBody(answer.zone);
}

/** True if the individual camera may be shown to the client that wrote to it (removal reports, confirmations). */
export function mayShowCamera(app: FastifyInstance, record: CameraRecord<CameraLike>): boolean {
  return app.cameraPolicy.current().levelOf(record.countries) === "full";
}
