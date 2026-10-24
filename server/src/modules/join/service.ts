import type { Database, Queryable } from "../../db/client.js";
import { findClientByClientId } from "../../db/queries/clients.js";
import type { Env } from "../../config/env.js";
import {
  findCurrentPublicJoinCode,
  findJoinCode,
  insertJoinClient,
  listJoinCodes,
  lockPublicJoinCode,
  revokeJoinCode,
  setJoinCodeExpiry,
  type JoinCodeRow,
  type JoinKind,
} from "../../db/queries/join-codes.js";
import { hashSecret, verifySecret } from "../auth/credentials.js";
import { JoinCodeError, decodeKey, deriveCredentials, formatJoinUri, generateJoinCode, nodeFromAddress, parseJoinUri, rootFingerprint, type JoinCode } from "./code.js";
import { qrSvg } from "./qr.js";
import { JoinStore, type CodeMetadata, type CodeName } from "./store.js";

/**
 * Creating, checking, rotating and revoking join codes (docs/join-code.md). Everything that could leak a code is deliberately
 * absent from here: the log lines name a client id or a reason, never a seed, a secret, a code or a file's content.
 */

export interface JoinLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface JoinContext {
  db: Database["db"];
  env: Env;
  log: JoinLog;
}

export type JoinStatus = "active" | "grace" | "revoked";

/** What the node says its code is made of: the address part and the public root key, if it has them. */
export interface JoinSettings {
  node: string | null;
  root: Buffer | null;
  /** Why there is no node part, for the log and the CLI. */
  problem: string | null;
}

export function joinSettings(env: Env): JoinSettings {
  const address = env.JOIN_PUBLIC_ADDRESS !== "" ? env.JOIN_PUBLIC_ADDRESS : (env.FEDERATION_PUBLIC_ADDRESS ?? "");
  let node: string | null = null;
  let problem: string | null = null;
  if (address === "") {
    problem = "no public address is configured (set JOIN_PUBLIC_ADDRESS, or FEDERATION_PUBLIC_ADDRESS)";
  } else {
    node = nodeFromAddress(address);
    if (!node) problem = "the configured public address cannot be named in a join code (it must be https://host with a dot in the host name, no IP address, no path)";
  }
  const root = env.NETWORK_ROOT_PUBLIC_KEY ? decodeKey(env.NETWORK_ROOT_PUBLIC_KEY.trim()) : null;
  return { node, root, problem };
}

export function joinStore(env: Env): JoinStore {
  return new JoinStore(env.JOIN_DIR);
}

export function statusOf(row: JoinCodeRow, now: Date = new Date()): JoinStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt) {
    if (Date.parse(row.expiresAt) <= now.getTime()) return "revoked";
    // a public code with an end date is one that was replaced; an invitation code with an end date is simply in force until then
    if (row.kind === "join-public") return "grace";
  }
  return "active";
}

function nameOf(row: Pick<JoinCodeRow, "kind" | "clientId">): CodeName {
  return row.kind === "join-public" ? "public" : `invite-${row.clientId}`;
}

function metadataOf(row: JoinCodeRow, node: string, root: Buffer | null): CodeMetadata {
  const meta: CodeMetadata = {
    v: 1,
    clientId: row.clientId,
    node,
    createdAt: row.createdAt,
    status: statusOf(row),
    useCount: row.useCount,
    rootFingerprint: root ? rootFingerprint(root) : null,
  };
  if (row.kind === "join-invite") {
    meta.label = row.label;
    meta.expiresAt = row.expiresAt;
    meta.maxUses = row.maxUses;
  }
  return meta;
}

const QR_TITLE = "Trafficnetwork join code";

/** Writes the files of one code. Throws when the disk refuses; the caller decides whether that undoes the database change. */
function writeFiles(store: JoinStore, row: JoinCodeRow, code: JoinCode): void {
  const uri = formatJoinUri(code);
  store.writeCode(nameOf(row), uri, qrSvg(uri, QR_TITLE), metadataOf(row, code.node, code.root));
}

async function createCode(
  ctx: JoinContext,
  tx: Queryable,
  settings: JoinSettings,
  input: { kind: JoinKind; label: string | null; expiresAt: Date | null; maxUses: number | null },
): Promise<{ row: JoinCodeRow; code: JoinCode }> {
  if (!settings.node) throw new Error(`cannot create a join code: ${settings.problem ?? "no public address"}`);
  const code = generateJoinCode(settings.node, settings.root);
  const { clientId, clientSecret } = deriveCredentials(code.seed);
  await insertJoinClient(tx, { clientId, clientSecretHash: await hashSecret(clientSecret), ...input });
  const row = await findJoinCode(tx, clientId);
  if (!row) throw new Error("join code was not stored");
  // inside the transaction: a disk that refuses the file rolls the key back, so no key exists without a way to show it
  writeFiles(joinStore(ctx.env), row, code);
  return { row, code };
}

