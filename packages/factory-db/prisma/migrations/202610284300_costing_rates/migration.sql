-- CreateTable
CREATE TABLE "LabourRate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "workCentreKind" "WorkCentreKind" NOT NULL,
    "costPerMinute" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "plannedEfficiencyPct" DECIMAL(7,4) NOT NULL DEFAULT 100,
    "validFrom" DATE NOT NULL,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LabourRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostingSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "overheadPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CostingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabourRate_tenantId_workCentreKind_validFrom_idx" ON "LabourRate"("tenantId", "workCentreKind", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "LabourRate_tenantId_companyId_workCentreKind_validFrom_key" ON "LabourRate"("tenantId", "companyId", "workCentreKind", "validFrom");

-- CreateIndex
CREATE INDEX "CostingSettings_tenantId_companyId_idx" ON "CostingSettings"("tenantId", "companyId");

-- AddForeignKey
ALTER TABLE "LabourRate" ADD CONSTRAINT "LabourRate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostingSettings" ADD CONSTRAINT "CostingSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

