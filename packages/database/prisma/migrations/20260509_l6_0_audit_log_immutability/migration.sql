-- L.6.0 — AuditLog immutability via Postgres triggers.
--
-- Compliance + forensic guarantee: once a row is in AuditLog it
-- cannot be modified or deleted by application code. Only the
-- retention cron (planned, scoped to a fixed minimum age) may DELETE
-- rows, and even that path is opt-in.
--
-- Application code (Prisma) writes AuditLog only via auditLog.create
-- — there are no audit.update or audit.delete callsites today (we
-- audited 26 callsites; all are create-only). The trigger formalises
-- that: any future regression that adds a write path will fail
-- immediately at the DB layer with a clear error message.
--
-- The triggers do NOT block INSERT — that's how rows get there in
-- the first place. They only block UPDATE / DELETE.
--
-- Bypass for retention: the (eventual) retention cron runs as the
-- DB owner and can SET LOCAL session_replication_role = 'replica'
-- to disable triggers within a transaction. That's the same pattern
-- Postgres docs recommend for trusted maintenance jobs.

CREATE OR REPLACE FUNCTION audit_log_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog rows are immutable (entityType=%, entityId=%, action=%) — application code may not UPDATE this table',
    OLD."entityType", OLD."entityId", OLD.action;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_log_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog rows are immutable (entityType=%, entityId=%, action=%) — application code may not DELETE this table; use the retention cron with session_replication_role=replica',
    OLD."entityType", OLD."entityId", OLD.action;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON "AuditLog";
DROP TRIGGER IF EXISTS audit_log_no_delete ON "AuditLog";

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_block_update();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_block_delete();
