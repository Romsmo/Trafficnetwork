# syntax=docker/dockerfile:1
# Runs the ingestion CLI together with the real `osmium` binary it shells out to — the way to run it
# on Windows/macOS, or anywhere osmium-tool is not installed. Build context = this directory.
#
# The named build context "certs" supplies extra-ca.crt: a TLS-inspecting antivirus/proxy root CA that the
# HOST trusts but a Linux container does not. An empty PEM file is fine (no extra CA). Example:
#
#   docker build --build-context certs=<dir containing extra-ca.crt> -t trafficnetwork-ingest .
#
# Run (see docs/europe-runbook.md for the Europe layout: raw data on a big disk, node index on an SSD):
#
#   docker run --rm --memory=5g --network <server-network> \
#     -v <big-disk>:/data -v <ssd>:/idx \
#     -e SERVER_URL=http://server:3000 -e CLIENT_ID=... -e CLIENT_SECRET=... \
#     -e OSMIUM_INDEX_DIR=/idx trafficnetwork-ingest --region europe
FROM node:24-bookworm-slim
# `time` (GNU) lets the pipeline record osmium's peak memory per step.
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool ca-certificates time \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=certs extra-ca.crt /extra-ca.crt
ENV NODE_EXTRA_CA_CERTS=/extra-ca.crt
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY config ./config
COPY src ./src
# The whole progress log is streamed and the dedup keys are a compact numeric set (state/keyset.ts), but
# leave headroom for the V8 heap: the default limit depends on the container's memory.
ENV NODE_OPTIONS=--max-old-space-size=3072
ENV STATE_DIR=/data/state DOWNLOAD_DIR=/data/downloads
ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
