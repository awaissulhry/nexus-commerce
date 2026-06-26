# Pages & Routes

→ [[00 - Nexus Commerce MOC]] | [[08 - Web App (Next.js)]]

## Router

Next.js 16 **App Router** — all routes under `apps/web/src/app/`.

---

## Route Map

### `/dashboard`
- `/dashboard/overview` — Global snapshot: Amazon Sales/Open Orders/Buyer Messages widget + per-marketplace tables + SSE auto-refresh
- Real-time: SSE connected to `/api/dashboard/events`

### `/products`
- `/products` — Master product grid (PG-series: 11 phases, density-aware, inline actions, Preferences modal, sticky freeze)
- `/products/[id]/edit` — Product editor (27-wave engagement; 14+ tabs)
  - `?tab=master` — Master/Global merged fields
  - `?tab=amazon` — Amazon fields grouped by marketplace/productType
  - `?tab=ebay` — eBay Listing Cockpit (15 phases: Aspects, Variations, Images, Pricing, Health, Publish, AI, Motors Compatibility, Apply-to-Siblings)
  - `?tab=shopify` — Shopify fields
  - `?tab=images` — Multi-channel image workspace (DAM, Amazon JSON_LISTINGS_FEED, eBay VariationSpecificPictureSet, Shopify pool DnD, Color×Slot matrix)
  - `?tab=pricing` — Per-channel pricing
  - `?tab=datasheet` — Opens in new tab (real `<a target="_blank">`)
  - Customize Tabs modal — dnd-kit reorder, per-row visibility checkbox
- `/products/amazon-flat-file` — Amazon Flat File Editor (**UNTOUCHABLE** — zero changes without explicit approval)
- `/products/ebay-flat-file` — eBay Flat File Editor (**UNTOUCHABLE**)
- `/products/[id]/edit?tab=images` — Images tab (IR-series + IE-series)

### `/listings`
- `/listings` — Multi-channel listing status grid
- `/listings/amazon` — Amazon listing grid (per-ASIN/SKU)
- `/listings/ebay` — eBay listing grid
- `/listings/shopify` — Shopify listing grid
- `/listings/recovery` — Listing recovery workflows (reactivation, deactivation)
- `/listings/wizard` — Listing creation wizard (6-step, AI-powered)
- `/listings/templates` — Listing templates

### `/fulfillment`
- `/fulfillment/stock` — Stock management (bins, lots, serials, reservations, ATP)
- `/fulfillment/replenishment` — Replenishment forecasts + auto-PO
- `/fulfillment/returns` — Returns management
- `/fulfillment/inbound` — Inbound shipment planning (FBA Inbound V2 API)
- `/fulfillment/outbound` — Outbound shipment management
- `/fulfillment/carriers` — Carrier service management
- `/fulfillment/fnsku-labels` — FNSKU label printing (10-phase: ZPL, SVG, PDF, scan, keyboard, multi-select, drag)
- `/fulfillment/repricing` — Repricing decisions + /fulfillment/stock/channel-drift

### `/orders`
- `/orders` — Order list (FBM/FBA toggle, status tabs, date-range, Amazon-parity row layout)
  - Real-time: SSE connected to `/api/orders/events` + SQS ~30s
  - `LiveSyncBadge` component shows SQS connection health
- `/orders/[id]` — Order detail (buyer drawer, Italian fiscal block, per-package sections)
- `/orders/[id]/fulfillment` — Pick/pack, label generation
- `/orders/reviews` — Review pipeline management
- `/orders/refunds` — Refund management
- `/orders/invoices` — Fiscal invoice list

### `/pricing`
- `/pricing` — Repricing rules + price history
- `/pricing/rules` — Repricing rule management
- `/pricing/history` — Price change event timeline (sparkline drawer)
- `/pricing/buy-box` — Buy Box tracking

