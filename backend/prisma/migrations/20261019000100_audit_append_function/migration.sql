-- One round trip per audit entry instead of five.
-- The hash chain still works exactly as before: lock → read the newest hash (with a fresh snapshot, because each statement inside a
-- volatile PL/pgSQL function sees data committed while it waited for the lock) → hash = SHA-256("[" + previous-hash-as-JSON + "," + the rest of the
-- canonical row, built by the application) → insert. `AuditService.verifyChain` recomputes the same canonical form, so old and new rows verify alike.
CREATE OR REPLACE FUNCTION audit_append(
  p_id uuid, p_user_id uuid, p_user_name text, p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb,
  p_reason text, p_ip text, p_device_info text, p_request_id text, p_created_at timestamptz, p_tail text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  prev text;
  h text;
BEGIN
  PERFORM pg_advisory_xact_lock(748201); -- serialise chain appends (same lock as before)
  SELECT "hash" INTO prev FROM "AuditLog" ORDER BY "seq" DESC LIMIT 1;
  h := encode(sha256(convert_to('[' || CASE WHEN prev IS NULL THEN 'null' ELSE '"' || prev || '"' END || ',' || p_tail, 'UTF8')), 'hex');
  INSERT INTO "AuditLog" ("id", "userId", "userName", "action", "entityType", "entityId", "before", "after", "reason", "ip", "deviceInfo", "requestId", "createdAt", "prevHash", "hash")
  VALUES (p_id, p_user_id, p_user_name, p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason, p_ip, p_device_info, p_request_id, p_created_at, prev, h);
END;
$$;
