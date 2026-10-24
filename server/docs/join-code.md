# Join code (server 1.3.0)

A **join code** is a short text (also shown as a QR code) that sets up an app for one node: it carries the node's address, an app key and,
optionally, the public network root key. The app scans or pastes it, shows the address and the key's fingerprint, and - after the user
confirms - registers a device. No build variables, no typing.

This page is the server side of the specification both projects build to (the app is built in parallel). It is the single shared truth:
gaps or deviations are reported, not changed on one side only. The test vectors are in
[`join-code-vectors.json`](join-code-vectors.json); the server and the app both run them in CI.

## Purpose and security model

* The code is a **setup code for apps**, not a user login. It replaces typing the node address, the app key and the network key.
* Whoever knows the code can **register as an app at this node** (scope `device-registration`) - **nothing more**: no administration rights,
  no bulk import, no access to anyone else's data.
* A code shown on the node's web page is **public in fact**. That is intended (open membership). Protection lies in rate limits, in
  revoking and rotating the code, in reports the device signs itself and in moderation - **not** in keeping the code secret. A node that
  is not public turns the page off (`JOIN_CODE_PUBLIC=false`) and hands out invitation codes instead.
* A hash cannot be reversed. So the QR code holds not a hash of id and secret but the **seed** both are derived from. The server stores
  the secret like every app key (hashed, scrypt).

## Format

QR content and text form are **the same string** (UTF-8/ASCII, at most 512 characters):

```
trafficnetwork://join?v=1&n=<node>&k=<seed>&r=<root>&c=<check>
```

| Parameter | Required | Content |
|---|---|---|
| `v` | yes | format version, exactly `1` |
| `n` | yes | the node: host name **in lower case** (Punycode for non-ASCII), at least one dot, optional `:port` (1-65535). **Always HTTPS**; no scheme, no path, no credentials, no IP address, no `localhost` |
| `k` | yes | `seed`: 32 random bytes (CSPRNG), base64url (RFC 4648 section 5) **without padding**, exactly 43 characters, canonical |
| `r` | no | the public network root key (Ed25519, 32 bytes), base64url without padding, 43 characters. The server adds it as soon as it knows one |
| `c` | yes | check value against typos and damage, 8 characters `A-Z2-7` |

Parameters may come in any order; the server writes them in the order above. Unknown parameters are ignored (forward compatibility).

## Deriving the app key

```
salt   = ASCII "trafficnetwork-join-v1"
PRK    = HKDF-Extract(salt, seed)                    # HMAC-SHA256(salt, seed), RFC 5869
id     = "join-" + lowercase_hex( HKDF-Expand(PRK, info="id",     L=8) )    # 21 characters
secret = base64url_nopad(         HKDF-Expand(PRK, info="secret", L=32) )   # 43 characters
```

`id` is the app key's `clientId`, `secret` its `clientSecret`. The client library is unchanged: the app passes both to it as it passes any
app key. The app key is created when the code is created (scope `device-registration` only); the secret is stored hashed.

## Check value and fingerprint

```
digest = SHA-256( "tn-join-v1/check" || 0x00 || n_ascii || 0x00 || seed )
c      = base32_rfc4648_nopad_uppercase( digest[0..5] )          # 5 bytes -> 8 characters
fp     = base32_rfc4648_nopad_uppercase( SHA-256(root_32_bytes) )[0..20]
display: five groups of four characters separated by "-", e.g. ADUY-QZ36-5T4U-YC5Z-EMZX
```

`c` binds address and seed (typos, truncated QR codes); it is **not** a security feature. Note that it does not cover `r`: a damaged `r` in
a pasted code is not caught by `c` (a QR code has its own error correction); the fingerprint comparison is what catches it. The
fingerprint is for display only: the page and the CLI show the same value the app shows, so people can compare.

## Parser rules (strict - app and the server's self-check)

1. Scheme `trafficnetwork` (case-insensitive), host `join`. Total length at most 512.
2. Each known parameter at most **once**.
3. `v` must be `1`; a larger value is "from a newer version".
4. `n` exactly as above (lower case letters, digits, `-`, `.`, labels of 1-63 characters, at most 253 in total, optional port).
5. `k` and `r`: length 43, alphabet `A-Z a-z 0-9 - _`, 32 bytes after decoding, and **canonical** (encoding again gives the same string).
6. `c` equals the computed value.
7. On **any** error nothing is stored and nothing connects. The message names the reason (a category), **does not repeat the code** and
   does not write it to a log.
8. A valid code never connects on its own: the app shows a confirmation first.

