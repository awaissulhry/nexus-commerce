-- RV.3.3 — App-level retry tracking on ReviewRequest.
--
-- SP-API client already retries 429/5xx with 1s/2s/4s backoff inside a
-- single request lifecycle (amazon-sp-api.client.ts:344). What's missing
-- is *re-attempt across cron ticks*: if all client retries fail, the row
-- gets marked FAILED and never reprocessed. These three fields close that
-- gap.
--
--   attemptCount  — how many cron-tick send attempts we've made
--   lastAttemptAt — last time the mailer touched this row
--   nextRetryAt   — earliest time the mailer should re-try (null = no
--                   pending retry; once set, the next mailer tick
--                   re-queries FAILED rows whose nextRetryAt <= now AND
--                   attemptCount < 3, sets status back to SCHEDULED and
--                   retries through the normal Solicitations path).
--
-- After 3 attempts the row stays FAILED until an operator manually re-queues.

ALTER TABLE "ReviewRequest"
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ReviewRequest_nextRetryAt_idx" ON "ReviewRequest"("nextRetryAt");
