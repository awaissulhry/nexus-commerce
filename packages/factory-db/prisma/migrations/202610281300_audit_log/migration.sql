-- CreateEnum
CREATE TYPE "AuditAudience" AS ENUM ('OFFICE', 'FLOOR', 'PARTNER', 'LINK', 'SYSTEM');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "siteId" UUID,
    "partyId" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceTime" TIMESTAMPTZ(3),
    "audience" "AuditAudience" NOT NULL,
    "actorId" UUID NOT NULL,
    "deviceId" UUID,
    "action" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "requestId" TEXT NOT NULL,
    "idempotencyKey" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyReceipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID,
    "partyId" UUID,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "actorId" UUID NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_recordType_recordId_at_idx" ON "AuditLog"("tenantId", "recordType", "recordId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyReceipt_tenantId_scope_key_key" ON "IdempotencyReceipt"("tenantId", "scope", "key");
