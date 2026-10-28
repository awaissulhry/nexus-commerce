-- CreateEnum
CREATE TYPE "NumberKind" AS ENUM ('QUOTE', 'SALES_ORDER', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'WORK_ORDER', 'SHIPMENT', 'DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'RETURN', 'LOT', 'BATCH');

-- CreateEnum
CREATE TYPE "NumberReset" AS ENUM ('YEARLY', 'NEVER');

-- CreateEnum
CREATE TYPE "NumberSeriesStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "NumberSeries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "kind" "NumberKind" NOT NULL,
    "code" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "reset" "NumberReset" NOT NULL,
    "pattern" TEXT NOT NULL,
    "fiscal" BOOLEAN NOT NULL,
    "startValue" INTEGER NOT NULL DEFAULT 1,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "lastIssuedDate" DATE,
    "status" "NumberSeriesStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "NumberSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberAllocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "seriesId" UUID NOT NULL,
    "kind" "NumberKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "formatted" TEXT NOT NULL,
    "documentDate" DATE NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "allocatedAt" TIMESTAMPTZ(3) NOT NULL,
    "allocatedById" UUID NOT NULL,
    "requestId" TEXT NOT NULL,

    CONSTRAINT "NumberAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NumberSeries_tenantId_companyId_kind_code_scopeKey_key" ON "NumberSeries"("tenantId", "companyId", "kind", "code", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "NumberSeries_tenantId_companyId_id_key" ON "NumberSeries"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "NumberAllocation_tenantId_seriesId_value_idx" ON "NumberAllocation"("tenantId", "seriesId", "value");

-- CreateIndex
CREATE UNIQUE INDEX "NumberAllocation_tenantId_seriesId_formatted_key" ON "NumberAllocation"("tenantId", "seriesId", "formatted");

-- CreateIndex
CREATE UNIQUE INDEX "NumberAllocation_tenantId_recordType_recordId_kind_key" ON "NumberAllocation"("tenantId", "recordType", "recordId", "kind");

-- AddForeignKey
ALTER TABLE "NumberSeries" ADD CONSTRAINT "NumberSeries_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NumberAllocation" ADD CONSTRAINT "NumberAllocation_tenantId_companyId_seriesId_fkey" FOREIGN KEY ("tenantId", "companyId", "seriesId") REFERENCES "NumberSeries"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

