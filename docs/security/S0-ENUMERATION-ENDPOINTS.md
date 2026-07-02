# S0 — apps/api HTTP endpoint inventory

Generated 2026-07-02 by static extraction from `apps/api/src/index.ts` + 149 registered route files. Basis for deny-by-default permission middleware.

**Total endpoints: 2028** across 149 registered route modules (Fastify only — no Express).

## 1. Registration pattern + mount map

- Server: single Fastify app (`apps/api/src/index.ts:401`). Every route module is a Fastify plugin — `export (default) async function xxxRoutes(fastify: FastifyInstance)` — registered flat via `app.register(pluginFn, { prefix })` in one block at `index.ts:489-657`. No Express routers anywhere; no `fastify.route({})` object style; no nested `register` inside route files.
- Three prefix conventions: (a) `{ prefix: "/api" }` (majority — file paths start at `/resource`), (b) mounted bare with absolute paths written inline in the file — MOSTLY `/api/...` but 11 files claim ROOT namespaces outside `/api` entirely: `/admin/*` (admin.ts), `/listings/*` (listings.ts), `/ai/*` (ai.ts), `/marketplaces/*` (marketplaces.ts), `/monitoring/*` (monitoring.ts), `/shopify/*`, `/woocommerce/*`, `/etsy/*`, `/ebay/*` (channel ops files), `/webhooks/*` (shopify/woo/etsy webhook receivers + webhooks.routes.ts stock-adjustment), (c) specific prefixes: `/api/catalog`, `/api/amazon`, `/api/feed-transform`, `/api/feed-export`. **A deny-by-default matcher scoped to `/api/*` would silently miss the root namespaces — including root `/admin/*`.**
- Global hooks on every request: `x-request-id` AsyncLocalStorage (`index.ts:410`), compress, multipart (50MB/1 file), rate-limit 2000 req/min/IP with allow-list (`index.ts:452-478`, disable via `NEXUS_DISABLE_RATE_LIMIT=1`), CORS restricted to `ALLOWED_WEB_ORIGINS`. **No global auth hook — the app is unauthenticated by default.**
- Existing per-route guard primitive: `requireApiKeyScope(scope)` (hard 401) + `allowApiKeyScope(scope)` (soft — validates Bearer `nxk_…` if present, falls through if absent) in `apps/api/src/lib/api-key-hook.ts:69,104`, backed by `verifyApiKey` (scopes, revocation, rotation, expiry, IP allowlist). Used on only 3 routes today (products.routes.ts:215, products-catalog.routes.ts:1586, listings-syndication.routes.ts:3242) via route-options `preHandler`. A deny-by-default `requirePermission` would attach the same way — as a `preHandler` in the route-options object — OR as a global `onRequest` hook keyed off a route→permission manifest; the flat `app.register` block makes a per-register wrapper (e.g. `registerGuarded(plugin, prefix, module)`) the lowest-touch CI-checkable seam.
- Rate-limit opt-outs to preserve: `/api/health`, `/api/products/bulk-fetch*`, `/api/inventory*`, `/api/catalog/products*`, `/api/marketplaces*`, `/api/pim/fields*`.

### Mount map (file → prefix, register at index.ts line)

| Route file | Prefix | index.ts | Bucket | Endpoints |
|---|---|---|---|---|
| routes/listings.ts | `(none)` | :489 | listings/channels | 8 |
| routes/inventory.ts | `/api` | :490 | fulfillment/inventory | 7 |
| routes/ai.ts | `(none)` | :491 | ai/agents | 1 |
| routes/marketplaces.ts | `(none)` | :492 | listings/channels | 8 |
| routes/admin.ts | `(none)` | :493 | admin/ops | 28 |
| routes/monitoring.ts | `(none)` | :494 | health/infra | 7 |
| routes/shopify.ts | `(none)` | :495 | listings/channels | 7 |
| routes/shopify-webhooks.ts | `(none)` | :496 | webhooks/notifications | 8 |
| routes/woocommerce.ts | `(none)` | :497 | listings/channels | 6 |
| routes/woocommerce-webhooks.ts | `(none)` | :498 | webhooks/notifications | 6 |
| routes/etsy.ts | `(none)` | :499 | listings/channels | 6 |
| routes/etsy-webhooks.ts | `(none)` | :500 | webhooks/notifications | 6 |
| routes/sync.routes.ts | `/api` | :501 | admin/ops | 5 |
| routes/ebay-auth.ts | `(none)` | :502 | settings/connections | 8 |
| routes/ebay.routes.ts | `(none)` | :503 | listings/channels | 10 |
| routes/ebay-orders.routes.ts | `(none)` | :504 | orders | 3 |
| routes/catalog.routes.ts | `/api/catalog` | :505 | products/catalog | 18 |
| routes/catalog-organize.routes.ts | `/api/catalog` | :506 | products/catalog | 4 |
| routes/listing-health.routes.ts | `(none)` | :511 | listings/channels | 3 |
| routes/field-links.routes.ts | `(none)` | :512 | products/catalog | 7 |
| routes/outbound.routes.ts | `(none)` | :513 | admin/ops | 8 |
| routes/matrix.routes.ts | `(none)` | :514 | products/catalog | 6 |
| routes/inbound.routes.ts | `(none)` | :515 | fulfillment/inventory | 2 |
| routes/fba-inbound-v2.routes.ts | `/api` | :516 | fulfillment/inventory | 10 |
| routes/webhooks.routes.ts | `(none)` | :517 | webhooks/notifications | 2 |
| routes/sendcloud-webhooks.routes.ts | `(none)` | :518 | webhooks/notifications | 1 |
| routes/orders.routes.ts | `(none)` | :519 | orders | 36 |
| routes/customers.routes.ts | `(none)` | :520 | customers | 16 |
| routes/catalog-safe.routes.ts | `/api/catalog` | :521 | products/catalog | 1 |
| routes/health.ts | `/api` | :522 | health/infra | 1 |
| routes/amazon.routes.ts | `/api/amazon` | :523 | listings/channels | 46 |
| routes/amazon-flat-file.routes.ts | `/api` | :524 | listings/channels | 25 |
| routes/amazon-cockpit-publish.routes.ts | `/api` | :525 | listings/channels | 1 |
| routes/amazon-preflight.routes.ts | `/api` | :526 | listings/channels | 1 |
| routes/cockpit-telemetry.routes.ts | `/api` | :527 | admin/ops | 2 |
| routes/ebay-flat-file.routes.ts | `/api` | :528 | listings/channels | 18 |
| routes/ebay-cockpit.routes.ts | `/api` | :529 | listings/channels | 16 |
| routes/ebay-volume-pricing.routes.ts | `/api` | :530 | pricing | 14 |
| routes/flat-file-pull-history.routes.ts | `/api` | :531 | listings/channels | 2 |
| routes/flat-file-unified.routes.ts | `/api` | :532 | listings/channels | 4 |
| routes/marketplaces.routes.ts | `/api` | :533 | listings/channels | 18 |
| routes/fulfillment.routes.ts | `/api` | :534 | fulfillment/inventory | 304 |
| routes/returns.routes.ts | `/api` | :535 | fulfillment/inventory | 51 |
| routes/stock.routes.ts | `/api` | :536 | fulfillment/inventory | 73 |
| routes/brand-settings.routes.ts | `/api` | :537 | settings/connections | 4 |
| routes/settings-audit.routes.ts | `/api` | :538 | settings/connections | 3 |
| routes/profile.routes.ts | `/api` | :539 | settings/connections | 10 |
| routes/settings-webhooks.routes.ts | `/api` | :540 | settings/connections | 5 |
| routes/settings-privacy.routes.ts | `/api` | :541 | settings/connections | 8 |
| routes/pricing.routes.ts | `/api` | :542 | pricing | 22 |
| routes/pricing-rules.routes.ts | `/api` | :543 | pricing | 6 |
| routes/marketing.routes.ts | `/api` | :544 | marketing/content | 4 |
| routes/marketing-os.routes.ts | `/api` | :545 | marketing/content | 37 |
| routes/advertising.routes.ts | `/api` | :546 | advertising | 277 |
| routes/advertising-intel.routes.ts | `/api` | :547 | advertising | 18 |
| routes/amazon-ads-auth.routes.ts | `/api` | :548 | advertising | 4 |
| routes/reviews.routes.ts | `/api` | :549 | orders | 55 |
| routes/brand-brain.routes.ts | `/api` | :550 | ai/agents | 5 |
| routes/feed-transform.routes.ts | `/api/feed-transform` | :551 | listings/channels | 9 |
| routes/feed-export.routes.ts | `/api/feed-export` | :552 | listings/channels | 4 |
| routes/analytics.routes.ts | `/api` | :553 | analytics/insights | 1 |
| routes/insights.routes.ts | `/api` | :554 | analytics/insights | 15 |
| routes/customer-segments.routes.ts | `/api` | :555 | customers | 9 |
| routes/orders-routing.routes.ts | `/api` | :556 | orders | 2 |
| routes/products.routes.ts | `/api` | :557 | products/catalog | 29 |
| routes/listing-recovery.routes.ts | `/api` | :558 | listings/channels | 3 |
| routes/families.routes.ts | `/api` | :559 | products/catalog | 15 |
| routes/attributes.routes.ts | `/api` | :560 | products/catalog | 13 |
| routes/workflows.routes.ts | `/api` | :561 | products/catalog | 9 |
| routes/product-workflow.routes.ts | `/api` | :562 | products/catalog | 7 |
| routes/tier-pricing.routes.ts | `/api` | :563 | pricing | 9 |
| routes/product-channel-data.routes.ts | `/api` | :564 | products/catalog | 8 |
| routes/assets.routes.ts | `/api` | :565 | marketing/content | 28 |
| routes/aplus-content.routes.ts | `/api` | :566 | marketing/content | 18 |
| routes/brand-story.routes.ts | `/api` | :567 | marketing/content | 17 |
| routes/brand-kit.routes.ts | `/api` | :568 | marketing/content | 10 |
| routes/marketing-automation.routes.ts | `/api` | :569 | marketing/content | 7 |
| routes/channel-publish.routes.ts | `/api` | :570 | marketing/content | 6 |
| routes/cloudinary-webhook.routes.ts | `/api` | :571 | webhooks/notifications | 1 |
| routes/repricing-rules.routes.ts | `/api` | :572 | pricing | 6 |
| routes/categories.routes.ts | `/api` | :573 | products/catalog | 4 |
| routes/pim-categories.routes.ts | `/api` | :574 | products/catalog | 8 |
| routes/listing-wizard.routes.ts | `/api` | :575 | listings/channels | 38 |
| routes/wizard-templates.routes.ts | `/api` | :576 | listings/channels | 6 |
| routes/gtin-exemption.routes.ts | `/api` | :577 | listings/channels | 8 |
| routes/listing-content.routes.ts | `/api` | :578 | listings/channels | 1 |
| routes/terminology.routes.ts | `/api` | :579 | ai/agents | 4 |
| routes/bulk-operations.routes.ts | `/api` | :580 | admin/ops | 18 |
| routes/bulk-action-templates.routes.ts | `/api` | :581 | admin/ops | 7 |
| routes/scheduled-bulk-actions.routes.ts | `/api` | :582 | admin/ops | 6 |
| routes/bulk-automation-rules.routes.ts | `/api` | :583 | admin/ops | 8 |
| routes/listing-automation-rules.routes.ts | `/api` | :584 | listings/channels | 7 |
| routes/bulk-automation-approvals.routes.ts | `/api` | :585 | admin/ops | 5 |
| routes/import-wizard.routes.ts | `/api` | :586 | products/catalog | 7 |
| routes/scheduled-imports.routes.ts | `/api` | :587 | products/catalog | 6 |
| routes/scheduled-image-publishes.routes.ts | `/api` | :588 | marketing/content | 3 |
| routes/bulk-image-publish.routes.ts | `/api` | :589 | marketing/content | 1 |
| routes/export-wizard.routes.ts | `/api` | :590 | products/catalog | 5 |
| routes/scheduled-exports.routes.ts | `/api` | :591 | products/catalog | 6 |
| routes/dashboard.routes.ts | `/api` | :592 | analytics/insights | 24 |
| routes/outbound-queue.routes.ts | `(none)` | :593 | admin/ops | 6 |
| routes/pim.routes.ts | `/api` | :594 | products/catalog | 9 |
| routes/pim-global.routes.ts | `/api` | :595 | products/catalog | 11 |
| routes/catalog-matrix.routes.ts | `/api` | :596 | products/catalog | 1 |
| routes/pim-mapping.routes.ts | `/api` | :597 | products/catalog | 16 |
| routes/value-map.routes.ts | `/api` | :598 | products/catalog | 7 |
| routes/mapping-propagation.routes.ts | `/api` | :599 | products/catalog | 5 |
| routes/amazon-cockpit.routes.ts | `/api` | :600 | listings/channels | 3 |
| routes/audit-log.routes.ts | `/api` | :601 | admin/ops | 3 |
| routes/sync-logs.routes.ts | `/api` | :602 | admin/ops | 26 |
| routes/listings-syndication.routes.ts | `/api` | :603 | listings/channels | 33 |
| routes/products-catalog.routes.ts | `/api` | :604 | products/catalog | 32 |
| routes/products-search.routes.ts | `/api` | :605 | products/catalog | 1 |
| routes/products-ai.routes.ts | `/api` | :606 | ai/agents | 2 |
| routes/products-images.routes.ts | `/api` | :607 | products/catalog | 2 |
| routes/listing-images.routes.ts | `/api` | :608 | listings/channels | 5 |
| routes/images/amazon-images.routes.ts | `/api` | :609 | listings/channels | 13 |
| routes/images/images-workspace.routes.ts | `/api` | :610 | listings/channels | 5 |
| routes/images/channel-image-publish.routes.ts | `/api` | :611 | listings/channels | 4 |
| routes/product-translations.routes.ts | `/api` | :612 | products/catalog | 6 |
| routes/product-relations.routes.ts | `/api` | :613 | products/catalog | 5 |
| routes/product-certificates.routes.ts | `/api` | :614 | products/catalog | 4 |
| routes/product-images-crud.routes.ts | `/api` | :615 | products/catalog | 17 |
| routes/product-seo.routes.ts | `/api` | :616 | products/catalog | 4 |
| routes/workflow-assignments.routes.ts | `/api` | :617 | products/catalog | 5 |
| routes/forecast.routes.ts | `/api` | :618 | analytics/insights | 2 |
| routes/ai-usage.routes.ts | `/api` | :619 | ai/agents | 17 |
| routes/agents.routes.ts | `/api` | :620 | ai/agents | 14 |
| routes/amazon-reports.routes.ts | `/api` | :621 | analytics/insights | 3 |
| routes/amazon-economics.routes.ts | `/api` | :622 | analytics/insights | 8 |
| routes/product-costs.routes.ts | `/api` | :623 | pricing | 2 |
| routes/saved-view-alerts.routes.ts | `/api` | :624 | webhooks/notifications | 6 |
| routes/notifications.routes.ts | `/api` | :627 | webhooks/notifications | 4 |
| routes/inbox.routes.ts | `/api` | :628 | webhooks/notifications | 2 |
| routes/orders-reviews.routes.ts | `/api` | :629 | orders | 21 |
| routes/review-inserts.routes.ts | `/api` | :630 | orders | 3 |
| routes/review-send-windows.routes.ts | `/api` | :631 | orders | 4 |
| routes/connections.routes.ts | `/api` | :632 | settings/connections | 3 |
| routes/reconciliation.routes.ts | `/api` | :633 | fulfillment/inventory | 16 |
| routes/ebay-phase3.routes.ts | `/api` | :634 | listings/channels | 4 |
| routes/amazon-notifications.routes.ts | `/api` | :636 | webhooks/notifications | 3 |
| routes/ebay-notification.routes.ts | `/api` | :637 | webhooks/notifications | 6 |
| routes/push-health.routes.ts | `/api` | :640 | admin/ops | 1 |
| routes/push-latency.routes.ts | `/api` | :642 | admin/ops | 1 |
| routes/outbound-latency.routes.ts | `/api` | :644 | admin/ops | 1 |
| routes/inventory-sync-diagnostics.routes.ts | `/api` | :646 | admin/ops | 1 |
| routes/control-tower.routes.ts | `/api` | :648 | admin/ops | 2 |
| routes/shopify-setup.routes.ts | `/api` | :653 | settings/connections | 2 |
| routes/job-monitor.routes.ts | `(none)` | :657 | admin/ops | 7 |

**Not registered (dead route files, excluded from counts):** `routes/bulk-list.routes.ts` (imported nowhere), `routes/monitoring.routes.ts` (superseded by monitoring.ts), `routes/repricing.ts` (superseded by repricing-rules.routes.ts). `routes/validation.ts` is a Zod schema module, not routes. `routes/__tests__/` + `amazon-flat-file.browse-nodes.vitest.test.ts` excluded.

## 2. Per-module endpoint counts

| Module | Files | Endpoints |
|---|---|---|
| fulfillment/inventory | 7 | 463 |
| listings/channels | 31 | 322 |
| advertising | 3 | 299 |
| products/catalog | 32 | 278 |
| admin/ops | 18 | 135 |
| marketing/content | 10 | 131 |
| orders | 7 | 124 |
| pricing | 6 | 59 |
| analytics/insights | 6 | 53 |
| webhooks/notifications | 11 | 45 |
| ai/agents | 6 | 43 |
| settings/connections | 8 | 43 |
| customers | 2 | 25 |
| health/infra | 2 | 8 |
| **TOTAL** | **149** | **2028** |

## 3. Full endpoint enumeration (by module, then file)

### fulfillment/inventory — 463 endpoints

#### routes/inventory.ts (prefix `/api`) — 7

- `POST /api/inventory/bulk-upload` — POST /inventory/bulk-upload
- `POST /api/inventory/variants/stock` — POST /inventory/variants/stock
- `POST /api/inventory/allocate` — POST /inventory/allocate
- `GET /api/inventory/top-level` — GET /inventory/top-level
- `GET /api/inventory/stats` — GET /inventory/stats
- `GET /api/inventory/:id` — GET /inventory/:id
- `GET /api/inventory/variants/:productId` — GET /inventory/variants/:productId

#### routes/inbound.routes.ts (prefix `(none)`) — 2

- `POST /api/inbound/sync-catalog` — create/run inbound sync catalog
- `GET /api/inbound/sync-status` — read inbound sync status

#### routes/fba-inbound-v2.routes.ts (prefix `/api`) — 10

- `GET /api/fba/inbound/v2` — GET /api/fba/inbound/v2 — list plans (latest first, paginated)
- `GET /api/fba/inbound/v2/:id` — GET /api/fba/inbound/v2/:id — single plan with full state
- `POST /api/fba/inbound/v2` — POST /api/fba/inbound/v2 — create new plan (step 1)
- `GET /api/fba/inbound/v2/:id/packing-options` — GET /api/fba/inbound/v2/:id/packing-options — step 2
- `POST /api/fba/inbound/v2/:id/packing-options/:optionId/confirm` — POST /api/fba/inbound/v2/:id/packing-options/:optionId/confirm — step 3
- `GET /api/fba/inbound/v2/:id/placement-options` — GET /api/fba/inbound/v2/:id/placement-options — step 4
- `POST /api/fba/inbound/v2/:id/placement-options/:optionId/confirm` — POST /api/fba/inbound/v2/:id/placement-options/:optionId/confirm — step 5
- `GET /api/fba/inbound/v2/:id/shipments/:shipmentId/transport-options` — GET /api/fba/inbound/v2/:id/shipments/:shipmentId/transport-options — step 6
- `POST /api/fba/inbound/v2/:id/transport-options/confirm` — POST /api/fba/inbound/v2/:id/transport-options/confirm — step 7
- `GET /api/fba/inbound/v2/:id/labels` — GET /api/fba/inbound/v2/:id/labels — step 8

#### routes/fulfillment.routes.ts (prefix `/api`) — 304