The server's implementation is `src/modules/join/code.ts`; its errors are `too_long`, `not_a_join_code`, `duplicate_parameter`,
`missing_parameter`, `newer_version`, `bad_version`, `bad_node`, `bad_seed`, `bad_root`, `bad_check`.

## What the server does

**Directory.** `JOIN_DIR` (default `./data/join`; in the Docker setup the volume `join-data` at `/app/data/join`). Never in git. The
directory is `0700`, every file `0600`:

| File | Content |
|---|---|
| `public.join` | one line: the code, plus a line break |
| `public.svg` | the QR code (error correction M, quiet zone 4 modules), a self-contained SVG without external references |
| `public.json` | metadata **without a secret**: `v`, `clientId`, `node`, `createdAt`, `status` (`active` / `grace` / `revoked`), `useCount`, `rootFingerprint` |
| `invite-<clientId>.join` / `.svg` / `.json` | the same for an invitation code (its `.json` adds `label`, `expiresAt`, `maxUses`) |

`status` `revoked` means the code accepts no new registrations - revoked or past its end date. The metadata files are informational (the
database is the truth); they are refreshed at start, after every command and hourly.

**The public code** is created at the first start **if** the node's public address is configured: `JOIN_PUBLIC_ADDRESS` (`https://host`,
no path), or else `FEDERATION_PUBLIC_ADDRESS`. Without one nothing is created and a note goes to the log. With `JOIN_CODE_PUBLIC=false`
no public code is created either (nothing public unless asked). A restart never makes a second one. If the node has a
`NETWORK_ROOT_PUBLIC_KEY`, the code carries it as `r`; if address or key change later, the files are written again from the same seed
(same app key - no rotation needed).

**Self-check at start.** The file is parsed with the strict parser, the id and secret are derived again and compared with the stored app
key. A missing file, a file that does not parse or a code that does not belong to the app key is logged as an error with the client id
and the reason - and **never silently replaced**: `join:rotate` makes a new code.

**The page "App verbinden" / "Connect an app"** (`/join`, linked from the footer and the connect page) shows the QR code (inline SVG), the
code as text with a copy button, the fingerprint, three steps and a note on purpose and limits, in German and English. It exists only
with `JOIN_CODE_PUBLIC=true` and the web UI on; it reads the current public code from `GET /join-code.json` (`Cache-Control: no-store`,
rate-limited 60/minute per IP). Invitation codes are never shown there.

**Commands** (`npm run join:<command>`, or in the container `docker compose exec server node dist/join-cli.js <command>`):

| Command | What it does |
|---|---|
| `show [<clientId>]` | the public code (or an invitation code): text, file paths, QR in the terminal |
| `create --label <text> [--max-uses N] [--expires 7d]` | an invitation code (`7d`, `12h`, `90m`); never on the page |
| `rotate` | a new public code; the old one keeps working for `JOIN_ROTATE_GRACE_DAYS` (default 7, `0` = ends at once) |
| `revoke <clientId>` | no new registrations with that code, **at once** |
| `list` | all codes: status, registrations, end date |

**Revoking affects new registrations only.** Devices that already registered with a code stay valid - they are ordinary device
credentials. (A separate command that also revokes the devices of one code is deliberately not part of this version.)

**Limits.** The per-IP limit of `POST /v1/auth/token` and `POST /v1/devices/register` (10 per minute) applies. Per code: an invitation code
stops at its `--max-uses`; the public code has **no** cap by default (`JOIN_CODE_MAX_REGISTRATIONS_PER_DAY=0`); set a number to cap
registrations per code and day. `useCount` counts registrations - no personal data. The app key behind a join code is **not** subject to
`DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY`.

**Error codes** (same error format as everywhere, [`api.md`](api.md)): `join_code_revoked` (401), `join_code_expired` (401),
`join_code_exhausted` (403), `join_code_rate_limited` (429). `revoked` and `expired` are answered on `POST /v1/auth/token` - only to
a caller that proves it knows the code's secret; anyone else gets the ordinary `UNAUTHORIZED` - and again on `POST /v1/devices/register`
for a token issued before the end. `exhausted` and `rate_limited` come from the registration.

**Logs.** The seed, the secret, the whole code and the files' contents are never in logs, error messages or metrics. Log lines name a client
id or a reason.

## Test vectors

[`join-code-vectors.json`](join-code-vectors.json): three valid codes (V1 with a root key, V2 with a port and no root key, V3 with a seed of
`ff` bytes), eight codes that must be rejected (`bad_check`, `version_2`, `ip_host`, `uppercase_host`, `k_too_short`, `k_non_canonical`,
`duplicate_k`, `missing_n`) and RFC 5869 test case 1 (guards the HKDF use). They were computed by an independent reference and recomputed
for the server with Node's `crypto`.
