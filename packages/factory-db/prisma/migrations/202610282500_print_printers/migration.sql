-- CreateEnum
CREATE TYPE "PrinterKind" AS ENUM ('LABEL_ZPL', 'A4_PDF');

-- CreateEnum
CREATE TYPE "PrintRelay" AS ENUM ('FAKE');

-- CreateEnum
CREATE TYPE "PrinterStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PrintPayloadKind" AS ENUM ('ZPL', 'PDF');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('QUEUED', 'SENT', 'PRINTED', 'FAILED');

-- CreateTable
CREATE TABLE "Printer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PrinterKind" NOT NULL,
    "relay" "PrintRelay" NOT NULL,
    "relayTarget" TEXT NOT NULL,
    "dpi" INTEGER,
    "labelWidthMm" INTEGER,
    "labelHeightMm" INTEGER,
    "status" "PrinterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintJob" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "printerId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "payloadKind" "PrintPayloadKind" NOT NULL,
    "labelKind" TEXT,
    "scanId" TEXT,
    "zpl" TEXT,
    "fileId" UUID,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "relayJobId" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "printedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "requestedById" UUID,
    "deviceId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Printer_tenantId_siteId_code_key" ON "Printer"("tenantId", "siteId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Printer_tenantId_companyId_siteId_id_key" ON "Printer"("tenantId", "companyId", "siteId", "id");

-- CreateIndex
CREATE INDEX "PrintJob_tenantId_printerId_status_idx" ON "PrintJob"("tenantId", "printerId", "status");

-- CreateIndex
CREATE INDEX "PrintJob_tenantId_recordType_recordId_idx" ON "PrintJob"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "PrintJob_tenantId_siteId_createdAt_idx" ON "PrintJob"("tenantId", "siteId", "createdAt");

-- AddForeignKey
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_tenantId_companyId_siteId_printerId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "printerId") REFERENCES "Printer"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

