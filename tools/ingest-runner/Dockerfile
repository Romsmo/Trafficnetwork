# syntax=docker/dockerfile:1
# Runs the ingestion CLI (ingestion/, branch phase3/ingestion) on Windows via Docker,
# because it needs the real `osmium` binary. Build context = the ingestion/ directory;
# a named context "certs" supplies extra-ca.crt (an antivirus TLS-scanning root CA
# that Windows already trusts but Linux containers don't; an empty PEM is fine).
#
#   docker build -f tools/ingest-runner/Dockerfile \
#     --build-context certs=<dir containing extra-ca.crt> -t trafficnetwork-ingest <path-to>/ingestion
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=certs extra-ca.crt /extra-ca.crt
ENV NODE_EXTRA_CA_CERTS=/extra-ca.crt
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY config ./config
COPY src ./src
ENV STATE_DIR=/data/state DOWNLOAD_DIR=/data/downloads
ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
