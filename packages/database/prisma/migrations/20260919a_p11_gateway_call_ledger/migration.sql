-- P1.1 — the channel gateway's call-ledger fields (docs/channel-connections/FINAL-PLAN.md, section 5 item 1).
-- Additive only: seven nullable columns on OutboundApiCallLog. No index (a non-concurrent index on this
-- table would block writes while it builds; P3.6 adds what the dashboards need, concurrently).

-- AlterTable
ALTER TABLE "OutboundApiCallLog" ADD COLUMN "outcome" TEXT,
ADD COLUMN "errorClass" TEXT,
ADD COLUMN "rateLimitRemaining" DOUBLE PRECISION,
ADD COLUMN "rateLimitLimit" DOUBLE PRECISION,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "attempts" INTEGER,
ADD COLUMN "apiVersion" TEXT;
