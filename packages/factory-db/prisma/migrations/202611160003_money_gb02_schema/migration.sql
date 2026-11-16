-- AlterEnum
ALTER TYPE "SelfInvoiceKind" ADD VALUE 'TD16';

-- AlterTable
ALTER TABLE "ReceivablesSettings" ADD COLUMN     "depositAutoCarryOn" BOOLEAN NOT NULL DEFAULT false;
