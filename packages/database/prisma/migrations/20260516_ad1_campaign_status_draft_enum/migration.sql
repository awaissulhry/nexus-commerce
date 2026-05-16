-- AD.1 — CampaignStatus gains DRAFT.
--
-- Split out of the main AD.1 migration because PostgreSQL forbids
-- `ALTER TYPE ... ADD VALUE` inside a transaction block, and Prisma
-- migrate deploy wraps each migration file in a transaction. Putting
-- the enum change in its own file lets it commit cleanly.

ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
