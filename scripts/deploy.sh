#!/usr/bin/env bash
set -euo pipefail
TARGET_HOST="${1:?Usage: bash scripts/deploy.sh SSH_ALIAS}"
cd "$(git rev-parse --show-toplevel)"
git diff --quiet
git diff --cached --quiet
REVISION="$(git rev-parse HEAD)"
git archive HEAD | ssh "$TARGET_HOST" 'set -eu
  cd /opt/whale-stack
  tar -xf -
  docker compose build whale-bot
  docker compose up -d --no-deps whale-bot
  docker compose ps whale-bot'
printf '%s\n' "$REVISION" | ssh "$TARGET_HOST" 'cat > /opt/whale-stack/DEPLOYED_COMMIT'
printf 'Deployed %s\n' "$REVISION"
