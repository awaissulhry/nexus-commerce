-- Rollback for L.16.0 — drop alert engine tables + indexes.
DROP INDEX IF EXISTS "AlertEvent_triggeredAt_idx";
DROP INDEX IF EXISTS "AlertEvent_status_triggeredAt_idx";
DROP INDEX IF EXISTS "AlertEvent_ruleId_status_idx";
DROP TABLE IF EXISTS "AlertEvent";

DROP INDEX IF EXISTS "AlertRule_metric_idx";
DROP INDEX IF EXISTS "AlertRule_enabled_idx";
DROP TABLE IF EXISTS "AlertRule";
