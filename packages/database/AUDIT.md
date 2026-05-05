# Nexus Database Audit — 2026-05-06

Snapshot of the production Neon database after the test-data cleanup of 2026-05-05.

- **Cleanup performed:** 2026-05-05 (74 Products + 1,272 ProductVariation rows removed)
- **Audit conducted:** 2026-05-06
- **Database:** Neon — `ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech/neondb`

## Summary

| Metric | Count |
|---|---|
| Products (real Xavia) | **267** |
| Test data remaining | **0** |
| Total tables in `public` schema | 78 (76 model + `_prisma_migrations` + `playing_with_neon`) |
| Channel connections (active) | 1 of 8 |
| Orders | 5 (all PENDING) |
| Open data-quality issues | 7 (see TECH_DEBT.md → Data Quality Issues) |

## Catalog State

| Field | Count |
|---|---|
| Total Products | 267 |
| `importSource = NULL` (early imports, real) | 262 |
| `importSource = 'MANUAL'` (UI-entered, real) | 5 |
| `basePrice = 0` (zero-price) | 7 |
| `basePrice > 0` | 260 |
| `brand IS NULL` | 267 (all) |
| ProductVariation rows | 0 |
| ProductImage rows | 0 |
| ListingImage orphans | 0 ✓ |

> **Note:** `Product.category` does not exist in the current schema — the spec template assumed it did. Categorization today is via `productType` and the `ProductTag` join table (also empty). The 76-row `Tag` table holds the vocabulary.

## Order Pipeline State

| Metric | Count |
|---|---|
| Total Orders | 5 |
| ↳ AMAZON | 1 |
| ↳ EBAY | 2 |
| ↳ Other channels | 2 |
| ↳ Status PENDING | 5 |
| ↳ Status SHIPPED | 0 |
| ↳ Status DELIVERED | 0 |
| OrderItem | 15 |
| Shipment / ShipmentItem | 0 / 0 |
| Return / ReturnItem | 0 / 0 |

The 5 orders look like manual or sync-test seed orders. None have moved past PENDING — fulfillment side has never been exercised against a real workflow.

## Inventory & Fulfillment State

| Table | Rows |
|---|---|
| Warehouse | 1 |
| StockMovement | **0** ⚠ |
| InboundShipment | 1 |
| InboundShipmentItem | 1 |
| FBAShipment | 1 |
| FBAShipmentItem | 0 |
| PurchaseOrder | 4 |
| PurchaseOrderItem | 262 |
| Supplier | 0 |
| Carrier | 0 |

`StockMovement = 0` despite having a Warehouse, 4 POs, and an InboundShipment means the inventory ledger has never been written to — stock is being tracked through `Product.totalStock` only, not the movement log.

## Channel Connections

| Metric | Count |
|---|---|
| ChannelConnection (total) | 8 |
| ChannelConnection (active) | **1** |
| ChannelConnection (inactive) | 7 |
| ChannelListing | 8 |
| Listing (legacy table, still in schema) | tracked separately |
| ListingWizard total | 30 |
| ListingWizard DRAFT | **30** (all of them) |

> **Note:** `ChannelListing.status` does not exist — the spec template assumed it did. The `Listing` and `ChannelListing` tables both exist; the latter is the post-Phase-26 unified model and the former is legacy (TECH_DEBT candidate for removal).

## Configured Category Schemas

| Marketplace | Schemas |
|---|---|
| IT | 11 |
| DE | 2 |
| FR | 2 |
| UK | 1 |
| ES | 1 |
| **Total** | **17** |

Italy is well-covered (primary market). Other EU marketplaces have minimal schemas — fine for now since no listings live outside IT.

## Bulk Operations & Other

| Table | Rows |
|---|---|
| BulkActionJob | 2 (both COMPLETED) |
| BulkOperation | 93 |
| BulkOpsTemplate | tracked |
| GtinExemptionApplication | 2 (1 PACKAGE_READY, 1 DRAFT) |
| MarketplaceSync | 260 |
| Marketplace | 17 (seed reference data) |
| PricingSnapshot | 104 |
| TerminologyPreference | 7 (Italian glossary in use) |
| AuditLog | 7 |
| BrandSettings | 1 |
| `_prisma_migrations` | 44 |
| `playing_with_neon` | 60 (Neon default sample table — should drop) |

