-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('SES', 'R2', 'SDI', 'SENDCLOUD', 'VIES');

-- CreateEnum
CREATE TYPE "IntegrationMode" AS ENUM ('LIVE', 'SANDBOX', 'FAKE');

-- CreateEnum
CREATE TYPE "IntegrationAccountStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "IntegrationCallStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REFUSED');

-- CreateEnum
CREATE TYPE "InboundStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "IntegrationAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "provider" "IntegrationProvider" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mode" "IntegrationMode" NOT NULL,
    "status" "IntegrationAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "credentialsSecretId" UUID,
    "webhookSecretId" UUID,
    "settings" JSONB,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "rateLimitBurst" INTEGER NOT NULL DEFAULT 10,
    "callTimeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "circuitFailureThreshold" INTEGER NOT NULL DEFAULT 5,
    "circuitCooldownSeconds" INTEGER NOT NULL DEFAULT 60,
    "lastOkAt" TIMESTAMPTZ(3),
    "lastErrorAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "IntegrationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretValue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "purpose" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "wrappedKey" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMPTZ(3),
    "createdById" UUID,

    CONSTRAINT "SecretValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCall" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "accountId" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "mode" "IntegrationMode" NOT NULL,
    "operation" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL,
    "status" "IntegrationCallStatus" NOT NULL,
    "reason" TEXT,
    "httpStatus" INTEGER,
    "requestSummary" JSONB,
    "responseSummary" JSONB,
    "error" TEXT,

    CONSTRAINT "IntegrationCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundWebhook" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "accountId" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "dedupeKey" TEXT,
    "externalId" TEXT,
    "eventType" TEXT,
    "bodySha256" TEXT NOT NULL,
    "bodyBytes" INTEGER NOT NULL,
    "contentType" TEXT,
    "body" TEXT,
    "rejectReason" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" "InboundStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,

    CONSTRAINT "InboundWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationAccount_tenantId_provider_idx" ON "IntegrationAccount"("tenantId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAccount_tenantId_code_key" ON "IntegrationAccount"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAccount_tenantId_id_key" ON "IntegrationAccount"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SecretValue_tenantId_id_key" ON "SecretValue"("tenantId", "id");

-- CreateIndex
CREATE INDEX "IntegrationCall_tenantId_accountId_startedAt_idx" ON "IntegrationCall"("tenantId", "accountId", "startedAt");

-- CreateIndex
CREATE INDEX "IntegrationCall_tenantId_status_startedAt_idx" ON "IntegrationCall"("tenantId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "InboundWebhook_tenantId_status_receivedAt_idx" ON "InboundWebhook"("tenantId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundWebhook_tenantId_provider_dedupeKey_key" ON "InboundWebhook"("tenantId", "provider", "dedupeKey");

-- AddForeignKey
ALTER TABLE "IntegrationAccount" ADD CONSTRAINT "IntegrationAccount_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IntegrationAccount" ADD CONSTRAINT "IntegrationAccount_tenantId_credentialsSecretId_fkey" FOREIGN KEY ("tenantId", "credentialsSecretId") REFERENCES "SecretValue"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "IntegrationAccount" ADD CONSTRAINT "IntegrationAccount_tenantId_webhookSecretId_fkey" FOREIGN KEY ("tenantId", "webhookSecretId") REFERENCES "SecretValue"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

