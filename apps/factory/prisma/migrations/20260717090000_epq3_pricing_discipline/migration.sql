-- EPQ.3 — pricing discipline. Additive only; authored from `prisma migrate
-- diff` output and hand-shaped to plain ADD COLUMNs (the diff proposes table
-- rebuilds for column adds, which take a long write lock while the Owner's
-- server runs; end state verified identical with `migrate diff --exit-code`).
-- NOT applied here — the merging session runs `prisma migrate dev` after the
-- Owner's dev server is restarted, per PLAYBOOK trap 6b.

-- AlterTable (EPQ.3 — below-MOQ surcharge per template; moqQty NULL = no MOQ)
ALTER TABLE "ProductTemplate" ADD COLUMN "moqQty" INTEGER;
ALTER TABLE "ProductTemplate" ADD COLUMN "moqSurchargeMode" TEXT NOT NULL DEFAULT 'ABSOLUTE';
ALTER TABLE "ProductTemplate" ADD COLUMN "moqSurcharge" INTEGER NOT NULL DEFAULT 0;

-- AlterTable (EPQ.3 — discount reason codes on quote lines)
ALTER TABLE "QuoteLine" ADD COLUMN "adjustmentReasonCode" TEXT;

-- CreateTable (EPQ.3 — quantity-break tiers per template)
CREATE TABLE "QuantityBreak" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "minQty" INTEGER NOT NULL,
    "priceDeltaMode" TEXT NOT NULL DEFAULT 'ABSOLUTE',
    "priceDelta" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "QuantityBreak_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProductTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "QuantityBreak_templateId_minQty_key" ON "QuantityBreak"("templateId", "minQty");
