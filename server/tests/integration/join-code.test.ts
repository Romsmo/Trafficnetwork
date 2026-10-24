import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { b64url, deriveCredentials, formatJoinUri, generateJoinCode, parseJoinUri } from "../../src/modules/join/code.js";
import { createInvitation, ensurePublicJoinCode, listCodes, revokeCode, rotatePublicJoinCode, showCode, type JoinContext } from "../../src/modules/join/service.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";

/**
 * Join codes end to end (docs/join-code.md): an empty node with a public address makes its code at start, the file and the page show
 * the same code, the app key derived from it registers a device through the ordinary registration path, revoking and rotating
 * behave as documented, and no secret reaches a log, an error or the metadata file.
 */
describe("join codes", () => {
  let testDb: TestDatabase;
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  const logged: string[] = [];
  let base: Record<string, string>;
  let dirA: string;
  let app: FastifyInstance;
  let env: Env;
  let ctx: JoinContext;
  let ipCounter = 0;
  const secrets: string[] = []; // every seed, secret and whole code this test file ever made: none may show up in a log or an error

  const freshDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "tn-join-"));
    dirs.push(dir);
    return dir;
  };

  async function build(extra: Record<string, string> = {}): Promise<{ app: FastifyInstance; env: Env }> {
    resetEnvCache();
    const e = loadEnv({ ...base, ...extra });
    const a = await buildApp({ env: e, db: testDb.db });
    closers.push(() => a.close());
    return { app: a, env: e };
  }

  /** loadEnv caches; a test that wants other settings has to drop the cache first. */
  const envWith = (extra: Record<string, string>): Env => {
    resetEnvCache();
    return loadEnv({ ...base, ...extra });
  };

  const recorder = { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) };
  const contextOf = (e: Env): JoinContext => ({ db: testDb.db, env: e, log: recorder });

  /** A fresh IP per call: the token and register endpoints are limited per IP and these tests make many calls. */
  const nextIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

  async function token(a: FastifyInstance, clientId: string, clientSecret: string) {
    return a.inject({ method: "POST", url: "/v1/auth/token", payload: { clientId, clientSecret }, remoteAddress: nextIp() });
  }

  async function register(a: FastifyInstance, uri: string) {
    const creds = deriveCredentials(parseJoinUri(uri).seed);
    const tokenRes = await token(a, creds.clientId, creds.clientSecret);
    if (tokenRes.statusCode !== 200) return { tokenRes, registerRes: null };
    const registerRes = await a.inject({
      method: "POST",
      url: "/v1/devices/register",
      headers: { authorization: `Bearer ${tokenRes.json().accessToken as string}` },
      remoteAddress: nextIp(),
    });
    return { tokenRes, registerRes };
  }

  const rememberSecrets = (uri: string) => {
    const code = parseJoinUri(uri);
    secrets.push(uri, b64url(code.seed), deriveCredentials(code.seed).clientSecret);
  };

  beforeAll(async () => {
    testDb = await startTestDatabase();
    dirA = freshDir();
    base = {
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      JOIN_PUBLIC_ADDRESS: "https://tn.example.org",
      JOIN_DIR: dirA,
    };
    ({ app, env } = await build());
    ctx = contextOf(env);
  });

  afterAll(async () => {
    for (const close of closers) await close();
    await testDb.teardown();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the public code at the first start: files, metadata without a secret, one app key with only the registration scope", async () => {
    expect(existsSync(join(dirA, "public.join"))).toBe(true);
    expect(existsSync(join(dirA, "public.svg"))).toBe(true);
    const uri = readFileSync(join(dirA, "public.join"), "utf8").trim();
    rememberSecrets(uri);
    const code = parseJoinUri(uri);
    expect(code.node).toBe("tn.example.org");
    expect(code.root).toBeNull();

    const svg = readFileSync(join(dirA, "public.svg"), "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:|href|<script|style=/i);

    const meta = JSON.parse(readFileSync(join(dirA, "public.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toMatchObject({ v: 1, node: "tn.example.org", status: "active", useCount: 0, rootFingerprint: null });
    const metaText = JSON.stringify(meta);
    for (const secret of secrets) expect(metaText).not.toContain(secret);
    expect(Object.keys(meta).sort()).toEqual(["clientId", "createdAt", "node", "rootFingerprint", "status", "useCount", "v"]);

    const rows = await testDb.db.execute<{ client_id: string; scopes: string[]; kind: string }>(sql`select client_id, scopes, kind from clients where kind = 'join-public'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_id).toBe(deriveCredentials(code.seed).clientId);
    expect(rows[0]!.scopes).toEqual(["device-registration"]);
  });

  it.skipIf(process.platform === "win32")("writes the files 0600 in a 0700 directory", () => {
    for (const name of readdirSync(dirA)) expect(statSync(join(dirA, name)).mode & 0o777).toBe(0o600);
    expect(statSync(dirA).mode & 0o777).toBe(0o700);
  });

  it("is idempotent: a second start finds the code and makes no second one", async () => {
    const before = readFileSync(join(dirA, "public.join"), "utf8");
    const second = await build();
    expect(readFileSync(join(dirA, "public.join"), "utf8")).toBe(before);
    const rows = await testDb.db.execute<{ total: number }>(sql`select count(*)::int as total from clients where kind = 'join-public'`);
    expect(rows[0]!.total).toBe(1);
    expect(second.app).toBeDefined();
  });

  it("shows the same code on the page's data as in the file, no-store, and links the page from the web config", async () => {
    const fileUri = readFileSync(join(dirA, "public.join"), "utf8").trim();
    const data = await app.inject({ method: "GET", url: "/join-code.json" });
    expect(data.statusCode).toBe(200);
    expect(data.headers["cache-control"]).toBe("no-store");
    expect(data.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(data.json()).toMatchObject({ available: true, node: "tn.example.org", code: fileUri, fingerprint: null });
    expect(data.json().svg).toContain("<svg");

    const page = await app.inject({ method: "GET", url: "/join" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain("join-page.js");
    expect(page.body).not.toContain(fileUri); // the code comes from the JSON route, never baked into a cacheable page

    const config = await app.inject({ method: "GET", url: "/web-config.json" });
    expect(config.json().joinCodePage).toBe(true);
  });

  it("registers a device with the derived app key through the ordinary registration path", async () => {
    const uri = readFileSync(join(dirA, "public.join"), "utf8").trim();
    const { tokenRes, registerRes } = await register(app, uri);
    expect(tokenRes.statusCode).toBe(200);
    expect(tokenRes.json().scopes).toEqual(["device-registration"]);
    expect(registerRes!.statusCode).toBe(200);
    const device = registerRes!.json() as { clientId: string; clientSecret: string };
    expect(device.clientId).toMatch(/^client_/);
    secrets.push(device.clientSecret);
    const deviceToken = await token(app, device.clientId, device.clientSecret);
    expect(deviceToken.statusCode).toBe(200);
    expect(deviceToken.json().scopes).toEqual(["client"]);

    const [pub] = await listCodes(ctx);
    expect(pub!.row.useCount).toBeGreaterThanOrEqual(1);
  });

  it("registers many devices with no daily cap by default (the per-IP limit is separate)", async () => {
    const uri = readFileSync(join(dirA, "public.join"), "utf8").trim();
    for (let i = 0; i < 60; i++) {
      const { registerRes } = await register(app, uri);
      expect(registerRes!.statusCode).toBe(200);
    }
  });

  it("selfcheck: reports a missing file, a foreign code and a broken file - and never replaces them", async () => {
    const file = join(dirA, "public.join");
    const good = readFileSync(file, "utf8");

    rmSync(file);
    expect((await ensurePublicJoinCode(ctx)).state).toBe("file_missing");
    expect(existsSync(file)).toBe(false);
    expect("problem" in (await showCode(ctx, null))).toBe(true);

    const foreign = formatJoinUri(generateJoinCode("tn.example.org", null));
    rememberSecrets(foreign);
    writeFileSync(file, `${foreign}\n`);
    expect((await ensurePublicJoinCode(ctx)).state).toBe("mismatch");
    expect(readFileSync(file, "utf8")).toBe(`${foreign}\n`);

    writeFileSync(file, "garbage\n");
    expect((await ensurePublicJoinCode(ctx)).state).toBe("file_invalid");

    writeFileSync(file, good);
    expect((await ensurePublicJoinCode(ctx)).state).toBe("ok");
    const page = await app.inject({ method: "GET", url: "/join-code.json" });
    expect(page.json().available).toBe(true);
  });

  it("writes the files again with the same app key when the node's address changes", async () => {
    const before = parseJoinUri(readFileSync(join(dirA, "public.join"), "utf8").trim());
    const moved = envWith({ JOIN_PUBLIC_ADDRESS: "https://other.example.org:8443" });
    expect((await ensurePublicJoinCode(contextOf(moved))).state).toBe("ok");
    const after = parseJoinUri(readFileSync(join(dirA, "public.join"), "utf8").trim());
    expect(after.node).toBe("other.example.org:8443");
    expect(after.seed.equals(before.seed)).toBe(true);
    // and back, so the later tests see the original address
    expect((await ensurePublicJoinCode(ctx)).state).toBe("ok");
    expect(parseJoinUri(readFileSync(join(dirA, "public.join"), "utf8").trim()).node).toBe("tn.example.org");
  });

  it("puts the network root key into the code when the node knows one, with the fingerprint", async () => {
    const root = Buffer.alloc(32, 0xa1);
    const withRoot = envWith({ NETWORK_ROOT_PUBLIC_KEY: b64url(root) });
    expect((await ensurePublicJoinCode(contextOf(withRoot))).state).toBe("ok");
    const uri = readFileSync(join(dirA, "public.join"), "utf8").trim();
    expect(parseJoinUri(uri).root?.equals(root)).toBe(true);
    const meta = JSON.parse(readFileSync(join(dirA, "public.json"), "utf8")) as { rootFingerprint: string };
    expect(meta.rootFingerprint).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){4}$/);
    // same app key: a registration with the code still works
    const { registerRes } = await register(app, uri);
    expect(registerRes!.statusCode).toBe(200);
    // and without the key again
    expect((await ensurePublicJoinCode(ctx)).state).toBe("ok");
    expect(parseJoinUri(readFileSync(join(dirA, "public.join"), "utf8").trim()).root).toBeNull();
  });

  describe("invitation codes", () => {
    it("limits registrations, is never on the page, and has its own files", async () => {
      const created = await createInvitation(ctx, { label: "workshop", maxUses: 2, expiresAt: null });
      rememberSecrets(created.uri);
      expect(created.clientId).toMatch(/^join-[0-9a-f]{16}$/);
      expect(existsSync(join(dirA, `invite-${created.clientId}.join`))).toBe(true);
      const meta = JSON.parse(readFileSync(join(dirA, `invite-${created.clientId}.json`), "utf8")) as Record<string, unknown>;
      expect(meta).toMatchObject({ label: "workshop", maxUses: 2, status: "active", useCount: 0 });

      expect((await register(app, created.uri)).registerRes!.statusCode).toBe(200);
      expect((await register(app, created.uri)).registerRes!.statusCode).toBe(200);
      const third = await register(app, created.uri);
      expect(third.registerRes!.statusCode).toBe(403);
      expect(third.registerRes!.json().error.code).toBe("join_code_exhausted");

      const page = await app.inject({ method: "GET", url: "/join-code.json" });
      expect(page.body).not.toContain(created.clientId);
      expect(page.body).not.toContain(b64url(parseJoinUri(created.uri).seed));
      const html = await app.inject({ method: "GET", url: "/join" });
      expect(html.body).not.toContain(created.clientId);
    });

    it("does not let two simultaneous registrations take the last place", async () => {
      const created = await createInvitation(ctx, { label: "race", maxUses: 1, expiresAt: null });
      rememberSecrets(created.uri);
      const creds = deriveCredentials(parseJoinUri(created.uri).seed);
      const tokens = await Promise.all([0, 1, 2, 3].map(async () => (await token(app, creds.clientId, creds.clientSecret)).json().accessToken as string));
      const results = await Promise.all(
        tokens.map((t) => app.inject({ method: "POST", url: "/v1/devices/register", headers: { authorization: `Bearer ${t}` }, remoteAddress: nextIp() })),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 403)).toHaveLength(3);
    });

    it("expires: the token endpoint says join_code_expired once the end has passed", async () => {
      const created = await createInvitation(ctx, { label: "short", maxUses: null, expiresAt: new Date(Date.now() + 3_600_000) });
      rememberSecrets(created.uri);
      expect((await register(app, created.uri)).registerRes!.statusCode).toBe(200);
      await testDb.db.execute(sql`update clients set expires_at = now() - interval '1 minute' where client_id = ${created.clientId}`);
      const { tokenRes } = await register(app, created.uri);
      expect(tokenRes.statusCode).toBe(401);
      expect(tokenRes.json().error.code).toBe("join_code_expired");
    });

    it("caps registrations per day when JOIN_CODE_MAX_REGISTRATIONS_PER_DAY is set", async () => {
      const { app: capped, env: cappedEnv } = await build({ JOIN_CODE_MAX_REGISTRATIONS_PER_DAY: "1", JOIN_DIR: freshDir() });
      const created = await createInvitation(contextOf(cappedEnv), { label: "capped", maxUses: null, expiresAt: null });
      rememberSecrets(created.uri);
      expect((await register(capped, created.uri)).registerRes!.statusCode).toBe(200);
      const second = await register(capped, created.uri);
      expect(second.registerRes!.statusCode).toBe(429);
      expect(second.registerRes!.json().error.code).toBe("join_code_rate_limited");
    });
  });

  describe("revoke and rotate", () => {
    it("revoke stops new registrations with join_code_revoked - to the holder of the secret only - and leaves registered devices alone", async () => {
      const created = await createInvitation(ctx, { label: "to revoke", maxUses: null, expiresAt: null });
      rememberSecrets(created.uri);
      const creds = deriveCredentials(parseJoinUri(created.uri).seed);
      const first = await register(app, created.uri);
      expect(first.registerRes!.statusCode).toBe(200);
      const device = first.registerRes!.json() as { clientId: string; clientSecret: string };
      secrets.push(device.clientSecret);
      const oldToken = first.tokenRes.json().accessToken as string;

      expect(await revokeCode(ctx, created.clientId)).toBe("revoked");
      expect(await revokeCode(ctx, created.clientId)).toBe("already_revoked");
      expect(await revokeCode(ctx, "join-0000000000000000")).toBe("not_found");

      const refused = await token(app, creds.clientId, creds.clientSecret);
      expect(refused.statusCode).toBe(401);
      expect(refused.json().error.code).toBe("join_code_revoked");
      // a stranger guessing the id learns nothing: the answer for a wrong secret is the same as for any client
      const stranger = await token(app, creds.clientId, "x".repeat(43));
      expect(stranger.statusCode).toBe(401);
      expect(stranger.json().error.code).toBe("UNAUTHORIZED");
      // a token issued before the revocation cannot register any more either
      const late = await app.inject({ method: "POST", url: "/v1/devices/register", headers: { authorization: `Bearer ${oldToken}` }, remoteAddress: nextIp() });
      expect(late.statusCode).toBe(401);
      expect(late.json().error.code).toBe("join_code_revoked");
      // the device that registered earlier keeps working
      expect((await token(app, device.clientId, device.clientSecret)).statusCode).toBe(200);

      const meta = JSON.parse(readFileSync(join(dirA, `invite-${created.clientId}.json`), "utf8")) as { status: string; useCount: number };
      expect(meta).toMatchObject({ status: "revoked", useCount: 1 });
    });

    it("rotate makes a new public code; the old one keeps working through the grace period, then ends", async () => {
      const oldUri = readFileSync(join(dirA, "public.join"), "utf8").trim();
      const rotated = await rotatePublicJoinCode(ctx);
      rememberSecrets(rotated.uri);
      expect(rotated.uri).not.toBe(oldUri);
      expect(rotated.previous).toBe(deriveCredentials(parseJoinUri(oldUri).seed).clientId);
      expect(readFileSync(join(dirA, "public.join"), "utf8").trim()).toBe(rotated.uri);
      expect(rotated.graceUntil!.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

      const listing = await listCodes(ctx);
      expect(listing.find((c) => c.row.clientId === rotated.previous)!.status).toBe("grace");
      expect(listing.find((c) => c.row.clientId === rotated.clientId)!.status).toBe("active");

      // new and old code both register
      expect((await register(app, rotated.uri)).registerRes!.statusCode).toBe(200);
      expect((await register(app, oldUri)).registerRes!.statusCode).toBe(200);
      // the page shows the new one only
      const page = await app.inject({ method: "GET", url: "/join-code.json" });
      expect(page.json().code).toBe(rotated.uri);

      // the grace period ends
      await testDb.db.execute(sql`update clients set expires_at = now() - interval '1 minute' where client_id = ${rotated.previous}`);
      const ended = await register(app, oldUri);
      expect(ended.tokenRes.statusCode).toBe(401);
      expect(ended.tokenRes.json().error.code).toBe("join_code_expired");
      expect((await register(app, rotated.uri)).registerRes!.statusCode).toBe(200);
    });

    it("rotate with a grace period of 0 ends the old code at once", async () => {
      const { env: noGrace } = await build({ JOIN_ROTATE_GRACE_DAYS: "0", JOIN_DIR: dirA });
      const noGraceCtx = contextOf(noGrace);
      const oldUri = readFileSync(join(dirA, "public.join"), "utf8").trim();
      const rotated = await rotatePublicJoinCode(noGraceCtx);
      rememberSecrets(rotated.uri);
      expect(rotated.graceUntil).toBeNull();
      const ended = await register(app, oldUri);
      expect(ended.tokenRes.json().error.code).toBe("join_code_revoked");
    });
  });

  describe("JOIN_CODE_PUBLIC=false", () => {
    it("has no page and no data route, and says so in the web config", async () => {
      const { app: hidden } = await build({ JOIN_CODE_PUBLIC: "false", JOIN_DIR: freshDir() });
      expect((await hidden.inject({ method: "GET", url: "/join" })).statusCode).toBe(404);
      expect((await hidden.inject({ method: "GET", url: "/join-code.json" })).statusCode).toBe(404);
      expect((await hidden.inject({ method: "GET", url: "/web-config.json" })).json().joinCodePage).toBe(false);
    });
  });

  describe("secrets stay out of logs, errors and metrics", () => {
    it("none of the log lines the service wrote contains a seed, a secret or a whole code", () => {
      expect(logged.length).toBeGreaterThan(0);
      const text = logged.join("\n");
      for (const secret of secrets) expect(text).not.toContain(secret);
    });

    it("the error answers do not echo a secret either", async () => {
      const creds = deriveCredentials(generateJoinCode("tn.example.org", null).seed);
      const res = await token(app, creds.clientId, creds.clientSecret);
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(creds.clientSecret);
      const metrics = await app.inject({ method: "GET", url: "/v1/stats/online" });
      for (const secret of secrets) expect(metrics.body).not.toContain(secret);
    });
  });
});