export type SelfCheckState = "ok" | "created" | "no_address" | "disabled" | "file_missing" | "file_invalid" | "mismatch";

export interface SelfCheck {
  state: SelfCheckState;
  clientId?: string;
}

/**
 * The start-up routine for the public code. Idempotent: a second start finds the code and only checks it.
 *  - no public address: nothing is created, a note goes to the log
 *  - JOIN_CODE_PUBLIC=false: nothing public is created (an existing one is left alone and still checked)
 *  - a code exists: its file is parsed with the strict parser, the credentials are derived again and compared with the stored
 *    app key; a missing, unreadable or unmatching file is reported and never silently replaced (`join:rotate` makes a new code)
 */
export async function ensurePublicJoinCode(ctx: JoinContext): Promise<SelfCheck> {
  const settings = joinSettings(ctx.env);
  const store = joinStore(ctx.env);

  return ctx.db.transaction(async (tx) => {
    await lockPublicJoinCode(tx);
    const current = await findCurrentPublicJoinCode(tx);

    if (!current) {
      if (!ctx.env.JOIN_CODE_PUBLIC) {
        ctx.log.info("join code: JOIN_CODE_PUBLIC=false, no public code is created (invitation codes: join:create)");
        return { state: "disabled" };
      }
      if (!settings.node) {
        ctx.log.warn(`join code: no public code created, ${settings.problem}`);
        return { state: "no_address" };
      }
      const { row } = await createCode(ctx, tx, settings, { kind: "join-public", label: null, expiresAt: null, maxUses: null });
      ctx.log.info(`join code: public code created (${row.clientId}), files in ${store.dir}`);
      return { state: "created", clientId: row.clientId };
    }

    return checkStoredCode(ctx, store, settings, current);
  });
}

async function checkStoredCode(ctx: JoinContext, store: JoinStore, settings: JoinSettings, row: JoinCodeRow): Promise<SelfCheck> {
  const name = nameOf(row);
  const text = store.readCode(name);
  if (text === null) {
    ctx.log.error(`join code ${row.clientId}: its file is missing in ${store.dir}; the app key still exists but the code cannot be shown. Run join:rotate to make a new code.`);
    return { state: "file_missing", clientId: row.clientId };
  }
  let code: JoinCode;
  try {
    code = parseJoinUri(text);
  } catch (err) {
    ctx.log.error(`join code ${row.clientId}: its file does not parse (${err instanceof JoinCodeError ? err.reason : "unreadable"}). Run join:rotate to make a new code.`);
    return { state: "file_invalid", clientId: row.clientId };
  }
  const derived = deriveCredentials(code.seed);
  const hash = await storedSecretHash(ctx, row.clientId);
  if (derived.clientId !== row.clientId || hash === null || !(await verifySecret(derived.clientSecret, hash))) {
    ctx.log.error(`join code ${row.clientId}: the code in its file does not belong to this app key. Run join:rotate to make a new code.`);
    return { state: "mismatch", clientId: row.clientId };
  }
  // The credentials depend on the seed only. If the address or the root key of the node changed since the file was written, the
  // same seed is written out again with the new values: same app key, no rotation needed.
  const rootSame = (code.root?.toString("hex") ?? null) === (settings.root?.toString("hex") ?? null);
  if (settings.node && (code.node !== settings.node || !rootSame)) {
    writeFiles(store, row, { node: settings.node, seed: code.seed, root: settings.root });
    ctx.log.info(`join code ${row.clientId}: address or network key of the node changed, files written again (same app key)`);
  }
  return { state: "ok", clientId: row.clientId };
}

async function storedSecretHash(ctx: JoinContext, clientId: string): Promise<string | null> {
  return (await findClientByClientId(ctx.db, clientId))?.clientSecretHash ?? null;
}

export interface CreatedCode {
  clientId: string;
  uri: string;
  files: { join: string; svg: string; json: string };
  row: JoinCodeRow;
}

function describeCode(store: JoinStore, row: JoinCodeRow, code: JoinCode): CreatedCode {
  const name = nameOf(row);
  return {
    clientId: row.clientId,
    uri: formatJoinUri(code),
    files: { join: store.path(name, "join"), svg: store.path(name, "svg"), json: store.path(name, "json") },
    row,
  };
}

/** `join:create`: an invitation code. It is never shown on the web page. */
export async function createInvitation(ctx: JoinContext, input: { label: string; maxUses: number | null; expiresAt: Date | null }): Promise<CreatedCode> {
  const settings = joinSettings(ctx.env);
  return ctx.db.transaction(async (tx) => {
    const { row, code } = await createCode(ctx, tx, settings, { kind: "join-invite", label: input.label, expiresAt: input.expiresAt, maxUses: input.maxUses });
    return describeCode(joinStore(ctx.env), row, code);
  });
}

