-- CreateEnum
CREATE TYPE "AppointmentKind" AS ENUM ('FITTING', 'SHOWROOM', 'MEASURING');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'DONE', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FittingVerdict" AS ENUM ('OK', 'ALTER', 'REMAKE');

-- CreateEnum
CREATE TYPE "MeasurementReviewStatus" AS ENUM ('WAITING', 'CONFIRMED', 'NEED_MORE');

-- AlterEnum
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'MTM_WORKSHEET';

-- AlterTable
ALTER TABLE "MeasurementProfile" ADD COLUMN     "measuredByUserId" UUID,
ADD COLUMN     "measuredPlace" TEXT,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewStatus" "MeasurementReviewStatus" NOT NULL DEFAULT 'WAITING',
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewedById" UUID;

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "contactId" UUID,
    "riderName" TEXT,
    "measurementProfileId" UUID,
    "kind" "AppointmentKind" NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "place" TEXT NOT NULL,
    "withUserId" UUID,
    "withName" TEXT,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "cancelReason" TEXT,
    "notes" TEXT,
    "inviteSentAt" TIMESTAMPTZ(3),
    "reminderSentAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FittingResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "appointmentId" UUID,
    "salesOrderLineId" UUID,
    "measurementProfileId" UUID NOT NULL,
    "fittedAt" TIMESTAMPTZ(3) NOT NULL,
    "verdict" "FittingVerdict" NOT NULL,
    "pointChanges" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "alterationDays" INTEGER,
    "alterationRepairId" UUID,
    "newProfileId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FittingResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Appointment_tenantId_startsAt_idx" ON "Appointment"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_measurementProfileId_idx" ON "Appointment"("tenantId", "measurementProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_partyId_id_key" ON "Appointment"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "FittingResult_tenantId_measurementProfileId_idx" ON "FittingResult"("tenantId", "measurementProfileId");

-- CreateIndex
CREATE INDEX "FittingResult_tenantId_appointmentId_idx" ON "FittingResult"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "FittingResult_tenantId_salesOrderLineId_idx" ON "FittingResult"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "FittingResult_tenantId_alterationRepairId_key" ON "FittingResult"("tenantId", "alterationRepairId");

-- CreateIndex
CREATE INDEX "MeasurementProfile_tenantId_reviewStatus_idx" ON "MeasurementProfile"("tenantId", "reviewStatus");

-- CreateIndex
CREATE UNIQUE INDEX "RepairOrder_tenantId_partyId_id_key" ON "RepairOrder"("tenantId", "partyId", "id");

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_partyId_measurementProfileId_fkey" FOREIGN KEY ("tenantId", "partyId", "measurementProfileId") REFERENCES "MeasurementProfile"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_withUserId_fkey" FOREIGN KEY ("tenantId", "withUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FittingResult" ADD CONSTRAINT "FittingResult_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FittingResult" ADD CONSTRAINT "FittingResult_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FittingResult" ADD CONSTRAINT "FittingResult_tenantId_partyId_appointmentId_fkey" FOREIGN KEY ("tenantId", "partyId", "appointmentId") REFERENCES "Appointment"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FittingResult" ADD CONSTRAINT "FittingResult_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FittingResult" ADD CONSTRAINT "FittingResult_tenantId_partyId_measurementProfileId_fkey" FOREIGN KEY ("tenantId", "partyId", "measurementProfileId") REFERENCES "MeasurementProfile"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FittingResult" ADD CONSTRAINT "FittingResult_tenantId_partyId_alterationRepairId_fkey" FOREIGN KEY ("tenantId", "partyId", "alterationRepairId") REFERENCES "RepairOrder"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FittingResult" ADD CONSTRAINT "FittingResult_tenantId_partyId_newProfileId_fkey" FOREIGN KEY ("tenantId", "partyId", "newProfileId") REFERENCES "MeasurementProfile"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MeasurementProfile" ADD CONSTRAINT "MeasurementProfile_tenantId_measuredByUserId_fkey" FOREIGN KEY ("tenantId", "measuredByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

