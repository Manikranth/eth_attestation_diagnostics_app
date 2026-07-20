#!/usr/bin/env bash
set -euo pipefail

# Attestation Monitor bootstrap for a fresh machine.
# Run:
#   bash setup-attmon.sh
#
# Optional overrides:
#   INSTALL_DIR="$HOME/apps/eth_attestation_diagnostics_app" bash setup-attmon.sh
#   LIGHTHOUSE_LOG_DIR="/path/to/beacon/logs" VC_LOG_DIR="/path/to/validator/logs" bash setup-attmon.sh

REPO_URL="${REPO_URL:-https://github.com/Manikranth/eth_attestation_diagnostics_app.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/eth_attestation_diagnostics_app}"
BACKFILL_EPOCHS="${BACKFILL_EPOCHS:-3}"
POLL_SECONDS="${POLL_SECONDS:-60}"
CLICKHOUSE_USER="${CLICKHOUSE_USER:-attmon}"
CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-attmon}"
LIGHTHOUSE_LOG_DIR="${LIGHTHOUSE_LOG_DIR:-/Volumes/geth/hoodi_node/lighthouse/hoodi/beacon/logs}"
VC_LOG_DIR="${VC_LOG_DIR:-/Volumes/geth/hoodi_node/lighthouse/hoodi/validators/logs}"
HOODI_NETWORK="${HOODI_NETWORK:-hoodi_node_default}"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    echo "Install it, then rerun this script." >&2
    exit 1
  fi
}

need_command git
need_command docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required. Install Docker Desktop or the Docker Compose plugin." >&2
  exit 1
fi

if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi

cd "$INSTALL_DIR"

cat > .env <<EOF
BACKFILL_EPOCHS=$BACKFILL_EPOCHS
POLL_SECONDS=$POLL_SECONDS
CLICKHOUSE_USER=$CLICKHOUSE_USER
CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASSWORD
LIGHTHOUSE_LOG_DIR=$LIGHTHOUSE_LOG_DIR
VC_LOG_DIR=$VC_LOG_DIR
EOF

if ! docker network inspect "$HOODI_NETWORK" >/dev/null 2>&1; then
  echo "Missing Docker network: $HOODI_NETWORK" >&2
  echo "Start your Hoodi Lighthouse node stack first, or create/connect the network before running:" >&2
  echo "  docker network create $HOODI_NETWORK" >&2
  exit 1
fi

if [ ! -d "$LIGHTHOUSE_LOG_DIR" ]; then
  echo "Missing Lighthouse beacon log directory: $LIGHTHOUSE_LOG_DIR" >&2
  echo "Rerun with LIGHTHOUSE_LOG_DIR=/actual/beacon/log/path" >&2
  exit 1
fi

if [ ! -d "$VC_LOG_DIR" ]; then
  echo "Missing Lighthouse validator log directory: $VC_LOG_DIR" >&2
  echo "Rerun with VC_LOG_DIR=/actual/validator/log/path" >&2
  exit 1
fi

docker compose pull
docker compose up -d --build

echo
echo "Attestation Monitor is running."
echo "Dashboard:   http://localhost:8080"
echo "Prometheus:  http://localhost:9090"
echo "ClickHouse:  http://localhost:8123"
echo
echo "Useful commands:"
echo "  cd \"$INSTALL_DIR\""
echo "  docker compose logs -f indexer"
echo "  docker compose run --rm app --last 5"