- `GET /api/fulfillment/overview` — OVERVIEW — dashboard tiles for /fulfillment index page
- `GET /api/fulfillment/stock-overview` — Legacy endpoint kept for backwards compatibility with current
- `GET /api/fulfillment/stock` — read fulfillment stock
- `GET /api/fulfillment/stock/:productId/movements` — read fulfillment stock movements
- `POST /api/fulfillment/stock/:productId/adjust` — create/run fulfillment stock adjust
- `GET /api/fulfillment/cycle-counts` — read fulfillment cycle counts
- `GET /api/fulfillment/cycle-counts/due` — S.17 — auto-scheduler endpoints
- `POST /api/fulfillment/cycle-counts/auto-schedule` — POST — manually trigger an auto-scheduled session right now (the
- `POST /api/fulfillment/cycle-counts` — create/run fulfillment cycle counts
- `GET /api/fulfillment/cycle-counts/:id` — read fulfillment cycle counts
- `POST /api/fulfillment/cycle-counts/:id/start` — create/run fulfillment cycle counts start
- `PATCH /api/fulfillment/cycle-counts/:id/items/:itemId` — update fulfillment cycle counts items
- `POST /api/fulfillment/cycle-counts/:id/items/:itemId/reconcile` — create/run fulfillment cycle counts items reconcile
- `POST /api/fulfillment/cycle-counts/:id/items/:itemId/ignore` — create/run fulfillment cycle counts items ignore
- `POST /api/fulfillment/cycle-counts/:id/complete` — create/run fulfillment cycle counts complete
- `POST /api/fulfillment/cycle-counts/:id/cancel` — create/run fulfillment cycle counts cancel
- `GET /api/fulfillment/shipments` — read fulfillment shipments
- `GET /api/fulfillment/shipments/search` — O.62: Cmd+K shipment search. Returns a lean payload (no items,
- `GET /api/fulfillment/shipments/:id` — read fulfillment shipments
- `POST /api/fulfillment/shipments` — create/run fulfillment shipments
- `POST /api/fulfillment/shipments/:id/print-label` — create/run fulfillment shipments print label
- `GET /api/api/public/track/:trackingNumber` — O.21: Public branded tracking
- `GET /api/fulfillment/shipments/:id/pack-slip.html` — O.37: pack slip print
- `POST /api/fulfillment/shipments/:id/release` — O.36: holds queue — release shipment from ON_HOLD
- `POST /api/fulfillment/shipments/:id/hold` — on hold manually (e.g., suspect address, fraud check, customer
- `POST /api/fulfillment/shipments/bulk-hold` — O.40: bulk hold + bulk release
- `POST /api/fulfillment/shipments/bulk-mark-shipped` — F1.9 — bulk-mark-shipped. LABEL_PRINTED → SHIPPED in one server
- `POST /api/fulfillment/shipments/bulk-void-label` — F1.9 — bulk-void-label. Sendcloud's voidParcel is per-parcel
- `POST /api/fulfillment/shipments/bulk-release` — create/run fulfillment shipments bulk release
- `GET /api/fulfillment/outbound/events` — O.32: SSE event stream  **[SSE]**
- `GET /api/fulfillment/outbound/analytics` — O.31: Outbound analytics
- `POST /api/fulfillment/shipments/:id/split` — O.29: Multi-package — split shipment
- `GET /api/fulfillment/shipments/:id/customs-preflight` — read fulfillment shipments customs preflight
- `GET /api/fulfillment/shipments/:id/customs-declaration.html` — F1.8 — UPU CN22 / CN23 customs declaration (printable HTML).
- `POST /api/fulfillment/shipments/:id/pack` — O.13: pack station — capture weight + dimensions + scan-verify
- `GET /api/fulfillment/shipments/:id/rates` — O.28: Rate shopping
- `PATCH /api/fulfillment/shipments/:id/service` — O.28: bind operator's chosen carrier + service to the shipment.
- `POST /api/fulfillment/shipments/:id/void-label` — O.34: void label
- `POST /api/fulfillment/shipments/:id/reprint-label` — O.34: re-print label (existing label PDF, no Sendcloud call)
- `POST /api/fulfillment/shipments/:id/mark-shipped` — create/run fulfillment shipments mark shipped
- `POST /api/fulfillment/shipments/bulk-create` — create/run fulfillment shipments bulk create
- `POST /api/fulfillment/outbound/preflight-bulk` — O.69: bulk-create preflight. Operators want to know "if I click
- `GET /api/fulfillment/outbound/pending-orders` — O.4: Pending-shipment aggregation
- `GET /api/fulfillment/outbound/orders/:id` — O.5: Outbound order detail (drawer)
- `GET /api/fulfillment/shipping-rules` — Order routing rules — CRUD for OrderRoutingRule. Powers the
- `POST /api/fulfillment/shipping-rules` — create/run fulfillment shipping rules
- `PATCH /api/fulfillment/shipping-rules/:id` — update fulfillment shipping rules
- `POST /api/fulfillment/shipping-rules/simulate` — O.57: rules simulator
- `DELETE /api/fulfillment/shipping-rules/:id` — delete fulfillment shipping rules
- `GET /api/fulfillment/routing-rules` — /fulfillment/routing-rules admin page and is consumed by
- `POST /api/fulfillment/routing-rules` — create/run fulfillment routing rules
- `PATCH /api/fulfillment/routing-rules/:id` — update fulfillment routing rules
- `DELETE /api/fulfillment/routing-rules/:id` — delete fulfillment routing rules
- `POST /api/fulfillment/routing-rules/preview` — Routing dry-run — operator types in match criteria, server returns
- `GET /api/fulfillment/pick-list` — read fulfillment pick list
- `POST /api/fulfillment/pick-list/:id/picked` — create/run fulfillment pick list picked
- `GET /api/fulfillment/inbound` — read fulfillment inbound
- `GET /api/fulfillment/inbound/kpis` — H.3 — KPI strip for /fulfillment/inbound. Counts driven by the
- `GET /api/fulfillment/inbound/events` — H.14 — SSE stream of inbound events. Long-lived GET; keeps a  **[SSE]**
- `GET /api/fulfillment/inbound/events/stats` — read fulfillment inbound events stats
- `GET /api/fulfillment/carriers/inbound` — H.15 — server-side inbound carrier registry. Frontend pulls
- `POST /api/fulfillment/carriers/inbound/validate-tracking` — create/run fulfillment carriers inbound validate tracking
- `GET /api/fulfillment/inbound/qc-queue` — H.12 — QC queue. Cross-shipment view of items currently in
- `GET /api/fulfillment/inbound/:id` — read fulfillment inbound
- `PATCH /api/fulfillment/inbound/:id/costs` — H.11 — patch costs. Updates shipment-level cost fields and/or
- `PATCH /api/fulfillment/inbound/:id/compliance` — H.16 — compliance update. Per-line lot/expiry on
- `GET /api/fulfillment/inbound/:id/discrepancies/report.pdf` — H.17 — inbound discrepancy report PDF. Generates a one-page  **[file-download]**
- `GET /api/fulfillment/inbound/lots/:lotNumber` — H.16 — recall lookup. Given a lot number, return every
- `POST /api/fulfillment/inbound` — create/run fulfillment inbound
- `GET /api/fulfillment/inbound/receive-candidates` — Receive inbound items. H.0b — event-log idempotent flow,
- `POST /api/fulfillment/inbound/:id/receive` — create/run fulfillment inbound receive
- `POST /api/fulfillment/inbound/:id/transition` — H.2 — explicit state machine transition. Auto-transitions still
- `POST /api/fulfillment/inbound/:id/items/:itemId/scrap` — H.2 — release QC HOLD/FAIL units to stock. Default releases the
- `POST /api/fulfillment/inbound/:id/items/:itemId/release-hold` — create/run fulfillment inbound items release hold
- `POST /api/fulfillment/inbound/:id/items/:itemId/upload-photo` — H.7 — multipart upload: receives a binary file (camera capture or
- `POST /api/fulfillment/inbound/:id/items/:itemId/photos` — H.2 — append a photo URL to an item's proof gallery. Cloudinary
- `POST /api/fulfillment/inbound/:id/attachments` — H.2 — register an attachment uploaded to Cloudinary. Body:
- `POST /api/fulfillment/inbound/:id/discrepancies` — H.2 — record a discrepancy (ship-level or line-level).
- `PATCH /api/fulfillment/inbound/discrepancies/:did` — H.2 — update discrepancy status. Triggers maybeAutoTransition so
- `POST /api/fulfillment/inbound/:id/close` — /close kept as a convenience alias for transition→CLOSED.
- `POST /api/fulfillment/fba/plan-shipment` — H.8a — real SP-API createInboundShipmentPlan. v0 endpoint
- `POST /api/fulfillment/fba/create-shipment` — create/run fulfillment fba create shipment
- `GET /api/fulfillment/fba/shipments` — read fulfillment fba shipments
- `POST /api/fulfillment/fba/shipments/:id/labels` — H.8b — real SP-API getLabels. The :id param accepts EITHER the
- `POST /api/fulfillment/fba/shipments/:id/transport` — F.6.6 (TECH_DEBT #50) — v0 transport-booking route removed.
- `POST /api/fulfillment/fba/poll-status` — H.8d — FBA status polling. POST trigger for manual reconcile;
- `GET /api/fulfillment/fba/poll-status` — read fulfillment fba poll status
- `GET /api/fulfillment/suppliers` — read fulfillment suppliers
- `GET /api/fulfillment/suppliers/:id` — read fulfillment suppliers
- `GET /api/fulfillment/suppliers/:id/catalog` — PO.5 — supplier-product catalog feed for the smart Create-PO modal.
- `GET /api/fulfillment/fx-rate` — PO.5 — point-in-time FX rate lookup for the Create-PO modal's
- `GET /api/fulfillment/suppliers/:id/scorecard` — H.13 — supplier scorecard. Aggregates from PurchaseOrder +
- `POST /api/fulfillment/suppliers` — create/run fulfillment suppliers
- `PATCH /api/fulfillment/suppliers/:id` — update fulfillment suppliers
- `DELETE /api/fulfillment/suppliers/:id` — S2 — delete a supplier. Guard: refuse when it has purchase orders (keep PO
- `GET /api/fulfillment/suppliers/:id/contacts` — PD.2 — supplier contact persons (multi-contact book)
- `POST /api/fulfillment/suppliers/:id/contacts` — create/run fulfillment suppliers contacts
- `PATCH /api/fulfillment/suppliers/:id/contacts/:contactId` — update fulfillment suppliers contacts
- `DELETE /api/fulfillment/suppliers/:id/contacts/:contactId` — delete fulfillment suppliers contacts
- `GET /api/fulfillment/suppliers/:id/comms` — PD.3 — supplier comms log (timeline + compose-and-send)
- `POST /api/fulfillment/suppliers/:id/comms` — Log a manual touch-point (call / WhatsApp / note). No send.
- `POST /api/fulfillment/suppliers/:id/comms/email` — Compose-and-send an email to a supplier contact; logs the outcome.
- `GET /api/fulfillment/suppliers/followups/due` — PD.4 — supplier follow-ups / reminders
- `GET /api/fulfillment/suppliers/:id/followups` — read fulfillment suppliers followups
- `POST /api/fulfillment/suppliers/:id/followups` — create/run fulfillment suppliers followups
- `PATCH /api/fulfillment/suppliers/:id/followups/:fid` — update fulfillment suppliers followups
- `DELETE /api/fulfillment/suppliers/:id/followups/:fid` — delete fulfillment suppliers followups
- `GET /api/fulfillment/development/projects` — read fulfillment development projects
- `POST /api/fulfillment/development/projects` — create/run fulfillment development projects
- `GET /api/fulfillment/development/projects/:id` — read fulfillment development projects
- `PATCH /api/fulfillment/development/projects/:id` — update fulfillment development projects
- `DELETE /api/fulfillment/development/projects/:id` — delete fulfillment development projects
- `POST /api/fulfillment/development/projects/:id/candidates` — create/run fulfillment development projects candidates
- `PATCH /api/fulfillment/development/projects/:id/candidates/:cid` — update fulfillment development projects candidates
- `DELETE /api/fulfillment/development/projects/:id/candidates/:cid` — delete fulfillment development projects candidates
- `POST /api/fulfillment/development/projects/:id/attachments` — PD.7 — tech-pack / reference / sample-photo attachments (Cloudinary).
- `PATCH /api/fulfillment/development/projects/:id/attachments/:aid` — FP.5 — edit attachment pack metadata (order / caption / include).
- `DELETE /api/fulfillment/development/projects/:id/attachments/:aid` — delete fulfillment development projects attachments
- `POST /api/fulfillment/development/projects/:id/sample-po` — PD.8 — spin a sample PO from a development project to a supplier.
- `POST /api/fulfillment/development/projects/:id/certifications` — PD.9 — development certifications (compliance)
- `PATCH /api/fulfillment/development/projects/:id/certifications/:cid` — update fulfillment development projects certifications
- `DELETE /api/fulfillment/development/projects/:id/certifications/:cid` — delete fulfillment development projects certifications
- `POST /api/fulfillment/development/projects/:id/launch` — PD.10 — launch: convert a development project into a real Product.
- `GET /api/fulfillment/development/projects/:id/factory-pack.pdf` — FP.6 — factory pack PDF: cover + brief + size chart + materials +  **[file-download]**
- `POST /api/fulfillment/development/projects/:id/send-pack` — FP.7 — generate + email the factory pack to a recipient (the factory).
- `POST /api/fulfillment/suppliers/:supplierId/products` — POST — add/replace a product in a supplier's catalog (idempotent upsert
- `PATCH /api/fulfillment/suppliers/:supplierId/products/:productId` — PATCH — update cost / moq / case-pack / lead-time / primary for an
- `DELETE /api/fulfillment/suppliers/:supplierId/products/:productId` — DELETE — remove a product from a supplier's catalog. If it was the
- `POST /api/fulfillment/suppliers/bulk-import` — POST — bulk upsert supplier-product costs/lead-times. The client parses
- `GET /api/fulfillment/purchase-orders` — read fulfillment purchase orders
- `GET /api/fulfillment/purchase-orders/:id` — read fulfillment purchase orders
- `POST /api/fulfillment/purchase-orders/:id/transition` — R.7 — workflow state machine. submit-for-review / approve / send /
- `PATCH /api/fulfillment/purchase-orders/:id` — PO.6 — edit-in-place: header-field patch with optimistic lock.
- `PATCH /api/fulfillment/purchase-orders/:id/lines` — PO.6 — edit-in-place: bulk-replace line items.
- `GET /api/fulfillment/purchase-orders/:id/audit` — R.7 — chronological audit trail for a PO. Lists every state
- `GET /api/fulfillment/purchase-orders/:id/event-log` — PO-Plus.8 — Persisted event log. Reads PoEventLog rows for one
- `POST /api/fulfillment/purchase-orders/:id/push-landed-cost` — PO.10 — Three-way match read-side endpoint.
- `GET /api/fulfillment/purchase-orders/:id/match` — read fulfillment purchase orders match
- `POST /api/fulfillment/purchase-orders/:id/attachments` — up to MAX_ATTACHMENT_BYTES. Operator can override kind via the
- `PATCH /api/fulfillment/purchase-orders/:id/attachments/:attachmentId` — post-upload (operator catches a misclassification).
- `DELETE /api/fulfillment/purchase-orders/:id/attachments/:attachmentId` — to also delete the Cloudinary asset; the bytes age out per the
- `POST /api/fulfillment/purchase-orders/:id/comments` — create/run fulfillment purchase orders comments
- `DELETE /api/fulfillment/purchase-orders/:id/comments/:commentId` — PO.7 — Delete a comment. Soft-delete is overkill for comments; we
- `POST /api/fulfillment/purchase-orders/:id/revisions` — POST /:id/revisions — open a new revision.
- `PATCH /api/fulfillment/purchase-orders/:id/revisions/:revisionId` — items. The frozen `before` snapshot is preserved. Only PENDING
- `POST /api/fulfillment/purchase-orders/:id/revisions/:revisionId/apply` — `after` items to the PO. Bumps PO.version, replaces line items,
- `POST /api/fulfillment/purchase-orders/:id/revisions/:revisionId/cancel` — revision. Only PENDING revisions can be cancelled this way; once
- `GET /api/fulfillment/purchase-orders/:id/factory.pdf` — F.6 — Factory-ready PDF for a PO. Renders letterhead with company  **[file-download]**
- `POST /api/fulfillment/purchase-orders` — create/run fulfillment purchase orders
- `POST /api/fulfillment/purchase-orders/:id/submit` — create/run fulfillment purchase orders submit
- `POST /api/fulfillment/purchase-orders/:id/receive` — create/run fulfillment purchase orders receive
- `POST /api/fulfillment/purchase-orders/:id/quick-receive` — PO-Plus.3 — One-shot receive from the PO detail page. Creates the
- `GET /api/fulfillment/purchase-orders/events` — PO.4 — Server-sent events for purchase orders. Mirrors the inbound  **[SSE]**
- `GET /api/fulfillment/purchase-orders/events/stats` — read fulfillment purchase orders events stats
- `GET /api/fulfillment/purchase-orders/cost-history` — read fulfillment purchase orders cost history
- `GET /api/fulfillment/purchase-orders/eoq-hint` — read fulfillment purchase orders eoq hint
- `POST /api/fulfillment/purchase-orders/ai-draft` — create/run fulfillment purchase orders ai draft
- `GET /api/fulfillment/po-templates` — List templates (live only; soft-deleted hidden by default).
- `GET /api/fulfillment/po-templates/:id` — read fulfillment po templates
- `POST /api/fulfillment/po-templates` — Create a template. Two modes:
- `PATCH /api/fulfillment/po-templates/:id` — update fulfillment po templates
- `DELETE /api/fulfillment/po-templates/:id` — delete fulfillment po templates
- `POST /api/fulfillment/po-templates/:id/instantiate` — Instantiate a template → fresh DRAFT PO. Body lets the operator
- `POST /api/fulfillment/po-templates/:id/schedules` — create/run fulfillment po templates schedules
- `PATCH /api/fulfillment/po-schedules/:id` — update fulfillment po schedules
- `DELETE /api/fulfillment/po-schedules/:id` — delete fulfillment po schedules
- `GET /api/fulfillment/purchase-orders/spend-summary` — read fulfillment purchase orders spend summary
- `GET /api/fulfillment/purchase-orders/export.csv` — read fulfillment purchase orders export.csv  **[file-download]**
- `POST /api/fulfillment/purchase-orders/import-preview` — create/run fulfillment purchase orders import preview
- `POST /api/fulfillment/purchase-orders/import` — create/run fulfillment purchase orders import
- `GET /api/po/ack/:token` — read po ack
- `POST /api/po/ack/:token/confirm` — create/run po ack confirm
- `POST /api/po/ack/:token/decline` — create/run po ack decline
- `GET /api/po/approve/:token` — read po approve
- `POST /api/po/approve/:token/approve` — create/run po approve approve
- `POST /api/po/approve/:token/decline` — create/run po approve decline
- `GET /api/fulfillment/work-orders` — read fulfillment work orders
- `POST /api/fulfillment/work-orders` — create/run fulfillment work orders
- `POST /api/fulfillment/work-orders/:id/complete` — create/run fulfillment work orders complete
- `GET /api/fulfillment/replenishment` — read fulfillment replenishment
- `POST /api/fulfillment/replenishment/refresh-aggregates` — F.1 — Manual recompute. Re-aggregates OrderItem rows in the given
- `POST /api/fulfillment/sales-reports/ingest` — F.3 — Manual sales-report ingest trigger. Without a date range,
- `POST /api/fulfillment/replenishment/pipeline/run` — W1.3 — Operator-triggered "run pipeline now". Runs the four
- `GET /api/fulfillment/replenishment/upcoming-events` — F.5 — Upcoming retail events for the banner. Returns events whose
- `GET /api/fulfillment/facets` — F.5.1 — Facets for /fulfillment/replenishment filter dropdowns.
- `GET /api/fulfillment/replenishment/forecast-accuracy` — R.1 — Per-SKU forecast accuracy. Drawer card + per-product
- `GET /api/fulfillment/replenishment/forecast-accuracy/aggregate` — R.1 — aggregate accuracy. Powers the workspace "Forecast health"
- `POST /api/fulfillment/replenishment/forecast-accuracy/backfill` — R.1 — manual backfill. One-shot at deploy time so dashboards have  **[destructive?]**
- `GET /api/fulfillment/replenishment/:productId/forecast-detail` — F.5 — Per-SKU forecast detail. Returns 90 days of point forecasts,
- `POST /api/fulfillment/replenishment/bulk-draft-po` — F.5 — Bulk draft PO. Accepts an array of {productId, quantity,
- `GET /api/fulfillment/replenishment/forecast-backtest` — F.4 — Manual forecast trigger. Without a body, regenerates forecasts
- `GET /api/fulfillment/replenishment/sales-by-sku` — RX.S1 — lean per-SKU sales over an operator-chosen timeframe. Kept
- `GET /api/fulfillment/forecast/seasonality-preview` — RX.B1 — read-only preview of the category seasonal indices that the
- `POST /api/fulfillment/forecast/run` — create/run fulfillment forecast run
- `POST /api/fulfillment/replenishment/:productId/draft-po` — create/run fulfillment replenishment draft po
- `GET /api/fulfillment/replenishment/:productId/history` — R.3 — recommendation history per product. Chronological list of
- `GET /api/fulfillment/replenishment/recommendations/:id` — R.3 — single recommendation by id. Useful for forensics + future
- `GET /api/fulfillment/replenishment-views` — Replenishment saved views — named filter+sort presets
- `POST /api/fulfillment/replenishment-views` — create/run fulfillment replenishment views
- `PATCH /api/fulfillment/replenishment-views/:id` — update fulfillment replenishment views
- `DELETE /api/fulfillment/replenishment-views/:id` — delete fulfillment replenishment views
- `POST /api/fulfillment/replenishment/recommendations/bulk-dismiss` — R.21 — Bulk-dismiss N recommendations in one call. Body:
- `POST /api/fulfillment/replenishment/recommendations/:id/dismiss` — R.21 — Dismiss a recommendation. Status ACTIVE → DISMISSED.
- `POST /api/fulfillment/replenishment/auto-po/run` — R.6 — auto-PO manual trigger. POST runs the sweep + writes a real
- `GET /api/fulfillment/replenishment/auto-po/status` — R.6 — auto-PO status. Returns the latest run + the global config
- `GET /api/fulfillment/replenishment/pipeline/health` — W1.4 — pipeline health summary for the workspace's "Pipeline
- `GET /api/fulfillment/replenishment/slow-movers` — W6.1 — Slow-mover / dead-stock surface. The audit found 264
- `POST /api/fulfillment/replenishment/slow-movers/:productId/suggest-markdown` — create/run fulfillment replenishment slow movers suggest markdown
- `POST /api/fulfillment/replenishment/slow-movers/:productId/confirm-write-off` — W6.3 — Confirm write-off. Hard-action endpoint that actually
- `POST /api/fulfillment/replenishment/slow-movers/:productId/flag-write-off` — create/run fulfillment replenishment slow movers flag write off
- `GET /api/fulfillment/replenishment/suppliers/spend-summary` — W9.3 — Per-supplier spend summary. Closes the audit's
- `GET /api/fulfillment/replenishment/forecast-bias` — W8.4 — Per-SKU forecast bias. Closes the audit's
- `GET /api/fulfillment/replenishment/cannibalization` — W8.3 — Cannibalization detection. Inverse of R.17 substitution:
- `GET /api/fulfillment/replenishment/products/:productId/new-listing-demand` — W7.4 — New-listing demand estimator. Cold-start helper: a
- `GET /api/fulfillment/replenishment/pan-eu/imbalances` — W7.1 — Pan-EU FBA distribution recommender. Aggregates
- `GET /api/fulfillment/replenishment/scenarios` — read fulfillment replenishment scenarios
- `POST /api/fulfillment/replenishment/scenarios` — create/run fulfillment replenishment scenarios
- `GET /api/fulfillment/replenishment/scenarios/:id` — read fulfillment replenishment scenarios
- `DELETE /api/fulfillment/replenishment/scenarios/:id` — delete fulfillment replenishment scenarios
- `POST /api/fulfillment/replenishment/scenarios/:id/run` — W5.3 — Execute the scenario against current state. Always
- `GET /api/fulfillment/replenishment/scenarios/:id/runs` — read fulfillment replenishment scenarios runs
- `GET /api/fulfillment/replenishment/scenarios/:id/runs/:runId` — read fulfillment replenishment scenarios runs
- `GET /api/fulfillment/replenishment/command-center/kpis` — W3.1 — Operator command-center KPIs. The "what should I do
- `GET /api/fulfillment/replenishment/automation/rules` — read fulfillment replenishment automation rules
- `POST /api/fulfillment/replenishment/automation/rules` — create/run fulfillment replenishment automation rules
- `GET /api/fulfillment/replenishment/automation/rules/:id` — read fulfillment replenishment automation rules
- `PATCH /api/fulfillment/replenishment/automation/rules/:id` — update fulfillment replenishment automation rules
- `DELETE /api/fulfillment/replenishment/automation/rules/:id` — delete fulfillment replenishment automation rules
- `POST /api/fulfillment/replenishment/automation/rules/:id/test` — W4.3 — Test a rule against an operator-supplied context payload.
- `POST /api/fulfillment/replenishment/automation/run` — W4.8 — Manual evaluator run. Fires the same logic the W4.6 cron
- `GET /api/fulfillment/replenishment/automation/cron-status` — W4.8 — Cron status for the automation evaluator. Mirrors the
- `POST /api/fulfillment/replenishment/automation/emergency-disable-all` — W4.7 — Emergency disable-all. The failsafe the operator reaches
- `GET /api/fulfillment/replenishment/automation/rules/templates` — W4.4 — Pre-built rule template catalogue. Read-only; the seeder
- `POST /api/fulfillment/replenishment/automation/rules/seed-templates` — W4.4 — Idempotent seeder. Creates any template that doesn't
- `GET /api/fulfillment/replenishment/automation/rules/:id/executions` — W4.3 — Execution history for one rule. Limit-controlled, newest
- `POST /api/fulfillment/replenishment/lead-time-stats/recompute` — R.11 — manual lead-time stats recompute. Useful at deploy time
- `GET /api/fulfillment/replenishment/lead-time-stats/status` — read fulfillment replenishment lead time stats status
- `GET /api/fulfillment/replenishment/stockouts/summary` — R.12 — stockout ledger surfaces.
- `GET /api/fulfillment/replenishment/stockouts/events` — read fulfillment replenishment stockouts events
- `POST /api/fulfillment/replenishment/stockouts/sweep` — create/run fulfillment replenishment stockouts sweep
- `GET /api/fulfillment/replenishment/stockouts/status` — read fulfillment replenishment stockouts status
- `GET /api/fulfillment/replenishment/forecast-models/active` — R.16 — forecast model A/B routing.
- `POST /api/fulfillment/replenishment/forecast-models/rollout` — create/run fulfillment replenishment forecast models rollout
- `POST /api/fulfillment/replenishment/forecast-models/pin` — create/run fulfillment replenishment forecast models pin
- `POST /api/fulfillment/replenishment/forecast-models/promote` — create/run fulfillment replenishment forecast models promote
- `POST /api/fulfillment/replenishment/forecast-models/seed-champions` — create/run fulfillment replenishment forecast models seed champions
- `GET /api/fulfillment/replenishment/auto-po/runs` — R.6 — auto-PO run history. Forensic ledger; latest first.
- `GET /api/fulfillment/replenishment/substitutions/:productId` — R.17 — substitution links CRUD
- `POST /api/fulfillment/replenishment/substitutions` — Create. Body accepts either {primaryProductId | primarySku} +
- `PATCH /api/fulfillment/replenishment/substitutions/:id` — Update fraction.
- `DELETE /api/fulfillment/replenishment/substitutions/:id` — Delete.
- `GET /api/fulfillment/replenishment/products/:productId/supplier-comparison` — R.9 — multi-supplier comparison
- `POST /api/fulfillment/replenishment/products/:productId/preferred-supplier` — Switch the preferred supplier on a product's ReplenishmentRule.
- `POST /api/fulfillment/replenishment/fba-restock/refresh` — R.8 — Amazon FBA Restock Reports
- `GET /api/fulfillment/replenishment/fba-restock/status` — Status summary for the page card.
- `GET /api/fulfillment/replenishment/fba-restock/by-sku/:sku` — Drawer drill-down: latest row for one (sku, marketplaceCode).
- `GET /api/fulfillment/replenishment/cash-flow/projection` — R.20 — cash-flow projection
- `PUT /api/fulfillment/replenishment/cash-flow/cash-on-hand` — PUT cash on hand. Single-row BrandSettings convention.
- `GET /api/fulfillment/supplier-shipping-profiles/:supplierId` — R.19 — supplier shipping profiles
- `PUT /api/fulfillment/supplier-shipping-profiles/:supplierId` — replace fulfillment supplier shipping profiles
- `POST /api/fulfillment/replenishment/container-fill` — Container fill snapshot. Reuses the live recommendation list to
- `GET /api/fulfillment/carriers` — read fulfillment carriers
- `POST /api/fulfillment/carriers/:code/connect` — create/run fulfillment carriers connect
- `POST /api/fulfillment/carriers/:code/test` — CR.2 — "Test connection" endpoint.
- `POST /api/fulfillment/carriers/:code/disconnect` — create/run fulfillment carriers disconnect
- `GET /api/fulfillment/carriers/:code/services` — carrier's API + cached CarrierService rows. Today: only SENDCLOUD;
- `GET /api/fulfillment/carriers/:code/mappings` — marketplace × warehouse → service mappings for this carrier.
- `POST /api/fulfillment/carriers/:code/mappings` — mapping. Body: { channel, marketplace, warehouseId?, service:
- `DELETE /api/fulfillment/carriers/:code/mappings/:id` — Doesn't touch the underlying CarrierService row (other mappings
- `GET /api/fulfillment/carriers/:code/accounts` — CR.9 — secondary carrier accounts.
- `POST /api/fulfillment/carriers/:code/accounts` — create/run fulfillment carriers accounts
- `PATCH /api/fulfillment/carriers/:code/accounts/:id` — update fulfillment carriers accounts
- `DELETE /api/fulfillment/carriers/:code/accounts/:id` — delete fulfillment carriers accounts
- `POST /api/fulfillment/carriers/:code/accounts/:id/test` — CR.25 — test connection on a SECONDARY carrier account.
- `POST /api/fulfillment/carriers/:code/webhook-secret/rotate` — CR.20 — rotate the per-carrier webhook signing secret.
- `POST /api/fulfillment/carriers/:code/services/sync` — CR.12 — manual catalog refresh. Runs the same logic as the
- `POST /api/fulfillment/carriers/metrics/refresh` — CR.23 — manual metrics pre-warm. Same logic as the nightly cron
- `GET /api/fulfillment/carriers/:code/pickups` — CR.16 — pickup scheduling. PickupSchedule rows; one-time SENDCLOUD
- `POST /api/fulfillment/carriers/:code/pickups` — create/run fulfillment carriers pickups
- `POST /api/fulfillment/carriers/:code/pickups/:id/cancel` — create/run fulfillment carriers pickups cancel
- `PATCH /api/fulfillment/carriers/:code/preferences` — CR.13 — operator-tunable preferences.
- `GET /api/fulfillment/carriers/:code/sender-addresses` — CR.11 — Sendcloud sender addresses.
- `PATCH /api/fulfillment/warehouses/:id` — CR.11 — bind a Sendcloud sender_address ID to a warehouse.
- `GET /api/fulfillment/carriers/:code/metrics` — CR.15 — per-carrier performance metrics.
- `GET /api/fulfillment/warehouses` — read fulfillment warehouses
- `POST /api/fulfillment/fnsku/lookup` — create/run fulfillment fnsku lookup
- `GET /api/fulfillment/fnsku/templates` — read fulfillment fnsku templates
- `POST /api/fulfillment/fnsku/templates` — create/run fulfillment fnsku templates
- `PUT /api/fulfillment/fnsku/templates/:id` — replace fulfillment fnsku templates
- `DELETE /api/fulfillment/fnsku/templates/:id` — delete fulfillment fnsku templates
- `POST /api/fulfillment/fnsku/zpl` — create/run fulfillment fnsku zpl  **[file-download]**
- `POST /api/fulfillment/fnsku/pdf` — create/run fulfillment fnsku pdf  **[file-download]**
- `POST /api/fulfillment/inbound/bulk-soft-delete` — create/run fulfillment inbound bulk soft delete
- `POST /api/fulfillment/inbound/bulk-restore` — create/run fulfillment inbound bulk restore  **[destructive?]**
- `POST /api/fulfillment/inbound/bulk-hard-delete` — create/run fulfillment inbound bulk hard delete
- `POST /api/fulfillment/shipments/bulk-soft-delete` — create/run fulfillment shipments bulk soft delete
- `POST /api/fulfillment/shipments/bulk-restore` — create/run fulfillment shipments bulk restore  **[destructive?]**
- `POST /api/fulfillment/shipments/bulk-hard-delete` — create/run fulfillment shipments bulk hard delete
- `POST /api/fulfillment/purchase-orders/bulk-reassign-supplier` — PO.16 — Bulk transition. Runs transitionPo per id and returns a
- `POST /api/fulfillment/purchase-orders/bulk-merge` — PO-Plus.5 — Bulk merge POs into a single new DRAFT.
- `POST /api/fulfillment/purchase-orders/bulk-transition` — create/run fulfillment purchase orders bulk transition
- `POST /api/fulfillment/purchase-orders/bulk-soft-delete` — create/run fulfillment purchase orders bulk soft delete
- `POST /api/fulfillment/purchase-orders/bulk-restore` — create/run fulfillment purchase orders bulk restore  **[destructive?]**
- `POST /api/fulfillment/purchase-orders/bulk-hard-delete` — create/run fulfillment purchase orders bulk hard delete

#### routes/returns.routes.ts (prefix `/api`) — 51

- `GET /api/fulfillment/returns/analytics` — O.76: returns analytics. The returns surface had per-return
- `GET /api/fulfillment/returns/intelligence` — RX.5 — returns intelligence: customer-level serial-returner risk
- `GET /api/fulfillment/returns/defect-recall` — RX.6a — defect → recall signals (migration-free). Clusters defect
- `GET /api/fulfillment/returns` — R1.1 — list endpoint upgrades:
- `GET /api/fulfillment/returns/:id` — R2.1 — drawer detail include. Pulls the parent Order's customer
- `GET /api/fulfillment/returns/:id/full` — RX.0 — Drawer aggregate. The detail drawer used to fire four
- `GET /api/fulfillment/returns/command-center` — RX.1 — Returns Command Center aggregate. One endpoint feeds the
- `POST /api/fulfillment/returns` — B7 — Idempotency. Operators on flaky mobile networks were double-
- `POST /api/fulfillment/returns/:id/receive` — B2 — Receive emits no StockMovement (the units aren't in our
- `POST /api/fulfillment/returns/:id/inspect` — R3.2 — accepts per-item disposition + scrapReason. Auto-derives
- `POST /api/fulfillment/returns/:id/restock` — create/run fulfillment returns restock
- `POST /api/fulfillment/returns/:id/refund` — H.14 — refund publish.
- `POST /api/fulfillment/returns/:id/label` — Return label workflow — operator-driven for v0. The carrier
- `POST /api/fulfillment/returns/:id/label/mark-emailed` — create/run fulfillment returns label mark emailed
- `DELETE /api/fulfillment/returns/:id/label` — delete fulfillment returns label
- `POST /api/fulfillment/returns/:id/generate-label` — O.75: native Sendcloud return-label generation. Replaces the
- `POST /api/fulfillment/returns/:id/scrap` — B1 — Scrap stock semantics. The pre-R0.3 code only flipped the
- `GET /api/fulfillment/returns/:id/modulo-recesso.pdf` — read fulfillment returns modulo recesso.pdf  **[file-download]**
- `POST /api/fulfillment/returns/:id/send-email` — create/run fulfillment returns send email
- `GET /api/fulfillment/returns/risk-scores` — R7.2 — predictive risk: per-SKU return-rate scoring with
- `GET /api/fulfillment/returns/refund-deadline-summary` — R6.2 — refund-deadline summary. Returns approaching/overdue
- `POST /api/fulfillment/returns/:id/refund/retry` — R5.3 — manual retry for a failed refund. Bypasses the cron's
- `GET /api/fulfillment/returns/:id/refund/retry-status` — R5.3 — retry status (used by the drawer to render "next retry
- `GET /api/fulfillment/returns/refund-channel-status` — R5.2 — refund-adapter status diagnostic.
- `GET /api/fulfillment/return-policies` — read fulfillment return policies
- `POST /api/fulfillment/return-policies` — create/run fulfillment return policies
- `PATCH /api/fulfillment/return-policies/:id` — update fulfillment return policies
- `DELETE /api/fulfillment/return-policies/:id` — delete fulfillment return policies
- `GET /api/fulfillment/return-policies/resolve` — Resolution helper exposed for the frontend so the create-return
- `GET /api/fulfillment/returns/:id/policy` — Per-return policy view: drawer shows the matched policy +
- `GET /api/fulfillment/returns/:id/audit-log` — R2.1 — Per-return audit log (drawer activity timeline)
- `PATCH /api/fulfillment/returns/:id` — R2.2 — Operator notes + per-item PATCH + photo gallery
- `PATCH /api/fulfillment/returns/:id/items/:itemId` — update fulfillment returns items
- `PATCH /api/fulfillment/returns/:id/warranty` — RX.6b — warranty track. WARRANTY/DEFECT returns run a diagnosis →
- `POST /api/fulfillment/returns/:id/items/:itemId/upload-photo` — create/run fulfillment returns items upload photo
- `DELETE /api/fulfillment/returns/:id/items/:itemId/photos` — delete fulfillment returns items photos
- `POST /api/fulfillment/returns/bulk/approve` — create/run fulfillment returns bulk approve
- `POST /api/fulfillment/returns/bulk/deny` — create/run fulfillment returns bulk deny
- `POST /api/fulfillment/returns/bulk/receive` — create/run fulfillment returns bulk receive
- `GET /api/fulfillment/returns/automation/preview` — RX.4 — Automation engine (guardrailed, diff-then-apply)
- `POST /api/fulfillment/returns/automation/apply` — create/run fulfillment returns automation apply
- `GET /api/fulfillment/returns/export.csv` — read fulfillment returns export.csv  **[file-download]**
- `GET /api/fulfillment/returns/:id/refunds` — R5.1 — Refund history (read-only list of Refund rows)
- `POST /api/fulfillment/returns/ebay/ingest-test` — R4.2 / R4.3 — Channel webhook test endpoints (env-gated)
- `POST /api/fulfillment/returns/ebay/poll-test` — create/run fulfillment returns ebay poll test
- `POST /api/fulfillment/returns/amazon/ingest-test` — create/run fulfillment returns amazon ingest test
- `GET /api/fulfillment/refunds/:id/credit-note` — read fulfillment refunds credit note
- `POST /api/fulfillment/refunds/:id/credit-note/assign` — create/run fulfillment refunds credit note assign
- `GET /api/fulfillment/refunds/:id/credit-note/xml` — read fulfillment refunds credit note xml  **[file-download]**
- `POST /api/fulfillment/refunds/:id/credit-note/dispatch` — create/run fulfillment refunds credit note dispatch
- `POST /api/fulfillment/returns/amazon/poll-test` — create/run fulfillment returns amazon poll test

#### routes/stock.routes.ts (prefix `/api`) — 73

- `GET /api/stock/products` — GET /api/stock/products
- `GET /api/stock` — GET /api/stock
- `GET /api/stock/sync-status` — GET /api/stock/sync-status
- `GET /api/stock/insights` — GET /api/stock/insights
- `GET /api/stock/by-product` — GET /api/stock/by-product
- `GET /api/stock/kpis` — GET /api/stock/kpis
- `GET /api/stock/locations` — GET /api/stock/locations
- `POST /api/stock/locations` — POST /api/stock/locations
- `PATCH /api/stock/locations/:id` — PATCH /api/stock/locations/:id
- `DELETE /api/stock/locations/:id` — DELETE /api/stock/locations/:id
- `GET /api/stock/product/:productId` — GET /api/stock/product/:productId
- `GET /api/stock/transfers` — GET /api/stock/transfers
- `GET /api/stock/reservations` — GET /api/stock/reservations
- `GET /api/stock/analytics/turnover` — GET /api/stock/analytics/turnover
- `GET /api/stock/analytics/eoq` — GET /api/stock/analytics/eoq
- `POST /api/stock/analytics/eoq/apply` — POST /api/stock/analytics/eoq/apply
- `GET /api/stock/analytics/abc` — GET /api/stock/analytics/abc
- `POST /api/stock/analytics/abc/recompute` — POST /api/stock/analytics/abc/recompute
- `GET /api/stock/analytics/dead-stock` — GET /api/stock/analytics/dead-stock
- `GET /api/stock/year-end-valuation` — GET /api/stock/year-end-valuation
- `POST /api/stock/year-end-valuation/snapshot` — POST /api/stock/year-end-valuation/snapshot
- `GET /api/stock/lots` — GET /api/stock/lots
- `GET /api/stock/lots/:id/trace` — GET /api/stock/lots/:id/trace
- `POST /api/stock/lots` — POST /api/stock/lots
- `GET /api/stock/serials` — GET /api/stock/serials
- `GET /api/stock/serials/:id/trace` — read stock serials trace
- `POST /api/stock/serials` — create/run stock serials
- `POST /api/stock/serials/:id/transition` — create/run stock serials transition
- `GET /api/stock/bins` — BN.3 — Bins
- `POST /api/stock/bins` — create/run stock bins
- `PATCH /api/stock/bins/:id` — update stock bins
- `POST /api/stock/bins/:id/deactivate` — create/run stock bins deactivate
- `POST /api/stock/bins/move` — create/run stock bins move
- `GET /api/stock/recalls` — GET /api/stock/recalls
- `POST /api/stock/recalls` — POST /api/stock/recalls
- `GET /api/stock/recalls/:id` — GET /api/stock/recalls/:id
- `POST /api/stock/recalls/:id/release-reservations` — POST /api/stock/recalls/:id/release-reservations
- `POST /api/stock/recalls/:id/close` — POST /api/stock/recalls/:id/close
- `GET /api/stock/fba-pan-eu` — GET /api/stock/fba-pan-eu
- `GET /api/stock/fba-pan-eu/aged` — GET /api/stock/fba-pan-eu/aged
- `GET /api/stock/fba-pan-eu/unfulfillable` — GET /api/stock/fba-pan-eu/unfulfillable
- `GET /api/stock/mcf` — GET /api/stock/mcf
- `POST /api/stock/mcf/create` — POST /api/stock/mcf/create
- `POST /api/stock/mcf/:id/sync` — POST /api/stock/mcf/:id/sync
- `POST /api/stock/mcf/:id/cancel` — POST /api/stock/mcf/:id/cancel
- `GET /api/stock/shopify-locations` — GET /api/stock/shopify-locations
- `POST /api/stock/shopify-locations/discover` — POST /api/stock/shopify-locations/discover
- `PATCH /api/stock/shopify-locations/:id` — PATCH /api/stock/shopify-locations/:id
- `GET /api/stock/cost-layers/:productId` — GET /api/stock/cost-layers/:productId
- `POST /api/stock/cost-layers/:productId/recompute-wac` — POST /api/stock/cost-layers/:productId/recompute-wac
- `GET /api/stock/movements` — GET /api/stock/movements
- `PATCH /api/stock/:id` — PATCH /api/stock/:id
- `POST /api/stock/adjust-location` — POST /api/stock/adjust-location
- `POST /api/stock/bulk-transfer` — POST /api/stock/bulk-transfer
- `POST /api/stock/bulk-import` — POST /api/stock/bulk-import
- `POST /api/stock/import/parse` — POST /api/stock/import/parse
- `POST /api/stock/import/resolve` — POST /api/stock/import/resolve
- `POST /api/stock/import/preview` — POST /api/stock/import/preview
- `POST /api/stock/import/apply` — POST /api/stock/import/apply
- `GET /api/stock/import/aliases` — GET /api/stock/import/aliases
- `POST /api/stock/import/aliases` — POST /api/stock/import/aliases
- `DELETE /api/stock/import/aliases/:id` — DELETE /api/stock/import/aliases/:id
- `GET /api/stock/import/history` — GET /api/stock/import/history
- `GET /api/stock/import/history/:id` — GET /api/stock/import/history/:id
- `POST /api/stock/transfer` — POST /api/stock/transfer
- `POST /api/stock/reserve` — POST /api/stock/reserve
- `POST /api/stock/release/:reservationId` — POST /api/stock/release/:reservationId
- `POST /api/stock/sync` — POST /api/stock/sync
- `GET /api/stock/pool-drift` — FCF.6: per-pool fulfillment drift triage
- `GET /api/stock/channel-events` — read stock channel events
- `POST /api/stock/channel-events` — create/run stock channel events
- `POST /api/stock/channel-events/:id/apply` — create/run stock channel events apply
- `POST /api/stock/channel-events/:id/ignore` — create/run stock channel events ignore

#### routes/reconciliation.routes.ts (prefix `/api`) — 16

- `POST /api/reconciliation/run` — Trigger a run
- `GET /api/reconciliation/stats` — Stats
- `GET /api/reconciliation/items` — List rows
- `POST /api/reconciliation/items/:id/confirm` — Single-row actions
- `POST /api/reconciliation/items/:id/link` — create/run reconciliation items link
- `POST /api/reconciliation/items/:id/status` — create/run reconciliation items status
- `POST /api/reconciliation/bulk/confirm` — Confirm multiple specific rows
- `POST /api/reconciliation/bulk/status` — Set status on multiple rows
- `POST /api/reconciliation/bulk/confirm-all-high` — Confirm ALL high-confidence pending rows for a channel+marketplace in one click.
- `POST /api/reconciliation/flat-file-pull/start` — POST /api/reconciliation/flat-file-pull/start
- `GET /api/reconciliation/flat-file-pull/status/:jobId` — GET /api/reconciliation/flat-file-pull/status/:jobId
- `POST /api/reconciliation/flat-file-pull/start-all` — POST /api/reconciliation/flat-file-pull/start-all
- `GET /api/reconciliation/flat-file-pull/status-all/:jobId` — GET /api/reconciliation/flat-file-pull/status-all/:jobId
- `POST /api/reconciliation/propagate/start` — POST /api/reconciliation/propagate/start
- `GET /api/reconciliation/propagate/status/:jobId` — GET /api/reconciliation/propagate/status/:jobId
- `GET /api/reconciliation/product-types` — GET /api/reconciliation/product-types

### listings/channels — 322 endpoints

#### routes/listings.ts (prefix `(none)`) — 8

- `POST /listings/sync-amazon-catalog` — Pulls the full active catalog from Amazon via the SP-API Reports API,
- `POST /listings/force-sync-ebay` — Manually triggers the Amazon → eBay sync without waiting for the cron schedule.  **[destructive?]**
- `POST /listings/generate` — Generate an AI-optimized eBay listing draft from a product using Gemini API
- `POST /listings/:draftId/publish` — Publishes a draft listing to eBay
- `GET /listings/products` — Get all imported Amazon products (ready to list)
- `GET /listings/published` — Get products with ebayItemId (published to eBay)
- `POST /listings/bulk-publish-to-ebay` — Queue a bulk publish job to eBay using BullMQ
- `GET /listings/bulk-publish-to-ebay/:jobId` — Poll job status using BullMQ

#### routes/marketplaces.ts (prefix `(none)`) — 8

- `GET /marketplaces/status` — Get status of all connected marketplaces
- `POST /marketplaces/prices/update` — Update prices across one or more marketplaces
- `POST /marketplaces/inventory/update` — Update inventory across one or more marketplaces
- `POST /marketplaces/variants/sync` — Sync a variant to one or more marketplaces
- `GET /marketplaces/variants/:variantId/listings` — Get all channel listings for a variant
- `POST /marketplaces/sync-all` — Sync all variants with price changes to their connected marketplaces
- `GET /marketplaces/health` — Get health status of all connected marketplaces
- `POST /marketplaces/products/:productId/sync` — Sync a product across multiple channels

#### routes/shopify.ts (prefix `(none)`) — 7

- `POST /shopify/sync/products` — Sync all products from Shopify to Nexus
- `POST /shopify/sync/inventory/to-shopify` — Sync inventory from Nexus to Shopify
- `POST /shopify/sync/inventory/from-shopify` — Sync inventory from Shopify to Nexus
- `POST /shopify/sync/orders` — Sync orders from Shopify to Nexus
- `POST /shopify/fulfillments/create` — Create a fulfillment for an order
- `GET /shopify/products/:productId` — Get a product from Shopify
- `GET /shopify/orders/:orderId` — Get an order from Shopify

#### routes/woocommerce.ts (prefix `(none)`) — 6

- `POST /woocommerce/sync/products` — Sync all products from WooCommerce to Nexus
- `POST /woocommerce/sync/inventory/to-woocommerce` — Sync inventory from Nexus to WooCommerce
- `POST /woocommerce/sync/inventory/from-woocommerce` — Sync inventory from WooCommerce to Nexus
- `POST /woocommerce/sync/orders` — Sync orders from WooCommerce to Nexus
- `POST /woocommerce/orders/:orderId/status` — Update order status in WooCommerce
- `POST /woocommerce/orders/:orderId/fulfillment` — Add fulfillment note to order

#### routes/etsy.ts (prefix `(none)`) — 6

- `POST /etsy/sync/listings` — Sync all listings from Etsy to Nexus
- `POST /etsy/sync/inventory/to-etsy` — Sync inventory from Nexus to Etsy
- `POST /etsy/sync/inventory/from-etsy` — Sync inventory from Etsy to Nexus
- `POST /etsy/sync/orders` — Sync orders from Etsy to Nexus
- `POST /etsy/orders/:orderId/status` — Update order status in Etsy
- `POST /etsy/orders/:orderId/fulfillment` — Add fulfillment note to order

#### routes/ebay.routes.ts (prefix `(none)`) — 10

- `POST /api/sync/ebay/inventory` — Trigger eBay inventory sync for a specific connection
- `GET /api/sync/ebay/inventory/:connectionId` — Get sync status for a connection
- `GET /api/sync/ebay/listings/:connectionId` — Get all VariantChannelListings for an eBay connection
- `GET /api/sync/ebay/unmatched/:connectionId` — Get unmatched eBay listings (for manual mapping)
- `POST /api/sync/ebay/listings/:listingId/link` — Manually link an eBay listing to a Nexus product
- `GET /api/ebay/pull-listing` — DD.3 — GET /api/ebay/pull-listing
- `GET /api/ebay/diagnostics` — HH — GET /api/ebay/diagnostics
- `GET /api/ebay/conditions` — GG.1 — GET /api/ebay/conditions
- `GET /api/ebay/policies` — GG.2 — GET /api/ebay/policies
- `POST /ebay/financials/sync` — Body: { start?, end?, daysBack? }. Defaults to yesterday.

#### routes/listing-health.routes.ts (prefix `(none)`) — 3

- `GET /api/catalog/:productId/listing-health` — Get listing health and readiness scores for all channels
- `GET /api/catalog/marketplace-presence` — Get marketplace presence and listing counts
- `GET /api/catalog/stock-alerts` — Get stock alerts for low and out-of-stock items

#### routes/amazon.routes.ts (prefix `/api/amazon`) — 46

- `GET /api/amazon/products` — GET /api/amazon/products - Fetch products from Amazon SP-API and sync to database
- `GET /api/amazon/products/debug-hierarchy` — GET /api/amazon/products/debug-hierarchy
- `GET /api/amazon/products/:id/children` — Canonical endpoint is GET /api/products/:id/children (channel-agnostic).
- `GET /api/amazon/products/count` — GET /api/amazon/products/count - Quick count + sample for debugging
- `GET /api/amazon/products/list` — Query params:
- `POST /api/amazon/products/cleanup-bad-parents` — Find phantom parents (placeholder PARENT-* SKU, null amazonAsin, or  **[destructive?]**
- `POST /api/amazon/products/clear-hierarchy` — Emergency reset: unlinks all parent/child relationships and deletes phantom
- `GET /api/amazon/products/verify-amazon-parents` — Calls getListingsItem for every local product matching sku_prefix and shows
- `GET /api/amazon/products/test-catalog-api` — Calls getCatalogItem (v2022-04-01) for an ASIN and returns the raw response or full error.
- `GET /api/amazon/test-catalog-api` — GET /api/amazon/test-catalog-api?asin=XXXXXXXXXX
- `POST /api/amazon/products/sync-hierarchy` — Source-of-truth hierarchy sync: for every Amazon SKU in the DB, calls
- `GET /api/amazon/products/probe-listing` — Calls getListingsItem on a single SKU with includedData=[
- `POST /api/amazon/products/merge` — Manual hierarchy merge — last-resort fallback when Catalog Items API and
- `POST /api/amazon/products/unmerge` — POST /products/unmerge — undo a merge by parent SKU
- `GET /api/amazon/pim/detect-groups` — GET /api/amazon/pim/detect-groups — preview, no DB writes
- `POST /api/amazon/pim/apply-groups` — POST /api/amazon/pim/apply-groups — apply approved groups
- `POST /api/amazon/pim/create-group` — POST /api/amazon/pim/create-group — manually create one master+children
- `POST /api/amazon/pim/unlink-child` — from their master. C.4 — accepts either {productId} (legacy, kept
- `DELETE /api/amazon/pim/master/:masterId` — DELETE /api/amazon/pim/master/:masterId — unlink children, delete master
- `POST /api/amazon/pim/link-amazon` — POST /api/amazon/pim/link-amazon — verify ASIN on Amazon, link to product
- `DELETE /api/amazon/pim/products/stale` — Body: { skus: string[] }
- `POST /api/amazon/pim/bulk-link-amazon` — POST /api/amazon/pim/bulk-link-amazon — link every product with an ASIN
- `POST /api/amazon/orders/sync` — Phase-26 unified Order schema. Two cursor modes:
- `POST /api/amazon/orders/backfill-zero-totals` — pass for orders ingested at €0.00. SP-API ListOrders withholds  **[destructive?]**
- `POST /api/amazon/inventory/sync` — SP-API getInventorySummaries into Product.totalStock. Two modes:
- `POST /api/amazon/financials/sync` — window and write FinancialTransaction rows. Body: { start?, end?, daysBack? }
- `POST /api/amazon/settlements/sync` — Lists already-published settlement reports in the window, downloads each,
- `GET /api/amazon/reconciliation` — Compares SP-API order/revenue/inventory totals against our DB for
- `POST /api/amazon/products/images/backfill` — Walks products with Amazon ASIN, calls getCatalogItem (includedData=  **[destructive?]**
- `POST /api/amazon/suppression/backfill` — Pulls GET_MERCHANT_LISTINGS_DEFECT_DATA per participating marketplace,  **[destructive?]**
- `POST /api/amazon/fba/reimbursements/backfill` — POST /api/amazon/fba/reimbursements/backfill — HB.5 reimbursements  **[destructive?]**
- `POST /api/amazon/fba/adjustments/backfill` — POST /api/amazon/fba/adjustments/backfill — HB.5 inventory adjustments  **[destructive?]**
- `POST /api/amazon/fba/inbound/backfill` — history backfill. Walks SP-API getShipments with LastUpdatedAfter,  **[destructive?]**
- `POST /api/amazon/returns/backfill` — POST /api/amazon/returns/backfill — HB.x returns 24mo  **[destructive?]**
- `POST /api/amazon/settlements/backfill` — POST /api/amazon/settlements/backfill — HB.2 settlements 24mo  **[destructive?]**
- `POST /api/amazon/participations/refresh` — getMarketplaceParticipations + writes back to our Marketplace table.
- `GET /api/amazon/participations` — participation status, read straight from our Marketplace table
- `GET /api/amazon/reconciliation/all` — Runs reconcileAmazon across every connected Amazon marketplace and
- `POST /api/amazon/aplus/sync` — Pulls all A+ Content documents from Amazon for the marketplace and
- `GET /api/amazon/aplus/probe` — Calls GET /aplus/2020-11-01/contentDocuments to see if Amazon
- `POST /api/amazon/returns/sync` — { from, to, marketplaceId? } — explicit window
- `GET /api/amazon/finance/probe` — endpoints using the current production refresh token and reports which
- `GET /api/amazon/sp-api/health` — Pre-flight diagnostic for the Listings Items API path the wizard
- `GET /api/amazon/account-health` — O.16a — Account Health: rolling-30d LSR + VTR computed from
- `POST /api/amazon/orders/:id/buy-shipping/quote` — O.16b — Buy Shipping rate quotes (dryRun by default; real path
- `POST /api/amazon/orders/:id/buy-shipping/purchase` — create/run amazon orders buy shipping purchase

#### routes/amazon-flat-file.routes.ts (prefix `/api`) — 25

- `GET /api/amazon/flat-file/product-types` — GET /api/amazon/flat-file/product-types
- `GET /api/amazon/flat-file/browse-nodes` — GET /api/amazon/flat-file/browse-nodes
- `GET /api/amazon/flat-file/template` — GET /api/amazon/flat-file/template
- `GET /api/amazon/flat-file/union-template` — GET /api/amazon/flat-file/union-template
- `GET /api/amazon/flat-file/rows` — GET /api/amazon/flat-file/rows
- `POST /api/amazon/flat-file/submit` — POST /api/amazon/flat-file/submit
- `POST /api/amazon/flat-file/preflight` — POST /api/amazon/flat-file/preflight
- `GET /api/amazon/flat-file/feeds/:feedId` — GET /api/amazon/flat-file/feeds/:feedId
- `GET /api/amazon/flat-file/feeds` — GET /api/amazon/flat-file/feeds — durable submission list (FFS.2)
- `POST /api/amazon/flat-file/parse-tsv` — POST /api/amazon/flat-file/parse-tsv
- `POST /api/amazon/flat-file/parse` — POST /api/amazon/flat-file/parse
- `POST /api/amazon/flat-file/suggest-mapping` — POST /api/amazon/flat-file/suggest-mapping
- `POST /api/amazon/flat-file/suggest-columns-ai` — POST /api/amazon/flat-file/suggest-columns-ai
- `POST /api/amazon/flat-file/coerce` — POST /api/amazon/flat-file/coerce
- `POST /api/amazon/flat-file/plan-import` — POST /api/amazon/flat-file/plan-import
- `POST /api/amazon/flat-file/validate-rows` — POST /api/amazon/flat-file/validate-rows
- `POST /api/amazon/flat-file/fetch-listings` — POST /api/amazon/flat-file/fetch-listings
- `POST /api/amazon/flat-file/export` — POST /api/amazon/flat-file/export  **[file-download]**
- `POST /api/amazon/flat-file/fetch-images` — POST /api/amazon/flat-file/fetch-images
- `POST /api/amazon/flat-file/sync-rows` — POST /api/amazon/flat-file/sync-rows
- `POST /api/amazon/flat-file/translate-values` — POST /api/amazon/flat-file/translate-values
- `POST /api/amazon/flat-file/ai-assist` — A4.1 — Flat File AI Assistant
- `POST /api/amazon/flat-file/pull-preview/start` — POST /api/amazon/flat-file/pull-preview/start
- `GET /api/amazon/flat-file/pull-preview/status/:jobId` — GET /api/amazon/flat-file/pull-preview/status/:jobId
- `POST /api/amazon/flat-file/pull-preview/apply` — POST /api/amazon/flat-file/pull-preview/apply

#### routes/amazon-cockpit-publish.routes.ts (prefix `/api`) — 1

- `POST /api/products/:id/publish-amazon` — create/run products publish amazon

#### routes/amazon-preflight.routes.ts (prefix `/api`) — 1

- `GET /api/products/:id/preflight` — read products preflight

#### routes/ebay-flat-file.routes.ts (prefix `/api`) — 18

- `GET /api/ebay/flat-file/rows` — GET /api/ebay/flat-file/rows
- `GET /api/ebay/flat-file/category-schema` — GET /api/ebay/flat-file/category-schema
- `GET /api/ebay/flat-file/category-search` — GET /api/ebay/flat-file/category-search
- `PATCH /api/ebay/flat-file/rows` — PATCH /api/ebay/flat-file/rows
- `POST /api/ebay/flat-file/push` — POST /api/ebay/flat-file/push
- `GET /api/ebay/flat-file/pushes` — GET /api/ebay/flat-file/pushes
- `POST /api/ebay/flat-file/export` — POST /api/ebay/flat-file/export  **[file-download]**
- `POST /api/ebay/flat-file/parse` — POST /api/ebay/flat-file/parse
- `POST /api/ebay/flat-file/publish` — POST /api/ebay/flat-file/publish
- `DELETE /api/ebay/flat-file/offer` — DELETE /api/ebay/flat-file/offer
- `GET /api/ebay/flat-file/feed/:taskId` — GET /api/ebay/flat-file/feed/:taskId
- `GET /api/ebay/flat-file/policies` — GET /api/ebay/flat-file/policies
- `GET /api/ebay/flat-file/amazon-import` — GET /api/ebay/flat-file/amazon-import
- `GET /api/ebay/flat-file/poll-orders` — GET /api/ebay/flat-file/poll-orders
- `POST /api/ebay/flat-file/ai-assist` — A4.1 — Flat File AI Assistant
- `POST /api/ebay/flat-file/pull-preview/start` — POST /api/ebay/flat-file/pull-preview/start
- `GET /api/ebay/flat-file/pull-preview/status/:jobId` — GET /api/ebay/flat-file/pull-preview/status/:jobId
- `POST /api/ebay/flat-file/pull-preview/apply` — POST /api/ebay/flat-file/pull-preview/apply

#### routes/ebay-cockpit.routes.ts (prefix `/api`) — 16

- `POST /api/ebay/cockpit/suggest-categories` — POST /api/ebay/cockpit/suggest-categories
- `GET /api/ebay/cockpit/category-map` — GET /api/ebay/cockpit/category-map
- `PATCH /api/ebay/cockpit/category` — PATCH /api/ebay/cockpit/category
- `PATCH /api/ebay/cockpit/aspects` — PATCH /api/ebay/cockpit/aspects
- `GET /api/ebay/cockpit/variation-cells` — GET /api/ebay/cockpit/variation-cells
- `PATCH /api/ebay/cockpit/variation-matrix` — PATCH /api/ebay/cockpit/variation-matrix
- `GET /api/ebay/cockpit/file-exchange-csv` — GET /api/ebay/cockpit/file-exchange-csv  **[file-download]**
- `PATCH /api/ebay/cockpit/offer-policies` — PATCH /api/ebay/cockpit/offer-policies
- `POST /api/ebay/cockpit/snapshot` — POST /api/ebay/cockpit/snapshot
- `POST /api/ebay/cockpit/snapshot/restore` — POST /api/ebay/cockpit/snapshot/restore  **[destructive?]**
- `POST /api/ebay/cockpit/publish` — POST /api/ebay/cockpit/publish
- `POST /api/ebay/cockpit/ai-improve` — POST /api/ebay/cockpit/ai-improve
- `PATCH /api/ebay/cockpit/compatibility` — PATCH /api/ebay/cockpit/compatibility
- `GET /api/ebay/cockpit/template-candidates` — GET /api/ebay/cockpit/template-candidates
- `POST /api/ebay/cockpit/template-apply` — POST /api/ebay/cockpit/template-apply
- `POST /api/ebay/cockpit/promote-to-master` — POST /api/ebay/cockpit/promote-to-master

#### routes/flat-file-pull-history.routes.ts (prefix `/api`) — 2

- `GET /api/flat-file/pull-history` — GET /api/flat-file/pull-history
- `GET /api/flat-file/pull-job/active` — GET /api/flat-file/pull-job/active

#### routes/flat-file-unified.routes.ts (prefix `/api`) — 4

- `GET /api/flat-file/unified-template` — read flat file unified template
- `GET /api/flat-file/unified-rows` — read flat file unified rows
- `GET /api/products/browse-nodes/facets` — read products browse nodes facets
- `PATCH /api/flat-file/unified-rows` — update flat file unified rows

#### routes/marketplaces.routes.ts (prefix `/api`) — 18

- `GET /api/sidebar/counts` — Single endpoint covers everything the sidebar needs so navigation
- `POST /api/marketplaces/seed` — POST /api/marketplaces/seed — idempotent seed of the 17 marketplaces
- `GET /api/listings/all` — with the parent product's sku/name/asin and the marketplace's
- `GET /api/marketplaces` — GET /api/marketplaces?channel=AMAZON — flat list, optional channel filter
- `GET /api/marketplaces/grouped` — GET /api/marketplaces/grouped — { AMAZON: [...], EBAY: [...], ... }
- `GET /api/products/:id/all-listings` — GET /api/products/:id/all-listings — every channel/marketplace listing for a product
- `PATCH /api/products/:id/offer-availability` — MA.1 — PATCH /api/products/:id/offer-availability
- `PATCH /api/products/:id/auto-publish-content` — IS.2b — PATCH /api/products/:id/auto-publish-content
- `POST /api/products/bulk-offer-availability` — MA.1 — POST /api/products/bulk-offer-availability
- `GET /api/products/:id/listings/:channel/:marketplace` — GET /api/products/:id/listings/:channel/:marketplace
- `PUT /api/products/:id/listings/:channel/:marketplace` — Accepts the legacy direct-column shape ({ title, description,
- `POST /api/products/:id/listings/:channel/:marketplace/replicate` — Copy content from a source (channel, marketplace) listing to one or
- `POST /api/products/:id/listings/:channel/:marketplace/pricing` — Set the pricing rule for this (channel, marketplace): priceOverride,
- `GET /api/products/:id/listings/:channel/:marketplace/detect-type` — Returns { productType, variationTheme, browseNodes, categoryPath, asin, title, source }.
- `GET /api/products/:id/ebay-sibling-categories` — Returns all OTHER eBay marketplaces where this product already has a valid
- `POST /api/products/:id/listings/:channel/:marketplace/save-browse-nodes` — Persists browse nodes (and optionally category path) for a channel listing.
- `POST /api/products/:id/listings/:channel/:marketplace/publish` — Validates required fields, attempts a channel push (Amazon SP-API or
- `POST /api/products/:id/publish-preflight` — OL.B.1 — POST /api/products/:id/publish-preflight

#### routes/feed-transform.routes.ts (prefix `/api/feed-transform`) — 9

- `GET /api/feed-transform/rules` — List rules
- `POST /api/feed-transform/rules` — Create rule
- `PATCH /api/feed-transform/rules/:id` — Update rule
- `DELETE /api/feed-transform/rules/:id` — Delete rule
- `POST /api/feed-transform/preview` — Preview (evaluate rules for product × channel)
- `GET /api/feed-transform/schema/:channel` — Schema for channel
- `POST /api/feed-transform/seed-schemas` — Seed built-in schemas
- `POST /api/feed-transform/predict-browse-node/:productId` — CE.2: Predict browse node for a product
- `POST /api/feed-transform/cron/browse-node-predictor/trigger` — CE.2: Manual batch browse-node sweep

#### routes/feed-export.routes.ts (prefix `/api/feed-export`) — 4

- `GET /api/feed-export/gmc.xml` — GMC XML feed
- `GET /api/feed-export/meta.json` — Meta JSON feed
- `GET /api/feed-export/preview` — Preview (first 10 products)
- `POST /api/feed-export/trigger` — Manual trigger

#### routes/listing-recovery.routes.ts (prefix `/api`) — 3

- `POST /api/products/:id/recover/preview` — create/run products recover preview
- `POST /api/products/:id/recover` — create/run products recover
- `GET /api/products/:id/recover/events` — read products recover events

#### routes/listing-wizard.routes.ts (prefix `/api`) — 38

- `GET /api/listing-wizard/connection-status` — Phase B — Step 1 connection-status surface
- `GET /api/listing-wizard/drafts/summary` — Surfaces in-progress wizards (status='DRAFT') for the /products/drafts
- `GET /api/listing-wizard/drafts` — read listing wizard drafts
- `POST /api/listing-wizard/start` — create/run listing wizard start
- `GET /api/listing-wizard/:id` — read listing wizard
- `PATCH /api/listing-wizard/:id` — update listing wizard
- `POST /api/listing-wizard/:id/events` — C.0 — POST /api/listing-wizard/:id/events
- `GET /api/listing-wizard/:id/history` — C.1 — GET /api/listing-wizard/:id/history
- `GET /api/listing-wizard/:id/activity` — DR-S.4b — GET /api/listing-wizard/:id/activity
- `POST /api/listing-wizard/drafts/bulk-delete` — C.3 — POST /api/listing-wizard/drafts/bulk-delete
- `DELETE /api/listing-wizard/:id` — C.0 — DELETE /api/listing-wizard/:id
- `GET /api/listing-wizard/:id/gtin-status` — Phase C — Conditional GTIN exemption
- `GET /api/listing-wizard/product-types` — Step 3 — Product Type picker
- `POST /api/listing-wizard/:id/suggest-product-types` — Body: { candidates: ProductTypeListItem[] }
- `POST /api/listing-wizard/:id/prefetch-schema` — Body: { productType: string }
- `GET /api/listing-wizard/:id/required-fields` — Step 5 — Required Attributes (Phase D union)
- `GET /api/listing-wizard/:id/variations` — Step 6 — Variations (Phase E multi-channel)
- `GET /api/listing-wizard/:id/variation-themes` — Variation themes — real-time SP-API fetch
- `GET /api/listing-wizard/:id/images` — Step 7 — Images (Phase F multi-channel)
- `GET /api/listing-wizard/:id/pricing-context` — Step 9 — Pricing (Phase H multi-channel)
- `POST /api/listing-wizard/:id/generate-content` — Step 8 — Content (Phase G dedup)
- `GET /api/listing-wizard/:id/review` — Step 10 — Review (Phase I multi-channel)
- `POST /api/listing-wizard/:id/submit` — Step 11 — Submit (Phase J multi-channel orchestration)
- `POST /api/listing-wizard/:id/poll` — Walks each submission entry through pollStatus (no-op until an
- `POST /api/listing-wizard/:id/retry` — Body: { channelKeys: string[] }
- `GET /api/products/:id/listings/:channel/:marketplace/schema` — Q.2 — single-channel schema for the product-edit page. Same shape
- `POST /api/products/:id/generate-content` — Q.9 — product-scoped content generation for the edit page.
- `GET /api/products/:id/listings/:channel/:marketplace/gtin-status` — Q.7 — single-channel GTIN status for the product-edit page. Same
- `POST /api/listing-wizard/:id/ai-complete-all` — AI-4 — bulk orchestrator: "AI: Complete entire wizard"
- `POST /api/listing-wizard/:id/score-quality` — AI-4.7 — Step 9 listing quality scorer
- `POST /api/listing-wizard/:id/suggest-pricing` — AI-4.6 — Step 7 pricing suggester
- `POST /api/listing-wizard/:id/schedule-publish` — SP.2 (list-wizard) — scheduled wizard publish endpoints
- `GET /api/listing-wizard/:id/scheduled-publishes` — read listing wizard scheduled publishes
- `DELETE /api/listing-wizard/scheduled-publishes/:id` — delete listing wizard scheduled publishes
- `GET /api/listing-wizard/:id/compliance-status` — C.1 (list-wizard) — per-channel compliance status
- `POST /api/listing-wizard/:id/suggest-variation-theme` — AI-4.4 — Step 4 variation theme suggester
- `POST /api/listing-wizard/:id/suggest-channels` — AI-4.3 — Step 1 channel suggester
- `POST /api/listing-wizard/:id/ai-complete-all/estimate` — AI-4.2 — pre-flight estimate for the orchestrator

#### routes/wizard-templates.routes.ts (prefix `/api`) — 6

- `GET /api/wizard-templates` — read wizard templates
- `POST /api/wizard-templates` — create/run wizard templates
- `POST /api/wizard-templates/from-wizard/:id` — create/run wizard templates from wizard
- `POST /api/wizard-templates/:id/apply` — create/run wizard templates apply
- `DELETE /api/wizard-templates/:id` — delete wizard templates
- `PATCH /api/wizard-templates/:id` — WT.5a — patch a non-builtIn template's display fields. Channels +

#### routes/gtin-exemption.routes.ts (prefix `/api`) — 8

- `GET /api/gtin-exemption/check` — read gtin exemption check
- `POST /api/gtin-exemption` — create/run gtin exemption
- `POST /api/gtin-exemption/multi` — marketplaces. TECH_DEBT #28 entry's "while we're there" note: the
- `GET /api/gtin-exemption/:id` — read gtin exemption
- `PATCH /api/gtin-exemption/:id` — update gtin exemption
- `POST /api/gtin-exemption/:id/validate-images` — create/run gtin exemption validate images
- `GET /api/gtin-exemption/:id/brand-letter.pdf` — read gtin exemption brand letter.pdf  **[file-download]**
- `GET /api/gtin-exemption/:id/package.zip` — read gtin exemption package.zip  **[file-download]**

#### routes/listing-content.routes.ts (prefix `/api`) — 1

- `POST /api/listing-content/generate` — create/run listing content generate

#### routes/listing-automation-rules.routes.ts (prefix `/api`) — 7

- `GET /api/listing-automation-rules` — GET /api/listing-automation-rules
- `GET /api/listing-automation-rules/:id` — GET /api/listing-automation-rules/:id
- `POST /api/listing-automation-rules` — POST /api/listing-automation-rules
- `PATCH /api/listing-automation-rules/:id` — PATCH /api/listing-automation-rules/:id
- `DELETE /api/listing-automation-rules/:id` — DELETE /api/listing-automation-rules/:id
- `POST /api/listing-automation-rules/:id/dry-run` — POST /api/listing-automation-rules/:id/dry-run — preview against a context.
- `GET /api/listing-automation-rules/:id/executions` — GET /api/listing-automation-rules/:id/executions — audit history.

#### routes/amazon-cockpit.routes.ts (prefix `/api`) — 3

- `GET /api/amazon/cockpit/template-candidates` — GET /api/amazon/cockpit/template-candidates
- `POST /api/amazon/cockpit/template-apply` — POST /api/amazon/cockpit/template-apply
- `POST /api/amazon/cockpit/promote-to-master` — POST /api/amazon/cockpit/promote-to-master

#### routes/listings-syndication.routes.ts (prefix `/api`) — 33

- `GET /api/listings` — GET /api/listings — paginated, filterable, sortable
- `GET /api/listings/facets` — S.0.5 / M-1 — accepts the same filter params as /api/listings.
- `GET /api/listings/health` — GET /api/listings/health — rollup for the Health lens
- `GET /api/listings/matrix` — ?productIds=csv ?channels=csv ?limit=N
- `GET /api/listings/drafts` — ?channel=AMAZON|EBAY|... ?marketplace=IT|... ?search=...
- `GET /api/listings/:id` — S.2 — also returns `companions`: every other ChannelListing for the
- `PATCH /api/listings/:id` — S.2 — narrow surface for drawer-driven edits: per-field
- `GET /api/listings/amazon/overview` — S.5 — powers the AmazonListingsClient header. KPIs are scoped to a
- `GET /api/listings/ebay/overview` — C.15 — powers the EbayListingsClient header. Mirror of the Amazon
- `GET /api/listings/ebay/campaigns` — read listings ebay campaigns
- `POST /api/listings/ebay/campaigns` — create/run listings ebay campaigns
- `PATCH /api/listings/ebay/campaigns/:id` — update listings ebay campaigns
- `DELETE /api/listings/ebay/campaigns/:id` — delete listings ebay campaigns
- `GET /api/listings/ebay/markdowns` — read listings ebay markdowns
- `POST /api/listings/ebay/markdowns` — create/run listings ebay markdowns
- `PATCH /api/listings/ebay/markdowns/:id` — update listings ebay markdowns
- `DELETE /api/listings/ebay/markdowns/:id` — delete listings ebay markdowns
- `GET /api/listings/performance` — C.18 / C.19 / C.20 — Path A channel overview (Shopify/Woo/Etsy).
- `GET /api/listings/path-a/overview` — read listings path a overview
- `POST /api/listings/amazon/suppressions` — S.5 — used by the resolver UI when an operator wants to record a
- `PATCH /api/listings/amazon/suppressions/:id` — PATCH /api/listings/amazon/suppressions/:id — resolve a suppression
- `GET /api/products/:id/suppressions` — AC.10 — GET /api/products/:id/suppressions?marketplace=<MP>
- `GET /api/products/:id/listing-issues` — ALA Phase 4 — GET /api/products/:id/listing-issues?marketplace=<MP>
- `POST /api/listings/:id/diagnose-suppression` — listing is suppressed and what to fix.
- `GET /api/listings/publish-readiness` — PD.0 — publish-readiness: the operator's "am I actually live?" check.
- `GET /api/listings/publish-status` — M.7 — wraps the V.1 verification script's queries in an API so
- `GET /api/listings/:id/publish-attempts` — M.8 — pulls from ChannelPublishAttempt scoped to the listing's
- `GET /api/listings/:id/sync-history` — S.4 — backed by the SyncAttempt audit table. Drawer's Sync tab
- `GET /api/listings/events` — S.4 — mirrors /api/fulfillment/inbound/events. Long-lived GET;  **[SSE]**
- `POST /api/listings/:id/resync` — S.0 / C-3 — was a placebo (just flipped a flag with no consumer).
- `POST /api/listings/bulk-action` — body: { action, listingIds[], payload? }  **[guard:allowApiKeyScope]**
- `GET /api/listings/bulk-action/:jobId` — read listings bulk action
- `POST /api/listings/cascade` — IN.2 — POST /api/listings/cascade

#### routes/listing-images.routes.ts (prefix `/api`) — 5

- `GET /api/products/:productId/listing-images` — GET /api/products/:productId/listing-images
- `POST /api/products/:productId/listing-images` — POST /api/products/:productId/listing-images
- `PATCH /api/listing-images/:id` — PATCH /api/listing-images/:id
- `POST /api/products/:productId/listing-images/reorder` — POST /api/products/:productId/listing-images/reorder
- `DELETE /api/listing-images/:id` — DELETE /api/listing-images/:id

#### routes/images/amazon-images.routes.ts (prefix `/api`) — 13

- `POST /api/products/:productId/amazon-images/publish` — POST /api/products/:productId/amazon-images/publish
- `POST /api/products/:productId/amazon-images/adopt` — POST /api/products/:productId/amazon-images/adopt
- `GET /api/products/:productId/amazon-images/reconcile` — GET /api/products/:productId/amazon-images/reconcile
- `GET /api/products/:productId/amazon-images/mirror-diff` — GET /api/products/:productId/amazon-images/mirror-diff
- `GET /api/products/:productId/amazon-images/debug-live/:sku` — GET .../amazon-images/debug-live/:sku — TEMP read-only probe
- `POST /api/products/:productId/amazon-images/fill-from-gallery` — POST /api/products/:productId/amazon-images/fill-from-gallery
- `GET /api/products/:productId/amazon-images/validate` — GET /api/products/:productId/amazon-images/validate
- `GET /api/products/:productId/amazon-images/feed-status/:jobId` — GET /api/products/:productId/amazon-images/feed-status/:jobId
- `GET /api/products/:productId/amazon-images/preview` — GET /api/products/:productId/amazon-images/preview
- `GET /api/products/:productId/amazon-images/stale` — GET /api/products/:productId/amazon-images/stale
- `POST /api/products/:productId/amazon-images/export-zip` — POST /api/products/:productId/amazon-images/export-zip  **[file-download]**
- `GET /api/products/:productId/amazon-images/export-zip/manifest` — GET /api/products/:productId/amazon-images/export-zip/manifest
- `GET /api/products/:productId/amazon-images/jobs` — GET /api/products/:productId/amazon-images/jobs

#### routes/images/images-workspace.routes.ts (prefix `/api`) — 5

- `GET /api/products/:productId/images-workspace` — GET /api/products/:productId/images-workspace
- `PATCH /api/products/:productId/images-workspace/axis` — PATCH /api/products/:productId/images-workspace/axis
- `POST /api/products/:productId/images-workspace/bulk-save` — POST /api/products/:productId/images-workspace/bulk-save
- `POST /api/products/:productId/images-workspace/copy-scope` — POST /api/products/:productId/images-workspace/copy-scope
- `POST /api/products/:productId/images-workspace/lock` — POST /api/products/:productId/images-workspace/lock

#### routes/images/channel-image-publish.routes.ts (prefix `/api`) — 4

- `POST /api/products/:productId/ebay-images/publish` — POST /api/products/:productId/ebay-images/publish
- `POST /api/products/:productId/shopify-images/publish` — POST /api/products/:productId/shopify-images/publish
- `GET /api/products/:productId/image-publish-jobs` — GET /api/products/:productId/image-publish-jobs
- `POST /api/image-publish-jobs/:jobId/retry` — POST /api/image-publish-jobs/:jobId/retry

#### routes/ebay-phase3.routes.ts (prefix `/api`) — 4

- `GET /api/ebay/phase3/gap` — Gap analysis
- `GET /api/ebay/phase3/progress` — Progress
- `POST /api/ebay/phase3/schedule` — Bulk schedule — operator selects products and sets pace
- `DELETE /api/ebay/phase3/schedule` — Cancel all pending schedules for a marketplace

### advertising — 299 endpoints

#### routes/advertising.routes.ts (prefix `/api`) — 277

- `GET /api/advertising/campaigns` — GET /advertising/campaigns
- `GET /api/advertising/campaigns/:id` — GET /advertising/campaigns/:id
- `GET /api/advertising/ad-groups` — GET /advertising/ad-groups/:id (AME.6)
- `GET /api/advertising/ad-groups/:id` — read advertising ad groups
- `GET /api/advertising/fba-storage-age` — GET /advertising/fba-storage-age
- `GET /api/advertising/campaigns/:id/placements` — GET /advertising/campaigns/:id/placements (AX.3)
- `PATCH /api/advertising/campaigns/:id/placements` — PATCH placement bid adjustments (AX2.2)
- `PATCH /api/advertising/campaigns/:id/cpc-ceiling` — CPC-ceiling guardrail config (Pacvue-parity)
- `GET /api/advertising/campaigns/:id/self-competition` — Self-competition (RC2.R8) — other campaigns in the SAME market that
- `GET /api/advertising/campaigns/:id/keyword-conflicts` — GET /advertising/campaigns/:id/keyword-conflicts (RC3.2)
- `GET /api/advertising/campaigns/:id/product-dayparting` — Product-family dayparting (RC2.T·product)
- `PATCH /api/advertising/campaigns/:id/guardrails` — Apex A.2a: per-campaign bid guardrails (max-change-% + writes/day)
- `PATCH /api/advertising/campaigns/:id/automation` — CBN.2h.6: Bid Automation + Target ACoS (Ad Manager Bulk Actions)
- `PATCH /api/advertising/campaigns/:id/live-writes` — Apex A.2a: per-campaign live-write allowlist toggle
- `POST /api/advertising/campaigns/live-writes/bulk` — MM.2 — bulk live-write allowlist for a whole marketplace (or an explicit set), so an
- `POST /api/advertising/campaign-builder/launch` — CB.5 — guided Campaign Builder launch. dryRun=true returns the PLAN (what would be
- `POST /api/advertising/campaign-builder/sp-super-wizard/launch` — SPW.7: SP Super Wizard launch
- `POST /api/advertising/campaign-builder/single/launch` — SB.7 — Single Campaign builder launch. Creates ONE SP campaign with PER-KEYWORD match
- `GET /api/advertising/campaign-builder/auto-bid-suggestions` — AT.3 — suggested bid per Auto-targeting group (READ; works pre-launch + while
- `GET /api/advertising/campaigns/:id/pending-writes` — Apex A.2a: preview pending live writes for a campaign
- `POST /api/advertising/queued-mutations/:queueId/cancel` — RC4.5: cancel a staged (PENDING) Amazon write within its grace window
- `GET /api/advertising/campaigns/:id/history` — RC4.6: change-history timeline for a campaign (manual + automation)
- `GET /api/advertising/campaigns/:id/rank-trend` — RC4.12: per-day Top-of-search impression-share + ACOS trend (sparklines)
- `GET /api/advertising/fba-storage-age/:productId` — GET /advertising/fba-storage-age/:productId
- `GET /api/advertising/profit/daily` — GET /advertising/profit/daily
- `GET /api/advertising/summary` — GET /advertising/summary
- `POST /api/advertising/ads-connection/test` — POST /advertising/ads-connection/test
- `POST /api/advertising/reports/create-cycle` — { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD", adProducts?: [...] }
- `POST /api/advertising/reports/poll` — ?limit=N (default 20) — advance PENDING/IN_PROGRESS jobs.
- `POST /api/advertising/reports/:id/ingest` — Downloads a COMPLETED job's S3 file and upserts rows into
- `POST /api/advertising/reports/ingest-completed` — Bulk: find every COMPLETED job not yet ingested and ingest each.
- `GET /api/advertising/reports` — GET /api/advertising/reports — list jobs (paginated, newest first)
- `GET /api/advertising/reports/:id` — GET /api/advertising/reports/:id — single job detail
- `GET /api/advertising/campaigns/v1-metrics` — Phase 5b: per-campaign v1 metrics (last N days)
- `GET /api/advertising/product-ads` — Four insight types derived from live aggregates:
- `GET /api/advertising/by-product` — PC.1: product-centric ad roster
- `GET /api/advertising/by-product/variants` — PCF.1 — variant children of a parent product (the expansion rows). Per-
- `GET /api/advertising/by-product/campaigns` — PCG.1 — a product's CAMPAIGNS (the expansion rows). Per-campaign the
- `POST /api/advertising/by-product/bulk` — PC.7 — bulk action on the campaigns behind selected products. Resolves
- `GET /api/advertising/insights` — STALE_CAMPAIGN — ENABLED campaigns with 0 impressions in windowDays
- `GET /api/advertising/trends` — Phase 5a: v1 overview endpoint
- `GET /api/advertising/trends/sparklines` — CD.6 — batched per-entity sparklines. Returns one trailing daily series
- `GET /api/advertising/campaigns/:id/dayparting` — CD.12 — dayparting heatmap. Aggregates the hourly store (CD.11) into a
- `GET /api/advertising/dayparting/heatmap` — D-INT2: multi-campaign dayparting heatmap. Aggregates AmazonAdsHourlyPerformance
- `GET /api/advertising/overview/v1` — - per-adProduct live status from the adapter registry
- `POST /api/advertising/reports/create-search-terms-cycle` — POST /api/advertising/reports/create-search-terms-cycle
- `POST /api/advertising/reports/create-placements-cycle` — POST /api/advertising/reports/create-placements-cycle (SP only)
- `POST /api/advertising/reports/create-advertised-product-cycle` — POST /api/advertising/reports/create-advertised-product-cycle (SP only) — PC.0
- `POST /api/advertising/debug/backfill-campaign-adproduct` — One-time backfill: derives Campaign.adProduct from the legacy `type`  **[destructive?]**
- `GET /api/advertising/debug/advertised-product-report` — Downloads + dumps the latest COMPLETED spAdvertisedProduct report so we can
- `GET /api/advertising/debug/product-ad-reconcile` — Per-day PRODUCT_AD spend vs CAMPAIGN spend (+ row counts + a sample), to see
- `GET /api/advertising/reconcile` — AME.4: reconciliation + self-heal
- `POST /api/advertising/reconcile` — create/run advertising reconcile
- `GET /api/advertising/reconcile/targets` — AF.3 — fleet-wide target-accuracy reconcile (duplicates, manual campaigns
- `POST /api/advertising/debug/wipe-product-ad` — Deletes all PRODUCT_AD daily rows so they can be cleanly re-ingested (one  **[destructive?]**
- `POST /api/advertising/v1/export-cycle` — Body: { profileIds?: string[], resources?: V1Resource[], adProducts?: V1AdProduct[] }
- `POST /api/advertising/v1/exports/poll` — POST /api/advertising/v1/exports/poll?limit=N
- `POST /api/advertising/v1/exports/refresh-expired` — Re-GETs Amazon for COMPLETED jobs whose presigned URL lapsed (rowsIngested=0)
- `POST /api/advertising/v1/exports/ingest-completed` — Ingests up to 10 COMPLETED jobs per call.
- `GET /api/advertising/v1/exports` — GET /api/advertising/v1/exports?status=...&resource=...&limit=N
- `POST /api/advertising/debug/mark-expired-reports-failed` — Reports whose signed URL has long since expired (completedAt > 60 min ago)
- `POST /api/advertising/debug/clear-stale-export-errors` — Clears errorMessage on AmazonAdsExportJob rows that successfully
- `POST /api/advertising/debug/reset-stuck-completed-jobs` — Resets jobs that are status=COMPLETED but location=null (a data state  **[destructive?]**
- `GET /api/advertising/debug/report-download/:jobId` — Fetches Amazon's raw status response for a single AmazonAdsReportJob
- `GET /api/advertising/debug/report-status/:jobId` — read advertising debug report status
- `GET /api/advertising/debug/export-status` — Once a probe created an export (e.g. exports_v1_campaigns_sp returned
- `GET /api/advertising/debug/target-breakdown` — AF.1/AF.3 — DB-only target breakdown (instant, no export download). Tells
- `POST /api/advertising/debug/dedupe-campaigns` — AF.1d — de-duplicate campaigns split across marketplace representations
- `POST /api/advertising/debug/probe-endpoints` — create/run advertising debug probe endpoints
- `GET /api/advertising/debug/probe-endpoints/profiles` — available for probing. Convenience for the UI dropdown.
- `POST /api/advertising/profit/ingest-fba-fees` — Manual trigger for the FBA fees ingest. Accepts an optional
- `POST /api/advertising/profit/backfill-ad-spend` — Manually triggers fillAdSpend for a date range. Use after the first  **[destructive?]**
- `POST /api/advertising/negative-keywords` — Creates a negative keyword in Amazon at either ad-group or campaign
- `POST /api/advertising/reports/cleanup-search-terms` — create/run advertising reports cleanup search terms  **[destructive?]**
- `GET /api/advertising/reports/search-terms` — ?lookbackDays=30&profileId=&marketplace=&adProduct=&minSpend=0
- `GET /api/advertising/targets` — GET /advertising/targets — account-level keyword/target roster
- `POST /api/advertising/search-terms/promote` — POST /advertising/search-terms/promote — harvest a search term into a
- `GET /api/advertising/bulk/export` — read advertising bulk export  **[file-download]**
- `POST /api/advertising/bulk/apply` — POST /advertising/bulk/apply — apply a validated bulksheet
- `GET /api/advertising/reports/negative-keyword-candidates` — ?lookbackDays=30&minSpend=5&limit=100&profileId=&marketplace=
- `POST /api/advertising/cron/ads-sync/trigger` — Manual cron triggers (sandbox-safe)
- `POST /api/advertising/cron/fba-storage-age-ingest/trigger` — create/run advertising cron fba storage age ingest trigger
- `POST /api/advertising/cron/true-profit-rollup/trigger` — create/run advertising cron true profit rollup trigger
- `POST /api/advertising/cron/ads-metrics-ingest/trigger` — create/run advertising cron ads metrics ingest trigger
- `POST /api/advertising/cron/drain-ads-sync/trigger` — create/run advertising cron drain ads sync trigger
- `POST /api/advertising/cron/keyword-resync/trigger` — H.10 — on-demand mirror refresh: pull CURRENT keywords, negatives (ad-group + campaign-level),
- `GET /api/advertising/automation-rules` — read advertising automation rules
- `GET /api/advertising/automation-rules/:id` — read advertising automation rules
- `POST /api/advertising/automation-rules` — create/run advertising automation rules
- `PATCH /api/advertising/automation-rules/:id` — update advertising automation rules
- `DELETE /api/advertising/automation-rules/:id` — delete advertising automation rules
- `GET /api/advertising/rule-templates` — B3 (Budget rule builder): reusable rule templates — save a rule's criteria +
- `POST /api/advertising/rule-templates` — create/run advertising rule templates
- `DELETE /api/advertising/rule-templates/:id` — delete advertising rule templates
- `GET /api/advertising/suggestions/count` — ES1: Manual-rule Suggestions — list / approve(apply-live) / dismiss
- `GET /api/advertising/suggestions` — read advertising suggestions
- `POST /api/advertising/suggestions/:id/apply` — Approve → re-run the proposed action LIVE against the frozen execution context (respects the
- `POST /api/advertising/suggestions/:id/dismiss` — create/run advertising suggestions dismiss
- `POST /api/advertising/suggestions/:id/restore` — S.4 — Undo a dismiss: put a dismissed suggestion back to pending. Deliberately scoped to  **[destructive?]**
- `POST /api/advertising/automation-rules/:id/test` — Test a rule against a synthetic context — used by the rule-builder
- `GET /api/advertising/automation-rules/:id/gate-status` — Returns a structured 8-check checklist for graduating a rule from
- `POST /api/advertising/automation-rules/:id/graduate` — Flips dryRun=false after re-running all 8 gate checks server-side.
- `POST /api/advertising/automation-rules/seed-templates` — create/run advertising automation rules seed templates
- `GET /api/advertising/automation-rule-executions` — AD.3: Execution feed
- `GET /api/advertising/execution-events` — AD.3: Evaluator manual trigger + status  **[SSE]**
- `POST /api/advertising/debug/tos-is-ingest` — create/run advertising debug tos is ingest
- `POST /api/advertising/cron/advertising-rule-evaluator/trigger` — create/run advertising cron advertising rule evaluator trigger
- `GET /api/advertising/cron/advertising-rule-evaluator/status` — read advertising cron advertising rule evaluator status
- `POST /api/advertising/campaigns/create` — AX.4: CREATE routes (campaign/adGroup/keyword/productAd)
- `POST /api/advertising/adgroups/create` — create/run advertising adgroups create
- `POST /api/advertising/keywords/create` — create/run advertising keywords create
- `POST /api/advertising/product-ads/create` — create/run advertising product ads create
- `GET /api/advertising/autonomy/status` — AME.14: autonomy & guardrails control center
- `POST /api/advertising/autonomy/pause-all` — create/run advertising autonomy pause all
- `POST /api/advertising/autonomy/resume` — create/run advertising autonomy resume
- `POST /api/advertising/targets/create` — AX2.1: Product / ASIN / category / auto targeting
- `POST /api/advertising/negative-targets/create` — create/run advertising negative targets create
- `POST /api/advertising/campaigns/:id/push-structure` — LAUNCH-REPAIR — push a campaign's existing local structure (ad group/keywords/auto/product ads)
- `POST /api/advertising/campaigns/reconcile` — LAUNCH-REPAIR — Amazon->DB reconcile: back-fill negative-keyword ids, read serving status +
- `POST /api/advertising/campaigns/:id/assign-portfolio` — LAUNCH-REPAIR — force-push portfolio membership to Amazon (bypasses local-diff no-op).
- `POST /api/advertising/negative-keywords/bulk` — LAUNCH-REPAIR — bulk ad-group negative keywords (funnel isolation back-fill). Idempotent.
- `POST /api/advertising/bid-suggestions` — AX2.10: Data-grounded bid suggestions
- `POST /api/advertising/sb-creatives/create` — AX2.9: Sponsored Brands creative
- `POST /api/advertising/architect/preview` — AX.6: Keyword-paste auto-architect
- `POST /api/advertising/architect/apply` — create/run advertising architect apply
- `POST /api/advertising/marketing-stream/ingest` — AX.12: Amazon Marketing Stream ingest (hourly)
- `GET /api/advertising/marketing-stream/status` — read advertising marketing stream status
- `GET /api/advertising/marketing-stream/debug-sample` — Diagnostic — last raw AMS messages + ingest result this instance saw, to
- `GET /api/advertising/automation/state` — TD.0: Trading Desk automation safety spine (autonomy + circuit-breaker)
- `POST /api/advertising/automation/autonomy` — create/run advertising automation autonomy
- `POST /api/advertising/automation/halt` — create/run advertising automation halt
- `POST /api/advertising/automation/resume` — create/run advertising automation resume
- `POST /api/advertising/automation/thresholds` — create/run advertising automation thresholds
- `POST /api/advertising/automation/guard/run` — create/run advertising automation guard run
- `POST /api/advertising/automation/auto-bid/run` — TD.1 — run the profit-native target-ACOS auto-bid pass on demand (respects
- `POST /api/advertising/automation/auto-harvest/run` — TD.2 — run the keyword harvest+prune pass on demand (autonomy-gated).
- `GET /api/advertising/marketing-stream/subscriptions` — read advertising marketing stream subscriptions
- `POST /api/advertising/marketing-stream/subscriptions` — create/run advertising marketing stream subscriptions
- `DELETE /api/advertising/marketing-stream/subscriptions/:id` — delete advertising marketing stream subscriptions
- `GET /api/advertising/top-of-search` — AME.11: Top-of-search placement optimizer
- `POST /api/advertising/top-of-search/apply` — create/run advertising top of search apply
- `POST /api/advertising/top-of-search/apply-all` — create/run advertising top of search apply all
- `POST /api/advertising/keywords/resync` — AF.1b: synchronous keyword resync via the v3 list API
- `POST /api/advertising/keywords/resync-all` — AF.7 — fleet-wide keyword resync (real Amazon bids via v3 list API).
- `GET /api/advertising/funnel/state` — AME.15-17: campaign launcher + keyword-graduation funnel
- `POST /api/advertising/funnel/cross-match` — create/run advertising funnel cross match
- `POST /api/advertising/funnel/launch` — create/run advertising funnel launch
- `GET /api/advertising/ngrams` — AX.11: Search-term n-gram analysis
- `GET /api/advertising/share-of-voice` — AX2.6: Share of Voice + impression-share intel
- `GET /api/advertising/keyword-ranks` — SK3: Keyword Tracker rank backend
- `POST /api/advertising/keyword-ranks` — POST — ingest rank snapshots (pluggable source: manual import now, a collector later). Each row is
- `GET /api/advertising/events` — AX3.14: Advertising Events log
- `POST /api/advertising/events/custom` — create/run advertising events custom
- `GET /api/advertising/automation-health` — AX3.13: Automation Health
- `GET /api/internal/bidding/contexts` — read internal bidding contexts
- `POST /api/internal/bidding/applied` — create/run internal bidding applied
- `GET /api/advertising/momentum` — AX3.12: Live Ad Momentum
- `GET /api/advertising/budget-manager` — AX3.10: Budget Manager
- `POST /api/advertising/budget-manager/plans` — create/run advertising budget manager plans
- `DELETE /api/advertising/budget-manager/plans/:id` — delete advertising budget manager plans
- `GET /api/advertising/budget-manager/campaigns` — BM.B2 — per-marketplace campaign list + per-campaign min/max limits (the "More" view).
- `POST /api/advertising/budget-manager/campaign-limit` — create/run advertising budget manager campaign limit
- `GET /api/advertising/budget-manager/enforcement` — BM.B3 — enforcement preview: what Auto Pacing / Stop Over Spend WOULD do (dry-run).  **[destructive?]**
- `GET /api/advertising/ontology/children` — CP.1 — Control Plane scenario commit: apply a batch of staged changes
- `GET /api/advertising/ads-mode` — P6 — governance: the ads write mode (sandbox=local only / live=pushes to Amazon)
- `GET /api/advertising/campaigns/:id/settings` — P2 — campaign PPC settings for the Control Plane inspector (bidding strategy,
- `POST /api/advertising/budget-manager/scenario/commit` — CP.1 + P1.1 — Control Plane scenario commit: apply a batch of staged changes
- `POST /api/advertising/goals/suggest-targets` — AX3.2: Full-funnel Goal builder (branded + unbranded)
- `POST /api/advertising/goals/apply` — create/run advertising goals apply
- `POST /api/advertising/ai-goals` — AG.1: AI Advertising product goals (AI Goal builder → dashboard "Goals")
- `GET /api/advertising/ai-goals` — read advertising ai goals
- `POST /api/advertising/ai-goals/:id/archive` — create/run advertising ai goals archive
- `GET /api/advertising/dsp/meta` — AX3.3: Amazon DSP + Performance+/Brand+
- `GET /api/advertising/dsp` — read advertising dsp
- `POST /api/advertising/dsp/create` — create/run advertising dsp create
- `GET /api/advertising/audience-templates` — AX3.4: AMC-style no-SQL audiences
- `GET /api/advertising/audiences` — read advertising audiences
- `POST /api/advertising/audiences` — create/run advertising audiences
- `POST /api/advertising/audiences/:id/activate` — create/run advertising audiences activate
- `POST /api/advertising/audiences/:id/archive` — create/run advertising audiences archive
- `GET /api/advertising/incrementality` — AX3.5: iROAS / incrementality (modeled)
- `GET /api/advertising/retail-readiness` — AX3.1: Retail-readiness guard
- `POST /api/advertising/retail-readiness/apply` — create/run advertising retail readiness apply
- `GET /api/advertising/alerts` — AX2.12: Ads alerts (anomaly watch)
- `GET /api/advertising/recommendations` — AX2.7: Unified AI + rules recommendations feed
- `GET /api/advertising/recommendations/brief` — read advertising recommendations brief
- `POST /api/advertising/recommendations/apply` — create/run advertising recommendations apply
- `GET /api/advertising/pacing/preview` — AX.10: Budget pacing
- `POST /api/advertising/pacing/apply` — create/run advertising pacing apply
- `GET /api/advertising/schedules` — AX.9: Dayparting schedules
- `POST /api/advertising/schedules` — create/run advertising schedules
- `PATCH /api/advertising/schedules/:id` — update advertising schedules
- `DELETE /api/advertising/schedules/:id` — delete advertising schedules
- `GET /api/advertising/budget-schedules` — read advertising budget schedules
- `GET /api/advertising/budget-schedules/:id` — read advertising budget schedules
- `POST /api/advertising/budget-schedules` — create/run advertising budget schedules
- `PATCH /api/advertising/budget-schedules/:id` — update advertising budget schedules
- `DELETE /api/advertising/budget-schedules/:id` — delete advertising budget schedules
- `GET /api/advertising/budget-schedules/hourly-performance` — BS chart — "Hourly Campaign Performance" aggregated by hour-of-day (Rome), from the AMS
- `GET /api/advertising/autopilot-plans` — AC — AI Control / Autopilot: plans CRUD + decisions + real-time SSE feed
- `GET /api/advertising/autopilot-plans/:id` — read advertising autopilot plans
- `POST /api/advertising/autopilot-plans` — create/run advertising autopilot plans
- `PATCH /api/advertising/autopilot-plans/:id` — update advertising autopilot plans
- `DELETE /api/advertising/autopilot-plans/:id` — delete advertising autopilot plans
- `GET /api/advertising/autopilot-plans/:id/decisions` — read advertising autopilot plans decisions
- `POST /api/advertising/autopilot-plans/:id/run` — Manual dry-run: run the Conductor once for THIS plan and return the proposed actions (no writes).
- `GET /api/advertising/autopilot-plans/:id/backtest` — Backtest / projection: what AUTO would do now + the last-N-day spend/ACoS trajectory (P-F.2).
- `GET /api/advertising/autopilot-plans/:id/decisions/stream` — Real-time decision feed (SSE): emits new AutopilotDecision rows for the plan as they appear.  **[SSE]**
- `GET /api/advertising/rank-targets` — read advertising rank targets
- `POST /api/advertising/rank-targets` — create/run advertising rank targets
- `PATCH /api/advertising/rank-targets/:id` — update advertising rank targets
- `DELETE /api/advertising/rank-targets/:id` — delete advertising rank targets
- `POST /api/advertising/rank-targets/:id/reset` — RTC — reset a built-in target to its canonical default values (clears operator tuning).  **[destructive?]**
- `GET /api/advertising/rank-schedule-groups` — Phase 3 — named rank-schedule GROUPS (one named schedule spanning many campaigns). The group
- `GET /api/advertising/rank-schedule-groups/memberships` — Guardrail data — which campaigns are currently held by a group, so the builder can warn that
- `GET /api/advertising/rank-schedule-groups/:id` — read advertising rank schedule groups
- `POST /api/advertising/rank-schedule-groups` — create/run advertising rank schedule groups
- `PATCH /api/advertising/rank-schedule-groups/:id` — update advertising rank schedule groups
- `DELETE /api/advertising/rank-schedule-groups/:id` — delete advertising rank schedule groups
- `GET /api/advertising/rank-templates` — RTPL — named rank-SCHEDULE templates (account-global; Save/Load a painted schedule)
- `POST /api/advertising/rank-templates` — create/run advertising rank templates
- `PATCH /api/advertising/rank-templates/:id` — update advertising rank templates
- `DELETE /api/advertising/rank-templates/:id` — delete advertising rank templates
- `POST /api/advertising/campaigns/sync-settings` — RD.1 — Rank Director: product-FAMILY rank+dayparting plans
- `POST /api/advertising/campaigns/:id/refresh-settings` — B (on-open) — refresh ONE campaign's settings live from Amazon. The cockpit fires
- `GET /api/advertising/rank-plans` — read advertising rank plans
- `GET /api/advertising/rank-plans/:id` — read advertising rank plans
- `POST /api/advertising/rank-plans` — create/run advertising rank plans
- `PATCH /api/advertising/rank-plans/:id` — update advertising rank plans
- `DELETE /api/advertising/rank-plans/:id` — delete advertising rank plans
- `GET /api/advertising/rank-plans/:id/family` — RD.2 — what this plan fans out to + is the mapping trustworthy?
- `GET /api/advertising/by-product/family-dayparting` — RD.3 — family demand by hour (product-anchored, per-market, date-range)
- `POST /api/advertising/rank-plans/:id/run-now` — RD.7 — per-plan actuation: live preview / apply-now / revert / bulk push
- `POST /api/advertising/rank-plans/:id/revert` — create/run advertising rank plans revert
- `POST /api/advertising/rank-plans/:id/apply-across` — create/run advertising rank plans apply across
- `POST /api/advertising/rank-plans/copy-schedule` — RG.4 — copy one schedule (windows + baseline) onto many products' plans
- `POST /api/advertising/rank-controller/simulate` — RS.4 — preview the pure rank controller's next move for a given target +
- `POST /api/advertising/rank-defend/run-now` — RS.5 — run the rank-defend loop once across every enabled goal-mode schedule.
- `POST /api/advertising/rank-defend/resync-bids` — WC — one-time re-sync: force-push the CURRENT local bids to Amazon for rank-governed
- `POST /api/advertising/rank-defend/reconcile` — AR — manual trigger / preview for the auto-reconcile sweep (the same sweep the
- `POST /api/advertising/dayparting/run-now` — create/run advertising dayparting run now
- `GET /api/advertising/dayparting-intel` — AX2.11: Dayparting intelligence (day-of-week conversion)
- `GET /api/advertising/bid-optimizer/preview` — AX.8: Target-ACOS bid optimization
- `POST /api/advertising/bid-optimizer/apply` — create/run advertising bid optimizer apply
- `GET /api/advertising/harvest/preview` — AX.7: Negative + keyword harvesting
- `POST /api/advertising/harvest/apply` — create/run advertising harvest apply
- `GET /api/advertising/portfolios` — SP portfolios for the Campaign-Details picker. Live list from Amazon (GET /v2/portfolios),
- `POST /api/advertising/portfolios` — PA.2 — create a portfolio (gated-local: stored as an AmazonAdsPortfolio row; pushed to
- `POST /api/advertising/portfolios/sync` — Portfolios P1 — pull the account's portfolios from Amazon and persist them (idempotent).
- `GET /api/advertising/portfolios/overview` — Portfolios P1 — synced rows enriched with campaign counts + spend/sales rollup (from our data).
- `PATCH /api/advertising/portfolios/:id` — Portfolios P2/P3 — rename / archive / set budget-cap (gated live PUT to Amazon + local mirror).
- `PATCH /api/advertising/campaigns/:id` — update advertising campaigns
- `PATCH /api/advertising/ad-groups/:id` — update advertising ad groups
- `PATCH /api/advertising/ad-targets/:id` — update advertising ad targets
- `POST /api/advertising/ad-targets/bulk-bid` — create/run advertising ad targets bulk bid
- `PATCH /api/advertising/product-ads/:id` — AF.5 — product ad enable/pause toggle.
- `DELETE /api/advertising/mutations/:outboundQueueId` — delete advertising mutations
- `GET /api/advertising/bid-history` — AD.2: bid history feed
- `GET /api/advertising/profit/by-campaign` — AD.2: True ROAS by campaign
- `POST /api/advertising/connection/preview-writes` — create/run advertising connection preview writes
- `POST /api/advertising/connection/enable-writes` — create/run advertising connection enable writes
- `POST /api/advertising/connection/disable-writes` — create/run advertising connection disable writes
- `POST /api/advertising/connection/set-mode` — Apex A.2b: set a connection's mode (sandbox ↔ production)
- `GET /api/advertising/connections` — read advertising connections
- `POST /api/advertising/connections` — POST /advertising/connections — create or update credentials
- `DELETE /api/advertising/connections/:profileId` — DELETE /advertising/connections/:profileId
- `POST /api/advertising/actions/:executionId/rollback` — create/run advertising actions rollback  **[destructive?]**
- `GET /api/advertising/budget-pools` — read advertising budget pools
- `GET /api/advertising/budget-pools/:id` — read advertising budget pools
- `POST /api/advertising/budget-pools` — create/run advertising budget pools
- `PATCH /api/advertising/budget-pools/:id` — update advertising budget pools
- `DELETE /api/advertising/budget-pools/:id` — delete advertising budget pools
- `POST /api/advertising/budget-pools/:id/allocations` — Allocations CRUD (nested under pool)
- `DELETE /api/advertising/budget-pools/:id/allocations/:allocationId` — delete advertising budget pools allocations
- `POST /api/advertising/budget-pools/:id/rebalance` — Manual rebalance — always shows a dry-run preview first via the
- `GET /api/advertising/budget-pools/:id/history` — read advertising budget pools history
- `GET /api/advertising/actions/:executionId/log` — read advertising actions log

#### routes/advertising-intel.routes.ts (prefix `/api`) — 18

- `GET /api/advertising/cron-status` — Apex — diagnostic probe for the ads-cron gate. Reads the SAME process.env
- `GET /api/advertising/target-acos` — Per-product profit-native target ACOS + break-even + TACOS/TACoP.
- `POST /api/advertising/automation-rules/:id/simulate` — Trigger a single automation rule immediately (dry-run forced for safety).
- `GET /api/advertising/automation-feed` — Automation real-time activity feed — last N executions with what changed
- `GET /api/advertising/automation-analytics` — Automation analytics — per-rule impact over time
- `GET /api/advertising/automation-impact` — AU.7 — automation impact summary: what did automation actually DO this week?
- `GET /api/advertising/autopilot/simulate` — Apex F.1 — beginner autopilot: simulate (read-only) the full plan one north
- `POST /api/advertising/autopilot/apply` — Apex F.2 — apply the autopilot plan (operator-triggered). Allowlist-gated end
- `GET /api/advertising/search-query-performance` — Apex E.1 — competitive intel: our SHARE per search query (Brand Analytics SQP).
- `GET /api/advertising/sqp/debug` — Diagnostic: the last SQP report's real shape (top-level + first-row keys +
- `POST /api/advertising/sqp/probe` — Probe whether the account has Brand Analytics SQP access (resolves the
- `POST /api/advertising/sqp/ingest` — Manual SQP ingest trigger. FIRE-AND-FORGET: SP-API reports take minutes to
- `GET /api/advertising/ams/status` — read advertising ams status
- `GET /api/advertising/ams/subscriptions` — read advertising ams subscriptions
- `POST /api/advertising/ams/subscribe` — Create the sp-traffic + sp-conversion subscriptions for active production connections.
- `GET /api/advertising/target-acos/fleet` — Fleet view — every advertised product's target ACOS, revenue-ranked.
- `GET /api/advertising/orders-dayparting` — DP.1 — Orders-sourced dayparting demand heatmap
- `GET /api/advertising/orders-dayparting/ad-overlay` — DP.2 — Amazon ad-spend-by-hour overlay

#### routes/amazon-ads-auth.routes.ts (prefix `/api`) — 4

- `GET /api/amazon-ads/debug/test-auth` — Debug: test auth step-by-step
- `GET /api/amazon-ads/auth/connect` — Step 1: redirect operator to Amazon consent page
- `GET /api/amazon-ads/auth/callback` — Step 2: exchange code for tokens, discover + save profiles
- `POST /api/amazon-ads/backfill` — HB.1 — Amazon Ads 24-month backfill orchestrator  **[destructive?]**

### products/catalog — 278 endpoints

#### routes/catalog.routes.ts (prefix `/api/catalog`) — 18

- `GET /api/catalog/product-types` — Returns list of available Amazon product types for dropdown
- `GET /api/catalog/product-types/:productType/schema` — Returns parsed schema (required + optional fields) for a product type
- `POST /api/catalog/validate` — Validates product attributes against schema
- `POST /api/catalog/products` — Create product with dynamic attributes
- `POST /api/catalog/products/bulk` — Create master product with variations and channel listings in a single transaction
- `GET /api/catalog/products/:id` — Returns the product plus its existing children mapped into a
- `PATCH /api/catalog/products/:id` — Update product and queue syncs to marketplaces
- `GET /api/catalog/cache-stats` — Get cache statistics (for monitoring)
- `POST /api/catalog/cache-clear` — Clear schema cache (admin only)
- `DELETE /api/catalog/products/:id` — Delete a product and all associated data (cascading delete)
- `POST /api/catalog/products/:parentId/children` — Create a new child product (variation)
- `POST /api/catalog/products/:parentId/bulk-variants` — Phase 29: Bulk create variants from matrix builder
- `PATCH /api/catalog/products/:parentId/children/:childId` — Update a child product (variation)
- `PATCH /api/catalog/products/:productId/variant-attributes` — XX — PATCH /api/catalog/products/:productId/variant-attributes
- `DELETE /api/catalog/products/:parentId/children/:childId` — Delete a child product (variation)
- `POST /api/catalog/sync/bulk` — Phase 25: Bulk sync all products to specified channel(s)
- `POST /api/catalog/ebay/import` — Phase 25: Import eBay catalog and save as Master Products
- `GET /api/catalog/ebay/stats` — Get eBay import statistics

#### routes/catalog-organize.routes.ts (prefix `/api/catalog`) — 4

- `POST /api/catalog/organize/publish` — POST /api/catalog/organize/publish
- `GET /api/catalog/organize/sessions` — GET /api/catalog/organize/sessions
- `POST /api/catalog/organize/undo/:sessionId` — POST /api/catalog/organize/undo/:sessionId
- `POST /api/catalog/organize/undo/:sessionId/change/:changeId` — POST /api/catalog/organize/undo/:sessionId/change/:changeId

#### routes/field-links.routes.ts (prefix `(none)`) — 7

- `GET /api/products/:id/field-links` — read products field links
- `PUT /api/products/:id/field-links/:fieldKey` — replace products field links
- `POST /api/products/:id/field-links/:fieldKey/propagate-preview` — FL.4.2/4.3 — PREVIEW the propagation diff for a linked field. Plans
- `POST /api/products/:id/cross-channel/propagate-preview` — T3.3b / B1 — ad-hoc CROSS-CHANNEL propagate-preview. Same plan + AI
- `POST /api/products/:id/cross-channel/back-translate` — T3.3b / B3 — on-demand back-translation. Given a value in some target
- `POST /api/products/:id/cross-channel/applied` — T3.3b / B5 — record a cross-channel propagation to the audit log.
- `GET /api/products/:id/field-links/suggestions` — FL.6.2 — Smart link suggestions. Scans the product's listings for

#### routes/matrix.routes.ts (prefix `(none)`) — 6

- `GET /api/products/:id/matrix` — read products matrix
- `POST /api/products/:id/matrix/channel-listing` — create/run products matrix channel listing
- `PUT /api/products/:id/matrix/channel-listing/:listingId` — replace products matrix channel listing
- `POST /api/products/:id/matrix/offer` — create/run products matrix offer
- `PUT /api/products/:id/matrix/offer/:offerId` — replace products matrix offer
- `DELETE /api/products/:id/matrix/offer/:offerId` — delete products matrix offer

#### routes/catalog-safe.routes.ts (prefix `/api/catalog`) — 1

- `POST /api/catalog/amazon/import` — Returns the current count of Amazon-synced products already in the DB.

#### routes/products.routes.ts (prefix `/api`) — 29

- `GET /api/pim/fields` — selector. Optional filters:
- `POST /api/pim/ebay-prewarm` — BB.1 — prewarm the eBay aspect cache for a list of categoryIds.
- `GET /api/products` — Distinct from /products/bulk-fetch (bulk-ops, returns everything)  **[guard:allowApiKeyScope]**
- `GET /api/products/bulk-fetch` — bulk-operations table. Plain Decimal coercion to numbers so the
- `GET /api/products/:id` — P2 #21 — adds the canonical /products/:id endpoint so the
- `GET /api/products/:id/events` — ES.4 — GET /api/products/:id/events
- `GET /api/products/:id/children` — Lifts categoryAttributes.variations to a top-level `variations` field
- `GET /api/products/:id/fulfillment` — FCF.1 — GET /api/products/:id/fulfillment
- `GET /api/products/:id/state` — ES.5 — GET /api/products/:id/state?at=<ISO>
- `POST /api/products/:id/restore` — ES.5 — POST /api/products/:id/restore  **[destructive?]**
- `PATCH /api/products/:id/fbm-stock` — M.3 — PATCH /api/products/:id/fbm-stock
- `PATCH /api/products/bulk` — Body: { changes: Array<{ id, field, value, cascade? }> }
- `POST /api/admin/seed-bulk-test` — Performance-test seeding (admin-only — no auth gate but uses
- `DELETE /api/admin/cleanup-bulk-test` — Removes every Product row marked importSource = 'PERFORMANCE_TEST'.  **[destructive?]**
- `POST /api/admin/backfill-read-cache` — ES.3 — POST /api/admin/backfill-read-cache  **[destructive?]**
- `GET /api/admin/listing-integrity` — SKU-LINKAGE — GET /api/admin/listing-integrity
- `POST /api/admin/cleanup-product-orphans` — F.1 — POST /api/admin/cleanup-product-orphans  **[destructive?]**
- `POST /api/products/create-wizard` — D.4: CSV / XLSX bulk upload
- `POST /api/products/bulk-upload` — multipart/form-data with one file. Parses + validates against
- `POST /api/products/bulk-upload-preflight` — CC.2 — POST /api/products/bulk-upload-preflight
- `POST /api/products/bulk-upload-zip` — D.5: ZIP archive with one folder per SKU. Each folder may
- `POST /api/products/bulk-apply` — body: { uploadId }
- `GET /api/products/bulk-template` — CSV with editable field headers + a single sample row that  **[file-download]**
- `POST /api/products/bulk-schema-update` — R.2 — schema-driven bulk attribute update across products ×
- `POST /api/products/bulk-replicate` — AA.1 — replicate listing values from a source marketplace to one
- `GET /api/products/variant-search` — FNSKU label designer: search variant SKUs directly
- `GET /api/products/:id/analytics` — PA.1: Product Analytics
- `GET /api/products/:id/analytics/trend` — GET /api/products/:id/analytics/trend?days=30
- `GET /api/products/:id/quality-history` — GET /api/products/:id/quality-history?channel=AMAZON&days=90

#### routes/families.routes.ts (prefix `/api`) — 15

- `GET /api/families` — GET /api/families — list with attribute counts.
- `GET /api/families/:id` — GET /api/families/:id — single family + counts.
- `GET /api/families/:id/effective` — the parent chain (W2.4 service). Used by the editor + completeness
- `POST /api/families` — POST /api/families — create.
- `PATCH /api/families/:id` — parentFamilyId changes by walking the candidate's chain.
- `DELETE /api/families/:id` — childFamilies.parentFamilyId → SET NULL (children become roots)
- `GET /api/products/:id/family-completeness` — W2.14 — Completeness
- `GET /api/products/:id/channel-readiness` — W3.10 — Channel readiness
- `POST /api/products/channel-readiness/bulk` — Bulk readiness for the lens (W3.11). Capped at 200 ids per call.
- `POST /api/products/translation-coverage/bulk` — W5.6 — Bulk per-locale translation coverage for the
- `POST /api/products/family-completeness/bulk` — W5.1 — Bulk family-completeness for the /products grid column.
- `POST /api/families/:id/attributes` — Refuses with 409 if the attribute is already declared by this
- `PATCH /api/family-attributes/:id` — attributeId + familyId are immutable (would invalidate the
- `DELETE /api/family-attributes/:id` — Note: removing a parent's attribute means children stop
- `POST /api/products/bulk-attach-family` — W2.8 — bulk attach/detach family on N products

#### routes/attributes.routes.ts (prefix `/api`) — 13

- `GET /api/attribute-groups` — read attribute groups
- `GET /api/attribute-groups/:id` — read attribute groups
- `POST /api/attribute-groups` — create/run attribute groups
- `PATCH /api/attribute-groups/:id` — update attribute groups
- `DELETE /api/attribute-groups/:id` — delete attribute groups
- `GET /api/attributes` — read attributes
- `GET /api/attributes/:id` — read attributes
- `POST /api/attributes` — create/run attributes
- `PATCH /api/attributes/:id` — update attributes
- `DELETE /api/attributes/:id` — delete attributes
- `POST /api/attributes/:attrId/options` — create/run attributes options
- `PATCH /api/attribute-options/:id` — update attribute options
- `DELETE /api/attribute-options/:id` — delete attribute options

#### routes/workflows.routes.ts (prefix `/api`) — 9

- `GET /api/workflows` — read workflows
- `GET /api/workflows/:id` — read workflows
- `POST /api/workflows` — create/run workflows
- `PATCH /api/workflows/:id` — update workflows
- `DELETE /api/workflows/:id` — delete workflows
- `POST /api/workflows/:id/stages` — create/run workflows stages
- `PATCH /api/workflow-stages/:id` — update workflow stages
- `DELETE /api/workflow-stages/:id` — delete workflow stages
- `GET /api/workflows/:id/pipeline` — W3.7 — Pipeline aggregation

#### routes/product-workflow.routes.ts (prefix `/api`) — 7

- `POST /api/products/:id/workflow/attach` — create/run products workflow attach
- `POST /api/products/:id/workflow/detach` — create/run products workflow detach
- `POST /api/products/:id/workflow/move` — create/run products workflow move
- `GET /api/products/:id/workflow` — read products workflow
- `POST /api/products/:id/workflow/comments` — create/run products workflow comments
- `DELETE /api/workflow-comments/:id` — delete workflow comments
- `POST /api/products/bulk-move-workflow-stage` — create/run products bulk move workflow stage

#### routes/product-channel-data.routes.ts (prefix `/api`) — 8

- `GET /api/products/:id/channel-pricing` — GET /api/products/:id/channel-pricing
- `PATCH /api/products/:id/channel-pricing` — PATCH /api/products/:id/channel-pricing
- `GET /api/products/:id/channel-inventory` — GET /api/products/:id/channel-inventory
- `PATCH /api/products/:id/fulfillment` — PATCH /api/products/:id/fulfillment
- `GET /api/products/:id/listings` — GET /api/products/:id/listings
- `GET /api/products/:id/amazon-sync-data` — GET /api/products/:id/amazon-sync-data
- `GET /api/products/:id/variant-image-locks` — GET /api/products/:id/variant-image-locks
- `POST /api/products/listing-health/bulk` — OL.C.1 — POST /api/products/listing-health/bulk

#### routes/categories.routes.ts (prefix `/api`) — 4

- `GET /api/categories/schema` — Returns the cached or freshly-fetched CategorySchema row. `force=1`
- `GET /api/categories/browse-path` — Returns the Amazon category breadcrumb (categoryPath) and browse node IDs
- `GET /api/categories/suggestions` — Category search matching Amazon Seller Central's "Choose product type" UI.
- `GET /api/categories/changes` — Surfaces the SchemaChange log for a given (channel, marketplace,

#### routes/pim-categories.routes.ts (prefix `/api`) — 8

- `GET /api/pim/categories/tree` — Tree
- `GET /api/pim/categories/:id/breadcrumb` — read pim categories breadcrumb
- `POST /api/pim/categories` — Create
- `PATCH /api/pim/categories/:id` — Update
- `POST /api/pim/categories/:id/move` — Move (re-parent subtree)
- `DELETE /api/pim/categories/:id` — Delete
- `POST /api/products/:id/categories` — Product membership
- `DELETE /api/products/:id/categories/:categoryId` — delete products categories

#### routes/import-wizard.routes.ts (prefix `/api`) — 7

- `GET /api/import-jobs` — GET /api/import-jobs
- `GET /api/import-jobs/:id` — GET /api/import-jobs/:id
- `GET /api/import-jobs/:id/rows` — GET /api/import-jobs/:id/rows
- `POST /api/import-jobs/preview` — Parse the supplied file, build a column mapping (operator-
- `POST /api/import-jobs/:id/apply` — POST /api/import-jobs/:id/apply
- `POST /api/import-jobs/:id/retry-failed` — POST /api/import-jobs/:id/retry-failed
- `POST /api/import-jobs/:id/rollback` — POST /api/import-jobs/:id/rollback  **[destructive?]**

#### routes/scheduled-imports.routes.ts (prefix `/api`) — 6

- `GET /api/scheduled-imports` — read scheduled imports
- `GET /api/scheduled-imports/:id` — read scheduled imports
- `POST /api/scheduled-imports` — create/run scheduled imports
- `PATCH /api/scheduled-imports/:id/enabled` — update scheduled imports enabled
- `DELETE /api/scheduled-imports/:id` — delete scheduled imports
- `POST /api/scheduled-imports/tick` — create/run scheduled imports tick

#### routes/export-wizard.routes.ts (prefix `/api`) — 5

- `GET /api/export-jobs` — read export jobs
- `GET /api/export-jobs/:id` — read export jobs
- `POST /api/export-jobs` — create/run export jobs
- `GET /api/export-jobs/:id/download` — Streams the rendered artifact back with the right content-type  **[file-download]**
- `DELETE /api/export-jobs/:id` — delete export jobs

#### routes/scheduled-exports.routes.ts (prefix `/api`) — 6

- `GET /api/scheduled-exports` — read scheduled exports
- `GET /api/scheduled-exports/:id` — read scheduled exports
- `POST /api/scheduled-exports` — create/run scheduled exports
- `PATCH /api/scheduled-exports/:id/enabled` — update scheduled exports enabled
- `DELETE /api/scheduled-exports/:id` — delete scheduled exports
- `POST /api/scheduled-exports/tick` — create/run scheduled exports tick

#### routes/pim.routes.ts (prefix `/api`) — 9

- `GET /api/pim/standalones` — GET /pim/standalones
- `GET /api/pim/parents-overview` — GET /pim/parents-overview
- `POST /api/pim/attach-to-parent` — POST /pim/attach-to-parent
- `POST /api/pim/promote-to-parent` — POST /pim/promote-to-parent
- `GET /api/pim/parent/:id/children` — GET /pim/parent/:id/children
- `POST /api/pim/bulk-promote-to-parent` — POST /pim/bulk-promote-to-parent
- `GET /api/pim/family/:productId` — GET /pim/family/:productId
- `POST /api/pim/demote-parent` — POST /pim/demote-parent
- `POST /api/pim/reparent` — POST /pim/reparent

#### routes/pim-global.routes.ts (prefix `/api`) — 11

- `GET /api/products/:id/global` — GET /products/:id/global
- `GET /api/products/:id/master-schema` — GET /products/:id/master-schema
- `POST /api/products/:id/master/import-from-channel` — POST /products/:id/master/import-from-channel
- `POST /api/products/:id/master/import-from-flat-file` — POST /products/:id/master/import-from-flat-file
- `GET /api/products/:id/master/completeness` — GET /products/:id/master/completeness
- `POST /api/products/:id/master/ai-fill` — POST /products/:id/master/ai-fill
- `PATCH /api/products/:id/global` — PATCH /products/:id/global
- `GET /api/products/:id/channel-listing/:clId/inheritance` — GET /products/:id/channel-listing/:clId/inheritance
- `POST /api/products/:id/channel-listing/:clId/reset` — POST /products/:id/channel-listing/:clId/reset  **[destructive?]**
- `GET /api/products/:id/cascade-preview` — GET /products/:id/cascade-preview
- `DELETE /api/products/:id/global/technical/:key` — DELETE /products/:id/global/technical/:key

#### routes/catalog-matrix.routes.ts (prefix `/api`) — 1

- `GET /api/catalog/matrix` — GET /catalog/matrix

#### routes/pim-mapping.routes.ts (prefix `/api`) — 16

- `GET /api/pim/mappings/marketplaces` — GET /pim/mappings/marketplaces
- `GET /api/pim/mappings/:channel/:code` — GET /pim/mappings/:channel/:code
- `PUT /api/pim/mappings/:channel/:code/:fieldKey` — PUT /pim/mappings/:channel/:code/:fieldKey
- `POST /api/pim/mappings/:channel/:code/sync-schema` — POST /pim/mappings/:channel/:code/sync-schema
- `GET /api/pim/mappings/:channel/:code/preview/:productId` — GET /pim/mappings/:channel/:code/preview/:productId
- `GET /api/pim/mappings/:channel/:code/validate/:productId` — GET /pim/mappings/:channel/:code/validate/:productId
- `GET /api/pim/mappings/:channel/:code/suggest` — GET /pim/mappings/:channel/:code/suggest
- `POST /api/pim/mappings/:channel/:code/suggest-ai` — POST /pim/mappings/:channel/:code/suggest-ai
- `DELETE /api/pim/mappings/:channel/:code/:fieldKey` — DELETE /pim/mappings/:channel/:code/:fieldKey
- `GET /api/pim/mappings/:channel/:code/revisions` — GET /pim/mappings/:channel/:code/revisions
- `POST /api/pim/mappings/:channel/:code/rollback/:revisionId` — POST /pim/mappings/:channel/:code/rollback/:revisionId  **[destructive?]**
- `POST /api/pim/mappings/:channel/:code/bulk` — POST /pim/mappings/:channel/:code/bulk
- `DELETE /api/pim/mappings/:channel/:code/bulk` — DELETE /pim/mappings/:channel/:code/bulk
- `POST /api/pim/mappings/clone` — POST /pim/mappings/clone
- `GET /api/pim/mappings/coverage` — GET /pim/mappings/coverage
- `POST /api/pim/mappings/:channel/:code/simulate` — POST /pim/mappings/:channel/:code/simulate

#### routes/value-map.routes.ts (prefix `/api`) — 7

- `GET /api/pim/value-maps` — read pim value maps
- `PUT /api/pim/value-maps` — replace pim value maps
- `DELETE /api/pim/value-maps/:id` — delete pim value maps
- `POST /api/pim/value-maps/seed-ai` — create/run pim value maps seed ai
- `POST /api/pim/value-maps/seed-ebay` — VL.3 — eBay value-map seed: AI-translate a product's eBay aspect values
- `GET /api/pim/size-scales` — read pim size scales
- `PUT /api/pim/size-scales` — replace pim size scales

#### routes/mapping-propagation.routes.ts (prefix `/api`) — 5

- `POST /api/products/:id/mapping/propagate-preview` — create/run products mapping propagate preview
- `POST /api/products/:id/mapping/apply` — FM.6 — apply the cascade: persist translations (both stores), enqueue
- `GET /api/products/:id/mapping/divergence` — FM.12 — read-only divergence scan: per-coordinate overrides that diverge
- `GET /api/products/:id/mapping/matrix` — FM — per-product mapping matrix (read-only): field-rows × coordinate-
- `POST /api/products/:id/mapping/adopt-master` — FM — adopt master for one coordinate's field: clears the per-coordinate

#### routes/products-catalog.routes.ts (prefix `/api`) — 32

- `GET /api/products/facets` — read products facets
- `GET /api/products/:id/health` — HEALTH (per product)
- `GET /api/tags` — read tags
- `POST /api/tags` — create/run tags
- `PATCH /api/tags/:id` — update tags
- `DELETE /api/tags/:id` — delete tags
- `POST /api/products/:id/tags` — create/run products tags
- `DELETE /api/products/:id/tags/:tagId` — delete products tags
- `POST /api/products/bulk-tag` — create/run products bulk tag
- `GET /api/bundles` — read bundles
- `POST /api/bundles` — create/run bundles
- `GET /api/bundles/:id` — read bundles
- `PATCH /api/bundles/:id` — update bundles
- `DELETE /api/bundles/:id` — delete bundles
- `GET /api/saved-views` — read saved views
- `POST /api/saved-views` — create/run saved views
- `PATCH /api/saved-views/:id` — update saved views
- `DELETE /api/saved-views/:id` — delete saved views
- `POST /api/products/bulk-status` — BULK CATALOG ACTIONS — promote to parent / attach as child / set status
- `POST /api/products/bulk-duplicate` — create/run products bulk duplicate
- `PATCH /api/products/:id` — quick-edit cells in the Grid lens. Avoids re-using the heavy
- `GET /api/products/:id/activity` — F3 — GET /api/products/:id/activity
- `POST /api/products/bulk-set-stock` — products (and/or update lowStockThreshold).
- `POST /api/products/bulk-soft-delete` — create/run products bulk soft delete  **[guard:allowApiKeyScope]**
- `POST /api/products/bulk-restore` — create/run products bulk restore  **[destructive?]**
- `GET /api/products/hard-delete-preflight` — F.1 — manual hard-delete from the recycle bin. Mirrors the cron
- `POST /api/products/bulk-hard-delete` — create/run products bulk hard delete
- `POST /api/products/:id/scheduled-changes` — The cron worker (`scheduled-changes.cron.ts`, every 60s) picks
- `GET /api/products/:id/scheduled-changes` — read products scheduled changes
- `POST /api/products/scheduled-changes/:id/cancel` — create/run products scheduled changes cancel
- `POST /api/products/bulk-set-field` — Body: { productIds, field, value }
- `GET /api/products/command-matrix` — COMMAND MATRIX — hierarchical catalog grid

#### routes/products-search.routes.ts (prefix `/api`) — 1

- `GET /api/products/search` — read products search

#### routes/products-images.routes.ts (prefix `/api`) — 2

- `POST /api/products/images/resolve` — create/run products images resolve
- `POST /api/products/images/upload` — create/run products images upload

#### routes/product-translations.routes.ts (prefix `/api`) — 6

- `GET /api/products/:id/translations` — read products translations
- `GET /api/products/:id/translations/:language` — read products translations
- `PUT /api/products/:id/translations/:language` — replace products translations
- `POST /api/products/:id/translations/:language/review` — create/run products translations review
- `DELETE /api/products/:id/translations/:language` — delete products translations
- `POST /api/products/:id/translations/:language/ai-translate` — create/run products translations ai translate

#### routes/product-relations.routes.ts (prefix `/api`) — 5

- `GET /api/products/:id/relations` — read products relations
- `POST /api/products/:id/relations` — create/run products relations
- `PATCH /api/products/relations/:id` — update products relations
- `DELETE /api/products/relations/:id` — delete products relations
- `GET /api/products/:id/relations/suggest` — W11.1 — heuristic cross-sell suggestions.

#### routes/product-certificates.routes.ts (prefix `/api`) — 4

- `GET /api/products/:id/certificates` — GET /api/products/:id/certificates
- `POST /api/products/:id/certificates` — POST /api/products/:id/certificates
- `PATCH /api/products/:id/certificates/:certId` — PATCH /api/products/:id/certificates/:certId
- `DELETE /api/products/:id/certificates/:certId` — DELETE /api/products/:id/certificates/:certId

#### routes/product-images-crud.routes.ts (prefix `/api`) — 17

- `GET /api/products/:id/images` — GET /api/products/:id/images
- `POST /api/products/:id/images` — POST /api/products/:id/images (multipart upload)
- `POST /api/products/:id/videos` — POST /products/:id/videos
- `POST /api/products/:id/images/reorder` — POST /api/products/:id/images/reorder
- `PATCH /api/products/:id/images/:imageId` — PATCH /api/products/:id/images/:imageId
- `POST /api/products/:id/images/:imageId/derive` — POST /api/products/:id/images/:imageId/derive
- `POST /api/products/:id/images/:imageId/auto-enhance` — POST /api/products/:id/images/:imageId/auto-enhance
- `POST /api/products/:id/images/apply-to-children` — POST /api/products/:id/images/apply-to-children
- `POST /api/products/images/bulk-apply` — POST /api/products/images/bulk-apply
- `POST /api/products/:id/images/import-from-dam` — POST /api/products/:id/images/import-from-dam
- `POST /api/products/:id/images/:imageId/push-to-dam` — POST /api/products/:id/images/:imageId/push-to-dam
- `POST /api/products/:id/images/:imageId/analyze` — POST /api/products/:id/images/:imageId/analyze
- `POST /api/products/:id/images/generate-lifestyle` — POST /api/products/:id/images/generate-lifestyle
- `PATCH /api/products/:id/images/:imageId/primary` — PATCH /api/products/:id/images/:imageId/primary
- `DELETE /api/products/:id/images/:imageId` — DELETE /api/products/:id/images/:imageId
- `GET /api/products/:id/live-channel-images` — GET /api/products/:id/live-channel-images
- `POST /api/products/:id/live-channel-images/refresh` — POST /api/products/:id/live-channel-images/refresh

#### routes/product-seo.routes.ts (prefix `/api`) — 4

- `GET /api/products/:id/seo` — GET all locales
- `GET /api/products/:id/seo/:locale` — GET single locale
- `PUT /api/products/:id/seo/:locale` — PUT (upsert)
- `DELETE /api/products/:id/seo/:locale` — DELETE

#### routes/workflow-assignments.routes.ts (prefix `/api`) — 5

- `GET /api/products/:id/workflow/assignments` — GET assignments
- `POST /api/products/:id/workflow/assignments` — POST — create assignment
- `PATCH /api/products/:id/workflow/assignments/:assignmentId` — PATCH — update assignment
- `DELETE /api/products/:id/workflow/assignments/:assignmentId` — DELETE — remove assignment
- `GET /api/users/search` — GET users/search — for the assignee picker

### admin/ops — 135 endpoints

#### routes/admin.ts (prefix `(none)`) — 28

- `POST /admin/amazon/restore-fba` — Recovery for the FBA→FBM flip incident. Sends a Listings PATCH that sets  **[destructive?]**
- `GET /admin/amazon/listing-state` — READ-ONLY diagnostic — reads a listing's live fulfillment state from Amazon
- `GET /admin/amazon/fulfillment-report` — READ-ONLY authoritative check — pulls Amazon's merchant-listings report
- `GET /admin/validation/report` — Get comprehensive validation report for all products
- `GET /admin/validation/product/:productId` — Validate a specific product
- `POST /admin/repair/all` — Run all batch repair operations  **[destructive?]**
- `POST /admin/repair/orphaned-variations` — Remove variations without products  **[destructive?]**
- `POST /admin/repair/missing-themes` — Infer and set variation themes for products  **[destructive?]**
- `POST /admin/repair/missing-attributes` — Populate variation attributes from legacy fields  **[destructive?]**
- `POST /admin/normalize-image-urls` — Strip Amazon size modifiers (e.g. _SL75_) from ProductImage URLs →
- `GET /admin/amazon-slot-taxonomy` — M1 — inspect the schema-discovered image-slot taxonomy for a market +
- `POST /admin/repair/product-status` — Ensure all products have valid status  **[destructive?]**
- `POST /admin/repair/channel-listings` — Fix inconsistent channel listings  **[destructive?]**
- `POST /admin/amazon/hydrate-attributes` — System health check
- `GET /admin/health` — read admin health
- `GET /admin/sales-drift/audit` — DA-RT.13 — GET /admin/sales-drift/audit?lookbackDays=7
- `GET /admin/sales-drift/window` — DA-RT.13 — GET /admin/sales-drift/window?day=YYYY-MM-DD&marketplace=ES
- `POST /admin/orders/:id/manual-total` — PV-RT.4 — POST /admin/orders/:id/manual-total
- `POST /admin/sales-drift/delete-empty-order-fts` — DA-RT.18 — POST /admin/sales-drift/delete-empty-order-fts
- `POST /admin/sales-drift/fix-line-total-orderitems` — DA-RT.15 — POST /admin/sales-drift/fix-line-total-orderitems
- `POST /admin/sales-drift/refresh-aggregate` — DA-RT.14 — POST /admin/sales-drift/refresh-aggregate?days=30
- `POST /admin/sales-drift/backfill-financial-events` — DA-RT.13 — POST /admin/sales-drift/backfill-financial-events?days=7  **[destructive?]**
- `GET /admin/recycle-bin/summary` — RB.1 — Recycle bin housekeeping. Powers /admin/recycle-bin.
- `POST /admin/recycle-bin/purge` — create/run admin recycle bin purge  **[destructive?]**
- `GET /admin/pim/resolver-shadow-stats` — PIM A.2 — resolver shadow telemetry
- `POST /admin/pim/resolver-shadow-reset` — create/run admin pim resolver shadow reset  **[destructive?]**
- `GET /admin/search/status` — PIM search engine (Typesense) admin
- `POST /admin/search/backfill` — create/run admin search backfill  **[destructive?]**

#### routes/sync.routes.ts (prefix `/api`) — 5

- `POST /api/sync/detect-drift` — P.2 — Manual trigger for the master-drift detector.
- `GET /api/sync/detect-drift/status` — P.2 — Cron status for the drift detector. Useful for ops to
- `POST /api/sync/amazon/catalog` — Trigger a new Amazon catalog sync
- `GET /api/sync/amazon/catalog/:syncId` — Get sync status by ID
- `POST /api/sync/amazon/catalog/:syncId/retry` — Retry a failed sync

#### routes/outbound.routes.ts (prefix `(none)`) — 8

- `GET /api/outbound/queue` — View the outbound sync queue with optional filters
- `POST /api/outbound/process` — Manually trigger processing of pending syncs
- `POST /api/outbound/queue/:queueId/retry` — Retry a specific failed queue item
- `GET /api/outbound/stats` — Get sync statistics
- `POST /api/outbound/queue` — Manually queue a product for sync
- `GET /api/outbound/queue/:queueId` — Get details of a specific queue item
- `DELETE /api/outbound/queue/:queueId` — Cancel a pending sync (grace period - undo sync)
- `GET /api/outbound/worker-status` — Get the status of the background sync worker (Autopilot)

#### routes/cockpit-telemetry.routes.ts (prefix `/api`) — 2

- `POST /api/cockpit/events` — create/run cockpit events
- `GET /api/cockpit/events/stats` — read cockpit events stats

#### routes/bulk-operations.routes.ts (prefix `/api`) — 18

- `POST /api/bulk-operations` — Create a new bulk-operation job. Returns the job row including
- `POST /api/bulk-operations/check-conflicts` — Pre-flight conflict check without creating a job. Used by the
- `POST /api/bulk-operations/preview` — Resolve scope + simulate the operation against the first N items
- `GET /api/bulk-operations/queue-stats` — W13.4 — BullMQ counters for the bulk-job queue. Used by
- `POST /api/bulk-operations/ai/cost-preview` — W11.4 — Pre-flight USD cost estimate for AI bulk actions.
- `GET /api/bulk-operations/history` — Paginated job history for the /bulk-operations/history page.
- `POST /api/bulk-operations/:id/rollback` — Roll back a previously-COMPLETED or PARTIALLY_COMPLETED bulk job.  **[destructive?]**
- `POST /api/bulk-operations/:id/retry-failed` — Create a new BulkActionJob scoped to the FAILED items of the
- `GET /api/bulk-operations/:id/items` — Per-item drill-down for the history page's "Items" panel.
- `GET /api/bulk-operations` — List jobs that are still pending (PENDING or QUEUED). Useful for
- `GET /api/bulk-operations/:id` — Status + progress for a specific job. Frontend polls this.
- `GET /api/bulk-operations/:id/events` — W10.1 — Server-sent events stream for live job progress.  **[SSE]**
- `POST /api/bulk-operations/:id/process` — Trigger processing. Fire-and-forget — returns immediately with
- `POST /api/bulk-operations/:id/cancel` — Cancel a still-pending job. Once IN_PROGRESS, in-flight items
- `GET /api/bulk-ops/templates` — GET /api/bulk-ops/templates — list, newest first.
- `POST /api/bulk-ops/templates` — POST /api/bulk-ops/templates — create.
- `PATCH /api/bulk-ops/templates/:id` — subset of fields. updatedAt is auto-bumped by Prisma.
- `DELETE /api/bulk-ops/templates/:id` — DELETE /api/bulk-ops/templates/:id

#### routes/bulk-action-templates.routes.ts (prefix `/api`) — 7

- `GET /api/bulk-action-templates` — GET /api/bulk-action-templates — list, optionally filtered.
- `GET /api/bulk-action-templates/:id` — GET /api/bulk-action-templates/:id
- `POST /api/bulk-action-templates` — POST /api/bulk-action-templates
- `PATCH /api/bulk-action-templates/:id` — PATCH /api/bulk-action-templates/:id
- `DELETE /api/bulk-action-templates/:id` — DELETE /api/bulk-action-templates/:id
- `POST /api/bulk-action-templates/:id/duplicate` — POST /api/bulk-action-templates/:id/duplicate
- `POST /api/bulk-action-templates/:id/apply` — Substitutes parameters into the template, optionally overrides

#### routes/scheduled-bulk-actions.routes.ts (prefix `/api`) — 6

- `GET /api/scheduled-bulk-actions` — GET /api/scheduled-bulk-actions
- `GET /api/scheduled-bulk-actions/:id` — GET /api/scheduled-bulk-actions/:id
- `POST /api/scheduled-bulk-actions` — POST /api/scheduled-bulk-actions
- `PATCH /api/scheduled-bulk-actions/:id/enabled` — PATCH /api/scheduled-bulk-actions/:id/enabled
- `DELETE /api/scheduled-bulk-actions/:id` — DELETE /api/scheduled-bulk-actions/:id
- `POST /api/scheduled-bulk-actions/tick` — Manually fire the tick — used by the /bulk-operations/schedules

#### routes/bulk-automation-rules.routes.ts (prefix `/api`) — 8

- `GET /api/bulk-automation-rules` — GET /api/bulk-automation-rules
- `GET /api/bulk-automation-rules/:id` — GET /api/bulk-automation-rules/:id
- `POST /api/bulk-automation-rules` — POST /api/bulk-automation-rules
- `PATCH /api/bulk-automation-rules/:id` — PATCH /api/bulk-automation-rules/:id
- `DELETE /api/bulk-automation-rules/:id` — DELETE /api/bulk-automation-rules/:id
- `POST /api/bulk-automation-rules/:id/dry-run` — W7.6 dry-run: evaluate the rule against a caller-supplied
- `GET /api/bulk-automation-rules/:id/executions` — List AutomationRuleExecution rows for a bulk-ops rule, newest
- `POST /api/bulk-automation-rules/dry-run-inline` — Evaluate an unsaved rule shape against a context. Used by the

#### routes/bulk-automation-approvals.routes.ts (prefix `/api`) — 5

- `GET /api/bulk-automation-approvals` — GET /api/bulk-automation-approvals
- `GET /api/bulk-automation-approvals/:id` — GET /api/bulk-automation-approvals/:id
- `POST /api/bulk-automation-approvals/:id/approve` — POST /api/bulk-automation-approvals/:id/approve
- `POST /api/bulk-automation-approvals/:id/reject` — POST /api/bulk-automation-approvals/:id/reject
- `POST /api/bulk-automation-approvals/sweep-expired` — POST /api/bulk-automation-approvals/sweep-expired

#### routes/outbound-queue.routes.ts (prefix `(none)`) — 6

- `GET /api/outbound-queue` — GET /api/outbound-queue
- `POST /api/outbound-queue/:id/retry` — POST /api/outbound-queue/:id/retry
- `POST /api/outbound-queue/purge-failed` — POST /api/outbound-queue/purge-failed (B3)  **[destructive?]**
- `POST /api/outbound-queue/:id/cancel` — POST /api/outbound-queue/:id/cancel
- `POST /api/outbound-queue/bulk-retry` — POST /api/outbound-queue/bulk-retry
- `POST /api/outbound-queue/bulk-cancel` — POST /api/outbound-queue/bulk-cancel

#### routes/audit-log.routes.ts (prefix `/api`) — 3

- `GET /api/audit-log/search` — read audit log search
- `GET /api/events` — ES.4 — GET /api/events
- `GET /api/audit-log/:id` — read audit log

#### routes/sync-logs.routes.ts (prefix `/api`) — 26

- `GET /api/sync-logs/api-calls` — Aggregate rollup. One round-trip; the hub renders every API-call
- `GET /api/sync-logs/alerts/rules` — L.16.0 — alert rules + events (PagerDuty-tier).
- `POST /api/sync-logs/alerts/rules` — create/run sync logs alerts rules
- `PATCH /api/sync-logs/alerts/rules/:id` — update sync logs alerts rules
- `DELETE /api/sync-logs/alerts/rules/:id` — delete sync logs alerts rules
- `GET /api/sync-logs/alerts/events` — read sync logs alerts events
- `POST /api/sync-logs/alerts/events/:id/acknowledge` — create/run sync logs alerts events acknowledge
- `POST /api/sync-logs/alerts/events/:id/resolve` — create/run sync logs alerts events resolve
- `GET /api/sync-logs/saved-searches` — L.15.0 — saved searches.
- `POST /api/sync-logs/saved-searches` — create/run sync logs saved searches
- `DELETE /api/sync-logs/saved-searches/:id` — delete sync logs saved searches
- `GET /api/sync-logs/cron/registry` — L.14.0 — manual cron trigger.
- `POST /api/sync-logs/cron/:jobName/trigger` — create/run sync logs cron trigger
- `GET /api/sync-logs/api-calls/export` — L.13.0 — CSV / JSON export for filtered API calls.  **[file-download]**
- `GET /api/sync-logs/api-calls/timeseries` — L.11.0 — bucketed time-series for the API calls chart.
- `GET /api/sync-logs/events` — L.7.0 — SSE event stream for the live tail.  **[SSE]**
- `GET /api/sync-logs/error-groups` — L.8.1 — Sentry-tier error groups list.
- `POST /api/sync-logs/error-groups/:id/resolve` — Resolution workflow.
- `GET /api/sync-logs/webhooks` — L.9.0 — Webhook event browser.
- `POST /api/sync-logs/webhooks/:id/replay` — L.17.0 — webhook replay.
- `GET /api/sync-logs/webhooks/:id` — Single webhook detail. Returns the full row INCLUDING payload +
- `GET /api/sync-logs/api-calls/recent` — Paginated recent calls list with filters. Used by the hub's
- `GET /api/sync-logs/listing-health` — PIM E.1 — listing health rollup per (channel × marketplace)
- `GET /api/sync-logs/failing-listings` — PIM E.3 — failing listings drill-down
- `GET /api/sync-logs/in-flight` — PIM E.2 — In-flight sync rollup
- `POST /api/sync-logs/failing-listings/retry` — PIM E.5 — Retry failed listings (re-enqueue via OutboundSyncQueue)

#### routes/push-health.routes.ts (prefix `/api`) — 1

- `GET /api/admin/push-health` — GET /api/admin/push-health

#### routes/push-latency.routes.ts (prefix `/api`) — 1

- `GET /api/admin/push-latency` — read admin push latency

#### routes/outbound-latency.routes.ts (prefix `/api`) — 1

- `GET /api/admin/outbound-latency` — read admin outbound latency

#### routes/inventory-sync-diagnostics.routes.ts (prefix `/api`) — 1

- `GET /api/admin/inventory-sync/diagnostics` — read admin inventory sync diagnostics

#### routes/control-tower.routes.ts (prefix `/api`) — 2

- `GET /api/inventory-sync/control-tower` — Endpoint 1
- `GET /api/inventory-sync/control-tower/:sku/delta` — Endpoint 2

#### routes/job-monitor.routes.ts (prefix `(none)`) — 7

- `GET /api/monitoring/queue-stats` — Get current queue statistics
- `GET /api/monitoring/jobs` — Get recent jobs from queue
- `POST /api/monitoring/jobs/:jobId/retry` — Retry a failed job
- `POST /api/monitoring/jobs/:jobId/cancel` — Cancel an active job
- `POST /api/monitoring/queue/pause` — Pause the queue
- `POST /api/monitoring/queue/resume` — Resume the queue
- `GET /api/monitoring/queue/stats/detailed` — Get detailed queue statistics

### marketing/content — 131 endpoints

#### routes/marketing.routes.ts (prefix `/api`) — 4

- `GET /api/marketing/promotions` — read marketing promotions
- `GET /api/marketing/advertising` — read marketing advertising
- `GET /api/marketing/content` — read marketing content
- `GET /api/marketing/reviews` — read marketing reviews

#### routes/marketing-os.routes.ts (prefix `/api`) — 37

- `GET /api/marketing/os/summary` — Summary KPIs
- `GET /api/marketing/os/campaigns` — Roster
- `GET /api/marketing/os/campaigns/:id` — Single campaign
- `GET /api/marketing/os/analytics` — Unified analytics (P14)
- `GET /api/marketing/os/budgets` — Budget command center (P7)
- `POST /api/marketing/os/budgets` — create/run marketing os budgets
- `PATCH /api/marketing/os/budgets/:id` — update marketing os budgets
- `DELETE /api/marketing/os/budgets/:id` — delete marketing os budgets
- `POST /api/marketing/os/budgets/:id/allocations` — Add a campaign to a pool. campaignId is globally unique across pools.
- `DELETE /api/marketing/os/allocations/:allocId` — delete marketing os allocations
- `GET /api/marketing/os/budgets/:id/rebalance/preview` — Rebalance preview (dry diff) + apply.
- `POST /api/marketing/os/budgets/:id/rebalance/apply` — create/run marketing os budgets rebalance apply
- `GET /api/marketing/os/rules` — Automation rules (P6, domain=marketing)
- `POST /api/marketing/os/rules` — create/run marketing os rules
- `PATCH /api/marketing/os/rules/:id` — update marketing os rules
- `DELETE /api/marketing/os/rules/:id` — delete marketing os rules
- `POST /api/marketing/os/rules/:id/run` — Manual run. Defaults to a forced dry-run preview (?mode=apply runs at
- `POST /api/marketing/os/actions/:id/rollback` — Roll back an executed campaign action (post-grace undo).  **[destructive?]**
- `POST /api/marketing/os/rules/evaluate-now` — Run the marketing rule evaluator once (manual tick for verification).
- `POST /api/marketing/os/campaigns` — Create campaign (P10, any channel incl. INTERNAL)
- `DELETE /api/marketing/os/campaigns/:id` — Delete a campaign (cascades links/detail/targets/metrics via FK). For
- `POST /api/marketing/os/campaigns/:id/launch` — Launch an INTERNAL content-push / outreach campaign (sandbox-gated).
- `PATCH /api/marketing/os/campaigns/:id/mutate` — Campaign mutations (P5, sandbox-gated)
- `POST /api/marketing/os/mutations/:queueId/cancel` — create/run marketing os mutations cancel
- `POST /api/marketing/os/sync/drain` — Manual drain (sandbox verification + cron-friendly). Processes ready
- `GET /api/marketing/os/calendar` — Marketing calendar (P4)
- `POST /api/marketing/os/calendar` — create/run marketing os calendar
- `PATCH /api/marketing/os/calendar/:id` — update marketing os calendar
- `DELETE /api/marketing/os/calendar/:id` — delete marketing os calendar
- `GET /api/marketing/os/cutover/amazon/status` — Amazon cutover readiness + guarded test (P8)
- `POST /api/marketing/os/cutover/amazon/test` — Guarded test: writes a campaign's CURRENT budget back to itself — a
- `POST /api/marketing/os/sync/ebay` — eBay live sync (P9 live)
- `POST /api/marketing/os/backfill/ebay` — eBay shadow backfill trigger (P9)  **[destructive?]**
- `GET /api/marketing/os/diagnostics/metrics` — Diagnostics (P3.2)
- `POST /api/marketing/os/backfill/amazon` — Amazon shadow backfill trigger (P3.1)  **[destructive?]**
- `GET /api/marketing/os/campaigns/:id/actions` — Campaign action history (P3-detail)
- `GET /api/marketing/os/events` — SSE stream  **[SSE]**

#### routes/assets.routes.ts (prefix `/api`) — 28

- `GET /api/assets/_meta/delivery-profiles` — MC.13.2 — delivery profile catalog + active default. Powers the
- `GET /api/assets/analytics` — MC.13.4 — analytics aggregation for the storage dashboard.
- `GET /api/assets/activity` — MC.14.4 — recent activity feed for the Content Hub. Returns the
- `GET /api/assets/overview` — MC.1.1 — DAM hub KPI overview. Single roundtrip for the
- `GET /api/assets/library` — MC.1.2 — unified library feed.
- `GET /api/assets/library/:id` — MC.1.5 — unified detail endpoint for the library drawer.
- `GET /api/assets` — read assets
- `GET /api/assets/:id` — read assets
- `POST /api/assets` — create/run assets
- `PATCH /api/assets/:id` — update assets
- `DELETE /api/assets/:id` — delete assets
- `POST /api/products/:id/asset-usages` — create/run products asset usages
- `PATCH /api/asset-usages/:id` — update asset usages
- `DELETE /api/asset-usages/:id` — delete asset usages
- `GET /api/asset-tags` — List all tags. Includes asset count alongside the existing
- `PUT /api/assets/:id/tags` — Replace the tag set on a DigitalAsset. Body is { tagIds: [...] }
- `GET /api/assets/:id/preview` — Returns the channel variant URLs with the picked locale overlay
- `GET /api/assets/:id/locale-overlays` — List overlays for a single asset. The drawer fetches this on
- `PUT /api/assets/:id/locale-overlays/:locale` — Upsert a single locale overlay (one row per asset+locale). The
- `DELETE /api/assets/:id/locale-overlays/:locale` — delete assets locale overlays
- `GET /api/asset-folders` — Returns the entire folder tree as a flat list with parentId. The
- `POST /api/asset-folders` — create/run asset folders
- `PATCH /api/asset-folders/:id` — update asset folders
- `DELETE /api/asset-folders/:id` — delete asset folders
- `POST /api/assets/upload` — create/run assets upload
- `POST /api/assets/upload-url` — MC.3.1 — upload-from-URL.
- `POST /api/assets/upload-zip` — create/run assets upload zip
- `POST /api/assets/move` — Move a set of assets to a folder (or to "unfiled" via folderId

#### routes/aplus-content.routes.ts (prefix `/api`) — 18

- `GET /api/aplus-content` — read aplus content
- `GET /api/aplus-content/:id` — read aplus content
- `POST /api/aplus-content` — create/run aplus content
- `PATCH /api/aplus-content/:id` — update aplus content
- `DELETE /api/aplus-content/:id` — delete aplus content
- `POST /api/aplus-content/:id/modules` — Create a module appended to the end. Position is computed
- `PATCH /api/aplus-modules/:id` — update aplus modules
- `DELETE /api/aplus-modules/:id` — delete aplus modules
- `POST /api/aplus-content/:id/submit` — create/run aplus content submit
- `GET /api/aplus-content/_meta/submission-mode` — read aplus content _meta submission mode
- `GET /api/aplus-content/:id/versions` — read aplus content versions
- `POST /api/aplus-content/:id/versions/save` — create/run aplus content versions save
- `POST /api/aplus-content/:id/versions/:versionId/restore` — create/run aplus content versions restore  **[destructive?]**
- `PATCH /api/aplus-content/:id/schedule` — Set/clear scheduledFor. Body: { scheduledFor: ISO string | null }.
- `POST /api/aplus-content/:id/validate` — create/run aplus content validate
- `POST /api/aplus-content/:id/apply-template` — body: { modules: [{ type, payload }, ...], replaceExisting?: bool }
- `POST /api/aplus-content/:id/localize` — (and every module) into a new sibling row at a different
- `POST /api/aplus-content/:id/modules/reorder` — Bulk reorder. Body: { order: [{ id, position }] }. Caller sends

#### routes/brand-story.routes.ts (prefix `/api`) — 17

- `GET /api/brand-stories` — read brand stories
- `GET /api/brand-stories/:id` — read brand stories
- `POST /api/brand-stories` — create/run brand stories
- `PATCH /api/brand-stories/:id` — update brand stories
- `DELETE /api/brand-stories/:id` — delete brand stories
- `POST /api/brand-stories/:id/modules` — create/run brand stories modules
- `PATCH /api/brand-story-modules/:id` — update brand story modules
- `DELETE /api/brand-story-modules/:id` — delete brand story modules
- `POST /api/brand-stories/:id/localize` — create/run brand stories localize
- `POST /api/brand-stories/:id/modules/reorder` — create/run brand stories modules reorder
- `POST /api/brand-stories/:id/validate` — create/run brand stories validate
- `POST /api/brand-stories/:id/submit` — create/run brand stories submit
- `GET /api/brand-stories/_meta/submission-mode` — read brand stories _meta submission mode
- `GET /api/brand-stories/:id/versions` — read brand stories versions
- `POST /api/brand-stories/:id/versions/save` — create/run brand stories versions save
- `POST /api/brand-stories/:id/versions/:versionId/restore` — create/run brand stories versions restore  **[destructive?]**
- `PATCH /api/brand-stories/:id/schedule` — update brand stories schedule

#### routes/brand-kit.routes.ts (prefix `/api`) — 10

- `GET /api/brand-kits` — read brand kits
- `GET /api/brand-kits/:brand` — read brand kits
- `PUT /api/brand-kits/:brand` — Upsert by brand. Body fields all optional except `brand` is
- `GET /api/brand-kits/:brand/watermarks` — read brand kits watermarks
- `POST /api/brand-kits/:brand/watermarks` — create/run brand kits watermarks
- `PATCH /api/brand-watermarks/:id` — update brand watermarks
- `DELETE /api/brand-watermarks/:id` — delete brand watermarks
- `DELETE /api/brand-kits/:brand` — delete brand kits
- `GET /api/brand-kits/:brand/consistency` — read brand kits consistency
- `GET /api/brand-kits/_meta/brands` — List the catalogue's brand labels — feeds the create-kit

#### routes/marketing-automation.routes.ts (prefix `/api`) — 7

- `GET /api/marketing-automation/rules` — read marketing automation rules
- `GET /api/marketing-automation/rules/:id` — read marketing automation rules
- `POST /api/marketing-automation/rules` — create/run marketing automation rules
- `PATCH /api/marketing-automation/rules/:id` — update marketing automation rules
- `POST /api/marketing-automation/rules/:id/run` — create/run marketing automation rules run
- `GET /api/marketing-automation/executions` — read marketing automation executions
- `DELETE /api/marketing-automation/rules/:id` — delete marketing automation rules

#### routes/channel-publish.routes.ts (prefix `/api`) — 6

- `GET /api/channel-publish/_meta/mode` — read channel publish _meta mode
- `POST /api/channel-publish/amazon` — create/run channel publish amazon
- `POST /api/channel-publish/ebay` — create/run channel publish ebay
- `POST /api/channel-publish/shopify` — create/run channel publish shopify
- `POST /api/channel-publish/woo` — create/run channel publish woo
- `POST /api/channel-publish/cascade` — create/run channel publish cascade

#### routes/scheduled-image-publishes.routes.ts (prefix `/api`) — 3

- `POST /api/products/:productId/scheduled-image-publishes` — create/run products scheduled image publishes
- `GET /api/products/:productId/scheduled-image-publishes` — read products scheduled image publishes
- `DELETE /api/scheduled-image-publishes/:id` — delete scheduled image publishes

#### routes/bulk-image-publish.routes.ts (prefix `/api`) — 1

- `POST /api/products/bulk-image-publish` — create/run products bulk image publish

### orders — 124 endpoints

#### routes/ebay-orders.routes.ts (prefix `(none)`) — 3

- `POST /api/sync/ebay/orders` — Trigger eBay orders sync for a specific connection
- `GET /api/sync/ebay/orders/:connectionId` — Get sync status for a connection
- `GET /api/sync/ebay/orders/stats/:connectionId` — Get order statistics for a connection

#### routes/orders.routes.ts (prefix `(none)`) — 36

- `POST /api/orders/ingest` — Mock ingest (kept for demo/testing)
- `GET /api/orders/sync-health` — Stats (kept, lighter response shape)
- `GET /api/orders/stats` — read orders stats
- `GET /api/orders` — GET /api/orders — paginated, filterable, per-row enriched
- `GET /api/orders/facets` — GET /api/orders/facets — distinct channels, marketplaces, tags
- `GET /api/orders/:id` — GET /api/orders/:id — full detail with relations
- `GET /api/orders/:id/timeline` — GET /api/orders/:id/timeline — synthesized event log
- `GET /api/orders/:id/financials` — GET /api/orders/:id/financials — gross/fees/net rollup
- `GET /api/orders/customers/:email` — GET /api/orders/customers/:email — customer profile
- `POST /api/orders/reclassify-already-solicited` — POST /api/orders/reclassify-already-solicited
- `POST /api/orders/backfill-delivered-heuristic` — POST /api/orders/backfill-delivered-heuristic  **[destructive?]**
- `POST /api/orders/:id/mark-delivered` — POST /api/orders/:id/mark-delivered
- `PATCH /api/orders/:id/ship` — PATCH /api/orders/:id/ship — legacy single-mark-shipped
- `POST /api/orders/bulk-mark-shipped` — POST /api/orders/bulk-mark-shipped
- `POST /api/orders/:id/cancel` — O.48: Manual order cancellation
- `GET /api/orders/:id/notes` — AU.5 — Order-level notes CRUD (mirrors CustomerNote pattern).
- `POST /api/orders/:id/notes` — create/run orders notes
- `PATCH /api/orders/:id/notes/:noteId` — update orders notes
- `DELETE /api/orders/:id/notes/:noteId` — delete orders notes
- `PATCH /api/orders/:id/items/:itemId/vat` — FU.1 — per-line VAT rate override (Italian compliance).
- `GET /api/orders/:id/invoice.html` — F.3 — Italian invoice + packing slip as printable HTML.
- `GET /api/orders/:id/packing-slip.html` — read orders packing slip.html
- `GET /api/orders/:id/export.json` — OX.14 — single-order JSON export. Operator-triggered download of  **[file-download]**
- `GET /api/orders/bulk-packing-slips.html` — OX.5 — bulk packing slips. Operator selects N orders, hits "Print
- `GET /api/orders/buyer-profile` — OX.12 — cross-channel buyer profile. Aggregates all orders we have
- `POST /api/orders/bulk-issue-invoices` — OX.5 — bulk-issue invoices. Loop selected IDs; for each, call
- `GET /api/orders/:id/fattura-pa.xml` — F.4 — FatturaPA XML download (B2B only). Operator manually  **[file-download]**
- `POST /api/orders/:id/fattura-pa/dispatch` — create/run orders fattura pa dispatch
- `GET /api/corrispettivi/daily/:date.xml` — FU.5 — B2C corrispettivi telematici (daily summary). Distinct  **[file-download]**
- `GET /api/corrispettivi/daily/:date/preview` — read corrispettivi daily preview
- `POST /api/corrispettivi/daily/:date/dispatch` — create/run corrispettivi daily dispatch
- `GET /api/orders/export.csv` — O.23b — CSV export. Mirrors the GET /api/orders filter shape so  **[file-download]**
- `GET /api/orders/events` — O.6 — SSE channel for /orders. Mirrors the outbound bus pattern  **[SSE]**
- `POST /api/orders/bulk-soft-delete` — create/run orders bulk soft delete
- `POST /api/orders/bulk-restore` — create/run orders bulk restore  **[destructive?]**
- `POST /api/orders/bulk-hard-delete` — create/run orders bulk hard delete

#### routes/reviews.routes.ts (prefix `/api`) — 55

- `GET /api/reviews` — GET /reviews
- `GET /api/reviews/:id` — read reviews
- `GET /api/reviews/summary` — GET /reviews/summary
- `GET /api/reviews/ratings` — GET /reviews/ratings (RX.0)
- `GET /api/reviews/ingest-health` — GET /reviews/ingest-health (RX.1)
- `POST /api/reviews/import/preview` — POST /reviews/import/preview (RX.1)
- `POST /api/reviews/import/apply` — POST /reviews/import/apply (RX.1)
- `GET /api/reviews/events` — GET /reviews/events (RX.3) — SSE live stream  **[SSE]**
- `GET /api/reviews/desk/stats` — GET /reviews/desk/stats (RX.2)
- `PATCH /api/reviews/:id/triage` — PATCH /reviews/:id/triage (RX.2)
- `GET /api/reviews/:id/responses` — GET /reviews/:id/responses (RX.2)
- `POST /api/reviews/:id/reply/draft` — POST /reviews/:id/reply/draft (RX.2)
- `POST /api/reviews/:id/reply/send` — POST /reviews/:id/reply/send (RX.2)
- `GET /api/reviews/spikes` — GET /reviews/spikes
- `PATCH /api/reviews/spikes/:id` — update reviews spikes
- `GET /api/reviews/heatmap` — GET /reviews/heatmap (SR.2)
- `GET /api/reviews/by-product` — GET /reviews/by-product (SR.2)
- `GET /api/reviews/products/:productId/timeline` — GET /reviews/products/:productId/timeline (SR.2)
- `GET /api/reviews/automation-rules` — SR.3 — review-domain automation rules
- `POST /api/reviews/automation-rules/seed-templates` — create/run reviews automation rules seed templates
- `POST /api/reviews/cron/ingest/trigger` — Manual cron triggers
- `POST /api/reviews/cron/spike-detector/trigger` — create/run reviews cron spike detector trigger
- `POST /api/reviews/cron/digest/trigger` — RX.3 — manual digest trigger (also previews the digest payload).
- `POST /api/reviews/cron/orders-delivered-backfill/trigger` — RV.7.3 — manual orders-delivered-backfill trigger (runs the FBA+FBM delivery  **[destructive?]**
- `GET /api/reviews/spotlight` — Review Spotlight (RX.4)
- `GET /api/reviews/action-items` — Review action items (RX.5) — closed SR.3 loop
- `POST /api/reviews/spikes/:id/generate-actions` — create/run reviews spikes generate actions
- `PATCH /api/reviews/action-items/:id` — update reviews action items
- `POST /api/reviews/spotlight/generate` — create/run reviews spotlight generate
- `POST /api/reviews/cron/review-rule-evaluator/trigger` — create/run reviews cron review rule evaluator trigger
- `POST /api/reviews/cron/review-request-mailer/trigger` — SR.4 — review request mailer endpoints
- `POST /api/reviews/test` — RV.9.6 — End-to-end test mode. Three actions an operator can run
- `GET /api/reviews/requests/stats` — read reviews requests stats
- `POST /api/reviews/mailer/pause` — RV.4.2 — pause + resume endpoints for the mailer kill switch.
- `POST /api/reviews/mailer/resume` — create/run reviews mailer resume
- `POST /api/reviews/pipeline/sweep-stuck-crons` — RV.9.2 — manual cron-orphan sweep trigger. The cron runs every 30
- `POST /api/reviews/attribution/run` — RV.9.7 — manual review-attribution trigger.
- `GET /api/email/unsubscribe` — RV.9.5 — Public unsubscribe endpoint (no auth — token authenticates
- `POST /api/email/unsubscribe` — create/run email unsubscribe
- `GET /api/email/suppressions` — RV.9.5 — Admin list + manual add/remove for the suppression table.
- `POST /api/email/suppressions` — create/run email suppressions
- `DELETE /api/email/suppressions` — delete email suppressions
- `POST /api/review-requests/:id/unsuppress` — RV.4.3 — per-request unsuppress + snooze controls.
- `POST /api/review-requests/:id/snooze` — create/run review requests snooze
- `GET /api/reviews/analytics` — RV.8.1 — Conversion-rate + per-mp + per-productType analytics.
- `GET /api/r/:token` — GET — state lookup for the landing page render
- `POST /api/r/:token/positive` — POST positive — happy customer; fire downstream Solicitations.
- `POST /api/r/:token/negative` — POST negative — unhappy customer; capture feedback, route to support.
- `POST /api/reviews/insights/probe` — D.3 — Amazon official Customer Feedback API: access probe + debug
- `GET /api/reviews/insights/debug` — Last raw API shapes (topics/trends) — finalise the defensive parsers against
- `GET /api/reviews/insights` — D.4 — Amazon insights: read + rollup + manual ingest
- `GET /api/reviews/insights/rollup` — review-weighted avg rating + total count + merged top topics + worst access.
- `POST /api/reviews/insights/ingest` — POST /api/reviews/insights/ingest { marketplace, limit } — fire-and-forget.
- `GET /api/reviews/overview` — D.5 — Overview blend: ONE call for the kid-simple Tab 1, channel+market scoped.
- `GET /api/reviews/filter-options` — UX.1 — Global channel + market filter options (from the Marketplace table,

#### routes/orders-routing.routes.ts (prefix `/api`) — 2

- `POST /api/orders/simulate-routing` — Simulate routing
- `GET /api/orders/routing-log` — Routing log

#### routes/orders-reviews.routes.ts (prefix `/api`) — 21

- `GET /api/review-rules` — read review rules
- `POST /api/review-rules` — create/run review rules
- `GET /api/review-rules/:id` — read review rules
- `PATCH /api/review-rules/:id` — update review rules
- `DELETE /api/review-rules/:id` — delete review rules
- `GET /api/review-rules/export` — RX.6 — Export all rules as portable JSON (no ids / counts).  **[file-download]**
- `POST /api/review-rules/import` — RX.6 — Import rules from JSON. Upserts on (name, scope, marketplace);
- `POST /api/review-rules/:id/duplicate` — RX.6 — Duplicate a rule as an A/B variant (cloned with a name suffix,
- `POST /api/review-rules/lint` — RX.6 — ToS-compliance linter for custom copy (rule notes / messages).
- `POST /api/review-rules/seed-default` — RV.9.1 — Seed Xavia recommended-default rule (idempotent).
- `POST /api/review-rules/:id/dry-run` — RULES — DRY-RUN + RUN (eager enqueue)
- `POST /api/review-rules/preview-timing` — RRT.6 — stateless timing preview for the rule editor's live line. Synthesizes
- `POST /api/review-rules/:id/run` — create/run review rules run
- `GET /api/review-requests` — REQUESTS — list + manual one-offs
- `POST /api/orders/:id/request-review` — create/run orders request review
- `POST /api/orders/bulk-request-reviews` — create/run orders bulk request reviews
- `POST /api/review-engine/tick` — ENGINE TICK — process SCHEDULED rows now
- `POST /api/orders/historical-backfill` — BACKFILL — D.8 stub, re-pulls last N days from each channel.  **[destructive?]**
- `GET /api/review-timing-defaults` — RRT.1 — ReviewTimingDefault CRUD (the editable per-product-type baseline)
- `PUT /api/review-timing-defaults` — PUT — whole-list upsert + delete (drives the inline grid in one round-trip).
- `POST /api/review-timing-defaults/seed` — overwrites existing rows back to canonical ("Reset to defaults").

#### routes/review-inserts.routes.ts (prefix `/api`) — 3

- `GET /api/review-inserts/count` — how many products have an ASIN (drives the UI count + "print all")
- `GET /api/review-inserts/product/:id` — single-product card, inline so the browser previews it  **[file-download]**
- `POST /api/review-inserts/bulk` — bulk: every active product with an ASIN (or a provided id list), one card each  **[file-download]**

#### routes/review-send-windows.routes.ts (prefix `/api`) — 4

- `GET /api/review-send-windows` — list — global + any per-market overrides (optionally filtered)
- `PUT /api/review-send-windows` — upsert a marketplace's rows (the grid saves all 7 days for one market at once)
- `GET /api/review-send-windows/conversion` — STO.5 — descriptive conversion by send weekday×hour (read-only; not auto-applied)
- `POST /api/review-send-windows/seed` — (re)seed the global default pattern

### pricing — 59 endpoints

#### routes/ebay-volume-pricing.routes.ts (prefix `/api`) — 14

- `POST /api/ebay/volume-promotions` — POST /api/ebay/volume-promotions
- `GET /api/ebay/volume-promotions` — GET /api/ebay/volume-promotions
- `GET /api/ebay/volume-promotions/:id` — GET /api/ebay/volume-promotions/:id
- `PATCH /api/ebay/volume-promotions/:id` — PATCH /api/ebay/volume-promotions/:id
- `DELETE /api/ebay/volume-promotions/:id` — DELETE /api/ebay/volume-promotions/:id
- `POST /api/ebay/volume-promotions/:id/push` — POST /api/ebay/volume-promotions/:id/push
- `POST /api/ebay/volume-promotions/preview` — POST /api/ebay/volume-promotions/preview
- `POST /api/ebay/volume-tier-templates` — POST /api/ebay/volume-tier-templates
- `GET /api/ebay/volume-tier-templates` — GET /api/ebay/volume-tier-templates
- `GET /api/ebay/volume-tier-templates/:id` — GET /api/ebay/volume-tier-templates/:id
- `PATCH /api/ebay/volume-tier-templates/:id` — PATCH /api/ebay/volume-tier-templates/:id
- `DELETE /api/ebay/volume-tier-templates/:id` — DELETE /api/ebay/volume-tier-templates/:id
- `POST /api/ebay/volume-promotions/from-template` — POST /api/ebay/volume-promotions/from-template
- `POST /api/ebay/volume-promotions/resolve-skus` — POST /api/ebay/volume-promotions/resolve-skus

#### routes/pricing.routes.ts (prefix `/api`) — 22

- `GET /api/pricing/kpis` — B.1 + F.1.b — KPI strip on /pricing index. Single endpoint serves the
- `GET /api/pricing/explain` — read pricing explain
- `GET /api/pricing/alerts` — G.4.2 + B.2 + C.2 — Outlier alerts. Surfaces SKUs that need the user's
- `GET /api/pricing/matrix` — P.A — Hierarchy-aware matrix endpoint.
- `POST /api/pricing/refresh-snapshots` — create/run pricing refresh snapshots
- `POST /api/pricing/refresh-fx` — create/run pricing refresh fx
- `POST /api/pricing/refresh-fees` — G.3.1 — Manual fee-estimate refresh per marketplace.
- `POST /api/pricing/run-promotions` — G.5.2 — Manual promotion scheduler tick (enter/exit + snapshot refresh).
- `GET /api/pricing/buybox-stats` — F.2 — Buy Box drill-down. Per-marketplace win rate + top competitors
- `POST /api/pricing/promotions` — E.1.b — Create RetailEvent + optional RetailEventPriceAction in one
- `GET /api/pricing/repricer-status` — UI.7 — Repricer status. Reads the last AuditLog rows the
- `POST /api/pricing/coupons/prepare` — E.2 — Prepare an Amazon Coupon spec. SP-API doesn't expose
- `POST /api/pricing/markdowns/:id/push` — E.3 — Push an EbayMarkdown row to eBay's Marketing API. Centralized
- `DELETE /api/pricing/promotions/:id` — E.1.b — Soft-delete a RetailEvent + cascade clear of any
- `GET /api/pricing/promotions` — E.1 — Promotion calendar surface. Lists RetailEvent rows with their
- `POST /api/pricing/push` — G.5.1 — Push the latest snapshot price to the marketplace API.
- `POST /api/pricing/bulk-override` — G.6 — Bulk price override: set/adjust/clear priceOverride on ChannelListings
- `POST /api/pricing/refresh-competitive` — G.3.2 — Manual competitive-pricing refresh per marketplace.
- `GET /api/pricing/repricing-decisions` — CE.3: Repricing decisions feed
- `GET /api/pricing/price-history` — PH.2: Price-change history feed
- `GET /api/pricing/repricing-rule-stats` — PH.4: Per-rule repricing observability rollup
- `GET /api/products/:id/buybox` — AC.9 — Per-product Buy Box state for the Amazon Listing Cockpit.

#### routes/pricing-rules.routes.ts (prefix `/api`) — 6

- `POST /api/pricing-rules` — create/run pricing rules
- `GET /api/pricing-rules` — read pricing rules
- `GET /api/pricing-rules/variation/:variationId` — read pricing rules variation
- `PUT /api/pricing-rules/:id` — replace pricing rules
- `DELETE /api/pricing-rules/:id` — delete pricing rules
- `POST /api/pricing-rules/simulate` — D.2 — Dry-run simulator. Caller passes a rule definition (no DB write)

#### routes/tier-pricing.routes.ts (prefix `/api`) — 9

- `GET /api/customer-groups` — read customer groups
- `POST /api/customer-groups` — create/run customer groups
- `PATCH /api/customer-groups/:id` — update customer groups
- `DELETE /api/customer-groups/:id` — delete customer groups
- `GET /api/products/:id/tier-prices` — read products tier prices
- `POST /api/products/:id/tier-prices` — create/run products tier prices
- `PATCH /api/tier-prices/:id` — update tier prices
- `DELETE /api/tier-prices/:id` — delete tier prices
- `GET /api/products/:id/resolve-price` — read products resolve price

#### routes/repricing-rules.routes.ts (prefix `/api`) — 6

- `GET /api/products/:id/repricing-rules` — read products repricing rules
- `POST /api/products/:id/repricing-rules` — create/run products repricing rules
- `PATCH /api/repricing-rules/:id` — update repricing rules
- `DELETE /api/repricing-rules/:id` — delete repricing rules
- `GET /api/repricing-rules/:id/decisions` — read repricing rules decisions
- `POST /api/repricing-rules/:id/evaluate` — create/run repricing rules evaluate

#### routes/product-costs.routes.ts (prefix `/api`) — 2

- `GET /api/products/costs` — read products costs
- `PATCH /api/products/costs` — update products costs

### analytics/insights — 53 endpoints

#### routes/analytics.routes.ts (prefix `/api`) — 1

- `GET /api/analytics/portfolio` — read analytics portfolio  **[file-download]**

#### routes/insights.routes.ts (prefix `/api`) — 15

- `GET /api/insights/ping` — read insights ping
- `GET /api/insights/summary` — read insights summary
- `GET /api/insights/breakdown` — read insights breakdown
- `GET /api/insights/top-skus` — read insights top skus
- `GET /api/insights/sales` — read insights sales  **[file-download]**
- `GET /api/insights/profit` — read insights profit  **[file-download]**
- `GET /api/insights/advertising` — read insights advertising  **[file-download]**
- `GET /api/insights/products` — read insights products  **[file-download]**
- `GET /api/insights/customers` — read insights customers  **[file-download]**
- `GET /api/insights/inventory` — read insights inventory  **[file-download]**
- `GET /api/insights/fiscal` — read insights fiscal  **[file-download]**
- `GET /api/insights/brief` — read insights brief
- `GET /api/insights/forecast` — read insights forecast  **[file-download]**
- `GET /api/insights/anomalies` — read insights anomalies
- `GET /api/insights/what-changed` — read insights what changed

#### routes/dashboard.routes.ts (prefix `/api`) — 24

- `PATCH /api/admin/marketplace-config/:id` — GS.1 — Global Snapshot. Mirrors Amazon Seller Central's home-page
- `GET /api/dashboard/market-health` — MS.4 — per-marketplace ingest health. Surfaces which Amazon
- `GET /api/dashboard/sales-reconciliation` — SA.5 — sales reconciliation. Compares Order-table sum for a
- `GET /api/dashboard/global-snapshot` — read dashboard global snapshot
- `GET /api/dashboard/overview` — read dashboard overview
- `GET /api/dashboard/events` — DO.14 — Command Center event stream (SSE).  **[SSE]**
- `GET /api/dashboard/health` — H.13 — sync health dashboard data.
- `GET /api/dashboard/cron-runs` — Cron observability — latest run per known job + recent failures.
- `POST /api/dashboard/stock-drift/:id/resync` — Force-resync a single drifting ChannelListing. Repairs the
- `GET /api/dashboard/stock-drift` — Stock drift detection — surface ChannelListings where the cached
- `GET /api/dashboard/reports` — DO.32 — dashboard layout PUT.
- `POST /api/dashboard/reports` — create/run dashboard reports
- `PUT /api/dashboard/reports/:id` — replace dashboard reports
- `DELETE /api/dashboard/reports/:id` — delete dashboard reports
- `POST /api/dashboard/digest/run` — Manual fire: run the same logic the hourly cron runs. Useful
- `GET /api/dashboard/export/pdf` — DO.41 — on-demand PDF export. Same digest data the email  **[file-download]**
- `POST /api/dashboard/digest/preview` — Preview: build the digest for `frequency` and send a single
- `POST /api/dashboard/views` — DO.39 — saved view CRUD.
- `POST /api/dashboard/views/:id/apply` — create/run dashboard views apply
- `PUT /api/dashboard/views/:id` — replace dashboard views
- `DELETE /api/dashboard/views/:id` — delete dashboard views
- `PUT /api/dashboard/layout` — replace dashboard layout
- `GET /api/dashboard/circuit-breakers` — read dashboard circuit breakers
- `POST /api/dashboard/circuit-breakers/:channel/reset` — create/run dashboard circuit breakers reset  **[destructive?]**

#### routes/forecast.routes.ts (prefix `/api`) — 2

- `GET /api/products/:id/forecast` — read products forecast
- `GET /api/forecast/stockout-risk` — read forecast stockout risk

#### routes/amazon-reports.routes.ts (prefix `/api`) — 3

- `GET /api/amazon/reports` — read amazon reports
- `GET /api/amazon/reports/runs` — read amazon reports runs
- `POST /api/amazon/reports/backfill` — create/run amazon reports backfill  **[destructive?]**

#### routes/amazon-economics.routes.ts (prefix `/api`) — 8

- `GET /api/amazon/economics/fee-rates` — read amazon economics fee rates
- `GET /api/amazon/economics/fee-rates/by-sku` — R1.2 — per-SKU real fee rate (allocated from each order's actual fees).
- `GET /api/amazon/economics/fee-impact` — R1.4a — read-only before/after: profit-fees at the assumed 15% vs the
- `GET /api/amazon/economics/referral-rates` — R1.4b — the real referral rate the profit rollup now uses (resolver).
- `GET /api/amazon/economics/combined-rates` — R1.4c — the real combined Amazon fee rate the P&L (insights-profit) uses.
- `GET /api/amazon/economics/storage-fees` — R1.3 — storage (+ all) fees parsed from settlement rawBody (were €0).
- `GET /api/amazon/economics/fba-rates` — R1.4d — the real per-unit FBA fee the profit calc now uses.
- `POST /api/amazon/economics/profit-backfill` — R1.4b-backfill — re-roll historical ProductProfitDaily so PAST profit  **[destructive?]**

### webhooks/notifications — 45 endpoints

#### routes/shopify-webhooks.ts (prefix `(none)`) — 8

- `POST /webhooks/shopify/products/update` — Handle product update webhooks
- `POST /webhooks/shopify/products/delete` — Handle product delete webhooks
- `POST /webhooks/shopify/inventory/update` — Handle inventory update webhooks
- `POST /webhooks/shopify/orders/create` — Handle order create webhooks
- `POST /webhooks/shopify/orders/update` — Handle order update webhooks
- `POST /webhooks/shopify/fulfillments/create` — Handle fulfillment create webhooks
- `POST /webhooks/shopify/refunds/create` — R4.1 — POST /webhooks/shopify/refunds/create
- `POST /webhooks/shopify/refunds/create-test` — R4.1 — Sandbox-only test endpoint.

#### routes/woocommerce-webhooks.ts (prefix `(none)`) — 6

- `POST /webhooks/woocommerce/products/update` — Handle product update events
- `POST /webhooks/woocommerce/products/delete` — Handle product deletion
- `POST /webhooks/woocommerce/inventory/update` — Handle inventory level changes
- `POST /webhooks/woocommerce/orders/create` — Handle new order creation
- `POST /webhooks/woocommerce/orders/update` — Handle order status changes
- `POST /webhooks/woocommerce/orders/delete` — Handle order deletion

#### routes/etsy-webhooks.ts (prefix `(none)`) — 6

- `POST /webhooks/etsy/listings/update` — Handle listing update events
- `POST /webhooks/etsy/listings/delete` — Handle listing deletion
- `POST /webhooks/etsy/inventory/update` — Handle inventory level changes
- `POST /webhooks/etsy/orders/create` — Handle new order creation
- `POST /webhooks/etsy/orders/update` — Handle order status changes
- `POST /webhooks/etsy/orders/delete` — Handle order deletion

#### routes/webhooks.routes.ts (prefix `(none)`) — 2

- `POST /api/webhooks/order-created` — POST /api/webhooks/order-created
- `POST /webhooks/stock-adjustment` — POST /webhooks/stock-adjustment

#### routes/sendcloud-webhooks.routes.ts (prefix `(none)`) — 1

- `POST /api/webhooks/sendcloud` — Sendcloud sends application/x-www-form-urlencoded by default; some

#### routes/cloudinary-webhook.routes.ts (prefix `/api`) — 1

- `POST /api/assets/_webhooks/cloudinary` — create/run assets _webhooks cloudinary

#### routes/saved-view-alerts.routes.ts (prefix `/api`) — 6

- `GET /api/saved-views/:viewId/alerts` — read saved views alerts
- `POST /api/saved-views/:viewId/alerts` — create/run saved views alerts
- `PATCH /api/saved-view-alerts/:id` — update saved view alerts
- `DELETE /api/saved-view-alerts/:id` — delete saved view alerts
- `POST /api/saved-view-alerts/:id/evaluate` — create/run saved view alerts evaluate
- `POST /api/saved-view-alerts/:id/rebaseline` — create/run saved view alerts rebaseline

#### routes/notifications.routes.ts (prefix `/api`) — 4

- `GET /api/notifications` — read notifications
- `POST /api/notifications/:id/read` — create/run notifications read
- `POST /api/notifications/read-all` — create/run notifications read all
- `DELETE /api/notifications/:id` — delete notifications

#### routes/inbox.routes.ts (prefix `/api`) — 2

- `GET /api/inbox` — read inbox
- `GET /api/inbox/count` — read inbox count

#### routes/amazon-notifications.routes.ts (prefix `/api`) — 3

- `GET /api/admin/sqs-diagnostic` — GET /api/admin/sqs-diagnostic
- `POST /api/admin/setup-amazon-notifications` — create/run admin setup amazon notifications
- `GET /api/admin/amazon-notification-status` — read admin amazon notification status

#### routes/ebay-notification.routes.ts (prefix `/api`) — 6

- `GET /api/admin/ebay-token-status` — GET /api/admin/ebay-token-status
- `POST /api/admin/refresh-ebay-tokens` — POST /api/admin/refresh-ebay-tokens
- `POST /api/admin/setup-ebay-notifications` — POST /api/admin/setup-ebay-notifications
- `GET /api/admin/ebay-notification-status` — GET /api/admin/ebay-notification-status
- `GET /api/webhooks/ebay-notification` — GET /api/webhooks/ebay-notification?challenge_code=xxx
- `POST /api/webhooks/ebay-notification` — POST /api/webhooks/ebay-notification — receives push events from eBay.

### ai/agents — 43 endpoints

#### routes/ai.ts (prefix `(none)`) — 1

- `POST /ai/generate-listing` — Accepts { productId } and returns AI-generated eBay listing data.

#### routes/brand-brain.routes.ts (prefix `/api`) — 5

- `GET /api/brand-brain/status` — read brand brain status
- `POST /api/brand-brain/ingest` — create/run brand brain ingest
- `POST /api/brand-brain/cron/embedding-ingester/trigger` — create/run brand brain cron embedding ingester trigger
- `POST /api/brand-brain/ingest/:entityType/:id` — create/run brand brain ingest
- `GET /api/brand-brain/query` — read brand brain query

#### routes/terminology.routes.ts (prefix `/api`) — 4

- `GET /api/terminology` — List — optional brand / marketplace filters. `brand=*` (or omit)
- `POST /api/terminology` — create/run terminology
- `PATCH /api/terminology/:id` — update terminology
- `DELETE /api/terminology/:id` — delete terminology

#### routes/products-ai.routes.ts (prefix `/api`) — 2

- `POST /api/products/ai/bulk-generate` — create/run products ai bulk generate
- `POST /api/products/:id/ai/suggest-fields` — P.14 — POST /api/products/:id/ai/suggest-fields

#### routes/ai-usage.routes.ts (prefix `/api`) — 17

- `PATCH /api/ai/prompt-templates/:id` — AI-2.5 (list-wizard) — promote / archive / edit a single
- `POST /api/ai/prompt-templates/:id/clone` — AI-2.4 (list-wizard) — clone a PromptTemplate as a DRAFT variant.
- `GET /api/ai/prompt-templates` — AI-2.2 (list-wizard) — list PromptTemplate rows. Read-only v1
- `POST /api/ai/prompt-templates/record-edit` — AET.1 (list-wizard) — record an operator's accept-or-edit
- `GET /api/ai/brand-voices` — BV.3 (list-wizard) — BrandVoice CRUD for /settings/ai admin.
- `POST /api/ai/brand-voices` — create/run ai brand voices
- `PATCH /api/ai/brand-voices/:id` — update ai brand voices
- `DELETE /api/ai/brand-voices/:id` — delete ai brand voices
- `GET /api/ai/providers` — read ai providers
- `GET /api/ai/models` — read ai models
- `GET /api/ai/feature-prefs` — AI-2.2: per-feature model selection. Overview = catalog + each
- `PUT /api/ai/feature-prefs/:feature` — replace ai feature prefs
- `DELETE /api/ai/feature-prefs/:feature` — delete ai feature prefs
- `GET /api/ai/usage/summary` — read ai usage summary
- `GET /api/ai/usage/budget-posture` — AI-1.7 — budget posture for the settings dashboard.
- `GET /api/ai/usage/top-wizards` — AI-1.8 — per-wizard ROI rollup. Caller picks the window (days,
- `GET /api/ai/usage/recent` — read ai usage recent

#### routes/agents.routes.ts (prefix `/api`) — 14

- `POST /api/agent/run` — create/run agent run
- `POST /api/agent/chat` — ACP.2a — read-only products copilot (model-driven tool-use loop).
- `GET /api/agent/runs` — Recent AgentRun audit rows — slim projection for the Control Center
- `GET /api/agent/tools` — Effective tool policy (code defaults merged with operator overrides).
- `PUT /api/agent/tools/:name` — Operator policy edit (respects the always-ask hard floor).
- `POST /api/agent/tools/:name/invoke` — Invoke a single tool directly (testing + the Phase 2 copilot loop).
- `POST /api/agent/tools/seed` — Seed the editable AgentTool policy rows from the code registry.
- `GET /api/agent/approvals` — ACP.3a — governed-action approval gate
- `POST /api/agent/actions/request` — Request approval for a mutating action (copilot button / testing).
- `POST /api/agent/approvals/:id/approve` — create/run agent approvals approve
- `POST /api/agent/approvals/:id/reject` — create/run agent approvals reject
- `GET /api/agent/agents` — ACP.4a/5a — autonomous agents + Control Center
- `PUT /api/agent/agents/:key` — Toggle an agent's SCHEDULED runs (manual "Run now" always works).
- `POST /api/agent/agents/:key/run` — Run an autonomous agent now (operator-triggered). It scans + queues

### settings/connections — 43 endpoints

#### routes/ebay-auth.ts (prefix `(none)`) — 8

- `POST /api/ebay/auth/create-connection` — Creates a new ChannelConnection record for eBay
- `POST /api/ebay/auth/initiate` — Initiates the OAuth2 flow by generating authorization URL
- `POST /api/ebay/auth/callback` — Handles the OAuth2 callback from eBay
- `GET /api/ebay/auth/connections` — List all eBay channel connections (active + inactive). The
- `GET /api/ebay/auth/connection/:connectionId` — Get the status of an eBay connection
- `POST /api/ebay/auth/revoke` — Revoke eBay connection and clear tokens
- `POST /api/ebay/auth/refresh` — Manually refresh eBay access token
- `GET /api/ebay/auth/test` — Test eBay API connectivity with current token

#### routes/brand-settings.routes.ts (prefix `/api`) — 4

- `GET /api/settings/brand` — read settings brand
- `POST /api/settings/brand/logo` — Constraint #4 — Logo upload via multipart. Sends the file to
- `PATCH /api/settings/brand` — update settings brand
- `GET /api/settings/primary-marketplace` — PSM.1 — primary marketplace. Read-only convenience endpoint so the

#### routes/settings-audit.routes.ts (prefix `/api`) — 3

- `GET /api/settings/audit` — GET /api/settings/audit
- `GET /api/settings/audit/keys` — GET /api/settings/audit/keys
- `POST /api/settings/audit/:id/revert` — POST /api/settings/audit/:id/revert

#### routes/profile.routes.ts (prefix `/api`) — 10

- `POST /api/settings/profile/avatar` — Avatar upload
- `POST /api/settings/2fa/enroll/start` — 2FA: start enrollment
- `POST /api/settings/2fa/enroll/verify` — 2FA: verify the first code, complete enrollment
- `POST /api/settings/2fa/disable` — 2FA: disable
- `POST /api/settings/2fa/recovery-codes/regenerate` — 2FA: regenerate recovery codes
- `GET /api/settings/2fa/status` — 2FA: status (used by the page server-load to decide which UI to render)
- `GET /api/settings/sessions` — Sessions
- `POST /api/settings/sessions/:id/revoke` — create/run settings sessions revoke
- `POST /api/settings/sessions/revoke-all` — create/run settings sessions revoke all
- `GET /api/settings/login-history` — Login history

#### routes/settings-webhooks.routes.ts (prefix `/api`) — 5

- `GET /api/settings/webhooks` — List
- `POST /api/settings/webhooks` — Create
- `PATCH /api/settings/webhooks/:id` — Update
- `DELETE /api/settings/webhooks/:id` — Delete
- `POST /api/settings/webhooks/:id/test` — Test payload

#### routes/settings-privacy.routes.ts (prefix `/api`) — 8

- `POST /api/settings/privacy/export` — create/run settings privacy export
- `GET /api/settings/privacy/exports` — read settings privacy exports
- `GET /api/settings/privacy/exports/:id/download` — read settings privacy exports download  **[file-download]**
- `GET /api/settings/privacy/retention` — read settings privacy retention
- `PATCH /api/settings/privacy/retention` — update settings privacy retention
- `GET /api/settings/privacy/consent` — read settings privacy consent
- `POST /api/settings/privacy/consent` — create/run settings privacy consent
- `POST /api/settings/privacy/delete-account-dry-run` — create/run settings privacy delete account dry run

#### routes/connections.routes.ts (prefix `/api`) — 3

- `GET /api/connections` — read connections
- `GET /api/settings/channels/:type/detail` — Phase F.2 — per-channel deep detail
- `PATCH /api/settings/channels/:type/marketplaces` — Phase F.3 — per-marketplace toggle

#### routes/shopify-setup.routes.ts (prefix `/api`) — 2

- `POST /api/admin/setup-shopify-webhooks` — create/run admin setup shopify webhooks
- `GET /api/admin/shopify-webhook-status` — read admin shopify webhook status

### customers — 25 endpoints

#### routes/customers.routes.ts (prefix `(none)`) — 16

- `GET /api/customers` — List
- `GET /api/customers/:id` — Detail
- `GET /api/customers/by-email/:email` — Lookup by email
- `POST /api/customers/:id/notes` — Notes CRUD
- `PATCH /api/customers/:id/notes/:noteId` — update customers notes
- `DELETE /api/customers/:id/notes/:noteId` — delete customers notes
- `PATCH /api/customers/:id/fiscal` — FU.3: fiscal data (codice fiscale / partita IVA / B2B-B2C)
- `PATCH /api/customers/:id/tags` — Tags (replace-array semantics)
- `GET /api/customers/risk-queue` — O.22: risk queue — flagged customers awaiting operator review
- `PATCH /api/customers/:id/manual-review` — O.22: set manual-review state (PENDING / APPROVED / REJECTED)
- `POST /api/customers/:id/recompute-risk` — O.22: manual recompute (recomputes every order + rolls up)
- `GET /api/customers/export.csv` — O.23b: CSV export  **[file-download]**
- `POST /api/customers/:id/refresh-cache` — Manual cache refresh (ops escape hatch)
- `GET /api/customers/analytics/rfm` — CI.1: RFM distribution
- `POST /api/customers/analytics/rfm/recompute` — create/run customers analytics rfm recompute
- `GET /api/customers/analytics/overview` — CI.3: Analytics overview

#### routes/customer-segments.routes.ts (prefix `/api`) — 9

- `GET /api/customers/segments` — List segments
- `POST /api/customers/segments` — Create segment
- `PATCH /api/customers/segments/:id` — Update segment
- `DELETE /api/customers/segments/:id` — Delete segment
- `POST /api/customers/segments/:id/evaluate` — On-demand evaluate
- `GET /api/customers/segments/:id/customers` — Paginated members
- `POST /api/customers/segments/:id/export` — CI.4: CSV export  **[file-download]**
- `POST /api/customers/segments/:id/tag` — CI.4: Bulk tag
- `POST /api/customers/segments/:id/review-request` — CI.4: Review request for segment

### health/infra — 8 endpoints

#### routes/monitoring.ts (prefix `(none)`) — 7

- `POST /monitoring/run` — Run full monitoring cycle
- `GET /monitoring/health` — Get current health status
- `GET /monitoring/metrics` — Get metrics history
- `GET /monitoring/trend` — Get health trend over time
- `GET /monitoring/alerts/config` — Get alert configurations
- `PUT /monitoring/alerts/config/:type` — Update alert configuration
- `GET /monitoring/report` — Get comprehensive monitoring report

#### routes/health.ts (prefix `/api`) — 1

- `GET /api/health` — read health

## 4. Special cases for deny-by-default

### 4a. Externally-reachable webhooks/callbacks — MUST stay open (verify by signature, not session)

| Endpoint | Caller | Verification today |
|---|---|---|
| `POST /webhooks/shopify/*` (8: products/update+delete, inventory/update, orders/create+update, fulfillments/create, refunds/create, refunds/create-test) | Shopify | HMAC `x-shopify-hmac-sha256` via `WebhookValidator.validateShopifySignature` (shopify-webhooks.ts:961-975) |
| `POST /webhooks/woocommerce/*` (6) | WooCommerce | HMAC `x-wc-webhook-signature` — **only if** `config.webhookSecret` set, else accepted unverified (woocommerce-webhooks.ts:293-300) |
| `POST /webhooks/etsy/*` (6) | Etsy | **NO signature verification found** (channel inactive per memory, but routes are live) |
| `POST /api/webhooks/sendcloud` | Sendcloud | HMAC-SHA256 raw body vs `NEXUS_SENDCLOUD_WEBHOOK_SECRET`, `Sendcloud-Signature` header, enforced (file header lines 9-25) |
| `POST /api/assets/_webhooks/cloudinary` | Cloudinary | `sha1(body+timestamp+api_secret)` constant-time; refuses if `CLOUDINARY_API_SECRET` unset (file header lines 10-14) |
| `GET/POST /api/webhooks/ebay-notification` | eBay | GET = challenge `SHA256(challenge_code+verificationToken+endpointUrl)`; POST = platform notifications (ebay-notification.routes.ts:14-16) |
| `POST /api/webhooks/order-created` + `POST /webhooks/stock-adjustment` | internal/manual (S.1 inventory webhooks) | **no verification** — note the second path has NO `/api` prefix (webhooks.routes.ts:59,137) |

Amazon order push is SQS-based (no inbound HTTP endpoint); `amazon-notifications.routes.ts` endpoints are admin subscription-management, not receivers.

### 4b. OAuth callbacks — must stay reachable by browser redirect

- `GET /api/amazon-ads/auth/connect` + `GET /api/amazon-ads/auth/callback` — Amazon Ads LWA (PKCE store in-process; amazon-ads-auth.routes.ts:271,302). True browser redirect target.
- `POST /api/ebay/auth/callback` — eBay OAuth; the web app receives the browser redirect and POSTs code+state+connectionId here (ebay-auth.ts:133). Plus initiate/create-connection/revoke/refresh/test siblings (session-protectable).
- Shopify/Woo/Etsy connections are API-key/token based (no OAuth callback routes).

### 4c. SSE / streaming endpoints (12) — EventSource cannot send Authorization headers; permission layer must accept cookie/query auth here

- `GET /api/orders/events` (orders.routes.ts:1678)
- `GET /api/fulfillment/outbound/events` (fulfillment.routes.ts:2078)
- `GET /api/fulfillment/inbound/events` (fulfillment.routes.ts:4356)
- `GET /api/fulfillment/purchase-orders/events` (fulfillment.routes.ts:8704)
- `GET /api/marketing/os/events` (marketing-os.routes.ts:792)
- `GET /api/advertising/execution-events` (advertising.routes.ts:4618)
- `GET /api/advertising/autopilot-plans/:id/decisions/stream` (advertising.routes.ts:5670)
- `GET /api/reviews/events` (reviews.routes.ts:382)
- `GET /api/bulk-operations/:id/events` (bulk-operations.routes.ts:569)
- `GET /api/dashboard/events` (dashboard.routes.ts:2871)
- `GET /api/sync-logs/events` (sync-logs.routes.ts:746)
- `GET /api/listings/events` (listings-syndication.routes.ts:3021)

### 4d. File-serving / download-or-upload endpoints (39) — often opened via <a href>/new tab, so header-based auth also breaks

- `GET /api/orders/:id/export.json`
- `GET /api/orders/:id/fattura-pa.xml`
- `GET /api/corrispettivi/daily/:date.xml`
- `GET /api/orders/export.csv`
- `GET /api/customers/export.csv`
- `POST /api/amazon/flat-file/export`
- `POST /api/ebay/flat-file/export`
- `GET /api/ebay/cockpit/file-exchange-csv`
- `GET /api/fulfillment/inbound/:id/discrepancies/report.pdf`
- `GET /api/fulfillment/development/projects/:id/factory-pack.pdf`
- `GET /api/fulfillment/purchase-orders/:id/factory.pdf`
- `GET /api/fulfillment/purchase-orders/export.csv`
- `POST /api/fulfillment/fnsku/zpl`
- `POST /api/fulfillment/fnsku/pdf`
- `GET /api/fulfillment/returns/:id/modulo-recesso.pdf`
- `GET /api/fulfillment/returns/export.csv`
- `GET /api/fulfillment/refunds/:id/credit-note/xml`
- `GET /api/settings/privacy/exports/:id/download`
- `GET /api/advertising/bulk/export`
- `GET /api/analytics/portfolio`
- `GET /api/insights/sales`
- `GET /api/insights/profit`
- `GET /api/insights/advertising`
- `GET /api/insights/products`
- `GET /api/insights/customers`
- `GET /api/insights/inventory`
- `GET /api/insights/fiscal`
- `GET /api/insights/forecast`
- `POST /api/customers/segments/:id/export`
- `GET /api/products/bulk-template`
- `GET /api/gtin-exemption/:id/brand-letter.pdf`
- `GET /api/gtin-exemption/:id/package.zip`
- `GET /api/export-jobs/:id/download`
- `GET /api/dashboard/export/pdf`
- `GET /api/sync-logs/api-calls/export`
- `POST /api/products/:productId/amazon-images/export-zip`
- `GET /api/review-rules/export`
- `GET /api/review-inserts/product/:id`
- `POST /api/review-inserts/bulk`

### 4e. Admin / destructive endpoints (58 by path keyword: wipe|backfill|restore|migrate|purge|reset|cleanup|prune|orphan|repair|rebuild|force|flush|requeue|redrive|dlq|rollback)

All of `routes/admin.ts` (mounted bare, paths `/api/admin/*`) plus keyword matches across modules:

- `POST /listings/force-sync-ebay`
- `POST /admin/amazon/restore-fba`
- `POST /admin/repair/all`
- `POST /admin/repair/orphaned-variations`
- `POST /admin/repair/missing-themes`
- `POST /admin/repair/missing-attributes`
- `POST /admin/repair/product-status`
- `POST /admin/repair/channel-listings`
- `POST /admin/sales-drift/backfill-financial-events`
- `POST /admin/recycle-bin/purge`
- `POST /admin/pim/resolver-shadow-reset`
- `POST /admin/search/backfill`
- `POST /api/orders/backfill-delivered-heuristic`
- `POST /api/orders/bulk-restore`
- `POST /api/amazon/products/cleanup-bad-parents`
- `POST /api/amazon/orders/backfill-zero-totals`
- `POST /api/amazon/products/images/backfill`
- `POST /api/amazon/suppression/backfill`
- `POST /api/amazon/fba/reimbursements/backfill`
- `POST /api/amazon/fba/adjustments/backfill`
- `POST /api/amazon/fba/inbound/backfill`
- `POST /api/amazon/returns/backfill`
- `POST /api/amazon/settlements/backfill`
- `POST /api/ebay/cockpit/snapshot/restore`
- `POST /api/fulfillment/replenishment/forecast-accuracy/backfill`
- `POST /api/fulfillment/inbound/bulk-restore`
- `POST /api/fulfillment/shipments/bulk-restore`
- `POST /api/fulfillment/purchase-orders/bulk-restore`
- `POST /api/marketing/os/actions/:id/rollback`
- `POST /api/marketing/os/backfill/ebay`
- `POST /api/marketing/os/backfill/amazon`
- `POST /api/advertising/debug/backfill-campaign-adproduct`
- `POST /api/advertising/debug/wipe-product-ad`
- `POST /api/advertising/debug/reset-stuck-completed-jobs`
- `POST /api/advertising/profit/backfill-ad-spend`
- `POST /api/advertising/reports/cleanup-search-terms`
- `POST /api/advertising/suggestions/:id/restore`
- `GET /api/advertising/budget-manager/enforcement`
- `POST /api/advertising/rank-targets/:id/reset`
- `POST /api/advertising/actions/:executionId/rollback`
- `POST /api/amazon-ads/backfill`
- `POST /api/reviews/cron/orders-delivered-backfill/trigger`
- `POST /api/products/:id/restore`
- `DELETE /api/admin/cleanup-bulk-test`
- `POST /api/admin/backfill-read-cache`
- `POST /api/admin/cleanup-product-orphans`
- `POST /api/aplus-content/:id/versions/:versionId/restore`
- `POST /api/brand-stories/:id/versions/:versionId/restore`
- `POST /api/bulk-operations/:id/rollback`
- `POST /api/import-jobs/:id/rollback`
- `POST /api/dashboard/circuit-breakers/:channel/reset`
- `POST /api/outbound-queue/purge-failed`
- `POST /api/products/:id/channel-listing/:clId/reset`
- `POST /api/pim/mappings/:channel/:code/rollback/:revisionId`
- `POST /api/products/bulk-restore`
- `POST /api/amazon/reports/backfill`
- `POST /api/amazon/economics/profit-backfill`
- `POST /api/orders/historical-backfill`

### 4f. Existing per-route guards (the ONLY 3 guarded routes today)

- `GET /api/products` → `allowApiKeyScope('…')` (products.routes.ts:155)
- `POST /api/listings/bulk-action` → `allowApiKeyScope('…')` (listings-syndication.routes.ts:3241)
- `POST /api/products/bulk-soft-delete` → `allowApiKeyScope('…')` (products-catalog.routes.ts:1585)

`allowApiKeyScope` is a SOFT gate (no header → falls through unauthenticated). `requireApiKeyScope` (hard gate) exists but has ZERO route usages. Everything else on the API is open modulo CORS + rate-limit.

## 5. Files that do not follow the dominant pattern

1. **Bare mounts with inline absolute paths (25 files)** — registered with NO prefix: listings.ts (/listings); ai.ts (/ai); marketplaces.ts (/marketplaces); admin.ts (/admin); monitoring.ts (/monitoring); shopify.ts (/shopify); shopify-webhooks.ts (/webhooks); woocommerce.ts (/woocommerce); woocommerce-webhooks.ts (/webhooks); etsy.ts (/etsy); etsy-webhooks.ts (/webhooks); ebay-auth.ts (/api); ebay.routes.ts (/api /ebay); ebay-orders.routes.ts (/api); listing-health.routes.ts (/api); field-links.routes.ts (/api); outbound.routes.ts (/api); matrix.routes.ts (/api); inbound.routes.ts (/api); webhooks.routes.ts (/api /webhooks); sendcloud-webhooks.routes.ts (/api); orders.routes.ts (/api); customers.routes.ts (/api); outbound-queue.routes.ts (/api); job-monitor.routes.ts (/api). Eleven of these claim ROOT namespaces outside `/api` (`/admin`, `/listings`, `/ai`, `/marketplaces`, `/monitoring`, `/shopify`, `/woocommerce`, `/etsy`, `/ebay`, `/webhooks`); webhooks.routes.ts is inconsistent within one file (`/api/webhooks/order-created` vs root `/webhooks/stock-adjustment`). A prefix-based permission mapper scoped to `/api/*` misses all of these — including root `/admin/*` repair/restore endpoints.
2. **Monster files** — `fulfillment.routes.ts` (304 endpoints, ~16k lines) and `advertising.routes.ts` (277 endpoints) hold ~29% of the API in two plugin functions; per-file `requirePermission` defaults would be too coarse here — these two need path-segment-level rules (e.g. `/api/fulfillment/fnsku/*` vs `/api/fulfillment/stock/*`).
3. **Dead/duplicate route files** — `monitoring.routes.ts` + `repricing.ts` + `bulk-list.routes.ts` export plugins but are never registered (monitoring.ts and repricing-rules.routes.ts are the live ones); a CI completeness check that scans the routes dir must exclude them or they will appear as "unguarded".
4. **Parser trap** — `field-links.routes.ts:521` contains `f.get(l)` (a field accessor, not a route); receiver-name census confirms real routes only ever use `app.` or `fastify.` receivers — a CI extractor should anchor on those two.
5. **Mixed export style** — older files use named exports (`export async function xxxRoutes`), newer use default exports; ~44 registered with `{ prefix: "/api" }` writing relative paths, so the same literal path string can appear in two files and resolve to different full URLs.
