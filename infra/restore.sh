#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-}"
BUCKET="flowcanvas-private"
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/infra/compose.yaml")

if [[ -z "$SOURCE" || ! -f "$SOURCE/postgres.dump" || ! -f "$SOURCE/postgres.dump.sha256" || ! -d "$SOURCE/assets" ]]; then
  printf 'Usage: %s <backup-directory>\n' "$0" >&2
  exit 2
fi

python3 - "$SOURCE/postgres.dump" "$SOURCE/postgres.dump.sha256" <<'PY'
import hashlib
import pathlib
import sys

dump = pathlib.Path(sys.argv[1])
checksum = pathlib.Path(sys.argv[2]).read_text().split()[0]
with dump.open("rb") as backup_file:
    actual = hashlib.file_digest(backup_file, "sha256").hexdigest()
if actual != checksum:
    raise SystemExit("Backup checksum mismatch; restore cancelled.")
PY

read -r -p "This replaces the current database and bucket contents. Type RESTORE to continue: " confirmation
if [[ "$confirmation" != "RESTORE" ]]; then
  printf 'Restore cancelled.\n'
  exit 1
fi

"${COMPOSE[@]}" stop --timeout 60 api worker
SERVICES_STOPPED=true
restart_services() {
  if [[ "${SERVICES_STOPPED:-false}" == true ]]; then
    "${COMPOSE[@]}" up -d api worker
  fi
}
trap restart_services EXIT
"${COMPOSE[@]}" exec -T postgres sh -ec \
  'pg_restore --clean --if-exists --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$SOURCE/postgres.dump"
"${COMPOSE[@]}" exec -T redis sh -ec \
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli FLUSHDB'
"${COMPOSE[@]}" run --build --rm --no-deps \
  -v "$(cd "$SOURCE/assets" && pwd):/backup:ro" minio-client \
  mirror --overwrite --remove --preserve /backup "local/$BUCKET"
"${COMPOSE[@]}" up -d api worker
SERVICES_STOPPED=false
trap - EXIT

printf 'Restore completed from %s\n' "$SOURCE"
