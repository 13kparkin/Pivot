#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
app_root="$(CDPATH= cd -- "$script_dir/../.." && pwd)"
t3_entry="$app_root/apps/server/dist/bin.mjs"
pair_url_entry="$script_dir/pair-url.mjs"

t3() {
  node "$t3_entry" "$@"
}

port="${PORT:-10000}"
t3_home="${T3CODE_HOME:-/data/t3}"
workspace_dir="${T3CODE_WORKSPACE_DIR:-/data/workspace}"
codex_home="${CODEX_HOME:-/data/codex}"
claude_config_dir="${CLAUDE_CONFIG_DIR:-/data/claude}"
public_url="${T3CODE_PUBLIC_URL:-${RENDER_EXTERNAL_URL:-}}"
pairing_ttl="${T3CODE_PAIRING_TTL:-24h}"

export CODEX_HOME="$codex_home"
export CLAUDE_CONFIG_DIR="$claude_config_dir"
export T3CODE_CLOUD_PROVIDER="${T3CODE_CLOUD_PROVIDER:-render}"
export T3CODE_ENVIRONMENT_LABEL="${T3CODE_ENVIRONMENT_LABEL:-Render cloud environment}"
export T3CODE_WORKSPACE_DIR="$workspace_dir"

mkdir -p "$t3_home" "$workspace_dir" "$codex_home" "$claude_config_dir"

if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git
fi

if [ -n "$public_url" ]; then
  pairing_json="$(t3 auth pairing create \
    --base-dir "$t3_home" \
    --label "Render startup" \
    --ttl "$pairing_ttl" \
    --json)"
  printf '%s' "$pairing_json" | \
    T3CODE_PUBLIC_URL="$public_url" \
    node "$pair_url_entry"
else
  echo "Set T3CODE_PUBLIC_URL to print a public pairing link at startup." >&2
fi

cd "$workspace_dir"

exec node "$t3_entry" start \
  --host 0.0.0.0 \
  --port "$port" \
  --base-dir "$t3_home" \
  --no-browser
