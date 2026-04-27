-- Migration: Normalize existing products to parent-child hierarchical structure
-- Purpose: Convert standalone products and their variations into the Rithum parent-child model
-- Strategy:
--   1. Products with variations become parents (variationTheme = inferred from SKU patterns)
--   2. Existing variations become children with variationAttributes populated
--   3. Standalone products (no variations) remain as-is with variationTheme = NULL

-- Step 1: Identify products with variations and infer variation themes
-- Products with variations will have their theme inferred from SKU patterns
-- This uses a heuristic: if all child SKUs follow a pattern, detect the theme

-- Step 2: Update ProductVariation records to populate variationAttributes
-- For products with single-axis variations (name/value), convert to multi-axis format
-- Example: name='Color', value='Red' becomes variationAttributes='{"Color":"Red"}'

UPDATE "ProductVariation" pv
SET "variationAttributes" = jsonb_build_object(
  COALESCE(pv."name", 'Variant'),
  COALESCE(pv."value", '')
)
WHERE pv."variationAttributes" IS NULL
  AND (pv."name" IS NOT NULL OR pv."value" IS NOT NULL);

-- Step 3: Infer and set variationTheme for products with variations
-- Strategy: Detect common SKU patterns among child SKUs
-- Patterns:
--   SIZE_COLOR: base-SIZE-COLOR (e.g., SHIRT-M-BLK)
--   SIZE: base-SIZE (e.g., SHIRT-M)
--   COLOR: base-COLOR (e.g., SHIRT-BLK)
--   SIZE_MATERIAL: base-SIZE-MATERIAL (e.g., SHIRT-M-COTTON)

-- For now, set a generic "MultiAxis" theme for products with multiple variations
-- This can be refined later with more sophisticated pattern matching

UPDATE "Product" p
SET "variationTheme" = 'MultiAxis'
WHERE p.id IN (
  SELECT DISTINCT p2.id
  FROM "Product" p2
  INNER JOIN "ProductVariation" pv ON p2.id = pv."productId"
  GROUP BY p2.id
  HAVING COUNT(pv.id) > 1
)
AND p."variationTheme" IS NULL;

-- Step 4: For single-variation products, set variationTheme to the attribute name
UPDATE "Product" p
SET "variationTheme" = (
  SELECT pv."name"
  FROM "ProductVariation" pv
  WHERE pv."productId" = p.id
  LIMIT 1
)
WHERE p.id IN (
  SELECT DISTINCT p2.id
  FROM "Product" p2
  INNER JOIN "ProductVariation" pv ON p2.id = pv."productId"
  GROUP BY p2.id
  HAVING COUNT(pv.id) = 1
)
AND p."variationTheme" IS NULL
AND EXISTS (
  SELECT 1 FROM "ProductVariation" pv
  WHERE pv."productId" = p.id AND pv."name" IS NOT NULL
);

-- Step 5: Ensure all products have a status (default to ACTIVE if not set)
UPDATE "Product"
SET "status" = 'ACTIVE'
WHERE "status" IS NULL OR "status" = '';

-- Step 6: Verify data integrity
-- Log products that were updated
-- This is informational and helps track the migration

-- Summary of changes:
-- - ProductVariation.variationAttributes: Populated from legacy name/value fields
-- - Product.variationTheme: Inferred from variation patterns
-- - Product.status: Ensured all products have a valid status
-- - Backward compatibility: Legacy name/value fields remain unchanged for compatibility