> **Note:** `BulkActionItem` table does not exist — the spec template assumed it did. The bulk-ops state model is `BulkActionJob` + `BulkOperation` (separate tables) only.

## Top-30 Tables by Row Count

| Table | Rows |
|---|---|
| Product | 267 |
| PurchaseOrderItem | 262 |
| MarketplaceSync | 260 |
| PricingSnapshot | 104 |
| BulkOperation | 93 |
| `playing_with_neon` | 60 |
| `_prisma_migrations` | 44 |
| ListingWizard | 30 |
| Marketplace | 17 |
| CategorySchema | 17 |
| OrderItem | 15 |
| ChannelListing | 8 |
| ChannelConnection | 8 |
| TerminologyPreference | 7 |
| AuditLog | 7 |
| Order | 5 |
| PurchaseOrder | 4 |
| GtinExemptionApplication | 2 |
| BulkActionJob | 2 |
| InboundShipmentItem, FBAShipment, InboundShipment, Warehouse, BrandSettings | 1 each |
| All other 50+ tables | 0 |

## Data Quality Issues

Detail in `TECH_DEBT.md` → "Data Quality Issues (P2)". Headline list:

1. **7 zero-price products** (real Xavia jackets with `basePrice = 0`)
   - `AIRMESH-JACKET-{BLACK,YELLOW}-MEN`, `3K-HP05-BH9I` (MISANO), `GALE-JACKET`, `IT-MOSS-JACKET`, `REGAL-JACKET`, `VENTRA-JACKET`
2. **AIRMESH triple-stacked duplication** — for each colour (BLACK / YELLOW), one €0 "no-size" parent + 6 sized children at €109.99 + (BLACK only) one MANUAL master `XAVIA-AIRMESH-GIACCA-MOTO`. 15 SKUs covering 1 product family.
3. **Glove sizes stored as separate Products** — 15 SKUs (xevo-black ×5, xevo-mar ×5, xriser-bla ×5), all €39.95, all 0 stock. Should be 3 Products × 5 size-variations.
4. **Knee slider colours stored as separate Products** — 8 colours: black, blue, green, orange, pink, red, white, yellow. Should be 1 Product × 8 colour-variations. (Spec template said 6; actual is 8.)
5. **Every Product has `brand = NULL`** — should be `'Xavia Racing'` for all 267 (verify each is actually Xavia first).
6. **30 ListingWizard rows, all DRAFT** — abandoned wizard sessions; safe to bulk-delete.
7. **7 inactive ChannelConnection rows** — stale OAuth / dead tokens; clean up or refresh.

## Cleanup Performed (2026-05-05)

| Bucket | Products | Variations |
|---|---|---|
| `importSource = 'XAVIA_REALISTIC_TEST'` (seed data) | 67 | 1,272 (cascaded) |
| `sku LIKE 'NEW-%' AND name = 'Untitled product'` (empty drafts) | 6 | 0 |
| `sku = 'test'` (stray) | 1 | 0 |
| **Total removed** | **74** | **1,272** |

Pre-cleanup state: 341 Products + 1,272 ProductVariation + assorted test scaffolding.
Post-cleanup state: 267 Products + 0 ProductVariation + zero test markers.

## Cleanup Script

The cleanup is idempotent and lives at `packages/database/scripts/cleanup-test-data.sql`. Re-running it on a clean DB is a no-op. See `DEVELOPMENT.md` → "Test Data Lifecycle" for the importSource convention enforced going forward.

## Outstanding Audit Follow-ups (not data-quality)

- **`playing_with_neon` table** — Neon's default sample table, 60 rows. Drop with `DROP TABLE "playing_with_neon"` once confirmed unused.
- **Legacy `Listing` table** — coexists with `ChannelListing`; surveyed for removal in TECH_DEBT.
- **0 StockMovement rows** despite a Warehouse + InboundShipment + 4 POs — inventory ledger never written. Either we don't need it (then drop the model) or we need to backfill from `Product.totalStock` deltas.
- **DB `category` column referenced in spec template doesn't exist** — kept noting for any tooling that assumes it.
