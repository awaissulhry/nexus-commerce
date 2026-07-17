-- EPQ.4 — structured cost model. Additive only; authored from `prisma migrate
-- diff` output and hand-shaped to a plain ADD COLUMN (the diff proposes table
-- rebuilds for column adds, which take a long write lock while the Owner's
-- server runs; end state verified identical with `migrate diff --exit-code`).
-- NOT applied here — the merging session runs `prisma migrate dev` after the
-- Owner's dev server is restarted, per PLAYBOOK trap 6b.

-- AlterTable (EPQ.4 — labor hours per garment; NULL = not modeled = dormant)
ALTER TABLE "ProductTemplate" ADD COLUMN "laborHours" REAL;

-- CreateTable (EPQ.4 — leather m² per style×size + wastage %; no rows = the
-- template composes cost exactly as before)
CREATE TABLE "TemplateConsumption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "sizeKey" TEXT,
    "leatherSqm" REAL NOT NULL,
    "wastagePct" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "TemplateConsumption_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProductTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TemplateConsumption_templateId_sizeKey_key" ON "TemplateConsumption"("templateId", "sizeKey");
