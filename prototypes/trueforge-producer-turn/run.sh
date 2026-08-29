#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$prototype_dir/../.." && pwd)"

node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_minor_patch="${node_version#*.}"
node_minor="${node_minor_patch%%.*}"
if [[ "$node_major" != "22" ]] || (( node_minor < 14 )); then
  echo "This spike requires Node >=22.14.0 <23; found $node_version." >&2
  exit 1
fi

if [[ ! -d "$prototype_dir/node_modules" ]]; then
  npm --prefix "$prototype_dir" install --no-audit --no-fund
fi

npm --prefix "$repo_root" run build
exec node "$prototype_dir/run.mjs"

