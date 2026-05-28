# eBay Integration Map

How this app actually talks to eBay — which APIs, for what, and where in
the code. Derived from the real call sites (`/sell/…`, `/ws/api.dll`,
`/commerce/…`), not from product names. Companion to
[cockpit-parity.md](./cockpit-parity.md).

## TL;DR

**Inventory-API-first.** Listings (including variations) are created and
published through the **Sell Inventory API**. Bulk *pulls* use the **Sell
Feed API**. Fast price/quantity pushes use the **Trading API**
(`ReviseInventoryStatus`). Categories, policies, orders, finances, and
returns each use their dedicated Sell/Commerce/Post-Order API. We do
**not** use the Merchant Integration Platform, eBay's File Exchange as a
*publish* path, or any Seller Hub *UI* tool.

## Listing — Sell Inventory API (`/sell/inventory/v1/…`) — primary

The spine of listing. The model is: **`inventory_item`** (the SKU + its
product data/aspects) → **`offer`** (the listing of that SKU on one
marketplace, with price/qty/policies) → **`publish`**. Multi-variation
listings use **`inventory_item_group`** (`variesBy` + `variantSKUs`) +
**`publish_by_inventory_item_group`**. **`location`** sets the merchant
inventory location.

Call sites:
- `services/marketplaces/ebay.service.ts` — core eBay service.
- `services/listing-wizard/ebay-publish.adapter.ts` + `submission.service.ts` — cockpit / wizard publish.
- `routes/ebay-flat-file.routes.ts` — the flat-file **push** (item + offer + publish; `inventory_item_group` for families).
- `services/ebay-sync.service.ts`, `ebay-import.service.ts`, `listing-reconciliation.service.ts`, `outbound-sync.service.ts`, `channel-batch/ebay-parallel-batch.service.ts`, `routes/ebay.routes.ts`.

## Bulk pull — Sell Feed API (`/sell/feed/v1/task`)

Pulling existing listings in bulk. Creates a feed task and downloads the
**`LMS_ACTIVE_INVENTORY_REPORT`** (active-listings report). This is the
programmatic equivalent of "Seller Hub → Reports".

Call sites:
- `services/ebay-feed.service.ts` — task creation + `LMS_ACTIVE_INVENTORY_REPORT` download.
- `routes/ebay-flat-file.routes.ts` — `createInventoryTask`, the flat-file **pull-preview** flow.

## Fast price / quantity — Trading API (XML, `/ws/api.dll`)

Legacy XML calls for operations that are cheaper/faster than a full
Inventory offer update — chiefly **`ReviseInventoryStatus`** for
price/qty, plus a few `GetItem` / `AddFixedPriceItem` / `AddItem`.

Call sites:
- `providers/ebay.provider.ts` — the Trading API HTTP client (`ReviseInventoryStatus` ×15).
- `services/pricing-outbound.service.ts` — repricing/stock outbound sync routes through the provider.
- `routes/ebay-notification.routes.ts`, `services/images/ebay-live-images.service.ts` — notifications + image revisions.

## Supporting APIs

| API | Path | Used for | Where |
|---|---|---|---|
| Sell Account | `/sell/account/v1` | Business policies (return/payment/fulfillment), privileges | `ebay-account.service.ts`, `ebay-auth.service.ts`, flat-file routes |
| Commerce Taxonomy | `/commerce/taxonomy/v1` | Category trees (the category picker) | `ebay-category.service.ts` |
| Sell Metadata | `/sell/metadata/v1` | Marketplace metadata (aspects, conditions) | eBay services |
| Sell Fulfillment | `/sell/fulfillment/v1/order` | **Orders** (not listing) | `ebay-orders.service.ts`, pushback/refunds/cancel |
| Sell Finances | `/sell/finances/v1` | Transactions (fiscal) | `ebay-financial-events.service.ts` |
| Post-Order | `/post-order/v2` | Returns | `ebay-returns/ingest.service.ts` |
| Commerce Identity | `/commerce/identity/v1/user` | Connected-account identity | eBay auth |

## The eBay flat file (`/products/ebay-flat-file`)

- **Pull (load existing):** **Sell Feed API** — `createInventoryTask` +
  `LMS_ACTIVE_INVENTORY_REPORT` (`routes/ebay-flat-file.routes.ts` →
  `services/ebay-feed.service.ts`).
- **Push (publish the sheet):** **Sell Inventory API** — per-SKU
  `inventory_item` PUT + `offer` create/update + `publish`; a family is
  `inventory_item_group` + `publish_by_inventory_item_group` (the EV.6
  variation path, which now also applies the eBay-only renames).
- `GET /ebay/flat-file/rows` reads `Product` + its eBay `ChannelListing`s
  (EV.5: a family loads parent **+** variant children).
- It does **not** use the Trading API, File Exchange CSV, or MIP for its
  push — it's pure Inventory API.

## The cockpit publish (`/products/[id]/edit?tab=EBAY`)

The Listing Cockpit publishes via the same **Sell Inventory API** through
`ebay-publish.adapter.ts` / `submission.service.ts` (single listing:
item + offer + publish). Multi-variation group publishing currently lives
in the flat-file `/push` path (`inventory_item_group`).

## What we deliberately do NOT use

- **Merchant Integration Platform (MIP)** — eBay's legacy bulk XML feed
  platform for very-high-volume sellers. Not used; the modern Feed +
  Inventory APIs cover our volume.
- **Bulk Listing Tool** — a Seller Hub *UI* tool, not an API. Our "bulk"
  surface is the flat-file editor backed by Feed (pull) + Inventory
  (push).
- **Seller Hub Reports** — the Seller Hub *UI*. We use its API
  equivalent, the Feed API `LMS_ACTIVE_INVENTORY_REPORT`.
- **File Exchange (as a publish path)** — the **File Exchange CSV** the
  cockpit exports (EV.6a, `GET /ebay/cockpit/file-exchange-csv`) is an
  **export for you to upload into eBay's own File Exchange tool** if you
  want to. The app itself never publishes via File Exchange — it uses the
  Inventory API.

## Auth

OAuth (user tokens) via `ebay-auth.service.ts`; the Trading API uses the
same token in its XML headers. Origins/credentials are unrelated to the
[SSE-CORS](./cockpit-parity.md) work.
