-- EPQ.1 — quote lifecycle: per-version accept tokens (supersede semantics) +
-- the expiry-sweep index. Additive only; created with `prisma migrate diff`
-- (NOT applied here — the merging session runs `prisma migrate dev` after the
-- Owner's dev server is restarted, per PLAYBOOK trap 6b).

-- AlterTable
ALTER TABLE "QuoteVersion" ADD COLUMN "acceptTokenHash" TEXT;

-- CreateIndex
CREATE INDEX "Quote_validUntilAt_idx" ON "Quote"("validUntilAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteVersion_acceptTokenHash_key" ON "QuoteVersion"("acceptTokenHash");
