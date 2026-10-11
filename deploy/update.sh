#!/usr/bin/env bash
# Update the running Meadow server to match origin/main.
#
# Usage (on the EC2 instance, from anywhere):
#   bash ~/Hack-NC-26/deploy/update.sh
#   bash ~/Hack-NC-26/deploy/update.sh --init-db   # also run `flask tiger-init`
#
# Safe to re-run. It never touches .env (ignored by git).
# It stops if the server has local edits or the pull is not a clean
# fast-forward, so nothing is overwritten silently.

set -euo pipefail

BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-meadow}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Updating $REPO_DIR to origin/$BRANCH"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "ERROR: tracked files have local changes on this server:" >&2
    git status --short --untracked-files=no >&2
    echo "Discard them with 'git checkout -- <file>' (or 'git stash'), then re-run." >&2
    exit 1
fi

before="$(git rev-parse --short HEAD)"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
after="$(git rev-parse --short HEAD)"

if [ "$before" = "$after" ]; then
    echo "==> Already up to date ($after)"
else
    echo "==> Updated $before -> $after"
    git --no-pager log --oneline "$before..$after"
fi

if [ ! -x .venv/bin/pip ]; then
    echo "==> Creating virtualenv"
    python3.12 -m venv .venv 2>/dev/null || python3 -m venv .venv
fi

echo "==> Installing dependencies"
.venv/bin/pip install --quiet -r requirements.txt

if [ "${1:-}" = "--init-db" ]; then
    echo "==> Applying Tiger schema"
    .venv/bin/python -m flask --app app tiger-init
fi

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> Waiting for health check"
for i in 1 2 3 4 5 6 7 8 9 10; do
    if body="$(curl -fsS --max-time 3 http://127.0.0.1:5000/api/health 2>/dev/null)"; then
        echo "==> OK: $body (version $after)"
        exit 0
    fi
    sleep 1
done

echo "ERROR: $SERVICE did not become healthy. Recent log:" >&2
journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
exit 1
