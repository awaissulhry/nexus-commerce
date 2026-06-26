# eBay Integration

→ [[00 - Nexus Commerce MOC]] | [[14 - External Services]]

## Overview

eBay integration uses the modern **Inventory API** (not the deprecated Trading API). The flat-file editor remains untouchable; all new functionality goes through shared services.

---

## Authentication

| Method | Details |
|--------|---------|
| **OAuth 2.0** | Token exchange via `ebay-auth.routes.ts` |
| **Token Refresh** | `ebay-token-refresh.job.ts` cron keeps tokens fresh |
| **Storage** | `ChannelConnection` table (`managedBy: 'env' \| 'oauth'`) |

---

## Provider

| File | Purpose |
|------|---------|
| `apps/api/src/providers/ebay.provider.ts` | eBay REST API wrapper (OAuth 2.0) |
| `apps/api/src/routes/ebay-cockpit.routes.ts` (79.5 KB) | eBay Inventory API + Listing Cockpit (12 endpoints) |
| `apps/api/src/routes/ebay-flat-file.routes.ts` (79.5 KB) | eBay Flat File Editor (**UNTOUCHABLE**) |

---

## APIs Used

| eBay API | Used For |
|----------|---------|
| **Inventory API** (modern) | Create/update inventory items + listings |
| **Offer API** | Pricing, quantity, listing policies |
| **Browse API** | Category/aspect lookup |
| **Order API** | Order ingestion |
| **Returns API** | Return workflow |
| **Marketing API** | eBay campaigns, markdowns, volume pricing |
| Trading API (LEGACY) | **Abandoned** — replaced by Inventory API |

---

## eBay Listing Cockpit (EC-series, 15 phases)

All 15 phases shipped 2026-05-24. Location: `ebay-cockpit.routes.ts` (12 endpoints).

| Phase | Feature |
|-------|---------|
| EC.1 | Shell — eBay cockpit panel |
| EC.2 | Field Source System |
| EC.3 | SSE real-time updates |
| EC.4 | Category selection |
| EC.5 | Aspects (item specifics) |
| EC.6 | Variations (color/size matrix) |
| EC.7 | Images tab (VariationSpecificPictureSet) |
| EC.8 | Pricing / Offer / Policies |
| EC.9 | Health Score |
| EC.10 | Version history |
| EC.11 | Inventory API publish |
| EC.12 | AI Assistant |
| EC.13 | Motors Compatibility |
| EC.14 | Apply-to-Siblings bulk template |
| EC.15 | Cross-tab back-write (MasterDivergenceBanner) |

---

## eBay Images Tab (Rewire, 4 phases)

Approved 2026-06-24, P1 shipped.

| Phase | Status | Purpose |
|-------|--------|---------|
| P1 | ✅ Shipped | Shared `ebay-variation-push.service.ts` |
| P2 | Pending | Images tab UI wired to real Inventory API push |
| P3 | Pending | Per-variant image assignment |
| P4 | Pending | Sync/drift modal |

**Key change:** Images tab now points at real Inventory-API push (not dead Trading-API; `ebayItemId null` issue resolved).

---

## Shared eBay Push Service

`apps/api/src/services/ebay-variation-push.service.ts`

Handles:
- Variation group updates
- VariationSpecificPictureSet push
- Per-variant image assignment
- Group publish (all variants at once)
- Per-variant price gaps (excluded un-set-up variants)
- Synonym-aware axis handling (e.g. Color = Colour)

---

## Flat-File Editor (UNTOUCHABLE)

Route: `apps/api/src/routes/ebay-flat-file.routes.ts`
Page: `apps/web/src/app/products/ebay-flat-file/`

**Constraint:** ZERO changes to this page or routes without explicit approval.
Sync via shared store instead.

### FF-EN Series (eBay flat-file comboboxes, 8 phases)
- Pick-or-type dropdowns on every constrained eBay flat-file column
- Variants: open / strict / multi
- Full-parity columns
- Approved untouchable-flat-file exception

---

## Category Aspects

- Aspects = eBay "item specifics" (required/optional attributes per category)
- Fetched via Browse API → cached in `TtlCache`
- Synonym-aware axis collapsing (e.g. `Color` = `Colour` treated as same)
- Stable key lookup after synonym normalization

---

## Variation Handling

- Value-order modal for variant display ordering
- Synonym axes collapsed in value-order modal (EC.15 fix)
- `VariantChannelListing` tracks per-variant eBay listing state

---

## Order Sync

```
ebay-orders-sync.job.ts (cron)
    │
    ▼
eBay Order API
    │
    ▼
Order + OrderItem upserted in Postgres
    │
    ▼
SSE broadcast
```

---

## Campaigns & Promotions

| Model | Purpose |
|-------|---------|
| `EbayCampaign` | eBay Promoted Listings campaign |
| `EbayMarkdown` | Markdown sale (% discount, start/end date) |
| `EbayVolumePromotion` | Volume pricing tiers |

---

## Cron Jobs

| Job | Purpose |
|-----|---------|
| `ebay-token-refresh.job.ts` | Keep OAuth tokens fresh |
| `ebay-orders-sync.job.ts` | Pull new orders |
| `ebay-status-reconciliation.job.ts` | Reconcile listing status |
| `ebay-financial-sync.job.ts` | Pull financial transactions |
| `ebay-returns-poll.job.ts` | Poll returns API |

---

## Related Notes

- [[04 - API Layer (Fastify)]] — `ebay-cockpit.routes.ts` detail
- [[16 - Listing Management]] — listing publish via eBay
- [[18 - Orders & Sales]] — eBay order ingestion
- [[21 - Marketing & Content]] — eBay marketing campaigns
