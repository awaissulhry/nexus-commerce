-- =====================================================================
-- R.7 — PO approval workflow state machine
--
-- Adds REVIEW / APPROVED / ACKNOWLEDGED to PurchaseOrderStatus enum,
-- audit columns to PurchaseOrder for each transition, and a
-- BrandSettings flag that gates the explicit human approval step.
--
-- requireApprovalForPo=false (Xavia default) auto-collapses
-- DRAFT → REVIEW → APPROVED on submit-for-review. Flipping to true
-- splits them into separate transitions for two-person workflows.
-- =====================================================================

-- ── PurchaseOrderStatus enum extensions ────────────────────────────
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'REVIEW';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'ACKNOWLEDGED';

-- ── PurchaseOrder workflow audit columns ──────────────────────────
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "reviewedAt"        TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "reviewedByUserId"  TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "approvedAt"        TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "approvedByUserId"  TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "submittedAt"       TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "submittedByUserId" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "acknowledgedAt"    TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "cancelledAt"       TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "cancelledReason"   TEXT;

-- ── BrandSettings approval gate ───────────────────────────────────
ALTER TABLE "BrandSettings" ADD COLUMN IF NOT EXISTS "requireApprovalForPo" BOOLEAN NOT NULL DEFAULT false;
