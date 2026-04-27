-- Add missing columns to Product table
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "lowStockThreshold" INTEGER NOT NULL DEFAULT 10;

-- Add missing columns to ProductVariation table  
ALTER TABLE "ProductVariation" ADD COLUMN IF NOT EXISTS "stockBuffer" INTEGER NOT NULL DEFAULT 0;
