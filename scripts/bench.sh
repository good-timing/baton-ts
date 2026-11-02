#!/usr/bin/env bash
# Runs scripts/bench.mjs against the last release and the checkout, in turn,
# baton-spec's "repeats" times each, then prints the comparison.
#
#   scripts/bench.sh [OUT_DIR]
#
# The last release is the newest tag before HEAD; BENCH_AGAINST=X.Y.Z picks
# another. Both sides run with this checkout's MCP SDK.
set -euo pipefail

out="${1:-$(dirname "$0")/../bench-results}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
cd "$(dirname "$0")/.."
against="${BENCH_AGAINST:-$(git describe --tags --abbrev=0 HEAD^)}"
against="${against#v}"
repeats="$(node -p 'require("./baton-spec/bench/bench.json").repeats')"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npm run build --silent
npm install --silent --prefix "$work" --no-save --ignore-scripts "@goodtiming/baton-sdk@$against"
sdk_published="$work/node_modules/@goodtiming/baton-sdk"
sdk_checkout=.

for n in $(seq "$repeats"); do
  for side in published checkout; do
    echo "run $n of $repeats: $side" >&2
    sdk="sdk_$side"
    node --expose-gc scripts/bench.mjs "${!sdk}" "$side" "$out/$side-$n.json" 2>"$out/$side-$n.log"
  done
done
python3 baton-spec/scripts/compare_bench.py "$out"/published-*.json "$out"/checkout-*.json | tee "$out/compare.md"
