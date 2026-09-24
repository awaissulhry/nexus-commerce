-- A-53 — every active business gets the catalogue markets it lacks.
--
-- A business created under profiles got NO Marketplace rows (business creation wrote none), so the
-- product studio had no market to open in and waited forever (docs/product-cheat/PLAN.md § A-53;
-- Motovento, 2026-09-24). New businesses now get the catalogue at creation (workspace.service.ts).
-- This backfills the businesses that already exist.
--
-- Owner ruling (Q1, 2026-09-24): per ROW, create-only. A business gains each catalogue market it does
-- not have; a market row it already has is NEVER changed (ON CONFLICT DO NOTHING on the
-- (workspaceId, channel, code) unique key) — the same rule as POST /api/marketplaces/seed.
-- Production, measured 2026-09-24: Motovento 0 rows → 20; Xavia Racing holds all 20 → +0.
--
-- The VALUES are apps/api/src/services/pim/market-catalogue.ts row for row;
-- market-catalogue-backfill.vitest.test.ts applies this file and fails when the two differ.
-- `id` has no database default (Prisma's cuid() is client-side), so one is made here.
-- Runs as the migration role, which bypasses row-level security; the policies bind the app's runtime role.
INSERT INTO "Marketplace" (
  "id", "workspaceId", "channel", "code", "name", "marketplaceId", "region", "currency", "language",
  "languages", "domainUrl", "vatRate", "taxInclusive", "isActive", "updatedAt"
)
SELECT gen_random_uuid()::text, w."id", c.channel, c.code, c.name, c.marketplace_id, c.region, c.currency, c.language,
       c.languages::text[], c.domain_url, c.vat_rate::numeric(5, 2), c.tax_inclusive, c.is_active, CURRENT_TIMESTAMP
  FROM "Workspace" w
 CROSS JOIN (VALUES
  ('AMAZON', 'BE', 'Amazon Belgium', 'AMEN7PMS3EDWL', 'EU', 'EUR', 'nl', ARRAY['nl', 'fr'], 'amazon.com.be', 21.00, true, true),
  ('AMAZON', 'DE', 'Amazon Germany', 'A1PA6795UKMFR9', 'EU', 'EUR', 'de', ARRAY['de'], 'amazon.de', 19.00, true, true),
  ('AMAZON', 'ES', 'Amazon Spain', 'A1RKKUPIHCS9HS', 'EU', 'EUR', 'es', ARRAY['es'], 'amazon.es', 21.00, true, true),
  ('AMAZON', 'FR', 'Amazon France', 'A13V1IB3VIYZZH', 'EU', 'EUR', 'fr', ARRAY['fr'], 'amazon.fr', 20.00, true, true),
  ('AMAZON', 'IE', 'Amazon Ireland', 'A28R8C7NBKEWEA', 'EU', 'EUR', 'en', ARRAY['en'], 'amazon.ie', 23.00, true, true),
  ('AMAZON', 'IT', 'Amazon Italy', 'APJ6JRA9NG5V4', 'EU', 'EUR', 'it', ARRAY['it'], 'amazon.it', 22.00, true, true),
  ('AMAZON', 'NL', 'Amazon Netherlands', 'A1805IZSGTT6HS', 'EU', 'EUR', 'nl', ARRAY['nl'], 'amazon.nl', 21.00, true, true),
  ('AMAZON', 'PL', 'Amazon Poland', 'A1C3SOZRARQ6R3', 'EU', 'PLN', 'pl', ARRAY['pl'], 'amazon.pl', 23.00, true, true),
  ('AMAZON', 'SE', 'Amazon Sweden', 'A2NODRKZP88ZB9', 'EU', 'SEK', 'sv', ARRAY['sv'], 'amazon.se', 25.00, true, true),
  ('AMAZON', 'TR', 'Amazon Turkey', 'A33AVAJ2PDY3EV', 'EU', 'TRY', 'tr', ARRAY['tr'], 'amazon.com.tr', 18.00, true, true),
  ('AMAZON', 'UK', 'Amazon UK', 'A1F83G8C2ARO7P', 'EU', 'GBP', 'en', ARRAY['en'], 'amazon.co.uk', 20.00, true, true),
  ('AMAZON', 'US', 'Amazon US', 'ATVPDKIKX0DER', 'NA', 'USD', 'en', ARRAY['en'], 'amazon.com', NULL, false, false),
  ('EBAY', 'DE', 'eBay Germany', 'EBAY_DE', 'EU', 'EUR', 'de', ARRAY['de'], 'ebay.de', 19.00, true, true),
  ('EBAY', 'ES', 'eBay Spain', 'EBAY_ES', 'EU', 'EUR', 'es', ARRAY['es'], 'ebay.es', 21.00, true, true),
  ('EBAY', 'FR', 'eBay France', 'EBAY_FR', 'EU', 'EUR', 'fr', ARRAY['fr'], 'ebay.fr', 20.00, true, true),
  ('EBAY', 'IT', 'eBay Italy', 'EBAY_IT', 'EU', 'EUR', 'it', ARRAY['it'], 'ebay.it', 22.00, true, true),
  ('EBAY', 'UK', 'eBay UK', 'EBAY_GB', 'EU', 'GBP', 'en', ARRAY['en'], 'ebay.co.uk', 20.00, true, true),
  ('ETSY', 'GLOBAL', 'Etsy Shop', NULL, 'GLOBAL', 'EUR', 'en', ARRAY['en'], NULL, NULL, false, true),
  ('SHOPIFY', 'GLOBAL', 'Shopify Store', NULL, 'GLOBAL', 'EUR', 'en', ARRAY['en'], NULL, NULL, false, true),
  ('WOOCOMMERCE', 'GLOBAL', 'WooCommerce Store', NULL, 'GLOBAL', 'EUR', 'en', ARRAY['en'], NULL, NULL, false, true)

 ) AS c(channel, code, name, marketplace_id, region, currency, language, languages, domain_url, vat_rate, tax_inclusive, is_active)
 WHERE w."status" = 'active'
ON CONFLICT ("workspaceId", "channel", "code") DO NOTHING;