/**
 * `join:rotate`: a new public code; the old one keeps accepting registrations for JOIN_ROTATE_GRACE_DAYS (0 = it ends now), so
 * apps that already scanned it have time to move. Devices registered with the old code are unaffected.
 */
export async function rotatePublicJoinCode(ctx: JoinContext): Promise<CreatedCode & { previous: string | null; graceUntil: Date | null }> {
  const settings = joinSettings(ctx.env);
  return ctx.db.transaction(async (tx) => {
    await lockPublicJoinCode(tx);
    const previous = await findCurrentPublicJoinCode(tx);
    const { row, code } = await createCode(ctx, tx, settings, { kind: "join-public", label: null, expiresAt: null, maxUses: null });
    let graceUntil: Date | null = null;
    if (previous) {
      if (ctx.env.JOIN_ROTATE_GRACE_DAYS > 0) {
        graceUntil = new Date(Date.now() + ctx.env.JOIN_ROTATE_GRACE_DAYS * 86_400_000);
        await setJoinCodeExpiry(tx, previous.clientId, graceUntil);
      } else {
        await revokeJoinCode(tx, previous.clientId);
      }
    }
    ctx.log.info(`join code: public code rotated (new ${row.clientId}${previous ? `, old ${previous.clientId} ${graceUntil ? "in grace period" : "ended"}` : ""})`);
    return { ...describeCode(joinStore(ctx.env), row, code), previous: previous?.clientId ?? null, graceUntil };
  });
}

/** `join:revoke`: no new registrations with this code from now on. Devices that registered with it keep working. */
export async function revokeCode(ctx: JoinContext, clientId: string): Promise<"revoked" | "already_revoked" | "not_found"> {
  const row = await findJoinCode(ctx.db, clientId);
  if (!row) return "not_found";
  if (row.revokedAt) return "already_revoked";
  await revokeJoinCode(ctx.db, clientId);
  await refreshMetadata(ctx);
  ctx.log.info(`join code ${clientId}: revoked`);
  return "revoked";
}

/** Brings the status and the registration count in the metadata files up to date. They are informational: the database is the truth. */
export async function refreshMetadata(ctx: JoinContext): Promise<void> {
  const settings = joinSettings(ctx.env);
  const store = joinStore(ctx.env);
  for (const row of await listJoinCodes(ctx.db)) {
    const name = nameOf(row);
    if (!store.has(name)) continue;
    const node = settings.node ?? readNodeOf(store, name);
    if (!node) continue;
    store.writeMetadata(name, metadataOf(row, node, settings.root));
  }
}

function readNodeOf(store: JoinStore, name: CodeName): string | null {
  const text = store.readCode(name);
  if (text === null) return null;
  try {
    return parseJoinUri(text).node;
  } catch {
    return null;
  }
}

export interface ShownCode {
  row: JoinCodeRow;
  status: JoinStatus;
  uri: string;
  node: string;
  rootFingerprint: string | null;
  files: { join: string; svg: string; json: string };
}

/** The code of one client from its file (a code whose file is gone or no longer matches cannot be shown). */
export async function showCode(ctx: JoinContext, clientId: string | null, options: { verifySecret?: boolean } = {}): Promise<ShownCode | { problem: string }> {
  const store = joinStore(ctx.env);
  const row = clientId ? await findJoinCode(ctx.db, clientId) : await findCurrentPublicJoinCode(ctx.db);
  if (!row) return { problem: clientId ? `no join code ${clientId}` : "there is no public join code yet (start the server with a public address, or run join:rotate)" };
  const name = nameOf(row);
  const text = store.readCode(name);
  if (text === null) return { problem: `the file of ${row.clientId} is missing in ${store.dir}; run join:rotate (public) or join:create (invitation) for a new code` };
  let code: JoinCode;
  try {
    code = parseJoinUri(text);
  } catch {
    return { problem: `the file of ${row.clientId} does not hold a valid join code` };
  }
  // The page checks the cheap part only (the id derived from the seed); the CLI also proves the secret against the stored hash.
  const derived = deriveCredentials(code.seed);
  let belongs = derived.clientId === row.clientId;
  if (belongs && options.verifySecret !== false) {
    const hash = await storedSecretHash(ctx, row.clientId);
    belongs = hash !== null && (await verifySecret(derived.clientSecret, hash));
  }
  if (!belongs) return { problem: `the file of ${row.clientId} does not belong to this app key` };
  return {
    row,
    status: statusOf(row),
    uri: formatJoinUri(code),
    node: code.node,
    rootFingerprint: code.root ? rootFingerprint(code.root) : null,
    files: { join: store.path(name, "join"), svg: store.path(name, "svg"), json: store.path(name, "json") },
  };
}

export async function listCodes(ctx: JoinContext): Promise<{ row: JoinCodeRow; status: JoinStatus }[]> {
  return (await listJoinCodes(ctx.db)).map((row) => ({ row, status: statusOf(row) }));
}
