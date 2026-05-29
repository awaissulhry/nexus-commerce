-- AlterTable
ALTER TABLE "ProductReadCache" ADD COLUMN     "categoryIds" TEXT[],
ADD COLUMN     "categoryPathJson" JSONB,
ADD COLUMN     "primaryCategoryId" TEXT;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "slug" TEXT NOT NULL,
    "code" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "name" JSONB NOT NULL DEFAULT '{"en":{},"it":{}}',
    "description" JSONB,
    "attributes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryClosure" (
    "ancestorId" TEXT NOT NULL,
    "descendantId" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,

    CONSTRAINT "CategoryClosure_pkey" PRIMARY KEY ("ancestorId","descendantId")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "productId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("productId","categoryId")
);

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE INDEX "Category_isActive_idx" ON "Category"("isActive");

-- CreateIndex
CREATE INDEX "Category_slug_idx" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Category_parentId_slug_key" ON "Category"("parentId", "slug");

-- CreateIndex
CREATE INDEX "CategoryClosure_descendantId_idx" ON "CategoryClosure"("descendantId");

-- CreateIndex
CREATE INDEX "CategoryClosure_ancestorId_depth_idx" ON "CategoryClosure"("ancestorId", "depth");

-- CreateIndex
CREATE INDEX "ProductCategory_categoryId_idx" ON "ProductCategory"("categoryId");

-- CreateIndex
CREATE INDEX "ProductCategory_productId_isPrimary_idx" ON "ProductCategory"("productId", "isPrimary");

-- CreateIndex
CREATE INDEX "ProductReadCache_primaryCategoryId_idx" ON "ProductReadCache"("primaryCategoryId");

-- CreateIndex
CREATE INDEX "ProductReadCache_categoryIds_idx" ON "ProductReadCache" USING GIN ("categoryIds");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryClosure" ADD CONSTRAINT "CategoryClosure_ancestorId_fkey" FOREIGN KEY ("ancestorId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryClosure" ADD CONSTRAINT "CategoryClosure_descendantId_fkey" FOREIGN KEY ("descendantId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

