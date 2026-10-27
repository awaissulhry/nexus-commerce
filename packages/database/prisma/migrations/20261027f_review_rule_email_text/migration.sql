-- Reviews N3 (2026-10-27) — a review-request rule's own e-mail text per language.
--
--   ReviewRule.emailText (JSONB, nullable): { "it"?: { "subject", "body" }, "en"?: { "subject", "body" } } — the
--   rule's own subject and text for OUR review e-mail (Shopify buyers). Null, or a language left out, means the
--   standard text, exactly as before. Amazon buyers get Amazon's own e-mail and eBay buyers none: they never read it.
--
-- Additive only: one nullable column on a table that is already business-owned (its row-level security covers the new
-- column); nothing existing is changed. Every rule starts with no text of its own, so no buyer's e-mail changes until a
-- person writes and saves one.
--
-- DDL from `prisma migrate diff --from-schema <main> --to-schema prisma/schema.prisma` (offline).
--
-- Rollback: ALTER TABLE "ReviewRule" DROP COLUMN "emailText";

-- AlterTable
ALTER TABLE "ReviewRule" ADD COLUMN "emailText" JSONB;
