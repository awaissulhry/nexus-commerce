-- R3.2 — per-item disposition routing.
--
-- Three nullable columns + indexes:
--
--   Warehouse.kind      — enum-as-string. Values:
--                           PRIMARY        — the default sellable pool
--                           SECOND_QUALITY — light-damage / open-box pool
--                           REFURBISH      — items awaiting refurbish
--                           QUARANTINE     — held for further review
--                         A null `kind` means "not classified" and the
--                         restock router treats it as PRIMARY for back-
--                         compat with the existing single-warehouse
--                         setup.
--
--   ReturnItem.disposition — operator's decision per item. Values:
--                              SELLABLE       — restock to PRIMARY
--                              SECOND_QUALITY — restock to SECOND_QUALITY
--                              REFURBISH      — restock to REFURBISH
--                              QUARANTINE     — hold pool
--                              SCRAP          — write-off, no restock
--                            Null until the operator decides.
--
--   ReturnItem.scrapReason — free text, required by the UI when
--                            disposition=SCRAP (DB allows null so
--                            partial saves don't fail).
--
-- All adds are idempotent.

ALTER TABLE "Warehouse"
  ADD COLUMN IF NOT EXISTS "kind" TEXT;

CREATE INDEX IF NOT EXISTS "Warehouse_kind_idx"
  ON "Warehouse" ("kind");

ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "disposition" TEXT;

ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "scrapReason" TEXT;

CREATE INDEX IF NOT EXISTS "ReturnItem_disposition_idx"
  ON "ReturnItem" ("disposition");
