-- ADX A2 — record WHY a write happened, not only what changed and who did it.
-- Additive and nullable: every existing row is untouched and keeps today's behaviour.
ALTER TABLE "AdvertisingActionLog" ADD COLUMN "evidence" JSONB;
