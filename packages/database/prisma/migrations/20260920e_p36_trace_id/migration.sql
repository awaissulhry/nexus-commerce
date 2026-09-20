-- P3.6 — one trace id that follows a CHANGE from the click to the channel's answer.
--
-- `requestId` already existed and works, but it is a RUN id: for a cron it is one id
-- per tick, and the largest measured tick covers 1,243 calls. It answers "what did this
-- run do" and can never answer "what happened to my change".
--
-- The trace died at the queue: `OutboundSyncQueue` carried no id, so when the worker
-- picked a row up, the worker's own tick id was stamped on the channel call.
--
-- Both columns are additive and nullable: every existing row keeps meaning exactly what
-- it meant, and a null trace is an honest "this call belonged to no single change".
ALTER TABLE "OutboundSyncQueue"  ADD COLUMN IF NOT EXISTS "traceId" TEXT;
ALTER TABLE "OutboundApiCallLog" ADD COLUMN IF NOT EXISTS "traceId" TEXT;

-- Answering "show me everything my change did" is a lookup by trace, so it needs an
-- index. Partial, because the overwhelming majority of rows have no trace.
CREATE INDEX IF NOT EXISTS "OutboundApiCallLog_traceId_idx"
  ON "OutboundApiCallLog" ("traceId") WHERE "traceId" IS NOT NULL;
