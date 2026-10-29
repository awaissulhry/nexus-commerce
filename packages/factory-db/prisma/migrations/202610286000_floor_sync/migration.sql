-- CreateEnum
CREATE TYPE "FloorSyncOutcome" AS ENUM ('ACCEPTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "FloorRefusalStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "FloorDiscardAudience" AS ENUM ('FLOOR', 'OFFICE');

-- CreateTable
CREATE TABLE "FloorSyncEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "deviceSeq" INTEGER NOT NULL,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL,
    "clockSkewSeconds" INTEGER,
    "outcome" "FloorSyncOutcome" NOT NULL,
    "resultType" TEXT NOT NULL,
    "resultId" UUID NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloorSyncEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorRefusedAction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "deviceSeq" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "fix" TEXT NOT NULL,
    "final" BOOLEAN NOT NULL,
    "summary" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "moduleRefusalType" TEXT,
    "moduleRefusalId" UUID,
    "workerId" UUID,
    "stationId" UUID,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL,
    "status" "FloorRefusalStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedByEventId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "discardedAt" TIMESTAMPTZ(3),
    "discardedById" UUID,
    "discardedBy" "FloorDiscardAudience",
    "discardReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FloorRefusedAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorSyncEvent_tenantId_deviceId_serverTime_idx" ON "FloorSyncEvent"("tenantId", "deviceId", "serverTime");

-- CreateIndex
CREATE UNIQUE INDEX "FloorSyncEvent_tenantId_deviceId_clientEventId_key" ON "FloorSyncEvent"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorSyncEvent_tenantId_siteId_id_key" ON "FloorSyncEvent"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "FloorRefusedAction_tenantId_siteId_status_idx" ON "FloorRefusedAction"("tenantId", "siteId", "status");

-- CreateIndex
CREATE INDEX "FloorRefusedAction_tenantId_deviceId_status_idx" ON "FloorRefusedAction"("tenantId", "deviceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FloorRefusedAction_tenantId_deviceId_clientEventId_code_key" ON "FloorRefusedAction"("tenantId", "deviceId", "clientEventId", "code");

-- AddForeignKey
ALTER TABLE "FloorSyncEvent" ADD CONSTRAINT "FloorSyncEvent_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorRefusedAction" ADD CONSTRAINT "FloorRefusedAction_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorRefusedAction" ADD CONSTRAINT "FloorRefusedAction_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorRefusedAction" ADD CONSTRAINT "FloorRefusedAction_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorRefusedAction" ADD CONSTRAINT "FloorRefusedAction_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorRefusedAction" ADD CONSTRAINT "FloorRefusedAction_tenantId_siteId_resolvedByEventId_fkey" FOREIGN KEY ("tenantId", "siteId", "resolvedByEventId") REFERENCES "FloorSyncEvent"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

