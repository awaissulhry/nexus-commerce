-- CreateEnum
CREATE TYPE "StepUpResult" AS ENUM ('SUCCESS', 'WRONG_CODE', 'REUSED_CODE', 'LOCKED');

-- CreateEnum
CREATE TYPE "SecurityEventKind" AS ENUM ('SIGN_IN', 'SIGN_IN_FAILED', 'LOCKOUT', 'MFA_CHANGED', 'PERMISSION_DENIED', 'ROLE_CHANGED', 'API_KEY_USED', 'EXPORT', 'STEP_UP_LOCKED');

-- CreateEnum
CREATE TYPE "SecuritySurface" AS ENUM ('OFFICE', 'PORTAL', 'FLOOR', 'LINK', 'API', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ReadAction" AS ENUM ('VIEW', 'DOWNLOAD', 'EXPORT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SessionEndReason" ADD VALUE 'ENDED_BY_USER';
ALTER TYPE "SessionEndReason" ADD VALUE 'ENDED_BY_ADMIN';

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "archivedById" UUID;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "browser" TEXT,
ADD COLUMN     "deviceLabel" TEXT,
ADD COLUMN     "ipCity" TEXT,
ADD COLUMN     "ipCountry" TEXT;

-- CreateTable
CREATE TABLE "SecuritySettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "officeIdleMinutes" INTEGER NOT NULL DEFAULT 480,
    "officeLongestHours" INTEGER NOT NULL DEFAULT 168,
    "portalIdleMinutes" INTEGER NOT NULL DEFAULT 30,
    "portalLongestHours" INTEGER NOT NULL DEFAULT 12,
    "stepUpOff" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stepUpMaxFailures" INTEGER NOT NULL DEFAULT 5,
    "stepUpLockMinutes" INTEGER NOT NULL DEFAULT 15,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SecuritySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepUpAttempt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" "StepUpResult" NOT NULL,
    "action" TEXT,
    "codeFingerprint" TEXT,

    CONSTRAINT "StepUpAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID,
    "partyId" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "SecurityEventKind" NOT NULL,
    "surface" "SecuritySurface" NOT NULL,
    "actorId" UUID,
    "ipHash" TEXT,
    "ipCountry" TEXT,
    "recordType" TEXT,
    "recordId" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "action" "ReadAction" NOT NULL,
    "surface" "SecuritySurface" NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StepUpAttempt_tenantId_userId_at_idx" ON "StepUpAttempt"("tenantId", "userId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "StepUpAttempt_tenantId_userId_codeFingerprint_key" ON "StepUpAttempt"("tenantId", "userId", "codeFingerprint");

-- CreateIndex
CREATE INDEX "SecurityEvent_tenantId_at_idx" ON "SecurityEvent"("tenantId", "at");

-- CreateIndex
CREATE INDEX "SecurityEvent_tenantId_kind_at_idx" ON "SecurityEvent"("tenantId", "kind", "at");

-- CreateIndex
CREATE INDEX "SecurityEvent_tenantId_actorId_at_idx" ON "SecurityEvent"("tenantId", "actorId", "at");

-- CreateIndex
CREATE INDEX "ReadLog_tenantId_recordType_recordId_at_idx" ON "ReadLog"("tenantId", "recordType", "recordId", "at");

-- CreateIndex
CREATE INDEX "ReadLog_tenantId_userId_at_idx" ON "ReadLog"("tenantId", "userId", "at");

