#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
app_root="$(CDPATH= cd -- "$script_dir/../.." && pwd)"
t3_entry="$app_root/apps/server/dist/bin.mjs"

t3() {
  node "$t3_entry" "$@"
}

port="${PORT:-10000}"
t3_home="${T3CODE_HOME:-/data/t3}"
workspace_dir="${T3CODE_WORKSPACE_DIR:-/data/workspace}"
project_dir="${T3CODE_PROJECT_DIR:-$workspace_dir/project}"
codex_home="${CODEX_HOME:-/data/codex}"
claude_config_dir="${CLAUDE_CONFIG_DIR:-/data/claude}"
public_url="${T3CODE_PUBLIC_URL:-${RENDER_EXTERNAL_URL:-}}"
pairing_ttl="${T3CODE_PAIRING_TTL:-24h}"

export CODEX_HOME="$codex_home"
export CLAUDE_CONFIG_DIR="$claude_config_dir"

mkdir -p "$t3_home" "$workspace_dir" "$codex_home" "$claude_config_dir"

if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git
fi

if [ -n "${OPENAI_API_KEY:-}" ]; then
  printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key
fi

working_dir="$workspace_dir"
if [ -n "${T3CODE_PROJECT_REPO:-}" ]; then
  if [ ! -d "$project_dir/.git" ]; then
    if [ -d "$project_dir" ] && [ -n "$(find "$project_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      echo "T3CODE_PROJECT_DIR exists and is not an empty Git repository: $project_dir" >&2
      exit 1
    fi

    if [ -n "${T3CODE_PROJECT_BRANCH:-}" ]; then
      git clone --branch "$T3CODE_PROJECT_BRANCH" --single-branch "$T3CODE_PROJECT_REPO" "$project_dir"
    else
      git clone "$T3CODE_PROJECT_REPO" "$project_dir"
    fi
  fi
  working_dir="$project_dir"
fi

if [ -n "$public_url" ]; then
  t3 auth pairing create \
    --base-dir "$t3_home" \
    --base-url "$public_url" \
    --label "Render startup" \
    --ttl "$pairing_ttl"
else
  echo "Set T3CODE_PUBLIC_URL to print a public pairing link at startup." >&2
fi

exec node "$t3_entry" start \
  --host 0.0.0.0 \
  --port "$port" \
  --base-dir "$t3_home" \
  --no-browser \
  --auto-bootstrap-project-from-cwd \
  "$working_dir"
