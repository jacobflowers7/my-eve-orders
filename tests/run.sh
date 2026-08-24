#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")"
node --check <(awk '/^<script>$/{flag=1;next}/^<\/script>$/{flag=0}flag' ../index.html)
echo "syntax: OK"
for t in *.test.js; do
  echo "== $t"
  node "$t"
done
