-- Add FNSKU cache field to ProductVariation
ALTER TABLE "ProductVariation" ADD COLUMN IF NOT EXISTS "fnsku" TEXT;

-- Create FnskuLabelTemplate table for saved label designs
CREATE TABLE IF NOT EXISTS "FnskuLabelTemplate" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "config"    JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FnskuLabelTemplate_pkey" PRIMARY KEY ("id")
);
