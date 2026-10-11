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
BRIDGE_SERVICE="${BRIDGE_SERVICE:-meadow-bridge}"
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

echo "==> Installing Python dependencies"
.venv/bin/pip install --quiet -r requirements.txt

# Optional iMessage bridge (./meadow, systemd unit meadow-bridge).
HAS_BRIDGE=0
if systemctl cat "$BRIDGE_SERVICE" >/dev/null 2>&1 && [ -f meadow/package.json ]; then
    HAS_BRIDGE=1
    echo "==> Installing bridge dependencies (meadow/)"
    (
        export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
        # shellcheck disable=SC1091
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        cd meadow && npm install --no-audit --no-fund --loglevel=error
    )
elif [ -f meadow/package.json ]; then
    echo "==> Skipping $BRIDGE_SERVICE npm install (unit not installed — see deploy/meadow-bridge.service)"
fi

if [ "${1:-}" = "--init-db" ]; then
    echo "==> Applying Tiger schema"
    .venv/bin/python -m flask --app app tiger-init
fi

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> Waiting for Flask health check"
flask_ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
    if body="$(curl -fsS --max-time 3 http://127.0.0.1:5000/api/health 2>/dev/null)"; then
        echo "==> Flask OK: $body (version $after)"
        flask_ok=1
        break
    fi
    sleep 1
done
if [ "$flask_ok" != 1 ]; then
    echo "ERROR: $SERVICE did not become healthy. Recent log:" >&2
    journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
    exit 1
fi

if [ "$HAS_BRIDGE" = "1" ]; then
    echo "==> Restarting $BRIDGE_SERVICE"
    sudo systemctl restart "$BRIDGE_SERVICE" || {
        echo "WARNING: could not restart $BRIDGE_SERVICE (see: journalctl -u $BRIDGE_SERVICE -n 40)" >&2
    }
    echo "==> Waiting for bridge health check"
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if body="$(curl -fsS --max-time 3 http://127.0.0.1:5055/health 2>/dev/null)"; then
            echo "==> Bridge OK: $body"
            exit 0
        fi
        sleep 1
    done
    echo "ERROR: $BRIDGE_SERVICE did not become healthy. Recent log:" >&2
    journalctl -u "$BRIDGE_SERVICE" -n 40 --no-pager >&2 || true
    exit 1
fi

exit 0
