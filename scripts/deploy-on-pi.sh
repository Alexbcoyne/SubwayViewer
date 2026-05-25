#!/usr/bin/env bash

set -euo pipefail

repo_root="/home/pi/project-subwayviewer"
lock_file="/tmp/nyctrain-deploy.lock"

exec 9>"$lock_file"
flock -n 9 || exit 0

run_as_pi() {
  runuser -u pi -- "$@"
}

cd "$repo_root"

run_as_pi git fetch origin main

current_commit="$(run_as_pi git rev-parse HEAD)"
remote_commit="$(run_as_pi git rev-parse origin/main)"

if [[ "$current_commit" == "$remote_commit" ]]; then
  exit 0
fi

run_as_pi git pull --ff-only origin main

run_as_pi bash -lc "cd '$repo_root/client' && npm ci && npm run build"

run_as_pi bash -lc "cd '$repo_root/server' && npm ci"

systemctl restart nyctrain
