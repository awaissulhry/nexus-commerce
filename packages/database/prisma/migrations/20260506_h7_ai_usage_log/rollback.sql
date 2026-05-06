-- Rollback for 20260506_h7_ai_usage_log.
-- Drops the AiUsageLog table; no other table references it.
DROP TABLE IF EXISTS "AiUsageLog";
