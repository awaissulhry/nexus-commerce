-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'CLOSED');

-- CreateEnum
CREATE TYPE "ProjectOutcome" AS ENUM ('DONE', 'STOPPED');

-- AlterEnum
ALTER TYPE "FollowReason" ADD VALUE 'ADDED';

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'PROJECT';

-- AlterTable
ALTER TABLE "RecordFollower" ADD COLUMN     "partyId" UUID;

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "leadId" UUID NOT NULL,
    "partyId" UUID,
    "seasonCode" TEXT,
    "targetDate" DATE NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "outcome" "ProjectOutcome",
    "outcomeNote" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectLink" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "projectId" UUID NOT NULL,
    "partyId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProjectLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_tenantId_companyId_status_targetDate_idx" ON "Project"("tenantId", "companyId", "status", "targetDate");

-- CreateIndex
CREATE INDEX "Project_tenantId_leadId_status_idx" ON "Project"("tenantId", "leadId", "status");

-- CreateIndex
CREATE INDEX "Project_tenantId_partyId_idx" ON "Project"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_tenantId_companyId_number_key" ON "Project"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Project_tenantId_id_key" ON "Project"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ProjectLink_tenantId_projectId_idx" ON "ProjectLink"("tenantId", "projectId");

-- CreateIndex
CREATE INDEX "ProjectLink_tenantId_recordType_recordId_idx" ON "ProjectLink"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "ProjectLink_tenantId_partyId_idx" ON "ProjectLink"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectLink_tenantId_key_key" ON "ProjectLink"("tenantId", "key");

-- CreateIndex
CREATE INDEX "RecordFollower_tenantId_partyId_idx" ON "RecordFollower"("tenantId", "partyId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_leadId_fkey" FOREIGN KEY ("tenantId", "leadId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_companyId_seasonCode_fkey" FOREIGN KEY ("tenantId", "companyId", "seasonCode") REFERENCES "Season"("tenantId", "companyId", "code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProjectLink" ADD CONSTRAINT "ProjectLink_tenantId_projectId_fkey" FOREIGN KEY ("tenantId", "projectId") REFERENCES "Project"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

