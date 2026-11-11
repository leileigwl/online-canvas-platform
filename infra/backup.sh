#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT/backups}"
BUCKET="flowcanvas-private"
if [[ "$BACKUP_ROOT" != /* ]]; then
  BACKUP_ROOT="$ROOT/$BACKUP_ROOT"
fi
mkdir -p "$BACKUP_ROOT"
BACKUP_ROOT="$(cd "$BACKUP_ROOT" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
DESTINATION="$BACKUP_ROOT/$STAMP"
STAGING="$BACKUP_ROOT/.${STAMP}.incomplete"
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/infra/compose.yaml")

if [[ -e "$DESTINATION" || -e "$STAGING" ]]; then
  printf 'Backup destination already exists: %s\n' "$DESTINATION" >&2
  exit 1
fi
mkdir -p "$STAGING/assets"
"${COMPOSE[@]}" exec -T postgres sh -ec \
  'pg_dump --format=custom --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$STAGING/postgres.dump"
"${COMPOSE[@]}" run --build --rm --no-deps \
  -v "$STAGING/assets:/backup" minio-client \
  mirror --overwrite --preserve "local/$BUCKET" /backup

python3 - "$STAGING/postgres.dump" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
with path.open("rb") as backup_file:
    digest = hashlib.file_digest(backup_file, "sha256").hexdigest()
path.with_name("postgres.dump.sha256").write_text(f"{digest}  {path.name}\n")
PY

mv "$STAGING" "$DESTINATION"
printf 'Backup created at %s\n' "$DESTINATION"
