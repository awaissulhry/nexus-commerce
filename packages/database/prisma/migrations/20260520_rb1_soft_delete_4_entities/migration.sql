-- RB.1 — Soft-delete (recycle bin) for Order, InboundShipment, Shipment, PurchaseOrder.
--
-- Mirrors the Product.deletedAt pattern shipped on 2026-05-08
-- (20260508_f1_product_soft_delete). Single nullable column, no
-- backfill needed; existing rows keep deletedAt = NULL = "live".
--
-- Index strategy per table: a single composite (status, deletedAt)
-- supports the hot path on every recycle-bin enabled list page
-- (live = WHERE deletedAt IS NULL AND status IN (...); bin = WHERE
-- deletedAt IS NOT NULL [optionally AND status IN (...)]).
--
-- The recycle bin is a UI hide, not a workflow state. CANCELLED is
-- and remains the workflow terminal state; deletedAt is orthogonal —
-- a CANCELLED order can also be in the bin, a DRAFT PO can be soft-
-- deleted without ever going to CANCELLED.

-- ── Order ────────────────────────────────────────────────────────────
ALTER TABLE "Order" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Order_status_deletedAt_idx" ON "Order"("status", "deletedAt");

-- ── Shipment (outbound) ──────────────────────────────────────────────
ALTER TABLE "Shipment" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Shipment_status_deletedAt_idx" ON "Shipment"("status", "deletedAt");

-- ── PurchaseOrder ────────────────────────────────────────────────────
ALTER TABLE "PurchaseOrder" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "PurchaseOrder_status_deletedAt_idx" ON "PurchaseOrder"("status", "deletedAt");

-- ── InboundShipment ──────────────────────────────────────────────────
ALTER TABLE "InboundShipment" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "InboundShipment_status_deletedAt_idx" ON "InboundShipment"("status", "deletedAt");
