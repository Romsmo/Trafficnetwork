# tools/

Small helper tools, not part of any package's shipped product:

- **`test-client/`** — a CLI + local web UI that talks plain HTTP/WebSocket to a running server, for
  poking at it by hand or as a second simulated device during a manual multi-node test. See its own
  README. Built and used during Launch L's local acceptance run — results in `docs/launch-checklist.md`.
- **`ingest-runner/`** — a Dockerfile to run the ingestion CLI on Windows (needs the real `osmium`
  binary, which is easiest to get via Docker there). See its header comment for usage.
- **`federation-local/`** — a `docker-compose` file to run two federated nodes locally against the same
  images, for exercising real join/replication/failover without a second machine.
- **`start-docker-desktop.ps1`** — works around a specific Docker Desktop 4.88–4.91 Windows startup bug
  (see the script's own header). Kept here, not just locally, because it already cost two separate
  sessions on this repo real time on the same platform.

None of these are required to run the server, ingestion, or client-lib — they exist to make local,
manual testing on this project less painful, mostly for a Windows contributor.
