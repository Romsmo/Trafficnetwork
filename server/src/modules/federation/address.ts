/**
 * A federation address (FEDERATION_PUBLIC_ADDRESS, a join request's own
 * `address`) must be `https://` — no self-hosted server identity over plain
 * HTTP, per docs/threat-model.md's MITM mitigation. The one exception is a
 * loopback literal (`http://127.0.0.1[:port]` or `http://localhost[:port]`),
 * same precedent as RFC 8252's OAuth loopback exception: it only ever
 * resolves to "this same machine" for whoever dials it, so there's no real
 * network path to MITM. This exists for F-S5's multi-node integration test
 * (real listening servers, no publicly-trusted cert available for an
 * ephemeral test port) — never meaningful for an actual cross-internet peer,
 * since no other real server could ever dial another server's 127.0.0.1.
 */
const LOOPBACK_HTTP_ADDRESS = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export function isAcceptableFederationAddress(address: string): boolean {
  return address.startsWith("https://") || LOOPBACK_HTTP_ADDRESS.test(address);
}
