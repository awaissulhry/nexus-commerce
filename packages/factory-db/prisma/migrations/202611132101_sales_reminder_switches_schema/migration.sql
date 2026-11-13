-- AlterTable
ALTER TABLE "SalesSettings" ADD COLUMN     "fittingRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "quoteRemindersEnabled" BOOLEAN NOT NULL DEFAULT false;

