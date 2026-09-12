-- PES.8 — the market a draft's caps came from.
-- Additive: one nullable column on a table this lane owns. No FK, no index change.
-- Needed because PATCH /api/products/bulk resolves attr_* field definitions through the
-- market's cached Amazon schema; without it every attribute draft was refused at approval.
ALTER TABLE "ProductAiDraft" ADD COLUMN "market" TEXT;
