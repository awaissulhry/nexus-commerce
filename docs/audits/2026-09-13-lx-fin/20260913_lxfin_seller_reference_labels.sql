-- R-LX-24 (on LX.R's R-LX-12) — the seller-owned reference-label cache.
--
-- Authored OUTSIDE `packages/database/prisma/migrations/` on purpose (PES.0 ruling #12: a lane does not
-- put a migration folder in the deploy path; `prisma migrate deploy` drags PARKED folders —
-- `reference_migrate_deploy_drags_parked_migrations`). Applied to LOCAL only, with
-- `current_database()` asserted first. The prod apply is the Owner's.
--
-- ADDITIVE AND REVERSIBLE. One new table, nothing altered, no backfill and no data dependency: every row
-- is DERIVED from a provider answer, so an empty table behaves exactly as today (the cold page load shows
-- the raw option id and the wire says `sellerTemplates: 'cache-miss'`). `DROP TABLE
-- "SellerReferenceLabel";` is a complete rollback.
--
-- WHY THE UNIQUE KEY CARRIES `connectionId`: seller templates belong to the seller. Naming account B's
-- templates from account A's definition is the defect `isPrimaryChannelConnection` already refuses in
-- `reference-labels.service.ts`, and a cache keyed without the connection would reintroduce it silently
-- and durably.
--
-- `workspaceId` has the same generated default as every other business table here, so a row written
-- inside a request lands in the caller's workspace without the service naming it.
--
-- ── LOCAL apply, 2026-09-13 ─────────────────────────────────────────────────────────────────────────
--   npx prisma db execute --url "<apps/api/.env DATABASE_URL>" \
--     --file docs/audits/2026-09-13-lx-fin/20260913_lxfin_seller_reference_labels.sql
-- ── PROD apply (the Owner's word only) ──────────────────────────────────────────────────────────────
--   Same SQL, against Neon with `-pooler` stripped from the host (`reference_neon_migrations`), then
--   `npx prisma generate` on the deploy. No downtime: nothing reads the table until the deploy that
--   ships the service change, and that code treats an empty table as today's behaviour.

CREATE TABLE IF NOT EXISTS "SellerReferenceLabel" (
  "workspaceId"  TEXT NOT NULL DEFAULT NULLIF(current_setting('nexus.workspace_id', true), ''),
  "id"           TEXT NOT NULL,
  "channel"      TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "marketplace"  TEXT NOT NULL,
  "productType"  TEXT NOT NULL,
  "fieldKey"     TEXT NOT NULL,
  "labels"       JSONB NOT NULL,
  "fetchedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerReferenceLabel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SellerReferenceLabel_channel_connection_market_type_field_uq"
  ON "SellerReferenceLabel" ("workspaceId", "channel", "connectionId", "marketplace", "productType", "fieldKey");

CREATE INDEX IF NOT EXISTS "SellerReferenceLabel_workspaceId_idx"
  ON "SellerReferenceLabel" ("workspaceId");
