-- RX.6 — per-rule fallback control. Additive nullable-defaulted boolean;
-- default true preserves the existing "fall back to Solicitation after 5d
-- of no diversion response" behavior, so existing rules are unchanged.

-- AlterTable
ALTER TABLE "ReviewRule" ADD COLUMN "fallbackOnNoResponse" BOOLEAN NOT NULL DEFAULT true;
