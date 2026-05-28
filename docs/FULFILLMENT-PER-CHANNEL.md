# Fulfillment per channel (FCF series)

How Nexus models a product that is fulfilled differently on each channel and
marketplace — e.g. **FBA on Amazon-IT, FBM on Amazon-DE, and FBM (or MCF) on
eBay** — without creating duplicate products or listings.

> Core rule (operator intent): **never publish more than the backing pool
> holds.** "We do not want to sell what we do not have."

## The model

Fulfillment is a property of each **`ChannelListing`**, not of the product:

- `ChannelListing.fulfillmentMethod` (`FBA` | `FBM` | `null`) — the operator's
  per channel×marketplace choice. `null` = not set → resolved (derived) at read
  time. Promotes fulfillment off the legacy product-level
  `Product.fulfillmentMethod`.
- `ChannelListing.stockBuffer` (`Int`, default 0) — units hidden from the
  marketplace as overselling protection; subtracted from whichever pool backs
  the listing.

Resolution when `fulfillmentMethod` is `null`:

1. Merchant channels (eBay/Shopify/Woo/Etsy) → `FBM`.
2. Amazon → ingested `platformAttributes.fulfillmentChannel` (AFN/MFN) →
   `Product.fulfillmentMethod` → `FBM`.

## The two stock pools

`computeAvailableToPublish()` (`services/available-to-publish.service.ts`) binds
a listing's publishable quantity to exactly one physically-distinct pool:

| Method | Pool | Source |
| --- | --- | --- |
| `FBM` | own warehouse | `StockLevel.available` across `WAREHOUSE` locations |
| `FBA` | Amazon FBA | `FbaInventoryDetail` `condition='SELLABLE'`, scoped to the sku + marketplace |

`available = max(0, poolQuantity − max(0, stockBuffer))`. FBA stock sits at
Amazon and **cannot** ship an FBM order; warehouse stock cannot back a plain FBA
listing. Crossing the two is only possible via **MCF** (below).

## MCF — selling FBA stock on eBay (FCF.5)

An eBay listing whose `ChannelListing.fulfillmentMethod = 'FBA'` is a
**Multi-Channel Fulfillment** listing: it publishes the **FBA SELLABLE** pool,
and when an eBay order lands, **Amazon ships it** via the FBA Outbound API. This
is safe against the core rule because Amazon holds the stock.

- A merchant-channel listing backed by the FBA pool is flagged `isMcf: true` in
  the read endpoints.
- `Order.fulfillmentMethod` (a `String`) is set to `'MCF'` by
  `createMCFShipment()` when a fulfillment order is created. Inventory follows
  the reserve→consume pattern at the `AMAZON-EU-FBA` location.

### Enabling live MCF (gated; off by default)

Live MCF creates real Amazon fulfillment orders (ships product, costs money), so
it is gated:

| Env var | Effect |
| --- | --- |
| `AMAZON_MCF_LIVE=1` | `resolveMcfAdapter()` returns the real SP-API FBA Outbound adapter (else a stub that throws "not configured"). |
| `AMAZON_MCF_SANDBOX=1` | Adapter hits the SP-API **sandbox** host — exercise create/sync/cancel without shipping. |
| `NEXUS_ENABLE_MCF_STATUS_CRON=0` | Disable the 15-min status-sync cron (default on). |
| `NEXUS_EBAY_AUTO_MCF=1` | Auto-submit MCF for newly-ingested eBay orders whose listings are all MCF-backed (FCF.5b). Off by default; also requires `AMAZON_MCF_LIVE=1`. |

### Setting a listing to MCF (FCF.5b)

- **eBay** — the eBay cockpit's **Fulfillment** card (`cards/FulfillmentMethodCard.tsx`)
  toggles FBM ↔ Amazon MCF, writing `ChannelListing.fulfillmentMethod` via the
  shared `PATCH /products/:id/fulfillment` and showing the bound pool's
  available-to-publish.
- **Auto-submit** — with `NEXUS_EBAY_AUTO_MCF=1` (+ a live adapter), eBay order
  ingestion fire-and-forgets `autoSubmitMcfForEbayOrder` after the OrderItems
  are written. Conservative: it submits only when **every** order item maps to
  an MCF-backed eBay listing, otherwise it skips and leaves the order for the
  `/fulfillment/stock/mcf` dashboard. Idempotent (one active shipment per order).

The adapter (`createSpApiMcfAdapter`, `services/amazon-mcf.service.ts`) maps the
`MCFAdapter` surface onto FBA Outbound v2020-07-01:

- create → `POST /fba/outbound/2020-07-01/fulfillmentOrders`
- status → `GET  …/fulfillmentOrders/{sellerFulfillmentOrderId}`
- cancel → `PUT  …/fulfillmentOrders/{sellerFulfillmentOrderId}/cancel`

Amazon's create returns no id in the body, so the seller-provided
`sellerFulfillmentOrderId` **is** the lookup key for status/cancel and is echoed
back as `amazonFulfillmentOrderId`.

The dashboard (`/fulfillment/stock/mcf`), the 15-min cron
(`amazon-mcf-status.job`) and the ~30s SQS push path (`amazon-sqs-poll.job`) all
share the one `resolveMcfAdapter()` definition.

## Oversell guards at publish time

- **Amazon** — the Matrix tab (`tabs/MatrixTab.tsx`, FCF.4b) lets the operator
  set FBA/FBM per variant×market and shows the per-pool available-to-publish.
- **eBay** (`routes/ebay-flat-file.routes.ts`, `capToFbm`) — caps each SKU's
  published quantity at its **resolved pool** at every push site (feed,
  single-SKU, variation-group):
  - `FBM` → warehouse-available (less buffer).
  - `FBA`/MCF → FBA SELLABLE for the sku+market (less buffer).
  - Products/SKUs with no stock record for the resolved pool are left
    **uncapped but flagged** in the response `warnings` (a data gap is not a
    real stockout — don't mass-delist on missing data).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/products/:id/fulfillment` | Per channel×marketplace method, source, pool, availableToPublish, `isMcf` (FCF.1/.2/.5). |
| GET | `/api/products/:id/channel-inventory` | Matrix data: adds `fulfillmentMethod`, `fulfillmentSource`, `availableToPublish`, raw pools, `isMcf` per (variant, market). |
| PATCH | `/api/products/:id/fulfillment` | Set `ChannelListing.fulfillmentMethod` per variant×market; `null` clears to derived (FCF.4b). |
| POST/POST/PUT | `/api/stock/mcf/*` | Create / sync / cancel MCF shipments (S.24). |

## Phase log

- **FCF.1** — `ChannelListing.fulfillmentMethod` + GET read.
- **FCF.2** — `computeAvailableToPublish` per pool (+ unit tests).
- **FCF.3 / .3b** — eBay publish cap at the FBM pool; `.3b` honours `stockBuffer`.
- **FCF.4a** — eBay import marks the listing FBM, not the product.
- **FCF.4b** — editable fulfillment in the Matrix tab + `PATCH /fulfillment` +
  `channel-inventory` extension.
- **FCF.5** — MCF: real SP-API FBA Outbound adapter (gated), eBay publish cap
  becomes pool-aware (FBA/MCF), `isMcf` read flag, this doc.
- **FCF.5b** — eBay cockpit Fulfillment card (FBM ↔ MCF) + gated auto-MCF-submit
  on eBay order ingestion (`NEXUS_EBAY_AUTO_MCF`).
