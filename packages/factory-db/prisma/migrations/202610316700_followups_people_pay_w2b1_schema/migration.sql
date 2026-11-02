-- AlterEnum
ALTER TYPE "EarningsKind" ADD VALUE 'BONUS';

-- AlterEnum
ALTER TYPE "PartyRole" ADD VALUE 'CONSULTANT';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "payrollCode" TEXT;

-- AlterTable
ALTER TABLE "PayrollExport" ADD COLUMN     "correctionsCarried" UUID[] DEFAULT ARRAY[]::UUID[];

-- AlterTable
ALTER TABLE "PayrollExportLayout" ADD COLUMN     "confirmedById" UUID,
ADD COLUMN     "confirmedByName" TEXT,
ADD COLUMN     "confirmedOn" DATE;

-- AlterTable
ALTER TABLE "PeopleSettings" ADD COLUMN     "payrollConsultantPartyId" UUID,
ADD COLUMN     "standardReviewMinBundles" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "standardReviewPercent" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "statementPrinterId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "Printer_tenantId_companyId_id_key" ON "Printer"("tenantId", "companyId", "id");

-- AddForeignKey
ALTER TABLE "PeopleSettings" ADD CONSTRAINT "PeopleSettings_tenantId_companyId_statementPrinterId_fkey" FOREIGN KEY ("tenantId", "companyId", "statementPrinterId") REFERENCES "Printer"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PeopleSettings" ADD CONSTRAINT "PeopleSettings_tenantId_payrollConsultantPartyId_fkey" FOREIGN KEY ("tenantId", "payrollConsultantPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

