-- Sheet publish parity (2026-10-02; plan docs/sheet-publish-parity/PLAN.md, step 1).
--
-- A publish history must list, filter and sort studio publications by product, destination and result, and a
-- result sweep must find the publications still waiting for one. Until now those facts lived only inside
-- BulkOperation.changes JSON, which no index serves and which a list must not load (it holds the whole change plan).
--
-- (1) Additive only: eleven nullable columns on an existing business-owned table, and four indexes. No policy
--     change (the table's row-level security covers every column). Nothing existing is read differently.
-- (2) A one-time fill of the new columns for the studio publications made before today, from their own `changes`
--     JSON. `nextCheckAt` and `checkCount` are deliberately left null on every existing row: a null is never swept,
--     so the result sweep (step 2) cannot settle an old publication — and send its held prices — unwatched.
--     The fill is idempotent: it only writes rows whose `kind` is still null.

-- AlterTable
ALTER TABLE "BulkOperation" ADD COLUMN IF NOT EXISTS "aliasKey" TEXT,
ADD COLUMN IF NOT EXISTS "batchId" TEXT,
ADD COLUMN IF NOT EXISTS "channel" TEXT,
ADD COLUMN IF NOT EXISTS "channelConnectionId" TEXT,
ADD COLUMN IF NOT EXISTS "checkCount" INTEGER,
ADD COLUMN IF NOT EXISTS "kind" TEXT,
ADD COLUMN IF NOT EXISTS "marketplace" TEXT,
ADD COLUMN IF NOT EXISTS "nextCheckAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "productId" TEXT,
ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "summary" JSONB;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BulkOperation_workspaceId_kind_createdAt_idx" ON "BulkOperation"("workspaceId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BulkOperation_workspaceId_kind_productId_createdAt_idx" ON "BulkOperation"("workspaceId", "kind", "productId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BulkOperation_workspaceId_batchId_idx" ON "BulkOperation"("workspaceId", "batchId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BulkOperation_kind_status_nextCheckAt_idx" ON "BulkOperation"("kind", "status", "nextCheckAt");

-- Fill: the destination from `changes.scope`; the family from the product the studio opened (its parent when it is a
-- variation); the alias from the submitted delivery, else from the listing the review named, else the primary ('')
-- when the review named no listing. `submittedAt` is the send's own `startedAt`. `summary` counts the stored
-- result per SKU status, as studio-publication.service.ts `publicationSummary` does (the counts are disjoint).
UPDATE "BulkOperation" b
   SET "kind" = 'studio-publication',
       "productId" = COALESCE(
         (SELECT COALESCE(p."parentId", p.id) FROM "Product" p WHERE p.id = b.changes->>'productId'),
         b.changes->>'productId'),
       "channel" = b.changes->'scope'->>'channel',
       "marketplace" = b.changes->'scope'->>'marketplace',
       "channelConnectionId" = b.changes->'scope'->>'accountId',
       "aliasKey" = COALESCE(
         b.changes->'delivery'->>'aliasKey',
         (SELECT cl."aliasKey" FROM "ChannelListing" cl WHERE cl.id = b.changes->'scope'->>'listingId'),
         CASE WHEN b.changes->'scope'->>'listingId' IS NULL THEN '' END),
       "submittedAt" = CASE WHEN b.changes->>'startedAt' IS NOT NULL THEN (b.changes->>'startedAt')::timestamptz AT TIME ZONE 'UTC' END,
       "summary" = CASE WHEN jsonb_typeof(b.changes->'result') = 'object' THEN jsonb_build_object(
         'message', b.changes->'result'->>'message',
         'products', COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(b.changes->'result'->'results') = 'array' THEN b.changes->'result'->'results' END), 0),
         'accepted', (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.changes->'result'->'results') = 'array' THEN b.changes->'result'->'results' ELSE '[]'::jsonb END) r WHERE r->>'status' = 'ACCEPTED'),
         'verified', (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.changes->'result'->'results') = 'array' THEN b.changes->'result'->'results' ELSE '[]'::jsonb END) r WHERE r->>'status' = 'VERIFIED'),
         'failed', (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.changes->'result'->'results') = 'array' THEN b.changes->'result'->'results' ELSE '[]'::jsonb END) r WHERE r->>'status' = 'FAILED'),
         'submitted', (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.changes->'result'->'results') = 'array' THEN b.changes->'result'->'results' ELSE '[]'::jsonb END) r WHERE r->>'status' = 'SUBMITTED')
       ) END
 WHERE b."kind" IS NULL
   AND jsonb_typeof(b.changes) = 'object'
   AND b.changes->>'kind' = 'studio-publication';
