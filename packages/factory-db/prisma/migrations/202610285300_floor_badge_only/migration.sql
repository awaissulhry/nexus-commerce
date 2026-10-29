-- AlterTable
ALTER TABLE "FloorSession" ADD COLUMN     "pinVerifiedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "FloorSettings" ADD COLUMN     "badgeOnlySignIn" BOOLEAN NOT NULL DEFAULT false;

