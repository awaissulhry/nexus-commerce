-- CreateTable
CREATE TABLE "SalesSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "marginFloorPct" DECIMAL(7,4) NOT NULL,
    "discountLimitPct" DECIMAL(7,4) NOT NULL,
    "defaultValidityDays" INTEGER NOT NULL,
    "defaultDepositPct" DECIMAL(7,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SalesSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesSettings_tenantId_companyId_idx" ON "SalesSettings"("tenantId", "companyId");

-- AddForeignKey
ALTER TABLE "SalesSettings" ADD CONSTRAINT "SalesSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

