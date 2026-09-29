#!/usr/bin/env bash
# Restore drill: restores a dump into a THROWAWAY database and checks that the business invariants hold.
#   ADMIN_DATABASE_URL=postgresql://.../postgres ./restore-verify.sh path/to/makarifor-....dump
# ADMIN_DATABASE_URL must be a server where creating and dropping a scratch database is acceptable (NOT production). Exit code 0 = restore is usable.
set -euo pipefail
: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL (scratch server, database name is ignored)}"
dump="${1:?usage: restore-verify.sh <dump>}"
( cd "$(dirname "$dump")" && sha256sum --check "$(basename "$dump").sha256" ) || { echo "checksum mismatch: dump is corrupt"; exit 1; }
name="restore_check_$(date -u +%s)"
base="${ADMIN_DATABASE_URL%/*}"
q() { psql "$base/$1" -v ON_ERROR_STOP=1 -At -c "$2"; }
q postgres "CREATE DATABASE $name"
trap 'q postgres "DROP DATABASE IF EXISTS $name" >/dev/null' EXIT
pg_restore --no-owner --no-privileges --dbname="$base/$name" --exit-on-error "$dump"
fail=0
check() { # description, sql returning 't' when healthy
  if [ "$(q "$name" "$2")" = "t" ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi
}
check "users table present and populated"            'SELECT count(*) > 0 FROM "User"'
check "stock balance equals the ledger sum"          $'SELECT coalesce(bool_and(b."quantityEggs" = coalesce(t.s,0)), true) FROM "InventoryBalance" b LEFT JOIN (SELECT "farmId","productId", sum("quantityEggs") s FROM "InventoryTransaction" GROUP BY 1,2) t USING ("farmId","productId")'
check "no negative stock"                            'SELECT NOT EXISTS (SELECT 1 FROM "InventoryBalance" WHERE "quantityEggs" < 0)'
check "sale totals equal item lines minus discount"  $'SELECT NOT EXISTS (SELECT 1 FROM "Sale" s WHERE s.status = \'ACTIVE\' AND s.total <> (SELECT coalesce(sum(i."lineTotal"),0) FROM "SaleItem" i WHERE i."saleId" = s.id) - s.discount)'
check "audit log is append-only (triggers restored)" $'SELECT count(*) >= 1 FROM pg_trigger WHERE tgname = \'audit_log_no_update_delete\''
check "audit chain has no gaps in prevHash linkage"  $'SELECT NOT EXISTS (SELECT 1 FROM (SELECT hash, lag(hash) OVER (ORDER BY seq) AS prev, "prevHash" FROM "AuditLog") a WHERE a."prevHash" IS DISTINCT FROM a.prev)'
echo "tables: $(q "$name" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
exit $fail
