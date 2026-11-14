-- CreateEnum
CREATE TYPE "KpiState" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "KpiUnit" AS ENUM ('PERCENT', 'COUNT', 'PIECES', 'MONEY', 'DAYS', 'HOURS', 'MINUTES', 'RATIO');

-- CreateEnum
CREATE TYPE "KpiGrain" AS ENUM ('PRICE', 'COST', 'MARGIN');

-- CreateEnum
CREATE TYPE "KpiUseKind" AS ENUM ('DASHBOARD', 'REPORT', 'ALERT', 'PORTAL');

-- CreateEnum
CREATE TYPE "DigestSection" AS ENUM ('SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'ALERTS', 'APPROVALS');

-- CreateEnum
CREATE TYPE "AlertRouteScope" AS ENUM ('COMPANY', 'SITE', 'LINE', 'CUSTOMER');

-- CreateTable
CREATE TABLE "KpiDefinition" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "kpiKey" TEXT NOT NULL,
    "kpiVersion" INTEGER NOT NULL,
    "basedOnId" UUID,
    "changeNote" TEXT,
    "state" "KpiState" NOT NULL DEFAULT 'DRAFT',
    "nameIt" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "definitionIt" TEXT NOT NULL,
    "definitionEn" TEXT NOT NULL,
    "formulaIt" TEXT NOT NULL,
    "formulaEn" TEXT NOT NULL,
    "sourceRecords" TEXT[],
    "measureKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownerRoleId" UUID NOT NULL,
    "unit" "KpiUnit" NOT NULL,
    "grain" "KpiGrain",
    "activatedAt" TIMESTAMPTZ(3),
    "activatedById" UUID,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "KpiDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KpiUse" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "kpiKey" TEXT NOT NULL,
    "usedIn" "KpiUseKind" NOT NULL,
    "useKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "KpiUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardLayout" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "dashboardKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "panels" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestSetting" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMPTZ(3),
    "enabledById" UUID,
    "companyId" UUID,
    "sendTime" TEXT NOT NULL DEFAULT '07:30',
    "timeZone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "locale" TEXT NOT NULL DEFAULT 'it',
    "sections" "DigestSection"[] DEFAULT ARRAY['SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'ALERTS', 'APPROVALS']::"DigestSection"[],
    "lastSentAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DigestSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsightsSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "digestMailOn" BOOLEAN NOT NULL DEFAULT false,
    "digestMailOnAt" TIMESTAMPTZ(3),
    "digestMailOnById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InsightsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRoute" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "ruleId" UUID NOT NULL,
    "scope" "AlertRouteScope" NOT NULL,
    "scopeId" UUID NOT NULL,
    "roleId" UUID,
    "userId" UUID,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AlertRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactDaily" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "lineId" UUID,
    "day" DATE NOT NULL,
    "measureKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" DECIMAL(18,4),
    "priceAmount" INTEGER,
    "costAmount" INTEGER,
    "marginAmount" INTEGER,
    "currency" TEXT,
    "rebuiltAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactHourly" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "lineId" UUID,
    "hourStart" TIMESTAMPTZ(3) NOT NULL,
    "day" DATE NOT NULL,
    "measureKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" DECIMAL(18,4),
    "priceAmount" INTEGER,
    "costAmount" INTEGER,
    "marginAmount" INTEGER,
    "currency" TEXT,
    "rebuiltAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactHourly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KpiDefinition_tenantId_state_idx" ON "KpiDefinition"("tenantId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "KpiDefinition_tenantId_kpiKey_kpiVersion_key" ON "KpiDefinition"("tenantId", "kpiKey", "kpiVersion");

-- CreateIndex
CREATE UNIQUE INDEX "KpiDefinition_tenantId_id_key" ON "KpiDefinition"("tenantId", "id");

-- CreateIndex
CREATE INDEX "KpiUse_tenantId_kpiKey_idx" ON "KpiUse"("tenantId", "kpiKey");

-- CreateIndex
CREATE INDEX "KpiUse_tenantId_usedIn_useKey_idx" ON "KpiUse"("tenantId", "usedIn", "useKey");

-- CreateIndex
CREATE UNIQUE INDEX "KpiUse_tenantId_key_key" ON "KpiUse"("tenantId", "key");

-- CreateIndex
CREATE INDEX "DashboardLayout_tenantId_userId_idx" ON "DashboardLayout"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardLayout_tenantId_key_key" ON "DashboardLayout"("tenantId", "key");

-- CreateIndex
CREATE INDEX "DigestSetting_tenantId_enabled_idx" ON "DigestSetting"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "DigestSetting_tenantId_userId_idx" ON "DigestSetting"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DigestSetting_tenantId_key_key" ON "DigestSetting"("tenantId", "key");

-- CreateIndex
CREATE INDEX "InsightsSettings_tenantId_companyId_idx" ON "InsightsSettings"("tenantId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "InsightsSettings_tenantId_key_key" ON "InsightsSettings"("tenantId", "key");

-- CreateIndex
CREATE INDEX "AlertRoute_tenantId_ruleId_idx" ON "AlertRoute"("tenantId", "ruleId");

-- CreateIndex
CREATE INDEX "AlertRoute_tenantId_scope_scopeId_idx" ON "AlertRoute"("tenantId", "scope", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRoute_tenantId_key_key" ON "AlertRoute"("tenantId", "key");

-- CreateIndex
CREATE INDEX "FactDaily_tenantId_measureKey_day_idx" ON "FactDaily"("tenantId", "measureKey", "day");

-- CreateIndex
CREATE INDEX "FactDaily_tenantId_companyId_day_idx" ON "FactDaily"("tenantId", "companyId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "FactDaily_tenantId_key_key" ON "FactDaily"("tenantId", "key");

-- CreateIndex
CREATE INDEX "FactHourly_tenantId_measureKey_hourStart_idx" ON "FactHourly"("tenantId", "measureKey", "hourStart");

-- CreateIndex
CREATE INDEX "FactHourly_tenantId_companyId_hourStart_idx" ON "FactHourly"("tenantId", "companyId", "hourStart");

-- CreateIndex
CREATE UNIQUE INDEX "FactHourly_tenantId_key_key" ON "FactHourly"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "KpiDefinition" ADD CONSTRAINT "KpiDefinition_tenantId_basedOnId_fkey" FOREIGN KEY ("tenantId", "basedOnId") REFERENCES "KpiDefinition"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "KpiDefinition" ADD CONSTRAINT "KpiDefinition_tenantId_ownerRoleId_fkey" FOREIGN KEY ("tenantId", "ownerRoleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DashboardLayout" ADD CONSTRAINT "DashboardLayout_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DigestSetting" ADD CONSTRAINT "DigestSetting_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DigestSetting" ADD CONSTRAINT "DigestSetting_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InsightsSettings" ADD CONSTRAINT "InsightsSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AlertRoute" ADD CONSTRAINT "AlertRoute_tenantId_ruleId_fkey" FOREIGN KEY ("tenantId", "ruleId") REFERENCES "AlertRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AlertRoute" ADD CONSTRAINT "AlertRoute_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AlertRoute" ADD CONSTRAINT "AlertRoute_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FactDaily" ADD CONSTRAINT "FactDaily_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FactDaily" ADD CONSTRAINT "FactDaily_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FactDaily" ADD CONSTRAINT "FactDaily_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FactHourly" ADD CONSTRAINT "FactHourly_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FactHourly" ADD CONSTRAINT "FactHourly_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FactHourly" ADD CONSTRAINT "FactHourly_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

