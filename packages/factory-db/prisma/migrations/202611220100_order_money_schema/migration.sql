-- CreateEnum
CREATE TYPE "OrderCostLineKind" AS ENUM ('FREIGHT_ESTIMATE', 'COMMISSION', 'BANK_CHARGES', 'OTHER');

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "targetMarginPct" DECIMAL(7,4);

-- CreateTable
CREATE TABLE "OrderCostLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "kind" "OrderCostLineKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMPTZ(3),
    "removedById" UUID,
    "removeReason" TEXT,

    CONSTRAINT "OrderCostLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderPriceAcceptance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "ourNet" INTEGER NOT NULL,
    "brandNet" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "acceptedById" UUID NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnById" UUID,
    "withdrawReason" TEXT,

    CONSTRAINT "OrderPriceAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderCostLine_tenantId_salesOrderId_idx" ON "OrderCostLine"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "OrderPriceAcceptance_tenantId_salesOrderId_idx" ON "OrderPriceAcceptance"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "OrderPriceAcceptance_tenantId_partyId_idx" ON "OrderPriceAcceptance"("tenantId", "partyId");

-- AddForeignKey
ALTER TABLE "OrderCostLine" ADD CONSTRAINT "OrderCostLine_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderPriceAcceptance" ADD CONSTRAINT "OrderPriceAcceptance_tenantId_companyId_partyId_salesOrder_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

