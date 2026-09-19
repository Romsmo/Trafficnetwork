import "dotenv/config";
import closeWithGrace from "close-with-grace";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { startExpiryWorker } from "./modules/expiry/worker.js";
import { startRetentionWorker } from "./modules/expiry/retention.js";
import { startFederationWorkers, type FederationWorkersHandle } from "./modules/federation/workers.js";

async function main() {
  const env = loadEnv();
  const { db, client } = createDb(env);
  const app = await buildApp({ env, db });
  const expiryWorker = startExpiryWorker(db, app.log, app.realtime);
  const retentionWorker = startRetentionWorker(db, env, app.log);
  const federationWorkers: FederationWorkersHandle | null = env.FEDERATION_ENABLED
    ? startFederationWorkers({ db, env, nodeIdentity: app.nodeIdentity, realtime: app.realtime, log: app.log })
    : null;

  closeWithGrace(async ({ err }) => {
    if (err) app.log.error(err, "closing due to error");
    expiryWorker.stop();
    retentionWorker.stop();
    federationWorkers?.stop();
    await app.close();
    await client.end();
  });

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
