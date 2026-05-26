#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="${DEPLOY_REPO_ROOT:-$(cd "$script_dir/.." && pwd -P)}"
deploy_branch="${DEPLOY_BRANCH:-main}"

if command -v stat >/dev/null 2>&1; then
  deploy_user="${DEPLOY_USER:-$(stat -c '%U' "$repo_root" 2>/dev/null || stat -f '%Su' "$repo_root") }"
else
  deploy_user="${DEPLOY_USER:-pi}"
fi

deploy_user="${deploy_user// /}"

if [[ -z "$deploy_user" ]]; then
  echo "Unable to determine DEPLOY_USER"
  exit 1
fi

lock_key="$(echo "$repo_root" | tr '/ ' '__')"
lock_file="/tmp/nyctrain-deploy-${lock_key}.lock"

exec 9>"$lock_file"
flock -n 9 || exit 0

run_as_pi() {
  runuser -u "$deploy_user" -- "$@"
}

cd "$repo_root"

run_as_pi git fetch origin "$deploy_branch"

current_commit="$(run_as_pi git rev-parse HEAD)"
remote_commit="$(run_as_pi git rev-parse origin/$deploy_branch)"

if [[ "$current_commit" == "$remote_commit" ]]; then
  exit 0
fi

run_as_pi git pull --ff-only origin "$deploy_branch"

run_as_pi bash -lc "cd '$repo_root/client' && npm ci && npm run build"

run_as_pi bash -lc "cd '$repo_root/server' && npm ci"

systemctl restart nyctrain
