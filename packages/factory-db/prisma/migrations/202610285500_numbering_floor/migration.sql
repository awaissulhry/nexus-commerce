-- CreateEnum
CREATE TYPE "NumberBlockPurpose" AS ENUM ('ONLINE', 'DEVICE');

-- CreateEnum
CREATE TYPE "NumberBlockStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'BUNDLE';
ALTER TYPE "NumberKind" ADD VALUE 'HIDE';
ALTER TYPE "NumberKind" ADD VALUE 'GARMENT_SERIAL';

-- CreateTable
CREATE TABLE "NumberBlock" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "kind" "NumberKind" NOT NULL,
    "purpose" "NumberBlockPurpose" NOT NULL,
    "fromRef" INTEGER NOT NULL,
    "toRef" INTEGER NOT NULL,
    "deviceId" UUID,
    "status" "NumberBlockStatus" NOT NULL DEFAULT 'ACTIVE',
    "closedReason" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "requestId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NumberBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberBlockUse" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "blockId" UUID NOT NULL,
    "kind" "NumberKind" NOT NULL,
    "ref" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "usedAt" TIMESTAMPTZ(3) NOT NULL,
    "requestId" TEXT NOT NULL,

    CONSTRAINT "NumberBlockUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NumberBlock_tenantId_deviceId_kind_idx" ON "NumberBlock"("tenantId", "deviceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "NumberBlock_tenantId_kind_fromRef_key" ON "NumberBlock"("tenantId", "kind", "fromRef");

-- CreateIndex
CREATE UNIQUE INDEX "NumberBlock_tenantId_kind_toRef_key" ON "NumberBlock"("tenantId", "kind", "toRef");

-- CreateIndex
CREATE UNIQUE INDEX "NumberBlock_tenantId_id_key" ON "NumberBlock"("tenantId", "id");

-- CreateIndex
CREATE INDEX "NumberBlockUse_tenantId_blockId_idx" ON "NumberBlockUse"("tenantId", "blockId");

-- CreateIndex
CREATE INDEX "NumberBlockUse_tenantId_siteId_deviceId_idx" ON "NumberBlockUse"("tenantId", "siteId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "NumberBlockUse_tenantId_code_key" ON "NumberBlockUse"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "NumberBlockUse" ADD CONSTRAINT "NumberBlockUse_tenantId_blockId_fkey" FOREIGN KEY ("tenantId", "blockId") REFERENCES "NumberBlock"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NumberBlockUse" ADD CONSTRAINT "NumberBlockUse_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

