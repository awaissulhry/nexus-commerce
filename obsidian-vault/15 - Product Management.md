# Product Management

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

The product domain is the master catalog: ~279 SKUs for Xavia (Italian motorcycle gear). Products are the source of truth that feed all channel listings.

---

## Data Model

```
ProductFamily (groups products)
    │
    └── Product (master product, 1 per ASIN/base SKU)
            │
            ├── ProductVariation (color × size variants)
            │       │
            │       ├── StockLevel (per warehouse)
            │       ├── ChannelListing (per channel/marketplace)
            │       └── VariantChannelListing (per-variant channel state)
            │
            ├── ProductImage (images, isPrimary flag)
            ├── ProductTag (tags)
            ├── SkuAlias (per-channel SKU aliases)
            └── Bundle → BundleComponent
```

---

## Product Editor (`/products/[id]/edit`)

27-wave engagement. Key tabs:

| Tab | Content |
|-----|---------|
| `master` | Core fields (title, description, brand, category) — merged from Global |
| `amazon` | Amazon attributes grouped by marketplace/productType |
| `ebay` | eBay Listing Cockpit (full 15-phase) |
| `shopify` | Shopify-specific fields |
| `images` | Multi-channel image workspace |
| `pricing` | Per-channel pricing |

### Edit UX Rules (DSP-series)

7 anti-patterns eliminated:
1. ❌ Silent auto-save → ✅ Explicit save with dirty indicator
2. ❌ Publish-without-save → ✅ Flush dirty state before publish
3. ❌ Cross-product channel bleed → ✅ Isolated per-product state
4. ❌ Flat-file submit losing edits → ✅ `useDirtyRegistry` coordination
5. Canonical spec: `docs/edit-ux.md`
6. Shared hooks: `useDirtyRegistry`, `useNavigationGuard`, `useEditorShortcuts`

### Tab System (TC-series)

- `useTabPrefs` hook + `CANONICAL_TABS` catalog
- Customize Tabs modal (dnd-kit sortable reorder)
- Per-row checkbox visibility
- Min-visible guard
- Active-but-hidden tab: dashed-border cue

---

## Product Grid (`/products`)

PG-series (11 phases, shipped 2026-05-23):

| Feature | Detail |
|---------|--------|
| Cache backfill | `ProductReadCache` pre-warmed |
| Parent picker | Select parent product |
| Density-aware thumbnails | Thumbnail size adapts to row density |
| `isPrimary` hero | Primary image shown in grid |
| Preferences modal | Column visibility + ordering |
| Sticky freeze | Freeze first N columns |
| Inline action cluster | Edit, duplicate, delete inline |
| Empty-state CTAs | Create first product guidance |
| Sort arrow polish | Visual sort indicator |
| i18n / a11y / memo | Internationalised, accessible, memoised |

---

## Variant Architecture

```
Product
├── variation: { color: "Red", size: "L" }
├── variation: { color: "Red", size: "XL" }
├── variation: { color: "Blue", size: "L" }
└── variation: { color: "Blue", size: "XL" }
```

- Color × Size matrix (main axes)
- `categoryAttributes.variations` fallback for older products (old bulk-create keeps Color/Size here, not in `variantAttributes`)
- Synonym-aware axis handling for eBay (Color = Colour)

---

## Images (`?tab=images`)

Images Efficiency (IE-series, 17 phases):

| Feature | Status |
|---------|--------|
| Dedup gate before upload | ✅ Shipped |
| Backfill + collapse | ✅ 4,626 → 2,063 rows |
| Master auto-seed from DAM | ✅ Shipped |
| Variant-targeted upload | ✅ Shipped |
| Live channel strip | ✅ Shipped |
| Drift modal | ✅ Shipped |
| altOverride / effective-url | ✅ Shipped |

Key models: `ProductImage`, `ChannelListingImage`, `ChannelLiveImage`

**Amazon images:** Pan-EU shared ASIN = ONE image set globally. Per-market main images are impossible.

---

## Amazon Tab Grouping (AG-series)

Amazon tab renders schema fields in coloured per-marketplace groups (matching flat-file editor):
- Hard constraint: zero changes to `/products/amazon-flat-file`
- Reuses `/api/amazon/flat-file/template` (cached 5min per market+productType)
- Sticky headers (top-24)
- Collapsible per-(marketplace, productType) with localStorage key
- Coloured-band skeleton + retryable error fallback
- Arrow Up/Down focus cycling + aria-live announcements
- Per-group dirty dot

---

## Edit Header (EH-series)

Speed optimisations on the `/products/[id]/edit` header:
- Matrix button dropped
- Datasheet / Flat File / Recover open in new tab (real `<a target="_blank">`)
- Mount-warm + hover-warm prefetch
- `TtlCache` (health 30s + FF template 5min)
- `Server-Timing` header
- Click → FCP measurement
- 10 components code-split via `next/dynamic`
- `useOpenOnce` for lazy-open panels

---

## Bulk Operations on Products

- CSV / Excel bulk import via `/bulk-operations/import`
- Bulk price updates
- Bulk status changes
- Bulk assign to families
- Auto-PO from replenishment

---

## Product Read Cache

`read-cache.worker.ts` maintains `ProductReadCache` (in-memory + Redis):
- Pre-warmed on startup
- Refreshed on product update events
- Fallback to Postgres if cache miss
- Powers `GET /api/products/search` (Typesense dormant → PG FTS)

---

## API Routes

| Route | Purpose |
|-------|---------|
| `GET /api/products` | List products (paginated, filtered) |
| `GET /api/products/:id` | Get product by ID |
| `POST /api/products` | Create product |
| `PATCH /api/products/:id` | Update product |
| `DELETE /api/products/:id` | Soft-delete product |
| `GET /api/products/search` | Full-text search (PG FTS / Typesense) |
| `POST /api/products/bulk` | Bulk operations |
| `PATCH /api/products/:id/global` | Update global/master fields |

---

## Related Notes

- [[05 - Database Schema]] — Product, ProductVariation, ProductFamily models
- [[16 - Listing Management]] — publishing products to channels
- [[17 - Inventory & Fulfillment]] — stock per product variation
- [[21 - Marketing & Content]] — content for products
- [[09 - Design System]] — components used in product editor
