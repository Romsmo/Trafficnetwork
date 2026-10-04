#!/usr/bin/env bash
# Generates the Kotlin wrapper from the compiled UniFFI library.
#
#   bindings/kotlin/generate.sh <jvm|android> <path to libtrafficnetwork_uniffi.so>
#
# Writes into bindings/kotlin/<jvm|android>/generated/ (not checked in). The
# generator is built from this workspace, so it is always the same UniFFI
# version as the library (a generator and a library from different versions
# refuse to work together). Run it from anywhere; needs a Rust toolchain.
set -euo pipefail

target="${1:?usage: generate.sh <jvm|android> <path to libtrafficnetwork_uniffi.so>}"
library="${2:?usage: generate.sh <jvm|android> <path to libtrafficnetwork_uniffi.so>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="$(cd "$here/../.." && pwd)"
library="$(cd "$(dirname "$library")" && pwd)/$(basename "$library")"

rm -rf "$here/$target/generated"
(cd "$workspace" && cargo run --quiet -p trafficnetwork-uniffi-bindgen --bin uniffi-bindgen -- \
  generate --library "$library" --language kotlin \
  --config "$here/$target/uniffi.toml" --out-dir "$here/$target/generated")
echo "generated $(find "$here/$target/generated" -name '*.kt' | wc -l) Kotlin file(s) in bindings/kotlin/$target/generated"
