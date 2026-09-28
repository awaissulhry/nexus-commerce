-- Images rebuild W4a (docs/images-studio-rebuild/NEXT-PLAN-2026-09-28.md): the Owner marks two library photos at two
-- addresses as the same picture (the kept one stays; the other becomes its copy, never deleted), or answers "not the
-- same" to a look-alike suggestion. Additive only: two nullable columns, one index, one self link.

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN     "distinctFromIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sameAsImageId" TEXT;

-- CreateIndex
CREATE INDEX "ProductImage_sameAsImageId_idx" ON "ProductImage"("sameAsImageId");

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_sameAsImageId_fkey" FOREIGN KEY ("sameAsImageId") REFERENCES "ProductImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
