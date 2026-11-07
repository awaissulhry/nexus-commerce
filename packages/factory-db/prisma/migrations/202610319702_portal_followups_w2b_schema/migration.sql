-- CreateEnum
CREATE TYPE "PartyAddressApproval" AS ENUM ('WAITING', 'APPROVED', 'REFUSED');

-- CreateEnum
CREATE TYPE "SupplierDocumentUploadStatus" AS ENUM ('WAITING', 'ACCEPTED', 'REFUSED');

-- CreateEnum
CREATE TYPE "PartyChangeRequestStatus" AS ENUM ('OPEN', 'APPROVED', 'REFUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ReturnRequestChannel" AS ENUM ('OFFICE', 'PORTAL', 'LINK');

-- CreateEnum
CREATE TYPE "ReturnOutcomeWanted" AS ENUM ('REPLACE', 'REPAIR', 'CREDIT');

-- AlterEnum
ALTER TYPE "PurchaseConfirmationChannel" ADD VALUE 'PORTAL';

-- AlterEnum
ALTER TYPE "SafetySignMethod" ADD VALUE 'LINK';

-- AlterTable
ALTER TABLE "Parcel" ADD COLUMN     "trackingUrl" TEXT;

-- AlterTable
ALTER TABLE "PartnerTask" ADD COLUMN     "assigneeId" UUID;

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "PartyAddress" ADD COLUMN     "approvalStatus" "PartyAddressApproval",
ADD COLUMN     "decidedAt" TIMESTAMPTZ(3),
ADD COLUMN     "decidedById" UUID,
ADD COLUMN     "refuseReason" TEXT,
ADD COLUMN     "requestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "requestedByUserId" UUID;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "confirmedByUserId" UUID,
ADD COLUMN     "proposedByUserId" UUID;

-- AlterTable
ALTER TABLE "ReturnAuthorisation" ADD COLUMN     "channel" "ReturnRequestChannel" NOT NULL DEFAULT 'OFFICE',
ADD COLUMN     "customerNote" TEXT,
ADD COLUMN     "outcomeWanted" "ReturnOutcomeWanted";

-- AlterTable
ALTER TABLE "RiskAssessmentSignature" ADD COLUMN     "approvalRequestId" UUID;

-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN     "cancelFeePct" DECIMAL(7,4);

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "expectedDeliveryAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "SupplierDocumentUpload" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "recordLabel" TEXT NOT NULL,
    "category" "FileCategory" NOT NULL,
    "issuer" TEXT,
    "documentNumber" TEXT,
    "issuedOn" DATE,
    "expiresOn" DATE,
    "articleCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lotCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "replacesFileId" UUID,
    "taskId" UUID,
    "uploadedById" UUID NOT NULL,
    "uploadedByName" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3),
    "status" "SupplierDocumentUploadStatus" NOT NULL DEFAULT 'WAITING',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decidedByName" TEXT,
    "acceptedCategory" "FileCategory",
    "acceptedExpiresOn" DATE,
    "documentFileId" UUID,
    "refuseReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierDocumentUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyChangeRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "note" TEXT,
    "status" "PartyChangeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decidedByName" TEXT,
    "refuseReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartyChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierDocumentUpload_tenantId_partyId_status_idx" ON "SupplierDocumentUpload"("tenantId", "partyId", "status");

-- CreateIndex
CREATE INDEX "SupplierDocumentUpload_tenantId_status_createdAt_idx" ON "SupplierDocumentUpload"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SupplierDocumentUpload_tenantId_fileId_idx" ON "SupplierDocumentUpload"("tenantId", "fileId");

-- CreateIndex
CREATE INDEX "PartyChangeRequest_tenantId_partyId_status_idx" ON "PartyChangeRequest"("tenantId", "partyId", "status");

-- CreateIndex
CREATE INDEX "PartyChangeRequest_tenantId_status_createdAt_idx" ON "PartyChangeRequest"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_tenantId_companyId_id_key" ON "ApprovalRequest"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "PartnerTask_tenantId_assigneeId_status_idx" ON "PartnerTask"("tenantId", "assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerTask_tenantId_partyId_id_key" ON "PartnerTask"("tenantId", "partyId", "id");

-- AddForeignKey
ALTER TABLE "PartyAddress" ADD CONSTRAINT "PartyAddress_tenantId_requestedByUserId_fkey" FOREIGN KEY ("tenantId", "requestedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocumentUpload" ADD CONSTRAINT "SupplierDocumentUpload_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocumentUpload" ADD CONSTRAINT "SupplierDocumentUpload_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocumentUpload" ADD CONSTRAINT "SupplierDocumentUpload_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocumentUpload" ADD CONSTRAINT "SupplierDocumentUpload_tenantId_replacesFileId_fkey" FOREIGN KEY ("tenantId", "replacesFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocumentUpload" ADD CONSTRAINT "SupplierDocumentUpload_tenantId_documentFileId_fkey" FOREIGN KEY ("tenantId", "documentFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocumentUpload" ADD CONSTRAINT "SupplierDocumentUpload_tenantId_partyId_taskId_fkey" FOREIGN KEY ("tenantId", "partyId", "taskId") REFERENCES "PartnerTask"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocumentUpload" ADD CONSTRAINT "SupplierDocumentUpload_tenantId_uploadedById_fkey" FOREIGN KEY ("tenantId", "uploadedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyChangeRequest" ADD CONSTRAINT "PartyChangeRequest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyChangeRequest" ADD CONSTRAINT "PartyChangeRequest_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyChangeRequest" ADD CONSTRAINT "PartyChangeRequest_tenantId_requestedById_fkey" FOREIGN KEY ("tenantId", "requestedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartnerTask" ADD CONSTRAINT "PartnerTask_tenantId_assigneeId_fkey" FOREIGN KEY ("tenantId", "assigneeId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessmentSignature" ADD CONSTRAINT "RiskAssessmentSignature_tenantId_companyId_approvalRequest_fkey" FOREIGN KEY ("tenantId", "companyId", "approvalRequestId") REFERENCES "ApprovalRequest"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_confirmedByUserId_fkey" FOREIGN KEY ("tenantId", "confirmedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_proposedByUserId_fkey" FOREIGN KEY ("tenantId", "proposedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

