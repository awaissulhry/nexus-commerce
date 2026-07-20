-- SC.0b — dedicated Sync Control routing column (servesMarketplaces belongs to ATP; additive).
ALTER TABLE "StockLocation" ADD COLUMN "syncRoutes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
