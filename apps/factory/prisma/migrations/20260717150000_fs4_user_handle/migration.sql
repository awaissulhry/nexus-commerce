-- FS4 — mention hot path (S-10). Additive only; shaped from `prisma migrate
-- diff --script` output to a plain ADD COLUMN (the diff proposes a table
-- rebuild, which takes a long write lock while the Owner's server runs; end
-- state is identical). NOT applied by the authoring session — the merging
-- session runs `prisma migrate dev` after the Owner's dev server restarts,
-- per PLAYBOOK trap 6b.

-- AlterTable (FS4 — User.handle: nullable @mention key)
ALTER TABLE "User" ADD COLUMN "handle" TEXT;

-- Backfill 1/3: derive first.last from the display name (trim · lower ·
-- whitespace→dots — the exact rule of src/lib/auth/handle.ts deriveHandle and
-- the FS3 client's handleFor, so already-inserted mentions resolve). Tabs/
-- newlines fold to spaces first; the repeated '..'→'.' passes collapse
-- whitespace RUNS the way the app's \s+ does (each pass halves a run — three
-- passes cover any name a human typed).
UPDATE "User" SET "handle" = lower(replace(replace(replace(trim("displayName"), char(9), ' '), char(10), ' '), char(13), ' '));
UPDATE "User" SET "handle" = replace("handle", ' ', '.');
UPDATE "User" SET "handle" = replace("handle", '..', '.') WHERE "handle" LIKE '%..%';
UPDATE "User" SET "handle" = replace("handle", '..', '.') WHERE "handle" LIKE '%..%';
UPDATE "User" SET "handle" = replace("handle", '..', '.') WHERE "handle" LIKE '%..%';

-- Backfill 2/3: empty names derive nothing (unique index ignores NULLs).
UPDATE "User" SET "handle" = NULL WHERE "handle" = '';

-- Backfill 3/3: collision suffixes in first-come order — the earliest user
-- (createdAt, id) keeps the bare handle; later twins become handle-2, -3…
-- (mirrors src/lib/auth/handle.ts uniqueHandle).
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "handle" ORDER BY "createdAt", "id") AS rn
  FROM "User"
  WHERE "handle" IS NOT NULL
)
UPDATE "User"
SET "handle" = "handle" || '-' || ranked.rn
FROM ranked
WHERE ranked."id" = "User"."id" AND ranked.rn > 1;

-- CreateIndex (after the backfill so pre-existing twins cannot violate it)
CREATE UNIQUE INDEX "User_handle_key" ON "User"("handle");
