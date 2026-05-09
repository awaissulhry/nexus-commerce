-- Rollback for L.3.0 — drop OutboundApiCallLog and its indexes.
DROP INDEX IF EXISTS "OutboundApiCallLog_productId_idx";
DROP INDEX IF EXISTS "OutboundApiCallLog_requestId_idx";
DROP INDEX IF EXISTS "OutboundApiCallLog_statusCode_createdAt_idx";
DROP INDEX IF EXISTS "OutboundApiCallLog_operation_createdAt_idx";
DROP INDEX IF EXISTS "OutboundApiCallLog_success_createdAt_idx";
DROP INDEX IF EXISTS "OutboundApiCallLog_createdAt_idx";
DROP INDEX IF EXISTS "OutboundApiCallLog_channel_createdAt_idx";
DROP TABLE IF EXISTS "OutboundApiCallLog";
