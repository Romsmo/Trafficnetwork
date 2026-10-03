#!/usr/bin/env bash
# Mints one credential in the running Docker stack — exactly the snippet from
# server/docs/installation.md ("Create the first client"), with the name and
# scope swapped in. Prints {"clientId":…,"clientSecret":…} to stdout.
#
#   cd <fresh clone>/server && bash <this dir>/mkclient.sh browser-1 client > browser-1.json
#
# Scopes used in the end-to-end run: client, bulk-import (seed data),
# device-registration (an app key a library registers devices with).
set -euo pipefail
name="${1:?name}"
scope="${2:?scope}"
docs="$(dirname "$0")/../../server/docs/installation.md"
[ -f "$docs" ] || docs="docs/installation.md"   # when run from <clone>/server
snippet="$(awk '/^### Create the first client/{f=1} f&&/^```bash/{g=1;next} g&&/^```/{exit} g{print}' "$docs")"
# The snippet's first line is the `docker compose exec … <<'EOF'` command itself; run it with name/scope swapped.
printf '%s\n' "$snippet" \
  | sed "s/name: \"my-first-client\"/name: \"$name\"/; s/scopes: \[\"client\"\]/scopes: [\"$scope\"]/" \
  | bash
