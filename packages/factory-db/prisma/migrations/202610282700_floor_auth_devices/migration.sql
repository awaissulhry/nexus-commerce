-- CreateEnum
CREATE TYPE "DeviceKind" AS ENUM ('TABLET', 'HANDHELD', 'PC');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "BadgeStatus" AS ENUM ('ACTIVE', 'LOST', 'REVOKED');

-- CreateEnum
CREATE TYPE "FloorSessionEndReason" AS ENUM ('SIGNED_OUT', 'SWITCHED', 'REPLACED', 'IDLE', 'SHIFT_END', 'DEVICE_REVOKED', 'BADGE_REVOKED', 'WORKER_DEACTIVATED', 'PIN_RESET');

-- AlterEnum
ALTER TYPE "RoleAudience" ADD VALUE 'FLOOR';

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "stationId" UUID,
    "name" TEXT NOT NULL,
    "kind" "DeviceKind" NOT NULL DEFAULT 'TABLET',
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT,
    "enrolledAt" TIMESTAMPTZ(3),
    "enrolledById" UUID,
    "lastSeenAt" TIMESTAMPTZ(3),
    "appVersion" TEXT,
    "currentSessionId" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEnrolment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "DeviceEnrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'it',
    "employeeCode" TEXT,
    "userId" UUID,
    "status" "WorkerStatus" NOT NULL DEFAULT 'ACTIVE',
    "pinHash" TEXT,
    "pinChangedAt" TIMESTAMPTZ(3),
    "pinMustChange" BOOLEAN NOT NULL DEFAULT false,
    "failedPinAttempts" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "status" "BadgeStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "issuedById" UUID NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerRole" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "grantedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,

    CONSTRAINT "WorkerRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "badgeId" UUID,
    "tokenHash" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "endReason" "FloorSessionEndReason",

    CONSTRAINT "FloorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "idleMinutes" INTEGER NOT NULL DEFAULT 10,
    "shiftEnds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FloorSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE INDEX "Device_tenantId_siteId_idx" ON "Device"("tenantId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tenantId_siteId_id_key" ON "Device"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceEnrolment_codeHash_key" ON "DeviceEnrolment"("codeHash");

-- CreateIndex
CREATE INDEX "DeviceEnrolment_tenantId_deviceId_idx" ON "DeviceEnrolment"("tenantId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_tenantId_employeeCode_key" ON "Worker"("tenantId", "employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_tenantId_siteId_id_key" ON "Worker"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_codeHash_key" ON "Badge"("codeHash");

-- CreateIndex
CREATE INDEX "Badge_tenantId_workerId_idx" ON "Badge"("tenantId", "workerId");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_tenantId_siteId_id_key" ON "Badge"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "WorkerRole_tenantId_workerId_idx" ON "WorkerRole"("tenantId", "workerId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorSession_tokenHash_key" ON "FloorSession"("tokenHash");

-- CreateIndex
CREATE INDEX "FloorSession_tenantId_deviceId_idx" ON "FloorSession"("tenantId", "deviceId");

-- CreateIndex
CREATE INDEX "FloorSession_tenantId_workerId_idx" ON "FloorSession"("tenantId", "workerId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorSession_tenantId_siteId_id_key" ON "FloorSession"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "FloorSettings_tenantId_siteId_idx" ON "FloorSettings"("tenantId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Station_tenantId_siteId_id_key" ON "Station"("tenantId", "siteId", "id");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_tenantId_siteId_currentSessionId_fkey" FOREIGN KEY ("tenantId", "siteId", "currentSessionId") REFERENCES "FloorSession"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeviceEnrolment" ADD CONSTRAINT "DeviceEnrolment_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Badge" ADD CONSTRAINT "Badge_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerRole" ADD CONSTRAINT "WorkerRole_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkerRole" ADD CONSTRAINT "WorkerRole_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSession" ADD CONSTRAINT "FloorSession_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSession" ADD CONSTRAINT "FloorSession_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSession" ADD CONSTRAINT "FloorSession_tenantId_siteId_badgeId_fkey" FOREIGN KEY ("tenantId", "siteId", "badgeId") REFERENCES "Badge"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorSettings" ADD CONSTRAINT "FloorSettings_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

