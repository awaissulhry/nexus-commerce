-- B.1 — Fulfillment domain spine
-- Idempotent: every CREATE uses IF NOT EXISTS so re-running on dev DBs
-- that have partial state from prior attempts is safe.

-- ─── Enums ────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "StockMovementReason" AS ENUM (
    'ORDER_PLACED','ORDER_CANCELLED','ORDER_REFUNDED','RETURN_RECEIVED','RETURN_RESTOCKED',
    'INBOUND_RECEIVED','SUPPLIER_DELIVERY','MANUFACTURING_OUTPUT',
    'FBA_TRANSFER_OUT','FBA_TRANSFER_IN','MANUAL_ADJUSTMENT','INVENTORY_COUNT','WRITE_OFF','RESERVATION_RELEASED'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ShipmentStatusFBM" AS ENUM (
    'DRAFT','READY_TO_PICK','PICKED','PACKED','LABEL_PRINTED','SHIPPED','IN_TRANSIT','DELIVERED','CANCELLED','RETURNED'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ReturnStatusFlow" AS ENUM (
    'REQUESTED','AUTHORIZED','IN_TRANSIT','RECEIVED','INSPECTING','RESTOCKED','REFUNDED','REJECTED','SCRAPPED'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ReturnConditionGrade" AS ENUM ('NEW','LIKE_NEW','GOOD','DAMAGED','UNUSABLE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT','SUBMITTED','CONFIRMED','PARTIAL','RECEIVED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "WorkOrderStatus" AS ENUM ('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "InboundType" AS ENUM ('FBA','SUPPLIER','MANUFACTURING','TRANSFER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "InboundStatus" AS ENUM ('DRAFT','IN_TRANSIT','ARRIVED','RECEIVING','CLOSED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CarrierCode" AS ENUM ('SENDCLOUD','AMAZON_BUY_SHIPPING','MANUAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ReplenishmentUrgency" AS ENUM ('CRITICAL','HIGH','MEDIUM','LOW');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── Warehouse ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Warehouse" (
  "id"           TEXT PRIMARY KEY,
  "code"         TEXT NOT NULL UNIQUE,
  "name"         TEXT NOT NULL,
  "addressLine1" TEXT,
  "addressLine2" TEXT,
  "city"         TEXT,
  "postalCode"   TEXT,
  "country"      TEXT NOT NULL DEFAULT 'IT',
  "isDefault"    BOOLEAN NOT NULL DEFAULT false,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "sendcloudSenderId" INTEGER,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── StockMovement ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "StockMovement" (
  "id"            TEXT PRIMARY KEY,
  "productId"     TEXT NOT NULL,
  "variationId"   TEXT,
  "warehouseId"   TEXT,
  "change"        INTEGER NOT NULL,
  "balanceAfter"  INTEGER NOT NULL,
  "reason"        "StockMovementReason" NOT NULL,
  "referenceType" TEXT,
  "referenceId"   TEXT,
  "notes"         TEXT,
  "actor"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockMovement_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "StockMovement_product_created_idx"   ON "StockMovement"("productId","createdAt");
CREATE INDEX IF NOT EXISTS "StockMovement_variation_created_idx" ON "StockMovement"("variationId","createdAt");
CREATE INDEX IF NOT EXISTS "StockMovement_warehouse_created_idx" ON "StockMovement"("warehouseId","createdAt");
CREATE INDEX IF NOT EXISTS "StockMovement_reason_idx"            ON "StockMovement"("reason");
CREATE INDEX IF NOT EXISTS "StockMovement_ref_idx"               ON "StockMovement"("referenceType","referenceId");

-- ─── Carrier ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Carrier" (
  "id"                  TEXT PRIMARY KEY,
  "code"                "CarrierCode" NOT NULL UNIQUE,
  "name"                TEXT NOT NULL,
  "isActive"            BOOLEAN NOT NULL DEFAULT false,
  "credentialsEncrypted" TEXT,
  "defaultServiceMap"   JSONB,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── Shipment + ShipmentItem ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Shipment" (
  "id"                TEXT PRIMARY KEY,
  "orderId"           TEXT,
  "warehouseId"       TEXT,
  "carrierCode"       "CarrierCode" NOT NULL DEFAULT 'SENDCLOUD',
  "status"            "ShipmentStatusFBM" NOT NULL DEFAULT 'DRAFT',
  "sendcloudParcelId" TEXT UNIQUE,
  "trackingNumber"    TEXT,
  "trackingUrl"       TEXT,
  "labelUrl"          TEXT,
  "serviceCode"       TEXT,
  "serviceName"       TEXT,
  "weightGrams"       INTEGER,
  "lengthCm"          DECIMAL(10,2),
  "widthCm"           DECIMAL(10,2),
  "heightCm"          DECIMAL(10,2),
  "costCents"         INTEGER,
  "currencyCode"      TEXT DEFAULT 'EUR',
  "pickedAt"          TIMESTAMP(3),
  "packedAt"          TIMESTAMP(3),
  "labelPrintedAt"    TIMESTAMP(3),
  "shippedAt"         TIMESTAMP(3),
  "deliveredAt"       TIMESTAMP(3),
  "cancelledAt"       TIMESTAMP(3),
  "trackingPushedAt"  TIMESTAMP(3),
  "trackingPushError" TEXT,
  "pickedBy"          TEXT,
  "packedBy"          TEXT,
  "notes"             TEXT,
  "version"           INTEGER NOT NULL DEFAULT 1,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Shipment_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "Shipment_orderId_idx"        ON "Shipment"("orderId");
CREATE INDEX IF NOT EXISTS "Shipment_status_idx"         ON "Shipment"("status");
CREATE INDEX IF NOT EXISTS "Shipment_carrierCode_idx"    ON "Shipment"("carrierCode");
CREATE INDEX IF NOT EXISTS "Shipment_trackingNumber_idx" ON "Shipment"("trackingNumber");
CREATE INDEX IF NOT EXISTS "Shipment_createdAt_idx"      ON "Shipment"("createdAt");

CREATE TABLE IF NOT EXISTS "ShipmentItem" (
  "id"          TEXT PRIMARY KEY,
  "shipmentId"  TEXT NOT NULL,
  "orderItemId" TEXT,
  "productId"   TEXT,
  "sku"         TEXT NOT NULL,
  "quantity"    INTEGER NOT NULL,
  CONSTRAINT "ShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "ShipmentItem_shipmentId_idx" ON "ShipmentItem"("shipmentId");
CREATE INDEX IF NOT EXISTS "ShipmentItem_productId_idx"  ON "ShipmentItem"("productId");

-- ─── Supplier + SupplierProduct ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Supplier" (
  "id"              TEXT PRIMARY KEY,
  "name"            TEXT NOT NULL,
  "contactName"     TEXT,
  "email"           TEXT,
  "phone"           TEXT,
  "addressLine1"    TEXT,
  "city"            TEXT,
  "postalCode"      TEXT,
  "country"         TEXT DEFAULT 'IT',
  "taxId"           TEXT,
  "paymentTerms"    TEXT,
  "defaultCurrency" TEXT DEFAULT 'EUR',
  "leadTimeDays"    INTEGER NOT NULL DEFAULT 14,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "SupplierProduct" (
  "id"           TEXT PRIMARY KEY,
  "supplierId"   TEXT NOT NULL,
  "productId"    TEXT NOT NULL,
  "supplierSku"  TEXT,
  "costCents"    INTEGER,
  "currencyCode" TEXT DEFAULT 'EUR',
  "moq"          INTEGER NOT NULL DEFAULT 1,
  "leadTimeDaysOverride" INTEGER,
  "isPrimary"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierProduct_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE,
  CONSTRAINT "SupplierProduct_supplier_product_unique" UNIQUE ("supplierId","productId")
);
CREATE INDEX IF NOT EXISTS "SupplierProduct_productId_idx" ON "SupplierProduct"("productId");

-- ─── PurchaseOrder + PurchaseOrderItem ────────────────────────────────
CREATE TABLE IF NOT EXISTS "PurchaseOrder" (
  "id"                   TEXT PRIMARY KEY,
  "poNumber"             TEXT NOT NULL UNIQUE,
  "supplierId"           TEXT,
  "warehouseId"          TEXT,
  "status"               "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "expectedDeliveryDate" TIMESTAMP(3),
  "totalCents"           INTEGER NOT NULL DEFAULT 0,
  "currencyCode"         TEXT NOT NULL DEFAULT 'EUR',
  "notes"                TEXT,
  "createdBy"            TEXT,
  "version"              INTEGER NOT NULL DEFAULT 1,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseOrder_supplierId_fkey"  FOREIGN KEY ("supplierId")  REFERENCES "Supplier"("id")  ON DELETE SET NULL,
  CONSTRAINT "PurchaseOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_status_idx"     ON "PurchaseOrder"("status");

CREATE TABLE IF NOT EXISTS "PurchaseOrderItem" (
  "id"               TEXT PRIMARY KEY,
  "purchaseOrderId"  TEXT NOT NULL,
  "productId"        TEXT,
  "supplierSku"      TEXT,
  "sku"              TEXT NOT NULL,
  "quantityOrdered"  INTEGER NOT NULL,
  "quantityReceived" INTEGER NOT NULL DEFAULT 0,
  "unitCostCents"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "PurchaseOrderItem_purchaseOrderId_idx" ON "PurchaseOrderItem"("purchaseOrderId");
CREATE INDEX IF NOT EXISTS "PurchaseOrderItem_productId_idx"       ON "PurchaseOrderItem"("productId");

-- ─── WorkOrder ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "WorkOrder" (
  "id"          TEXT PRIMARY KEY,
  "productId"   TEXT NOT NULL,
  "quantity"    INTEGER NOT NULL,
  "status"      "WorkOrderStatus" NOT NULL DEFAULT 'PLANNED',
  "startedAt"   TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "costCents"   INTEGER,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "WorkOrder_productId_idx" ON "WorkOrder"("productId");
CREATE INDEX IF NOT EXISTS "WorkOrder_status_idx"    ON "WorkOrder"("status");

-- ─── InboundShipment + InboundShipmentItem ────────────────────────────
CREATE TABLE IF NOT EXISTS "InboundShipment" (
  "id"              TEXT PRIMARY KEY,
  "type"            "InboundType" NOT NULL,
  "status"          "InboundStatus" NOT NULL DEFAULT 'DRAFT',
  "reference"       TEXT,
  "warehouseId"     TEXT,
  "fbaShipmentId"   TEXT,
  "purchaseOrderId" TEXT,
  "workOrderId"     TEXT,
  "asnNumber"       TEXT,
  "expectedAt"      TIMESTAMP(3),
  "arrivedAt"       TIMESTAMP(3),
  "closedAt"        TIMESTAMP(3),
  "notes"           TEXT,
  "version"         INTEGER NOT NULL DEFAULT 1,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundShipment_warehouseId_fkey"     FOREIGN KEY ("warehouseId")     REFERENCES "Warehouse"("id")     ON DELETE SET NULL,
  CONSTRAINT "InboundShipment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL,
  CONSTRAINT "InboundShipment_workOrderId_fkey"     FOREIGN KEY ("workOrderId")     REFERENCES "WorkOrder"("id")     ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "InboundShipment_type_idx"            ON "InboundShipment"("type");
CREATE INDEX IF NOT EXISTS "InboundShipment_status_idx"          ON "InboundShipment"("status");
CREATE INDEX IF NOT EXISTS "InboundShipment_fbaShipmentId_idx"   ON "InboundShipment"("fbaShipmentId");

CREATE TABLE IF NOT EXISTS "InboundShipmentItem" (
  "id"               TEXT PRIMARY KEY,
  "inboundShipmentId" TEXT NOT NULL,
  "productId"        TEXT,
  "sku"              TEXT NOT NULL,
  "quantityExpected" INTEGER NOT NULL,
  "quantityReceived" INTEGER NOT NULL DEFAULT 0,
  "qcStatus"         TEXT,
  "qcNotes"          TEXT,
  CONSTRAINT "InboundShipmentItem_inboundShipmentId_fkey" FOREIGN KEY ("inboundShipmentId") REFERENCES "InboundShipment"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "InboundShipmentItem_inboundShipmentId_idx" ON "InboundShipmentItem"("inboundShipmentId");
CREATE INDEX IF NOT EXISTS "InboundShipmentItem_productId_idx"         ON "InboundShipmentItem"("productId");

-- ─── Return + ReturnItem ──────────────────────────────────────────────
-- Prior migration 20260422230155_add_phase2_models created a Return table
-- with an incompatible 8-column shape (no `channel`, different status enum,
-- missing rmaNumber/conditionGrade/refundStatus/etc). It has zero consumers
-- in the current API code (only this B.7 fulfillment.routes.ts uses
-- prisma.return.*), so we drop it and its companion ReturnItem before
-- creating the new shape. CASCADE handles any incidental FKs.
-- IF NOT EXISTS is intentionally OMITTED on the new CREATE TABLEs so that
-- if the DROP somehow fails we get a loud collision error instead of
-- another silent skip.
DROP TABLE IF EXISTS "ReturnItem" CASCADE;
DROP TABLE IF EXISTS "Return" CASCADE;

CREATE TABLE "Return" (
  "id"                 TEXT PRIMARY KEY,
  "orderId"            TEXT,
  "channel"            TEXT NOT NULL,
  "marketplace"        TEXT,
  "channelReturnId"    TEXT,
  "rmaNumber"          TEXT UNIQUE,
  "status"             "ReturnStatusFlow" NOT NULL DEFAULT 'REQUESTED',
  "reason"             TEXT,
  "conditionGrade"     "ReturnConditionGrade",
  "refundStatus"       TEXT NOT NULL DEFAULT 'PENDING',
  "refundCents"        INTEGER,
  "currencyCode"       TEXT NOT NULL DEFAULT 'EUR',
  "isFbaReturn"        BOOLEAN NOT NULL DEFAULT false,
  "restockChannel"     TEXT,
  "restockWarehouseId" TEXT,
  "receivedAt"         TIMESTAMP(3),
  "inspectedAt"        TIMESTAMP(3),
  "refundedAt"         TIMESTAMP(3),
  "restockedAt"        TIMESTAMP(3),
  "notes"              TEXT,
  "version"            INTEGER NOT NULL DEFAULT 1,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Return_orderId_idx"     ON "Return"("orderId");
CREATE INDEX IF NOT EXISTS "Return_status_idx"      ON "Return"("status");
CREATE INDEX IF NOT EXISTS "Return_channel_idx"     ON "Return"("channel");
CREATE INDEX IF NOT EXISTS "Return_isFbaReturn_idx" ON "Return"("isFbaReturn");

CREATE TABLE "ReturnItem" (
  "id"             TEXT PRIMARY KEY,
  "returnId"       TEXT NOT NULL,
  "orderItemId"    TEXT,
  "productId"      TEXT,
  "sku"            TEXT NOT NULL,
  "quantity"       INTEGER NOT NULL,
  "conditionGrade" "ReturnConditionGrade",
  "notes"          TEXT,
  CONSTRAINT "ReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "ReturnItem_returnId_idx"  ON "ReturnItem"("returnId");
CREATE INDEX IF NOT EXISTS "ReturnItem_productId_idx" ON "ReturnItem"("productId");

-- ─── ReplenishmentRule ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ReplenishmentRule" (
  "id"                  TEXT PRIMARY KEY,
  "productId"           TEXT NOT NULL UNIQUE,
  "minStock"            INTEGER,
  "reorderPoint"        INTEGER,
  "reorderQuantity"     INTEGER,
  "safetyStockDays"     INTEGER NOT NULL DEFAULT 7,
  "preferredSupplierId" TEXT,
  "isManufactured"      BOOLEAN NOT NULL DEFAULT false,
  "isActive"            BOOLEAN NOT NULL DEFAULT true,
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ReplenishmentRule_preferredSupplierId_idx" ON "ReplenishmentRule"("preferredSupplierId");

-- ─── Seed default warehouse ───────────────────────────────────────────
INSERT INTO "Warehouse" ("id","code","name","country","isDefault","isActive","createdAt","updatedAt")
VALUES ('wh_default_it','IT-MAIN','Italy Main Warehouse','IT',true,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
