# S0 — Web Page & Route Handler Inventory (apps/web)

Date: 2026-07-03. Source: `find apps/web/src/app -name page.tsx` (310 pages) + `-name route.ts` (18 handlers).
No route groups `(...)` exist anywhere in the tree — file path == URL path for every page.

## 1. Module summary

| Module | Pages | Notes |
|---|---|---|
| /marketing | 116 | 3 parallel ad surfaces: advertising (41), ads (29, "Trading Desk", standalone chrome), ads-console (11); reviews (14), content (5), aplus/brand-story/brand-kit/automation/campaigns/budgets/calendar/templates/analytics |
| /fulfillment | 45 | stock (18), returns (5), outbound (5), inbound (4), suppliers (3), purchase-orders (3), + carriers/fnsku-labels/replenishment/repricing/routing-* |
| /settings | 23 | Two-pane hub with grouped rail (see §5) |
| /products | 21 | Master catalog grid + per-product edit/wizard/datasheet + amazon-flat-file + ebay-flat-file (both UNTOUCHABLE per user policy) |
| /insights | 17 | BI hub: sales/profit/ads/fiscal/anomalies/notebook/… |
| /listings | 11 | Per-channel (amazon/ebay/shopify) + per-market listing grids |
| /dashboard | 11 | overview (home redirect target), analytics, health, sync, reports |
| /catalog | 9 | Legacy catalog UI; root + import are redirects into /products |
| /sync-logs | 8 | Observability: events, errors, api-calls, webhooks, live tail |
| /pricing | 6 | pricing grid + rules/alerts/buybox/promotions/volume-pricing |
| /bulk-operations | 6 | imports/exports/history/schedules/automation |
| /orders | 5 | orders grid + detail + review-request rules |
| /inventory | 5 | ALL redirect stubs → /products/* |
| /customers | 5 | CRM: list, detail, segments, analytics, risk-queue |
| /admin | 2 | Admin dashboard (data repair) + recycle-bin (purge) — DESTRUCTIVE |
| /analytics | 2 | root redirects → /analytics/products (portfolio analytics) |
| /design, /design-system | 3 | internal style guides / living DS catalog |
| /performance | 2 | seller feedback + account health |
| /po, /r, /track, /unsubscribed | 6 | PUBLIC token-gated pages (suppliers/buyers) — must stay auth-exempt |
| misc singles | 8 | /, /inbox, /outbound, /reconciliation, /audit-log, /command-matrix, /reports/business |
| **Total** | **310** | |

## 2. Full page enumeration

Legend: `[R→x]` = redirect stub. `(pub)` = public/unauthenticated by design. `(danger)` = admin/destructive.

### Root & misc
| Route | Purpose |
|---|---|
| / | [R→/dashboard/overview] app entry |
| /inbox | Unified triage inbox (sync failures, alerts, webhook errors; retry/ack/replay) |
| /outbound | OutboundSyncQueue monitor (pending/failed channel pushes) |
| /reconciliation | Listing reconciliation hub (DB vs channel truth, review + fix actions) |
| /audit-log | Global audit log viewer |
| /command-matrix | Full-screen command matrix ops panel |
| /reports/business | 30-day sales rollup report (DB-side aggregation) |
| /performance/feedback | Amazon seller feedback list |
| /performance/health | Account health metrics vs targets |
| /design | Tailwind-era living style guide (internal) |
| /design/console | "Console" dark design language preview (internal) |
| /design-system | Design-system living catalog route (internal) |

### Public token pages (pub) — auth-exempt
| Route | Purpose |
|---|---|
| /po/ack/[token] | (pub) Supplier acknowledges a purchase order via emailed token link |
| /po/approve/[token] | (pub) Approver approves a PO via emailed token link |
| /r/[token]/positive | (pub) Review-funnel: happy buyer → marketplace review redirect |
| /r/[token]/negative | (pub) Review-funnel: unhappy buyer → private feedback form |
| /track/[trackingNumber] | (pub) Customer shipment tracking page |
| /unsubscribed | (pub) Email-unsubscribe confirmation (GDPR suppression) |

### /admin (danger)
| Route | Purpose |
|---|---|
| /admin | Admin dashboard: data validation report + repair operations (danger) |
| /admin/recycle-bin | Recycle-bin housekeeping: counts, oldest age, manual purge per entity (danger) |

### /dashboard
| Route | Purpose |
|---|---|
| /dashboard | [R→/dashboard/overview] |
| /dashboard/overview | Main home dashboard (Global Snapshot, KPIs) |
| /dashboard/analytics | Dashboard analytics hub |
| /dashboard/analytics/channels | Channel performance analytics |
| /dashboard/analytics/inventory | Inventory analytics |
| /dashboard/analytics/revenue | Revenue analytics |
| /dashboard/bulk-actions | Bulk-action job monitor (list/refresh jobs) |
| /dashboard/health | Sync health dashboard |
| /dashboard/reports | Reports list |
| /dashboard/reports/[reportId] | Single report viewer |
| /dashboard/sync | Sync status dashboard |

### /products
| Route | Purpose |
|---|---|
| /products | Master products grid (canonical catalog list) |
| /products/next | DS-first rebuild of products list (standalone chrome, preview bed) |
| /products/new | Create new product |
| /products/drafts | Draft products list |
| /products/upload | Product import/upload |
| /products/costs | Cost master editor |
| /products/datasheet | Datasheet index |
| /products/automation | Product automation rules |
| /products/fba | FBA inventory view |
| /products/stranded | Stranded inventory view |
| /products/resolve | Inventory/product conflict resolution |
| /products/amazon-flat-file | Amazon flat-file bulk editor (UNTOUCHABLE) |
| /products/ebay-flat-file | eBay flat-file bulk editor (UNTOUCHABLE) |
| /products/[id] | Product detail |
| /products/[id]/edit | Product editor (tabbed: Master/Amazon/eBay/Images/…) |
| /products/[id]/images | [R→ edit?tab=images] |
| /products/[id]/list-wizard | AI listing wizard |
| /products/[id]/matrix | Variant matrix editor |
| /products/[id]/datasheet | Product datasheet |
| /products/[id]/datasheet/print | Print-ready datasheet |
| /products/[id]/recover | Recover soft-deleted/previous versions |

### /catalog (legacy)
| Route | Purpose |
|---|---|
| /catalog | [R→/products] |
| /catalog/import | [R→/products/upload] |
| /catalog/[id] | [R→/products/[id]] (dynamic redirect) |
| /catalog/[id]/edit | Legacy catalog product editor |
| /catalog/[id]/images | Legacy catalog images editor |
| /catalog/add | Legacy add-product |
| /catalog/drafts | Legacy drafts list |
| /catalog/matrix | Catalog-wide variant matrix |
| /catalog/organize | PIM organize (families/attributes triage) |

### /inventory (all redirect stubs)
| Route | Purpose |
|---|---|
| /inventory | [R→/products] |
| /inventory/fba | [R→/products/fba] |
| /inventory/resolve | [R→/products/resolve] |
| /inventory/stranded | [R→/products/stranded] |
| /inventory/upload | [R→/products/upload] |

### /listings
| Route | Purpose |
|---|---|
| /listings | Cross-channel listings hub |
| /listings/amazon | Amazon listings grid (all markets) |
| /listings/amazon/[market] | Amazon listings per market (it/de/fr/es/uk) |
| /listings/ebay | eBay listings grid |
| /listings/ebay/[market] | eBay listings per market |
| /listings/ebay/campaigns | eBay promoted-listings campaigns |
| /listings/ebay/gaps | eBay listing coverage gaps |
| /listings/ebay/markdowns | eBay markdown sales |
| /listings/shopify | Shopify listings grid |
| /listings/generate | AI listing generation |
| /listings/publish-status | Publish job status monitor |

### /orders
| Route | Purpose |
|---|---|
| /orders | Orders grid (FBM/FBA tabs, Amazon-parity rows) |
| /orders/[id] | Order detail |
| /orders/reviews/rules | Review-request automation rules |
| /orders/reviews/rules/timing | Review-request timing config |
| /orders/reviews/rules/send-times | Review-request send-time windows |

### /fulfillment
| Route | Purpose |
|---|---|
| /fulfillment | Fulfillment hub/overview |
| /fulfillment/carriers | Carrier management |
| /fulfillment/fnsku-labels | FNSKU label generator (PDF/SVG/ZPL) |
| /fulfillment/replenishment | Replenishment planning workspace |
| /fulfillment/repricing | Repricing rules + decisions log |
| /fulfillment/routing-rules | Order routing rules |
| /fulfillment/routing-log | Routing decisions log |
| /fulfillment/inbound | Inbound shipments list |
| /fulfillment/inbound/v2 | Inbound v2 workspace |
| /fulfillment/inbound/qc-queue | Inbound QC queue |
| /fulfillment/inbound/[id]/receive | Receive inbound shipment |
| /fulfillment/outbound | Outbound shipments/orders queue |
| /fulfillment/outbound/analytics | Outbound analytics |
| /fulfillment/outbound/pick-list | Pick list generation |
| /fulfillment/outbound/rules | Outbound rules |
| /fulfillment/outbound/pack/[shipmentId] | Pack station for a shipment |
| /fulfillment/purchase-orders | PO list |
| /fulfillment/purchase-orders/[id] | PO detail (approve/receive/attachments) |
| /fulfillment/purchase-orders/templates | PO templates + recurring |
| /fulfillment/returns | Returns list |
| /fulfillment/returns/[id]/inspect | Return inspection workflow |
| /fulfillment/returns/analytics | Returns analytics |
| /fulfillment/returns/automation | Returns automation rules |
| /fulfillment/returns/policies | Return policies |
| /fulfillment/suppliers | Supplier list |
| /fulfillment/suppliers/development | Supplier development programs |
| /fulfillment/suppliers/development/[id] | Supplier development detail |
| /fulfillment/stock | Stock grid (central inventory) |
| /fulfillment/stock/analytics | Stock analytics |
| /fulfillment/stock/channel-drift | Channel stock drift triage |
| /fulfillment/stock/pool-drift | Pool drift triage |
| /fulfillment/stock/control-tower | Stock control tower |
| /fulfillment/stock/cycle-count | Cycle count list |
| /fulfillment/stock/cycle-count/[id] | Cycle count session |
| /fulfillment/stock/fba-pan-eu | FBA Pan-EU placement view |
| /fulfillment/stock/import | Stock import (danger: bulk overwrite) |
| /fulfillment/stock/locations | Warehouse locations/bins |
| /fulfillment/stock/shopify-locations | Shopify location mapping |
| /fulfillment/stock/lots | Lot tracking dashboard (GPSR) |
| /fulfillment/stock/recalls | Product recalls list |
| /fulfillment/stock/recalls/[id] | Recall workflow detail |
| /fulfillment/stock/mcf | Multi-channel fulfillment (FBA MCF) |
| /fulfillment/stock/reservations | Stock reservations (soft/hard) |
| /fulfillment/stock/stockouts | Stockout list |
| /fulfillment/stock/transfers | Stock transfers |

### /pricing
| Route | Purpose |
|---|---|
| /pricing | Pricing grid |
| /pricing/rules | Pricing rules |
| /pricing/alerts | Price alerts |
| /pricing/buybox | Buy Box monitor |
| /pricing/promotions | Promotions |
| /pricing/volume-pricing | Volume/tier pricing (B2B rails) |

### /customers
| Route | Purpose |
|---|---|
| /customers | Customer list (RFM) |
| /customers/[id] | Customer detail |
| /customers/analytics | Customer analytics dashboard |
| /customers/risk-queue | At-risk customer queue |
| /customers/segments | Segment builder |

### /insights
| Route | Purpose |
|---|---|
| /insights | Insights hub (SSE-live) |
| /insights/sales | Sales insights |
| /insights/profit | Profit & cost insights |
| /insights/advertising | Ads insights |
| /insights/amazon-reports | Amazon report browser |
| /insights/anomalies | Anomaly detection |
| /insights/brief | AI daily brief |
| /insights/builder | Custom report builder |
| /insights/customers | Customer insights |
| /insights/exports | Insight exports |
| /insights/fiscal | Italian fiscal insights (VAT) |
| /insights/forecast | Demand forecast |
| /insights/inventory | Inventory insights |
| /insights/live | Live order feed |
| /insights/notebook | Analysis notebook |
| /insights/products | Product insights |
| /insights/scenarios | What-if scenarios |

### /analytics
| Route | Purpose |
|---|---|
| /analytics | [R→/analytics/products] |
| /analytics/products | Product portfolio analytics (PA-series) |

### /bulk-operations
| Route | Purpose |
|---|---|
| /bulk-operations | Bulk ops hub |
| /bulk-operations/imports | Bulk imports (danger: mass writes) |
| /bulk-operations/exports | Bulk exports |
| /bulk-operations/history | Bulk job history |
| /bulk-operations/schedules | Scheduled bulk jobs |
| /bulk-operations/automation | Bulk automation rules |

### /sync-logs
| Route | Purpose |
|---|---|
| /sync-logs | Sync log list |
| /sync-logs/alerts | Sync alerts |
| /sync-logs/api-calls | External API call log |
| /sync-logs/errors | Sync errors |
| /sync-logs/events | Event stream log |
| /sync-logs/live | Live tail-f of sync events |
| /sync-logs/outbound-queue | Outbound queue log view |
| /sync-logs/webhooks | Webhook delivery log |

### /marketing (non-ads)
| Route | Purpose |
|---|---|
| /marketing | Marketing landing dashboard (cross-surface KPIs) |
| /marketing/analytics | Marketing analytics |
| /marketing/calendar | Marketing calendar |
| /marketing/templates | Content templates |
| /marketing/budgets | Marketing budgets |
| /marketing/campaigns | [R→/marketing/advertising/campaigns] |
| /marketing/campaigns/[id] | Unified Campaign detail (UM-series) |
| /marketing/automation-os | Unified Marketing OS automation studio (rules, dry-run→live) |
| /marketing/automation | Marketing automation rules (MC-series) |
| /marketing/automation/history | Automation run history |
| /marketing/aplus | A+ Content manager |
| /marketing/aplus/[id] | A+ Content editor |
| /marketing/brand-story | Brand Story list |
| /marketing/brand-story/[id] | Brand Story editor |
| /marketing/brand-kit | Brand Kit list |
| /marketing/brand-kit/[brand] | Brand Kit editor |
| /marketing/content | DAM hub (digital asset library) |
| /marketing/content/analytics | DAM analytics |
| /marketing/content/brand-brain | Brand-brain AI knowledge |
| /marketing/content/mapping | Asset-channel mapping |
| /marketing/content/publish | Channel publish (4-channel fan-out) |
| /marketing/reviews | Reviews hub |
| /marketing/reviews/desk | Review reply desk |
| /marketing/reviews/actions | Review action queue |
| /marketing/reviews/advanced | Advanced review analytics |
| /marketing/reviews/automation | Review automation |
| /marketing/reviews/by-product | Reviews by product |
| /marketing/reviews/products/[id] | Product review detail |
| /marketing/reviews/heatmap | Review heatmap |
| /marketing/reviews/import | Review import |
| /marketing/reviews/inserts | Package insert manager |
| /marketing/reviews/requests | Review request log |
| /marketing/reviews/requests/test/preview | Review email test preview |
| /marketing/reviews/spikes | Review spike detection |
| /marketing/reviews/spotlight | Review spotlight |

### /marketing/advertising (AD-series cockpit, 41)
| Route | Purpose |
|---|---|
| /marketing/advertising | Advertising overview |
| /marketing/advertising/campaigns | Campaign grid (main ads surface per nav) |
| /marketing/advertising/campaigns/[id] | Campaign detail |
| /marketing/advertising/campaigns/[id]/ad-groups/[adGroupId] | Ad-group detail |
| /marketing/advertising/create | Create campaign |
| /marketing/advertising/architect | Campaign architect (keyword-paste→campaigns) |
| /marketing/advertising/analytics | Ads analytics |
| /marketing/advertising/audiences | Audiences |
| /marketing/advertising/automation | Ads automation rules list |
| /marketing/advertising/automation/[id] | Rule detail |
| /marketing/advertising/automation/new | New rule |
| /marketing/advertising/automation/library | Rule template library |
| /marketing/advertising/automation/analytics | Automation analytics |
| /marketing/advertising/automation/executions | Rule execution log |
| /marketing/advertising/automation/executions/[id] | Execution detail |
| /marketing/advertising/automation/health | Automation health |
| /marketing/advertising/autopilot | Autopilot (auto bid/budget writes) |
| /marketing/advertising/bid-optimizer | Target-ACOS bid optimizer |
| /marketing/advertising/budget-manager | Budget manager |
| /marketing/advertising/budget-pools | Budget pools |
| /marketing/advertising/budget-pools/[id] | Budget pool detail |
| /marketing/advertising/dayparting | Dayparting scheduler |
| /marketing/advertising/debug | Ads debug console (internal) |
| /marketing/advertising/dsp | Amazon DSP |
| /marketing/advertising/events | Ads event log |
| /marketing/advertising/feeds | Ads feeds (GMC/Meta) |
| /marketing/advertising/funnel | Funnel analysis |
| /marketing/advertising/goals | Goal tracking |
| /marketing/advertising/harvest | Search-term harvesting |
| /marketing/advertising/incrementality | Incrementality testing |
| /marketing/advertising/insights | Ads insights |
| /marketing/advertising/momentum | Momentum view |
| /marketing/advertising/ngrams | N-gram analysis |
| /marketing/advertising/pacing | Budget pacing |
| /marketing/advertising/profit | Ad profit view |
| /marketing/advertising/recommendations | Recommendations |
| /marketing/advertising/reports | Ads reports |
| /marketing/advertising/retail-readiness | Retail readiness scores |
| /marketing/advertising/search-terms | Search-term explorer |
| /marketing/advertising/share-of-voice | Share of voice |
| /marketing/advertising/storage-age | FBA storage age (ads-adjacent) |

### /marketing/ads (AX "Trading Desk" — STANDALONE chrome, 29)
| Route | Purpose |
|---|---|
| /marketing/ads | [R→/marketing/ads/dashboard] |
| /marketing/ads/dashboard | Trading Desk dashboard |
| /marketing/ads/campaigns | Campaign grid (H10-style) |
| /marketing/ads/campaigns/[id] | Campaign detail |
| /marketing/ads/campaigns/[id]/ad-groups/[agId] | Ad-group detail |
| /marketing/ads/portfolios | Portfolio cockpit (P1 shipped) |
| /marketing/ads/account-overview | Account overview |
| /marketing/ads/account-settings | Ads account settings |
| /marketing/ads/ai-advertising | AI advertising goals |
| /marketing/ads/ai-advertising/new-goal | New AI goal |
| /marketing/ads/amc | Amazon Marketing Cloud |
| /marketing/ads/amc/audiences | AMC audiences |
| /marketing/ads/analytics | Ads analytics |
| /marketing/ads/autopilot | Autopilot |
| /marketing/ads/budget-manager | Budget manager |
| /marketing/ads/campaign-builder | Campaign builder chooser |
| /marketing/ads/campaign-builder/guided | Guided builder |
| /marketing/ads/campaign-builder/quick | Quick builder |
| /marketing/ads/campaign-builder/single | Single-campaign builder |
| /marketing/ads/campaign-builder/sp-super-wizard | SP super wizard (live GALE launch) |
| /marketing/ads/changelog | Ads change log |
| /marketing/ads/health | Ads health |
| /marketing/ads/recommendations | Recommendations |
| /marketing/ads/reporting | Reporting |
| /marketing/ads/reporting/brand-metrics | Brand metrics |
| /marketing/ads/rules-automation | Rules & automation list |
| /marketing/ads/rules-automation/builder | [R→/marketing/ads/rules-automation] |
| /marketing/ads/rules-automation/builder/[type] | Rule builder by type |
| /marketing/ads/suggestions | Suggestions |

### /marketing/ads-console (11 — STANDALONE chrome)
| Route | Purpose |
|---|---|
| /marketing/ads-console | [R→ overview] |
| /marketing/ads-console/overview | Console overview |
| /marketing/ads-console/campaigns | Campaigns |
| /marketing/ads-console/campaign-builder/guided | Guided builder |
| /marketing/ads-console/activity | Activity log |
| /marketing/ads-console/automation | Automation |
| /marketing/ads-console/bulk | Bulk operations on ads |
| /marketing/ads-console/products | Advertised products |
| /marketing/ads-console/rank | Rank tracking |
| /marketing/ads-console/settings | [R→/settings/advertising] |
| /marketing/ads-console/targeting | Targeting |

### /settings (23) — see §5 for grouping
| Route | Purpose |
|---|---|
| /settings | Settings landing (cards for every group) |
| /settings/profile | User profile |
| /settings/notifications | Notification prefs |
| /settings/account | Business settings |
| /settings/company | Company & fiscal (Italian VAT etc.) |
| /settings/terminology | Terminology glossary (Giacca/Giubbotto) |
| /settings/pim/families | Product families |
| /settings/pim/families/[id] | Family detail |
| /settings/pim/attributes | PIM attribute groups |
| /settings/pim/workflows | PIM workflows |
| /settings/dam | DAM settings |
| /settings/channels | Channel connections (Amazon/eBay/Shopify OAuth) |
| /settings/channels/[type] | Per-channel connection config |
| /settings/channels/ebay-callback | (pub-ish) eBay OAuth callback landing |
| /settings/advertising | Ads settings (rank-defend flags, gates) |
| /settings/ai | AI provider keys/config |
| /settings/api-keys | API key management (danger: secrets) |
| /settings/webhooks | Webhook endpoints (danger: outbound config) |
| /settings/audit | Audit log (compliance) |
| /settings/privacy | Data & privacy (GDPR erasure — danger) |
| /settings/security | Security settings |
| /settings/mappings | Channel mapping canvas list |
| /settings/mappings/canvas/[channel]/[code] | Mapping canvas editor |

## 3. route.ts handlers (18) — all in apps/web/src/app

Nearly all are thin proxies to the Railway API backend (`http://localhost:3001` / `getBackendUrl()` / `API_BASE_URL`). Two hit Prisma directly from the web app. None check auth.

| Handler path (under src/app) | Methods | Purpose | Privileged? |
|---|---|---|---|
| api/catalog/cache-clear/route.ts | POST | Proxy → backend catalog cache clear | Mutates (cache wipe); hardcoded localhost:3001 |
| api/catalog/cache-stats/route.ts | GET | Proxy → backend cache stats | Read-only |
| api/catalog/product-types/route.ts | GET | Proxy → backend product types | Read-only |
| api/catalog/product-types/[productType]/schema/route.ts | GET | Proxy → Amazon PT schema | Read-only |
| api/catalog/products/route.ts | POST | Proxy → create catalog product | Mutates data |
| api/catalog/products/bulk/route.ts | POST | Proxy → bulk create/update products | Mutates (bulk) |
| api/catalog/products/[id]/route.ts | DELETE | Proxy → delete product | DESTRUCTIVE |
| api/catalog/validate/route.ts | POST | Proxy → validate product payload | Read-only compute |
| api/inbound/sync-catalog/route.ts | POST | Proxy → trigger inbound catalog sync | Mutates (sync job) |
| api/inventory/route.ts | GET | Proxy → Amazon products list | Read-only |
| api/inventory/[productId]/children/route.ts | GET | Proxy → variant children | Read-only |
| api/listings/route.ts | GET | Direct Prisma: `prisma.listing.findMany` | DB read from web tier |
| api/products/route.ts | GET | Direct Prisma: `prisma.product.findMany` | DB read from web tier |
| api/products/[id]/matrix/route.ts | GET/POST/PUT/DELETE | Proxy → variant matrix CRUD | Mutates + DELETE |
| api/outbound/queue/[queueId]/route.ts | DELETE | Proxy → remove outbound queue item | DESTRUCTIVE |
| api/sync/amazon/catalog/route.ts | POST | Proxy → trigger Amazon catalog sync | Mutates (sync job) |
| api/sync/amazon/catalog/[syncId]/route.ts | GET | Stub: always returns status=success | Harmless stub |
| products/[id]/datasheet/export.json/route.ts | GET | Direct Prisma (8 models) → datasheet JSON export | DB read, no auth |

Note: the real API surface lives in apps/api (Railway, Fastify) — these 18 are the only Next.js handlers. Several server components also hit Prisma directly (e.g. /outbound, /performance/feedback, /reports/business).

## 4. Navigation / layout architecture

- **Root layout**: `apps/web/src/app/layout.tsx` — wraps EVERYTHING (single root; no route groups). Composes ToastProvider → ConfirmProvider → `AppShell` with slots: `sidebar={<AppNavRail/>}`, `topBar={<MobileTopBar/>}`, banners (GlobalAccountHealthBanner, GlobalDlqBanner), overlays (CommandPalette, CommandMatrixPanel, NotificationsBell, CompetitiveAlertWatcher) + CopilotMount on every route.
- **Shell switch**: `apps/web/src/components/layout/AppShell.tsx` ('use client') — `STANDALONE_PREFIXES = ['/marketing/ads-console', '/marketing/ads', '/products/next']` render full-bleed with NO chrome; everything else gets rail+topbar+banners.
- **Nav data source (the permission hook point)**: `apps/web/src/app/_shared/app-nav.ts` — `buildAppNav(counts, conn): RailNavItem[]` is the SINGLE data-driven source of truth for the global rail (Home, Products, Listings, Stock, Inbound, Outbound, Replenishment, POs, Suppliers, Carriers, Returns, Orders, Pricing, Insights, Advertising, Calendar, Content, Reviews, Inbox, Sync Logs, Connections, Mappings, Settings, Recycle Bin — each with `children` sub-items). Filtering this array by permission = nav filtering done.
- **Rail renderer**: `apps/web/src/app/_shared/AppNavRail.tsx` ('use client', fetches `/api/sidebar/counts` + `/api/connections`, polls 60s) → presentational `apps/web/src/app/_shared/AppRail.tsx`. Legacy `components/layout/AppSidebar.tsx` is GONE (migration complete). Sub-layout navs exist for settings (`settings/_shell/SettingsRail.tsx` ← `settings/_shell/settings-nav.ts`, also data-driven with SETTINGS_NAV groups) and the ads surfaces (own layouts: marketing/ads/layout.tsx, marketing/ads-console/layout.tsx, marketing/advertising/layout.tsx, pricing/layout.tsx, products/next/layout.tsx).
- **Other nav entry points needing permission filtering later**: `components/CommandPalette.tsx` (Cmd+K), `components/CommandMatrixPanel.tsx`, `components/MobileTopBar.tsx`, settings landing page cards (`app/settings/page.tsx`).
- **Auth surface: NONE.** No middleware.ts anywhere in apps/web, no /login, /403, /unauthorized, no auth provider in root layout. Error pages: root `app/error.tsx` + `app/not-found.tsx` (+ per-route error.tsx in dashboard/overview and pricing). A permission system needs middleware + login/denied pages built from scratch.

## 5. Settings sections (settings/_shell/settings-nav.ts groups)

| Group | Items |
|---|---|
| Account | Profile (/settings/profile), Notifications (/settings/notifications) |
| Workspace | Business (/settings/account), Company & fiscal (/settings/company), Terminology (/settings/terminology) |
| Catalog | Product families (/settings/pim/families), PIM attributes (/settings/pim/attributes), Workflows (/settings/pim/workflows), DAM library (/settings/dam) |
| Integrations | Channels (/settings/channels), Advertising (/settings/advertising), AI providers (/settings/ai) |
| Developer | API keys (/settings/api-keys), Webhooks (/settings/webhooks) |
| Compliance & audit | Audit log (/settings/audit), Data & privacy (/settings/privacy), Security (/settings/security) |

Not in the rail groups but under /settings: mappings + mappings/canvas/[channel]/[code] (reached from main rail "Mappings"), channels/[type], channels/ebay-callback (OAuth landing). Settings layout: `app/settings/layout.tsx` two-pane shell with SettingsRail + SettingsShellHeader + SettingsSaveBar.

## 6. Admin / destructive flags

- **/admin** — "Data Validation & Repair Operations" dashboard (server-fetches health + validation report; repair actions).
- **/admin/recycle-bin** — manual PURGE per entity (permanent deletes). Linked from main nav rail ("Recycle Bin").
- **/settings/api-keys, /settings/webhooks, /settings/ai** — secret material management.
- **/settings/privacy** — GDPR data erasure.
- **/settings/channels + [type]** — OAuth connect/disconnect for live channels (PRESERVE-sensitive per user policy).
- **/bulk-operations/imports, /fulfillment/stock/import, /products/upload** — bulk writes that can overwrite catalog/stock.
- **/marketing/automation-os, /marketing/advertising/autopilot, /marketing/ads rules-automation** — live channel-write automations (budget/bid writes, guardrailed).
- **Route handlers**: DELETE product, DELETE outbound-queue item, POST cache-clear, POST bulk products — none have any auth check today.
- **Internal-only pages** worth hiding from non-devs: /design, /design/console, /design-system, /marketing/advertising/debug, /products/next (preview bed), /command-matrix.
- **Public token pages** that must be EXEMPT from any auth wall: /r/[token]/*, /po/*/[token], /track/[trackingNumber], /unsubscribed, /settings/channels/ebay-callback (OAuth return).
