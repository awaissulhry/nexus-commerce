-- CreateEnum
CREATE TYPE "OrderFreezeField" AS ENUM ('SIZE_QUANTITY', 'COLOURWAY', 'OPTION', 'DELIVERY_DATE', 'SHIP_TO', 'PRICE');

-- CreateEnum
CREATE TYPE "OrderFreezeStage" AS ENUM ('RELEASED', 'CUT', 'SEWING', 'FINISHED', 'SHIPPED');

-- CreateEnum
CREATE TYPE "OrderFreezeAction" AS ENUM ('CHANGE_REQUEST', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CreditCheckStep" AS ENUM ('QUOTE', 'ORDER', 'RELEASE', 'SHIPMENT', 'PORTAL', 'API');

-- CreateEnum
CREATE TYPE "CreditCheckResult" AS ENUM ('PASS', 'WARN', 'HOLD');

-- CreateEnum
CREATE TYPE "SalesOrderPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- AlterEnum
ALTER TYPE "DepositKind" ADD VALUE 'CAPARRA_PENITENZIALE';

-- AlterEnum
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'ORDER_CONFIRMATION';

-- AlterEnum
ALTER TYPE "GoodsReceiptKind" ADD VALUE 'CUSTOMER_SUPPLIED';

-- AlterEnum
ALTER TYPE "SalesOrderStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "Lot" ADD COLUMN     "ownerPartyId" UUID;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "confirmationSentAt" TIMESTAMPTZ(3),
ADD COLUMN     "confirmationVersion" INTEGER,
ADD COLUMN     "priorityLevel" "SalesOrderPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "urgentReason" TEXT;

-- AlterTable
ALTER TABLE "SalesOrderAmendment" ADD COLUMN     "depositRequestId" UUID,
ADD COLUMN     "feeAmount" INTEGER,
ADD COLUMN     "priceDeltaLines" JSONB,
ADD COLUMN     "reapprovalTaskId" UUID;

-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN     "caparraPenitenzialeEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OrderFreezeRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "field" "OrderFreezeField" NOT NULL,
    "frozenFrom" "OrderFreezeStage" NOT NULL,
    "action" "OrderFreezeAction" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "updatedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderFreezeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditCheck" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "step" "CreditCheckStep" NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "openOrdersAmount" INTEGER NOT NULL,
    "openInvoicesAmount" INTEGER NOT NULL,
    "overdueAmount" INTEGER NOT NULL,
    "subjectAmount" INTEGER NOT NULL DEFAULT 0,
    "exposureAmount" INTEGER NOT NULL,
    "limitAmount" INTEGER,
    "onHold" BOOLEAN NOT NULL DEFAULT false,
    "result" "CreditCheckResult" NOT NULL,
    "words" TEXT,
    "overridesCheckId" UUID,
    "overrideTaskId" UUID,
    "checkedAt" TIMESTAMPTZ(3) NOT NULL,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CreditCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMaterial" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "bomRevisionId" UUID NOT NULL,
    "bomLineId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "uom" "Uom" NOT NULL,
    "expectedQuantity" DECIMAL(18,4) NOT NULL,
    "expectedBySize" JSONB NOT NULL DEFAULT '{}',
    "receivedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "usedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "returnedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "note" TEXT,
    "updatedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CustomerMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderFreezeRule_tenantId_companyId_field_idx" ON "OrderFreezeRule"("tenantId", "companyId", "field");

-- CreateIndex
CREATE INDEX "CreditCheck_tenantId_recordType_recordId_checkedAt_idx" ON "CreditCheck"("tenantId", "recordType", "recordId", "checkedAt");

-- CreateIndex
CREATE INDEX "CreditCheck_tenantId_partyId_companyId_checkedAt_idx" ON "CreditCheck"("tenantId", "partyId", "companyId", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditCheck_tenantId_companyId_partyId_id_key" ON "CreditCheck"("tenantId", "companyId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CreditCheck_tenantId_overridesCheckId_key" ON "CreditCheck"("tenantId", "overridesCheckId");

-- CreateIndex
CREATE INDEX "CustomerMaterial_tenantId_orderId_idx" ON "CustomerMaterial"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "CustomerMaterial_tenantId_partyId_itemId_idx" ON "CustomerMaterial"("tenantId", "partyId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderAmendment_tenantId_depositRequestId_key" ON "SalesOrderAmendment"("tenantId", "depositRequestId");

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenantId_ownerPartyId_fkey" FOREIGN KEY ("tenantId", "ownerPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderFreezeRule" ADD CONSTRAINT "OrderFreezeRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CreditCheck" ADD CONSTRAINT "CreditCheck_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CreditCheck" ADD CONSTRAINT "CreditCheck_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CreditCheck" ADD CONSTRAINT "CreditCheck_tenantId_companyId_partyId_overridesCheckId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "overridesCheckId") REFERENCES "CreditCheck"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CreditCheck" ADD CONSTRAINT "CreditCheck_tenantId_companyId_overrideTaskId_fkey" FOREIGN KEY ("tenantId", "companyId", "overrideTaskId") REFERENCES "ApprovalTask"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerMaterial" ADD CONSTRAINT "CustomerMaterial_tenantId_companyId_partyId_orderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "orderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerMaterial" ADD CONSTRAINT "CustomerMaterial_tenantId_partyId_orderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "orderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerMaterial" ADD CONSTRAINT "CustomerMaterial_tenantId_bomRevisionId_bomLineId_itemId_fkey" FOREIGN KEY ("tenantId", "bomRevisionId", "bomLineId", "itemId") REFERENCES "BomLine"("tenantId", "revisionId", "id", "itemId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerMaterial" ADD CONSTRAINT "CustomerMaterial_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerMaterial" ADD CONSTRAINT "CustomerMaterial_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderAmendment" ADD CONSTRAINT "SalesOrderAmendment_tenantId_companyId_partyId_depositRequ_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "depositRequestId") REFERENCES "DepositRequest"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrderAmendment" ADD CONSTRAINT "SalesOrderAmendment_tenantId_companyId_reapprovalTaskId_fkey" FOREIGN KEY ("tenantId", "companyId", "reapprovalTaskId") REFERENCES "ApprovalTask"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

