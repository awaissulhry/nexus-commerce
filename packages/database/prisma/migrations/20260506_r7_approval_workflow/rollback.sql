-- Rollback for R.7 approval workflow
ALTER TABLE "BrandSettings" DROP COLUMN IF EXISTS "requireApprovalForPo";

ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "cancelledReason";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "cancelledAt";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "acknowledgedAt";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "submittedByUserId";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "submittedAt";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "approvedByUserId";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "approvedAt";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "reviewedByUserId";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "reviewedAt";

-- Note: Postgres doesn't support DROPPING enum values without a
-- table rewrite. Leaving REVIEW/APPROVED/ACKNOWLEDGED in the type;
-- a fresh schema drop is cleaner than partial rollback.
