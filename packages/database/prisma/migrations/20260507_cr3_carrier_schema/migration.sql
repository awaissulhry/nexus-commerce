-- CR.3 — Carrier domain schema expansion.
--
-- Adds connection-health + multi-account + sandbox-vs-production
-- columns to the existing Carrier table, and four new tables that
-- replace the opaque defaultServiceMap JSON, cache per-carrier
-- performance, and persist pickup schedules.
--
-- All adds are idempotent (ADD COLUMN IF NOT EXISTS / CREATE TABLE
-- IF NOT EXISTS) so a re-run is a no-op. Pattern matches D.1's enum
-- widening + O.36's column adds.
--
-- No data migration: the new columns default sensibly (mode='sandbox',
-- nullable timestamps) and the new tables start empty. CR.7 backfills
-- CarrierServiceMapping from defaultServiceMap; CR.12 syncs
-- CarrierService from Sendcloud /shipping_methods; CR.15 + CR.16
-- populate CarrierMetric + PickupSchedule incrementally.

-- ── 1. Extend Carrier ───────────────────────────────────────────────
ALTER TABLE "Carrier" ADD COLUMN IF NOT EXISTS "lastUsedAt"     TIMESTAMP(3);
ALTER TABLE "Carrier" ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Carrier" ADD COLUMN IF NOT EXISTS "lastErrorAt"    TIMESTAMP(3);
ALTER TABLE "Carrier" ADD COLUMN IF NOT EXISTS "lastError"      TEXT;
ALTER TABLE "Carrier" ADD COLUMN IF NOT EXISTS "accountLabel"   TEXT;
ALTER TABLE "Carrier" ADD COLUMN IF NOT EXISTS "mode"           TEXT NOT NULL DEFAULT 'sandbox';
ALTER TABLE "Carrier" ADD COLUMN IF NOT EXISTS "webhookSecret"  TEXT;

CREATE INDEX IF NOT EXISTS "Carrier_isActive_idx"   ON "Carrier" ("isActive");
CREATE INDEX IF NOT EXISTS "Carrier_lastUsedAt_idx" ON "Carrier" ("lastUsedAt");

-- ── 2. CarrierService — per-carrier service catalog ───────────────
CREATE TABLE IF NOT EXISTS "CarrierService" (
  "id"               TEXT PRIMARY KEY,
  "carrierId"        TEXT NOT NULL,
  "externalId"       TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "carrierSubName"   TEXT,
  "tier"             TEXT,
  "minWeightG"       INTEGER,
  "maxWeightG"       INTEGER,
  "countriesJson"    JSONB,
  "capabilitiesJson" JSONB,
  "basePriceCents"   INTEGER,
  "currencyCode"     TEXT DEFAULT 'EUR',
  "isActive"         BOOLEAN NOT NULL DEFAULT TRUE,
  "syncedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CarrierService_carrierId_fkey"
    FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierService_carrierId_externalId_key"
  ON "CarrierService" ("carrierId", "externalId");
CREATE INDEX IF NOT EXISTS "CarrierService_carrierId_isActive_idx"
  ON "CarrierService" ("carrierId", "isActive");
CREATE INDEX IF NOT EXISTS "CarrierService_tier_idx"
  ON "CarrierService" ("tier");

-- ── 3. CarrierServiceMapping — channel × marketplace × warehouse → service ──
CREATE TABLE IF NOT EXISTS "CarrierServiceMapping" (
  "id"            TEXT PRIMARY KEY,
  "carrierId"     TEXT NOT NULL,
  "serviceId"     TEXT NOT NULL,
  "channel"       TEXT NOT NULL,
  "marketplace"   TEXT NOT NULL DEFAULT 'GLOBAL',
  "warehouseId"   TEXT,
  "tierOverride"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CarrierServiceMapping_carrierId_fkey"
    FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE,
  CONSTRAINT "CarrierServiceMapping_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "CarrierService"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "CarrierServiceMapping_carrierId_idx"
  ON "CarrierServiceMapping" ("carrierId");
CREATE INDEX IF NOT EXISTS "CarrierServiceMapping_channel_marketplace_idx"
  ON "CarrierServiceMapping" ("channel", "marketplace");
CREATE INDEX IF NOT EXISTS "CarrierServiceMapping_warehouseId_idx"
  ON "CarrierServiceMapping" ("warehouseId");

-- Partial unique: warehouseId is nullable, so we model the "exact"
-- and "any-warehouse" tuples as separate unique constraints. Prisma
-- doesn't express this; runs in raw SQL only.
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierServiceMapping_unique_with_warehouse"
  ON "CarrierServiceMapping" ("carrierId", "channel", "marketplace", "warehouseId")
  WHERE "warehouseId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierServiceMapping_unique_no_warehouse"
  ON "CarrierServiceMapping" ("carrierId", "channel", "marketplace")
  WHERE "warehouseId" IS NULL;

-- ── 4. CarrierMetric — denormalized perf cache ────────────────────
CREATE TABLE IF NOT EXISTS "CarrierMetric" (
  "id"                  TEXT PRIMARY KEY,
  "carrierId"           TEXT NOT NULL,
  "windowDays"          INTEGER NOT NULL,
  "shipmentCount"       INTEGER NOT NULL DEFAULT 0,
  "totalCostCents"      INTEGER NOT NULL DEFAULT 0,
  "avgCostCents"        INTEGER,
  "onTimeCount"         INTEGER NOT NULL DEFAULT 0,
  "lateCount"           INTEGER NOT NULL DEFAULT 0,
  "exceptionCount"      INTEGER NOT NULL DEFAULT 0,
  "medianDeliveryHours" DECIMAL(10, 2),
  "computedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CarrierMetric_carrierId_fkey"
    FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierMetric_carrierId_windowDays_key"
  ON "CarrierMetric" ("carrierId", "windowDays");
CREATE INDEX IF NOT EXISTS "CarrierMetric_carrierId_idx"
  ON "CarrierMetric" ("carrierId");

-- ── 5. PickupSchedule — one-time + recurring pickup bookings ─────
CREATE TABLE IF NOT EXISTS "PickupSchedule" (
  "id"              TEXT PRIMARY KEY,
  "carrierId"       TEXT NOT NULL,
  "warehouseId"     TEXT,
  "isRecurring"     BOOLEAN NOT NULL DEFAULT FALSE,
  "daysOfWeek"      INTEGER,
  "scheduledFor"    TIMESTAMP(3),
  "windowStart"     TEXT,
  "windowEnd"       TEXT,
  "contactName"     TEXT,
  "contactPhone"    TEXT,
  "notes"           TEXT,
  "externalRef"     TEXT,
  "status"          TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastDispatchAt"  TIMESTAMP(3),
  "lastDispatchErr" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PickupSchedule_carrierId_fkey"
    FOREIGN KEY ("carrierId") REFERENCES "Carrier"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "PickupSchedule_carrierId_status_idx"
  ON "PickupSchedule" ("carrierId", "status");
CREATE INDEX IF NOT EXISTS "PickupSchedule_warehouseId_idx"
  ON "PickupSchedule" ("warehouseId");
