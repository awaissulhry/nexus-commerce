-- Rollback for L.6.0 — drop AuditLog immutability triggers.
DROP TRIGGER IF EXISTS audit_log_no_update ON "AuditLog";
DROP TRIGGER IF EXISTS audit_log_no_delete ON "AuditLog";
DROP FUNCTION IF EXISTS audit_log_block_update();
DROP FUNCTION IF EXISTS audit_log_block_delete();
