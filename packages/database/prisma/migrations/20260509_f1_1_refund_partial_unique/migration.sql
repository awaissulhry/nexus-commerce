-- F1.1 — Prevent concurrent duplicate refund on the same Return.
--
-- Partial unique index: at most one Refund per Return where the
-- channelStatus indicates the refund is in flight or completed.
-- FAILED / NOT_IMPLEMENTED don't count — those are retryable, so the
-- operator can post again.
--
-- Combined with a fail-fast handler check (returns 409 when a
-- non-failed Refund already exists), this closes the race.

CREATE UNIQUE INDEX IF NOT EXISTS "Refund_oneActivePerReturn"
  ON "Refund"("returnId")
  WHERE "channelStatus" IN ('PENDING', 'POSTED', 'MANUAL_REQUIRED');
