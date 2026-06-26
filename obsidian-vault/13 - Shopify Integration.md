# Shopify Integration

→ [[00 - Nexus Commerce MOC]] | [[14 - External Services]]

## Overview

Shopify is the third supported channel (Amazon + eBay + Shopify). WooCommerce and Etsy are **explicitly out of scope** — skip them.

---

## Authentication

| Method | Details |
|--------|---------|
| **OAuth 2.0** | Standard Shopify app auth via `shopify-setup.routes.ts` |
| **Storage** | `ChannelConnection` table |

---

## APIs Used

| Shopify API | Used For |
|-------------|---------|
| **REST Admin API** | Product, order, inventory management |
| **Webhooks** | Real-time event ingestion |

---

## Routes

| File | Purpose |
|------|---------|
| `apps/api/src/routes/shopify.ts` | Main Shopify REST operations |
| `apps/api/src/routes/shopify-webhooks.ts` | Webhook ingestion endpoint |
| `apps/api/src/routes/shopify-setup.routes.ts` | OAuth setup flow |

---

## Features

### Product Sync
- Push product data (title, description, price, images) to Shopify
- Variant mapping (color × size)
- Shopify image pool with drag-and-drop (DnD) ordering
- Per-colour image assignment

### Inventory Push
- Stock levels pushed to Shopify location
- `ChannelStockEvent` tracks stock drift
- `CS.1–CS.3` (Channel Stock series) closed eBay + Shopify silent overselling

### Order Ingestion
- Shopify orders pulled via webhook
- Stored in `Order` table with `channel = SHOPIFY`

### Webhook Events
- Order created / updated / cancelled
- Inventory level updates
- Product updates

---

## Image Handling (Shopify)

- Images managed in the product Images tab (`?tab=images`)
- Shopify image pool — DnD reorder
- Per-colour gap: Shopify per-colour image assignment was identified as an open gap (Image publish hardening 2026-06-07)

---

## Channel Stock Events (CS-series)

`CS.1 + CS.2 + CS.3` shipped 2026-05-09:
- `ChannelStockEvent` model — records stock changes from channel webhooks
- Shopify + eBay ingesters — consume webhook payloads
- `/fulfillment/stock/channel-drift` — triage UI for drift

---

## Fulfillment

- Shopify fulfillments tracked in `Shipment` table
- Orders fulfilled via `/orders/[id]/fulfillment` route
- FBM only (no Shopify Fulfillment Network integration)

---

## Constraints

- WooCommerce and Etsy: **skip** — not in active channel scope
- Shopify is channel #3 after Amazon and eBay
- Per-colour image gap: open as of 2026-06-07 image hardening

---

## Related Notes

- [[14 - External Services]] — other external integrations
- [[16 - Listing Management]] — Shopify listing publish flow
- [[17 - Inventory & Fulfillment]] — Shopify stock sync
- [[18 - Orders & Sales]] — Shopify order ingestion
