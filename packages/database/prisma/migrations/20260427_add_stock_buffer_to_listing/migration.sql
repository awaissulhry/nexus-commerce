-- Phase 23.2: Add stock buffer to Listing model
-- This field allows channels to reserve units to prevent overselling on high-velocity channels
-- Example: If actualStock = 100 and stockBuffer = 5, marketplace sees 95 units

ALTER TABLE "Listing" ADD COLUMN "stockBuffer" INTEGER NOT NULL DEFAULT 0;
