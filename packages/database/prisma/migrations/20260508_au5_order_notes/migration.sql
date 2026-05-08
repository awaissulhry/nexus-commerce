-- AU.5 — OrderNote: per-order operator notes.
--
-- Mirrors the CustomerNote pattern (FU.3) but pinned to the Order
-- instead of the Customer. Use cases:
--   - "Sendcloud parcel needs reweighing — declared 1kg, scale
--     showed 1.6kg" → log on the order before re-printing label
--   - "Buyer messaged about gift wrap" → log + flag for pack
--   - "Hold for fraud review until cardholder confirms" → pinned
--     internal warning visible to whoever picks up the order next
--
-- Distinct from CustomerNote: customer notes persist across all
-- their orders ("VIP — fast-track pack"), order notes are about
-- THIS order specifically.

CREATE TABLE IF NOT EXISTS "OrderNote" (
  "id"           TEXT         NOT NULL,
  "orderId"      TEXT         NOT NULL,
  "body"         TEXT         NOT NULL,
  "authorUserId" TEXT,
  "authorEmail"  TEXT,
  "pinned"       BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderNote_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "OrderNote_orderId_idx" ON "OrderNote"("orderId");
CREATE INDEX IF NOT EXISTS "OrderNote_createdAt_idx" ON "OrderNote"("createdAt");
