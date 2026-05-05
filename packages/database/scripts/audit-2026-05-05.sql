-- ============================================================================
-- Comprehensive DB audit — 2026-05-05  (Neon SQL Editor compatible)
-- ----------------------------------------------------------------------------
-- Run as one block in Neon SQL Editor (or psql) and paste the output back.
-- Each section is preceded by a SELECT that prints a header row, so the
-- result set order matches the section list below.
-- Read-only — no mutations.
-- ============================================================================

SELECT '1. PRODUCTS & CATALOG' AS section;
SELECT count(*) AS total_products,
       count(*) FILTER (WHERE "basePrice" = 0) AS zero_price,
       count(*) FILTER (WHERE "basePrice" > 0) AS has_price,
       count(*) FILTER (WHERE brand IS NULL) AS no_brand,
       count(DISTINCT category) AS unique_categories,
       count(DISTINCT brand) AS unique_brands
FROM "Product";

SELECT 'ProductVariation' AS table, count(*) AS n FROM "ProductVariation"
UNION ALL SELECT 'ProductImage', count(*) FROM "ProductImage";

SELECT '2. PRODUCT importSource BREAKDOWN' AS section;
SELECT COALESCE("importSource", '(null)') AS source, count(*) AS n
FROM "Product" GROUP BY "importSource" ORDER BY n DESC;

SELECT '3. ORDERS' AS section;
SELECT count(*) AS total_orders,
       count(*) FILTER (WHERE channel = 'AMAZON') AS amazon_orders,
       count(*) FILTER (WHERE channel = 'EBAY') AS ebay_orders,
       count(*) FILTER (WHERE status = 'PENDING') AS pending,
       count(*) FILTER (WHERE status = 'SHIPPED') AS shipped,
       count(*) FILTER (WHERE status = 'DELIVERED') AS delivered
FROM "Order";

SELECT 'OrderItem' AS table, count(*) AS n FROM "OrderItem"
UNION ALL SELECT 'Shipment', count(*) FROM "Shipment"
UNION ALL SELECT 'ShipmentItem', count(*) FROM "ShipmentItem"
UNION ALL SELECT 'Return', count(*) FROM "Return"
UNION ALL SELECT 'ReturnItem', count(*) FROM "ReturnItem";

SELECT '4. INVENTORY & WAREHOUSES' AS section;
SELECT 'Warehouse' AS table, count(*) AS n FROM "Warehouse"
UNION ALL SELECT 'StockMovement', count(*) FROM "StockMovement"
UNION ALL SELECT 'InboundShipment', count(*) FROM "InboundShipment"
UNION ALL SELECT 'InboundShipmentItem', count(*) FROM "InboundShipmentItem"
UNION ALL SELECT 'PurchaseOrder', count(*) FROM "PurchaseOrder"
UNION ALL SELECT 'Supplier', count(*) FROM "Supplier"
UNION ALL SELECT 'Carrier', count(*) FROM "Carrier";

SELECT '5. LISTINGS & CHANNELS' AS section;
SELECT count(*) AS total_listings,
       count(*) FILTER (WHERE channel = 'AMAZON') AS amazon_listings,
       count(*) FILTER (WHERE channel = 'EBAY') AS ebay_listings,
       count(*) FILTER (WHERE status = 'ACTIVE') AS active,
       count(*) FILTER (WHERE status = 'INACTIVE') AS inactive
FROM "ChannelListing";

SELECT count(*) AS connections,
       count(*) FILTER (WHERE "isActive" = true) AS active
FROM "ChannelConnection";

SELECT 'ListingWizard total' AS metric, count(*) AS n FROM "ListingWizard"
UNION ALL SELECT 'ListingWizard DRAFT', count(*) FROM "ListingWizard" WHERE status = 'DRAFT';

SELECT '6. CATEGORY SCHEMAS' AS section;
SELECT count(*) AS total_schemas FROM "CategorySchema";
SELECT marketplace, count(*) AS n FROM "CategorySchema" GROUP BY marketplace ORDER BY n DESC;

SELECT '7. BULK OPERATIONS' AS section;
SELECT 'BulkActionJob' AS table, count(*) AS n FROM "BulkActionJob"
UNION ALL SELECT 'BulkActionItem', count(*) FROM "BulkActionItem";
SELECT status, count(*) AS n FROM "BulkActionJob" GROUP BY status;

SELECT '8. GTIN EXEMPTIONS' AS section;
SELECT count(*) AS total FROM "GtinExemptionApplication";
SELECT status, count(*) AS n FROM "GtinExemptionApplication" GROUP BY status;

SELECT '9. ALL TABLES (existence)' AS section;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;

SELECT '10. ROW COUNTS ACROSS ALL TABLES' AS section;
SELECT relname AS table_name, n_live_tup AS row_count
FROM pg_stat_user_tables
WHERE schemaname = 'public' ORDER BY n_live_tup DESC;

SELECT '11. DATA QUALITY SAMPLES' AS section;

-- Zero-price products (real Xavia, basePrice=0)
SELECT 'Zero-price products' AS sample_set;
SELECT sku, name, brand, "basePrice"
FROM "Product"
WHERE "basePrice" = 0
ORDER BY sku
LIMIT 30;

-- Glove sizes stored as separate Products
SELECT 'Glove-size duplicates (xriser/xevo)' AS sample_set;
SELECT sku, name, "basePrice", "totalStock"
FROM "Product"
WHERE sku LIKE 'xriser-%' OR sku LIKE 'xevo-%'
ORDER BY sku;

-- Knee slider colors stored as separate Products
SELECT 'Knee slider color duplicates' AS sample_set;
SELECT sku, name, "basePrice", "totalStock"
FROM "Product"
WHERE sku LIKE 'xavia-knee-slider-%'
ORDER BY sku;

-- AIRMESH duplicates (NULL vs MANUAL importSource)
SELECT 'AIRMESH duplicates by importSource' AS sample_set;
SELECT sku, name, "basePrice", "importSource"
FROM "Product"
WHERE sku ILIKE '%airmesh%'
ORDER BY sku;

-- Orphaned ListingImage check
SELECT 'Orphaned ListingImage (should be 0)' AS sample_set;
SELECT count(*) AS orphans
FROM "ListingImage" li
WHERE NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = li."productId");
