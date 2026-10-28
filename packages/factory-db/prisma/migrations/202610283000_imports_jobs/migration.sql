-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PLANNED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportMode" AS ENUM ('DRY_RUN', 'APPLY');

-- CreateEnum
CREATE TYPE "ImportRowAction" AS ENUM ('CREATE', 'UPDATE', 'UNCHANGED', 'ERROR');

-- CreateEnum
CREATE TYPE "ImportRowOutcome" AS ENUM ('APPLIED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "importerKey" TEXT NOT NULL,
    "fileId" UUID NOT NULL,
    "sheetName" TEXT,
    "encoding" TEXT,
    "numberFormat" TEXT NOT NULL DEFAULT 'it',
    "mapping" JSONB,
    "layout" JSONB,
    "grains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "mode" "ImportMode" NOT NULL DEFAULT 'DRY_RUN',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createCount" INTEGER NOT NULL DEFAULT 0,
    "updateCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "issues" JSONB,
    "error" TEXT,
    "plannedAt" TIMESTAMPTZ(3),
    "applyRequestedAt" TIMESTAMPTZ(3),
    "applyRequestedById" UUID,
    "appliedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "jobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "action" "ImportRowAction" NOT NULL,
    "key" TEXT,
    "recordId" UUID,
    "errors" JSONB,
    "before" JSONB,
    "after" JSONB,
    "outcome" "ImportRowOutcome",
    "note" TEXT,
    "appliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_tenantId_companyId_createdAt_idx" ON "ImportJob"("tenantId", "companyId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_tenantId_fileId_idx" ON "ImportJob"("tenantId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportJob_tenantId_id_key" ON "ImportJob"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ImportRow_tenantId_jobId_action_appliedAt_idx" ON "ImportRow"("tenantId", "jobId", "action", "appliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_tenantId_jobId_rowNumber_key" ON "ImportRow"("tenantId", "jobId", "rowNumber");

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_tenantId_jobId_fkey" FOREIGN KEY ("tenantId", "jobId") REFERENCES "ImportJob"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

