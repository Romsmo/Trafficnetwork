# Threat Model: Self-Hosting & Federation

Scope: the server rework in `docs/prompt-rework-server-federation.md` — open
membership, signature-based trust, self-hosting. This is the full version of
the summary presented for approval before F-S1 began; see that plan/report
for the research citations behind the design choices referenced here. Not
in scope: `client-lib/`'s own threat surface (covered by the companion
client-lib federation rework), physical security of an operator's hardware.

## Core principle

**Trust signatures, not servers** (`docs/federation.md` §2). Open membership
means any server can be malicious. No client or server may treat a fact as
true because of *who sent it* — only because it carries a valid signature
from the party that's supposed to vouch for that fact.

## Actors

| Actor | Motivation / capability |
|---|---|
| Malicious or compromised server operator | Wants to inject false data, censor/withhold real data, harvest client metadata (IP + subscribed tiles), or exhaust other servers' resources |
| Malicious or compromised device | Wants to spam reports, forge another device's identity, bypass rate limits by spreading submissions across servers |
| Network attacker (MITM) | Wants to intercept or tamper with traffic between client↔server or server↔server |
| Sybil attacker | Registers many fake servers to gain disproportionate influence over reputation, directory listing weight, or client traffic share |
| Compromised directory service | Wants to steer clients toward malicious servers or hide legitimate ones |
| Root key holder (the project owner) | Trusted by construction — but key loss or compromise is catastrophic; see below |
| Holder of an existing P1/P2 device credential | Not an attacker — a compatibility constraint: must keep working through the migration |

## Assets

- **Device signing keys** — generated on-device, must never leave it. Compromise = that one device's identity is fully impersonable.
- **Network root key** — held offline by the project owner. Compromise or loss is the single most catastrophic event in the whole design; see mitigation below.
- **Delegation keys** (directory key, import key) — narrower blast radius than the root key by construction (each is revocable independently via the signed network config).
- **Reporter pseudonymity** — position tiles + IP address, visible to whichever server a client happens to talk to. Explicitly flagged as a residual risk in `docs/federation.md` §5, not something this rework claims to fully solve.
- **Event data integrity** across relays — an event must remain verifiable after passing through zero or more untrusted intermediary servers.
- **Server node keys** — identify a server to its peers; used for heartbeats and gossip. Compromise lets an attacker impersonate that one server's *behavior history*, not forge data.

## Threats, and what actually mitigates each one

| Threat | Mitigation | Residual risk |
|---|---|---|
| Forged device report/confirmation | Every server and client verifies the device's Ed25519 signature over the canonical (RFC 8785) payload before accepting it | None — an invalid signature is unconditionally rejected |
| Server withholds or delays data | Anti-entropy hash comparison between peers surfaces "event X has been known elsewhere for N minutes, absent here" | Detection, not prevention — a server can still delay briefly before being caught; reputation drop is the consequence, not an undo |
| Server lies about its own capacity/health in heartbeats | Peers independently measure latency/error rate over time rather than trusting the self-report | Self-reported metrics are inherently gameable in any open system; academic consensus is that Sybil/self-report resistance is never fully solved in permissionless networks — accepted, not "fixed" |
| Sybil flood of fake servers | Join-rate-limiting per IP/ASN, reputation starts at zero and ramps slowly, directory listing weight is capped for probation-tier servers | Bounded, not eliminated — a sufficiently patient/distributed attacker can still slowly build reputation across many identities; the cap limits how much traffic-share any single low-reputation identity can capture in the meantime |
| MITM / server impersonation | Mandatory valid TLS (no self-signed certs accepted); a server's node public key is bound to its advertised address at directory registration, and changing the address requires a freshly signed proof from the same key | An attacker who compromises a server's *actual* TLS cert/private key can still impersonate it — outside this project's control, standard TLS operational hygiene applies |
| Root key compromise or loss | Root key never touches a running server or the internet — used offline, only to sign delegation certs and network-config updates | Loss is unrecoverable by design (no backdoor); the documented outcome is a fork with a new root key, which is a deliberate, accepted trade-off (`docs/federation.md` §2), not a gap to close later |
| Legacy P1/P2 device credential (symmetric secret) | Purely additive migration — see `server/README.md`'s federation section; nothing breaks for a non-federating operator | None specific to this rework — the existing symmetric-secret model's own properties (already true today) carry over unchanged for single-server use |
| Import-key holder publishes bad static data | Import key is itself a delegated, revocable credential — the root key can revoke it via a network-config update | Bounded blast radius (one delegated key, not the whole network), but real until revoked and propagated |
| An algorithm unilaterally excludes a legitimate operator | Network-wide exclusion is only ever a signed network-config entry — no purely local/automatic process can produce it | A malicious *root key holder* could still exclude arbitrarily — out of scope; the root key holder is trusted by construction in this design |
| Privacy leak via IP+tile correlation on a federated server | Coarse tiles, multi-server spreading (client-lib's responsibility), operator privacy notice requirement | Explicitly accepted residual risk per `docs/federation.md` §5 — not something a server-side change alone can close |

## What this rework does *not* attempt

- Full Sybil resistance (see table above — not achievable in an open-membership system per current literature).
- Anonymity beyond pseudonymity (a server operator can always see the IP address and rough position of a client talking to it).
- Protecting against a compromised root key holder.
- Protecting a device whose own private key has already leaked (out of scope — device-local key security is `client-lib`'s concern).
