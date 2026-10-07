#!/usr/bin/env bash
# Logical backup of the Makarifor database (independent of Neon's own point-in-time restore).
#   DIRECT_DATABASE_URL=postgresql://... ./backup.sh [output-dir] [keep-days]
# Produces  makarifor-YYYYmmdd-HHMMSSZ.dump  (pg_dump custom format, compressed) plus a .sha256 file. Store the result OFF the database
# provider (e.g. an encrypted bucket in a different account). Never commit or e-mail dumps: they contain customer and financial data.
set -euo pipefail
: "${DIRECT_DATABASE_URL:?set DIRECT_DATABASE_URL (the direct, non-pooled connection)}"
out="${1:-./backups}"; keep="${2:-30}"
mkdir -p "$out"; umask 077
stamp="$(date -u +%Y%m%d-%H%M%SZ)"; file="$out/makarifor-$stamp.dump"
# --no-owner/--no-privileges: restore into any role layout; roles/grants are re-applied by prisma/sql/app_role.sql.
pg_dump --format=custom --compress=6 --no-owner --no-privileges --dbname="$DIRECT_DATABASE_URL" --file="$file"
( cd "$out" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
pg_restore --list "$file" > /dev/null   # the archive must at least be readable
find "$out" -name 'makarifor-*.dump*' -mtime +"$keep" -delete
echo "backup ok: $file ($(du -h "$file" | cut -f1))"