### `/marketing`
- `/marketing/content` — DAM hub (library, filters, drawer, bulk, saved views, timeline, tags, folders)
- `/marketing/content/upload` — Asset upload
- `/marketing/content/aplus` — A+ Content authoring + version control
- `/marketing/content/brand-story` — Brand Story management
- `/marketing/content/brand-kit` — Brand Kit (colors, fonts, logos)
- `/marketing/campaigns` — Unified campaign platform
- `/marketing/automation` — Automation rules
- `/marketing/ads` — Amazon Ads cockpit
- `/marketing/ads/campaigns/[id]` — Campaign detail (H10 pixel-match reference for Helium 10 parity)
- `/marketing/ads/suggestions` — Ads rule suggestions review cockpit (S.1–S.6)

### `/insights`
- `/insights` — Analytics hub
- `/insights/sales` — Sales dashboard
- `/insights/profit` — Profit analytics (COGS, fees, ads spend)
- `/insights/ads` — Ad performance (ACOS, ROAS, conversions)
- `/insights/products` — Product portfolio analysis
- `/insights/customers` — Customer RFM segmentation
- `/insights/inventory` — Inventory analytics
- `/insights/fiscal` — Italian fiscal analytics
- `/insights/anomalies` — Anomaly detection
- `/insights/scenarios` — Scenario modeling (what-if)
- `/insights/ai-brief` — AI-generated business brief
- `/insights/builder` — Custom dashboard builder
- `/insights/exports` — Data exports
- `/insights/live` — Live analytics with SSE
- `/insights/notebook` — Analytics notebook

### `/bulk-operations`
- `/bulk-operations` — Bulk job list
- `/bulk-operations/import` — CSV/Excel import
- `/bulk-operations/templates` — Import/export templates
- `/bulk-operations/scheduled` — Scheduled bulk tasks

### `/catalog`
- `/catalog/organize` — Product organization
- `/catalog/matrix` — Matrix view (cross-variant editing)
- `/catalog/families` — Product family management
- `/catalog/categories` — Category tree

### `/customers`
- `/customers` — Customer list + RFM scores
- `/customers/segments` — Segment builder
- `/customers/analytics` — Customer analytics dashboard
- `/customers/outreach` — Outreach campaigns

### `/inventory`
- `/inventory/forecast` — Demand forecasting
- `/inventory/abc` — ABC classification
- `/inventory/cycle-counts` — Cycle count management

### `/settings`
- `/settings/webhooks` — Webhook configuration
- `/settings/api-keys` — API key management (scope-based)
- `/settings/connections` — Channel OAuth connections
- `/settings/audit` — Audit log viewer
- `/settings/privacy` — GDPR + data retention
- `/settings/team` — Team member management

### `/admin`
- `/admin/system` — System health dashboard
- `/admin/amazon/restore-fba` — Restore FBA listings (used in FBA→FBM flip incident)
- `/admin/wipe` — Data wipe (careful — 51,351+ rows wiped in Phase 2)
- `/admin/monitoring` — Observability dashboard
- `/admin/flags` — Feature flags / system flags

### `/sync-logs`
- `/sync-logs` — Outbound sync queue monitoring
- `/sync-logs/live` — Live tail-f view for DLQ investigation

---

## Hardcoded Constraints

| Route | Constraint |
|-------|-----------|
| `/products/amazon-flat-file` | **UNTOUCHABLE** — zero edits to page or routes |
| `/products/ebay-flat-file` | **UNTOUCHABLE** — zero edits to page or routes |

Sync to these pages via shared store (Zustand or React context), not by editing their files.

---

## Tab Architecture (`/products/[id]/edit`)

Built with `useTabPrefs` hook (TC-series):
- `CANONICAL_TABS` catalog — ordered list of all possible tabs
- Per-user tab visibility persisted to `localStorage`
- Customize Tabs modal — dnd-kit sortable reorder
- Active-but-hidden tab shows dashed-border cue
- Min-visible guard prevents hiding all tabs
- Legacy `product-edit:show-all-tabs` migration

---

## Related Notes

- [[08 - Web App (Next.js)]] — web app architecture
- [[09 - Design System]] — components used in these pages
- [[15 - Product Management]] — `/products` domain
- [[16 - Listing Management]] — `/listings` domain
- [[17 - Inventory & Fulfillment]] — `/fulfillment` domain
- [[18 - Orders & Sales]] — `/orders` domain
- [[20 - Advertising]] — `/marketing/ads` domain
