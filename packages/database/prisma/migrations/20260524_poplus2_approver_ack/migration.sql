-- PO-Plus.2 — approver-side ack token + expiry, parallel to PO.1's
-- supplier ack columns. Used by /po/approve/:token public route to
-- let an approver click "Approve" without app login when a PO crosses
-- the value threshold and stops at REVIEW.

ALTER TABLE "PurchaseOrder"
  ADD COLUMN "approverAckToken"     TEXT,
  ADD COLUMN "approverAckExpiresAt" TIMESTAMP(3);

-- Token is globally unique. Partial-where-not-null mirrors the
-- supplierAckToken index so the vast majority of POs (which never
-- mint an approver token) stay outside the unique index.
CREATE UNIQUE INDEX "PurchaseOrder_approverAckToken_key"
  ON "PurchaseOrder"("approverAckToken")
  WHERE "approverAckToken" IS NOT NULL;
