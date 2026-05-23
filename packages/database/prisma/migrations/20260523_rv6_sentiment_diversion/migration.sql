-- RV.6.1 — Negative-feedback diversion ("How was it?" review funnel).
--
-- New table ReviewSentimentCheck tracks the diversion lifecycle:
--   token         — public URL-safe identifier (never expose orderId)
--   response      — NONE | POSITIVE | NEGATIVE
--   responseFrom* — IP + UA captured on click for anti-spam
--   feedback      — free-text captured on the negative landing page
--   reviewRequestId — link back to the downstream review request created
--                     once we have a POSITIVE response (or fallback fired)
--
-- ReviewRule gains useSentimentDiversion (default false) so existing rules
-- continue to fire directly through Solicitations; operators opt-in per-rule.

ALTER TABLE "ReviewRule"
  ADD COLUMN IF NOT EXISTS "useSentimentDiversion" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "ReviewSentimentCheck" (
  "id"                     TEXT NOT NULL,
  "token"                  TEXT NOT NULL,
  "orderId"                TEXT NOT NULL,
  "ruleId"                 TEXT,
  "reviewRequestId"        TEXT,
  "sentimentEmailSentAt"   TIMESTAMP(3),
  "response"               TEXT NOT NULL DEFAULT 'NONE',
  "respondedAt"            TIMESTAMP(3),
  "respondedFromIp"        TEXT,
  "respondedFromUserAgent" TEXT,
  "feedback"               TEXT,
  "expiresAt"              TIMESTAMP(3),
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewSentimentCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReviewSentimentCheck_token_key" ON "ReviewSentimentCheck"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "ReviewSentimentCheck_reviewRequestId_key" ON "ReviewSentimentCheck"("reviewRequestId");
CREATE INDEX IF NOT EXISTS "ReviewSentimentCheck_orderId_idx" ON "ReviewSentimentCheck"("orderId");
CREATE INDEX IF NOT EXISTS "ReviewSentimentCheck_response_sentimentEmailSentAt_idx" ON "ReviewSentimentCheck"("response", "sentimentEmailSentAt");
CREATE INDEX IF NOT EXISTS "ReviewSentimentCheck_expiresAt_idx" ON "ReviewSentimentCheck"("expiresAt");

ALTER TABLE "ReviewSentimentCheck"
  ADD CONSTRAINT "ReviewSentimentCheck_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReviewSentimentCheck"
  ADD CONSTRAINT "ReviewSentimentCheck_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "ReviewRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReviewSentimentCheck"
  ADD CONSTRAINT "ReviewSentimentCheck_reviewRequestId_fkey"
  FOREIGN KEY ("reviewRequestId") REFERENCES "ReviewRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
