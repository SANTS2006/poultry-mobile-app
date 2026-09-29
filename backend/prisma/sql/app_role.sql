-- Least-privilege runtime role for the Node.js backend. Run once per environment as the database owner
-- (Neon: use the SQL editor or psql with the DIRECT connection), after `prisma migrate deploy`.
-- Replace :app_password via psql variable:  psql "$DIRECT_DATABASE_URL" -v app_password="'<generated>'" -f app_role.sql
-- The migration role (used only by `prisma migrate`) stays separate and is never given to the running app.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'makarifor_app') THEN
    CREATE ROLE makarifor_app LOGIN;
  END IF;
END $$;
ALTER ROLE makarifor_app PASSWORD :app_password NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO makarifor_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO makarifor_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO makarifor_app;

-- Append-only tables: defence in depth on top of the triggers.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM makarifor_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "InventoryTransaction" FROM makarifor_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "Price" FROM makarifor_app;

-- Tables created by future migrations must be granted explicitly (or re-run this script).
