# S0 — Proposed Permission Registry & Default Role Matrix

**Status:** Proposal for the S0 gate. Nothing here is implemented. The registry becomes the single source of truth in S2 (`packages/shared/src/permissions.ts`), imported by API middleware, web guards, seeds, and the admin matrix UI — permissions are defined nowhere else.

Mapped 1:1 to the real enumeration:
- Pages → `S0-ENUMERATION-PAGES.md` (310 pages, ~20 modules)
- Endpoints → `S0-ENUMERATION-ENDPOINTS.md` (2,028 endpoints, 149 files, 14 buckets)
- Fields → `S0-ENUMERATION-FINANCIAL-FIELDS.md` (191 restricted-financial fields)

**Design rules:**
1. **Three layers** — `pages.*` (can you see the page / does the nav link render), `<module>.<action>` (can you perform the action; server-enforced), `financials.*` (field-level response filtering).
2. **Deny by default** — every endpoint maps to exactly one required permission (or is explicitly `PUBLIC`). Anything unmapped returns 403 and logs an error. New endpoints are invisible until mapped.
3. **Dot notation, module-grouped.** Page perm gates visibility; feature perms gate mutation; `.view` gates read within a permitted page.
4. **OWNER is implicit-all** — never appears in grants; the resolver short-circuits `role === OWNER → allow`.

---

## 1. Page-access permissions (`pages.*`) — 24

One per top-level nav destination. Gating `pages.X` hides the nav link (via `buildAppNav()` filtering in `app/_shared/app-nav.ts`) **and** returns 403 on direct URL navigation (server-side layout guard). Sub-pages inherit their module's page permission unless separately listed.

| Permission | Covers (routes) |
|---|---|
| `pages.dashboard` | `/dashboard/*`, `/` |
| `pages.products` | `/products/*` (incl. amazon-flat-file, ebay-flat-file, edit, wizard, datasheet), `/catalog/*`, `/inventory/*` |
| `pages.listings` | `/listings/*`, `/reconciliation` |
| `pages.orders` | `/orders/*` |
| `pages.fulfillment` | `/fulfillment/*` (stock, inbound, outbound, returns, suppliers, purchase-orders, carriers, replenishment, routing, fnsku-labels) |
| `pages.repricing` | `/fulfillment/repricing`, `/pricing` repricing surfaces |
| `pages.pricing` | `/pricing/*` |
| `pages.insights` | `/insights/*` |
| `pages.analytics` | `/analytics/*`, `/reports/business` |
| `pages.marketing` | `/marketing/content`, `/marketing/campaigns`, `/marketing/calendar`, `/marketing/templates`, `/marketing/automation-os`, aplus/brand-* |
| `pages.advertising` | `/marketing/advertising/*`, `/marketing/ads/*`, `/marketing/ads-console/*` |
| `pages.reviews` | `/marketing/reviews/*`, `/orders/review-*` |
| `pages.customers` | `/customers/*` |
| `pages.financials` | Financial surfaces: `/insights/profit`, `/insights/fiscal`, `/reports/business` financial rollups, settlement/reimbursement views (see also `financials.view`) |
| `pages.bulkOperations` | `/bulk-operations/*` |
| `pages.syncLogs` | `/sync-logs/*`, `/inbox`, `/outbound` |
| `pages.performance` | `/performance/*` |
| `pages.settings` | `/settings` landing + non-privileged settings pages |
| `pages.settings.integrations` | `/settings/channels/*`, `/settings/advertising`, `/settings/ai`, `/settings/mappings/*` |
| `pages.settings.developer` | `/settings/api-keys`, `/settings/webhooks` |
| `pages.settings.compliance` | `/settings/audit`, `/settings/privacy`, `/settings/security` |
| `pages.teamAccess` | `/settings/team/*` (the NEW console — S4) |
| `pages.admin` | `/admin`, `/admin/recycle-bin`, `/command-matrix` |
| `pages.internal` | `/design`, `/design-system`, `/marketing/advertising/debug`, `/products/next` (dev/internal — OWNER/ADMIN only) |

**Auth-exempt (no permission — `PUBLIC`):** `/r/[token]/*`, `/po/ack/[token]`, `/po/approve/[token]`, `/track/[trackingNumber]`, `/unsubscribed`, `/settings/channels/ebay-callback`, plus the login/reset/invite-accept pages S1 creates.

---

## 2. Feature-action permissions (`<module>.<action>`) — proposed ~90

Grouped by module bucket (matching the endpoint enumeration). `.view` = read the module's data; `.*` actions = mutations. Every one of the 2,028 endpoints maps to one of these. The two monster files (`fulfillment.routes.ts` 304 eps, `advertising.routes.ts` 277 eps) map at **path-segment** granularity, not file granularity.

### Products / catalog (products/catalog bucket — 278 eps)
`products.view` · `products.create` · `products.edit` · `products.delete` · `products.price.edit` · `products.publish` · `products.import` · `products.export` · `products.images.edit` · `products.translations.edit` · `pim.manage` (families/attributes/workflows/mappings) · `products.bulk.run`

### Listings / channels (322 eps)
`listings.view` · `listings.edit` · `listings.publish` · `listings.recover` · `listings.flatfile.edit` (Amazon/eBay flat-file editors) · `channels.connect` · `channels.disconnect` · `channels.sync`

### Orders (124 eps)
`orders.view` · `orders.edit` · `orders.fulfill` · `orders.refund` · `orders.cancel` · `orders.export` · `orders.routing.manage` · `reviews.view` · `reviews.manage` (review-request rules/windows/inserts)

### Fulfillment / inventory (463 eps) — path-segment mapped
`inventory.view` · `inventory.adjust` · `stock.transfer` · `stock.count` · `lots.manage` · `inbound.manage` · `outbound.manage` · `returns.view` · `returns.process` (incl. `returns.refund`) · `suppliers.view` · `suppliers.manage` · `po.view` · `po.create` · `po.approve` · `po.receive` · `replenishment.view` · `replenishment.run` · `carriers.manage` · `fnsku.generate` · `fulfillment.export`

### Pricing / repricing (59 eps)
`pricing.view` · `pricing.edit` · `pricing.rules.manage` · `repricing.view` · `repricing.rules.manage` · `pricing.tiers.manage` (B2B tier prices) · `pricing.costs.edit` (product costs)

### Advertising (299 eps) — path-segment mapped
`ads.view` · `ads.campaigns.manage` · `ads.budgets.edit` · `ads.bids.edit` · `ads.automation.manage` (autopilot/rank/rules — live writes) · `ads.connect` (Amazon Ads OAuth) · `ads.export`

### Marketing / content (131 eps)
`marketing.view` · `marketing.content.edit` · `marketing.campaigns.manage` · `marketing.automation.manage` · `marketing.publish` · `assets.manage` (DAM) · `aplus.manage` · `brand.manage` (brand-kit/story/brain)

### Analytics / insights (53 eps)
`analytics.view` · `insights.view` · `forecast.view` · `reports.run` · `reports.export`

### Customers (25 eps)
`customers.view` · `customers.edit` · `customers.segments.manage` · `customers.export`

### Settings / connections (43 eps)
`settings.view` · `settings.workspace.edit` (business/company/fiscal/terminology) · `settings.notifications.edit` · `settings.integrations.manage` (channels/ai/mappings) · `settings.apikeys.manage` · `settings.webhooks.manage` · `settings.privacy.manage` (GDPR erasure/export) · `settings.security.manage`

### Admin / ops (135 eps)
`admin.view` · `admin.repair` (repair/backfill/rebuild) · `admin.purge` (recycle-bin purge, destructive deletes) · `admin.restore` (bulk-restore, FBA restore, version restore) · `sync.manage` (force-sync, requeue, DLQ redrive) · `jobs.manage` (job-monitor, circuit-breaker reset) · `bulk.rollback`

### AI / agents (43 eps)
`ai.view` · `ai.run` (agents/brand-brain/generate) · `ai.usage.view` (cost dashboards — see also `financials.adspend`/opex)

### Users / roles / audit (NEW — S2/S4)
`users.manage` · `roles.manage` · `invitations.manage` · `audit.view` · `sessions.manage` (force-sign-out others)

### Webhooks / infra
Webhook **receivers** are `PUBLIC` + signature-verified (not session-gated) — see §5. Admin webhook **config** is `settings.webhooks.manage`. Health = `PUBLIC`.

---

## 3. Field-visibility permissions (`financials.*`)

**Master switch: `financials.view`.** Without it, the central response serializer (S2) strips all 191 restricted-financial fields — server-side, so the data never reaches the browser. Not hidden columns: absent data.

The S0 field audit justifies **finer grains** so FINANCE-lite / operational roles can see some money without seeing all of it. Proposed sub-permissions (each implies a slice of the 191 fields; `financials.view` = all):

| Permission | Field classes (from `S0-ENUMERATION-FINANCIAL-FIELDS.md §3a`) |
|---|---|
| `financials.costs.view` | Product/variant `costPrice`, WAC, COGS, StockCostLayer, landed costs, supplier costs, PO/inbound costs, bundle costs, work-order costs (~56 fields) |
| `financials.margins.view` | `minMargin`, `trueProfitMarginPct`, margin guardrails, `StockoutEvent.margin*`, `BuyBoxHistory.marginAtObservation` |
| `financials.fees.view` | Marketplace fees, referral/FBA/storage fees, `FinancialTransaction` fee breakdown, `ProductProfitDaily` fee columns |
| `financials.payouts.view` | `SettlementReport.*`, `FbaReimbursement.*`, deposit dates/totals |
| `financials.adspend.view` | All 94 ad-money fields (Campaign/AdGroup/AdTarget spend/sales/acos/roas/bids/budgets, ads perf tables, budget pools, autopilot payloads) |
| `financials.revenue.view` | Revenue aggregates: `DailySalesAggregate.grossRevenue`, `ProductProfitDaily.grossRevenueCents`, `Customer.totalSpentCents` |
| `financials.suppliers.view` | Supplier fiscal identity, payment terms, negotiated/quoted costs, tier ladders (`ProductTierPrice.price`, `Product.b2bPrice`) |

**Simplest correct default:** ship S2 with the **master `financials.view`** enforced everywhere (the required control), and treat the 7 sub-grains as an **opt-in refinement** the matrix UI can toggle. Roles below use the master switch; sub-grains are available for custom roles (e.g. an "Ads Manager" who gets `financials.adspend.view` but not `financials.costs.view`).

**Bypass channels the serializer MUST cover (not just REST field-omission):**
- **JSON blobs** that smuggle money: `AuditLog.before/after`, `Order.amazonMetadata`, `PurchaseOrderRevision.snapshotJson`, `SettlementReport.rawBody`, `BudgetPoolRebalance.inputs/outputs`, `Campaign.budgetJson`, `AutopilotDecision.before/after`, `Refund.perLineAmounts`, export/import job payloads. → JSON redaction rules or route-level gating for their viewers (audit log UI, PO history, export downloads).
- **SSE event payloads** (order/ads events carry money) — enforce in the SSE serialization layer, not just REST.
- **CSV/XLSX exports** (`ExportJob`, insights exports, feed error reports) — enforce in the export writer.
- Enforcement therefore lives in **one serialization layer shared by REST + SSE + export writers**, keyed off the caller's permission set — never ad-hoc per handler.

---

## 4. Borderline field classifications — need a human ruling

These determine what the serializer strips. I need answers **before S2** (not before S1). My recommendation in each row; please confirm or override.

| # | Field(s) | Question | My recommendation |
|---|---|---|---|
| 1 | `Order.totalPrice`, `OrderItem.price` | Can warehouse/ops staff see customer-paid order money? | **OPERATIONAL** (needed for packing slips/refunds). Restrict only the **aggregates** (`DailySalesAggregate`, insights, Global Snapshot, `Customer.totalSpentCents`) under `financials.revenue.view` |
| 2 | `Refund.amountCents`, `perLineAmounts`, `Return.refundCents` | Returns staff process refunds — hide amounts? | **OPERATIONAL** for `returns.process` holders (hiding breaks the job) |
| 3 | Carrier/shipment costs (`Shipment.costCents`, `CarrierService.basePriceCents`, `CarrierMetric.*`) | Our shipping costs — who sees them? | **Visible to `fulfillment.*`** (they pick services by cost); hidden from VIEWER/CS |
| 4 | Min-price floors (`Product.minPrice`, `ProductVariation.minPrice/mapPrice`, `RepricingRule.minPrice`, `ChannelListing.bestOfferFloor`) | Min-price ≈ cost+margin → leaks margin | **RESTRICTED** (min/MAP floors under `financials.margins.view`); max-price OPERATIONAL |
| 5 | `ChannelListing.estimatedFbaFee`, `referralFeePercent` | Render on the **untouchable** flat-file pages | **RESTRICTED** (`financials.fees.view`) but filtered in `AmazonFlatFileService`/serializer, NOT the page (pages stay untouchable) |
| 6 | `Customer.totalSpentCents`, `totalOrders` | LTV — CS/segmentation uses it | **RESTRICTED** under `financials.revenue.view`; CS role can be granted it |
| 7 | `FiscalInvoice`/`CreditNote` amounts | Fulfillment prints invoices/credit notes | **OPERATIONAL for the doc-generation path**, RESTRICTED for browse/aggregate views |
| 8 | AI opex (`AiUsageLog.costUSD`, `AgentRun.costUSD`, etc.) | Internal spend, small € | **RESTRICTED** under `financials.adspend.view` (low severity; fine to leave for ADMIN/FINANCE) |
| 9 | Volume non-money (`DailySalesAggregate.unitsSold`, sessions, `KeywordRank`) | Not money but revenue-approximating | **Out of `financials.view` scope** (operational metrics); revisit if you want them restricted |
| 10 | B2B tier prices (`Product.b2bPrice`, `ProductTierPrice.price`) | Pre-classified RESTRICTED | **RESTRICTED** under `financials.suppliers.view`; note a future B2B-sales role needs read access |

---

## 5. Special endpoint classes (not session-gated)

From `S0-ENUMERATION-ENDPOINTS.md §4`. These are the exceptions to deny-by-default — each is `PUBLIC` at the session layer but carries its own control:

- **Webhook receivers (15):** `PUBLIC` + **signature verification** (already present for Shopify/Sendcloud/Cloudinary/eBay; **missing for Etsy ×6 and the internal stock webhooks** — flagged in `S0-FINDINGS.md`). Auth = HMAC, not session.
- **OAuth callbacks (2 browser-redirect):** `GET /api/amazon-ads/auth/callback`, `POST /api/ebay/auth/callback` — `PUBLIC` (state/PKCE-verified). Their initiate/revoke siblings are session-gated (`channels.connect`/`ads.connect`).
- **SSE streams (12):** session-gated but auth **must ride the cookie** (EventSource can't send headers). Option A domain makes this automatic.
- **File downloads (39):** session-gated but opened via `<a href>`/new tab → cookie auth (not header) required. Option A handles this.
- **Health (`/api/health`, `/admin/health`):** `PUBLIC`.

---

## 6. Default role → permission matrix

Six seeded roles (editable later; unlimited custom roles). `OWNER` is implicit-all and never enumerated. `●` = granted, blank = denied.

| Permission group | OWNER | ADMIN | OPS_MANAGER | FULFILLMENT | FINANCE | VIEWER |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| **Pages** |
| dashboard | ● | ● | ● | ● | ● | ● |
| products / listings | ● | ● | ● | view | | view |
| orders | ● | ● | ● | ● | view | view |
| fulfillment | ● | ● | ● | ● | view | view |
| pricing / repricing | ● | ● | ● | | view | |
| insights / analytics | ● | ● | ● | | ● | view |
| financials | ● | ● | | | ● | |
| marketing / advertising | ● | ● | ● | | view | view |
| reviews | ● | ● | ● | | | view |
| customers | ● | ● | ● | | view | view |
| bulkOperations | ● | ● | ● | | | |
| syncLogs / performance | ● | ● | ● | view | view | view |
| settings (base) | ● | ● | | | | |
| settings.integrations | ● | ● | | | | |
| settings.developer | ● | ● | | | | |
| settings.compliance | ● | ● | | | ● (audit) | |
| teamAccess | ● | ● | | | | |
| admin / internal | ● | ● | | | | |
| **Features** |
| products.* (edit/create/publish) | ● | ● | ● | | | |
| products.price.edit | ● | ● | ● | | | |
| listings.publish / channels.sync | ● | ● | ● | | | |
| channels.connect/disconnect | ● | ● | | | | |
| orders.fulfill | ● | ● | ● | ● | | |
| orders.refund / cancel | ● | ● | ● | | | |
| inventory.adjust / stock.* | ● | ● | ● | ● | | |
| returns.process | ● | ● | ● | ● | | |
| po.create / po.receive | ● | ● | ● | ● | | |
| po.approve | ● | ● | ● | | | |
| suppliers.manage | ● | ● | ● | | | |
| pricing.edit / rules | ● | ● | ● | | | |
| ads.campaigns/budgets/bids | ● | ● | ● | | | |
| ads.automation.manage | ● | ● | | | | |
| marketing.* | ● | ● | ● | | | |
| customers.edit / segments | ● | ● | ● | | | |
| reports.run / export | ● | ● | ● | | ● | |
| admin.repair/purge/restore | ● | ● | | | | |
| sync.manage / jobs.manage | ● | ● | ● | | | |
| ai.run | ● | ● | ● | | | |
| settings.*.manage | ● | ● | | | | |
| users/roles/invitations.manage | ● | ●¹ | | | | |
| audit.view | ● | ● | | | ● | |
| **Fields** |
| financials.view (all money) | ● | ● | | | ● | |
| financials.adspend.view² | ● | ● | ●² | | ● | |

¹ **ADMIN** holds `users.manage`/`roles.manage` but **cannot grant OWNER, demote/delete an OWNER, or edit the OWNER role** — enforced in the service layer (master prompt §3.4), not just UI.
² OPS_MANAGER seeing ad spend is a **borderline call** (ops runs campaigns but "no financial fields" per the role intent). Default: **OPS_MANAGER does NOT get `financials.view`** but MAY get `financials.adspend.view` so they can manage campaigns meaningfully. Confirm at gate — if you want ops fully money-blind, drop it and ad screens degrade to non-money columns.

**Role intent recap** (master prompt §4): OWNER=all·implicit·protected; ADMIN=all except OWNER-grant/owner-delete; OPS_MANAGER=full operational (orders/inventory/listings/products), **no financials, no settings, no user mgmt**; FULFILLMENT=view+fulfil orders only, minimal money; FINANCE=financial pages+fields+reports, read-only on ops; VIEWER=read-only ops, no financials.

---

## 7. Channel scoping (schema day-one, UI later)

A role assignment may optionally be scoped to specific channels/marketplaces (e.g. FULFILLMENT limited to eBay IT). Design:

- `UserRole.channelScope Json?` — `null` = all channels (default); else `{ channels?: string[], marketplaces?: string[] }` (e.g. `{ channels:['EBAY'], marketplaces:['IT'] }`).
- The permission resolver returns both the permission set **and** the scope. Enforcement: endpoints that carry a channel/marketplace param (most of listings/orders/fulfillment) additionally check the caller's scope; unscoped assignments skip the check (fast path).
- **S0 delivers the schema** (`UserRole.channelScope` in `S0-SCHEMA.md`). **UI ships in S4+.** Enforcement wiring can be staged: land the column now, enforce when the scoped-role UI ships, so no half-enforced state.

**Confirm at gate:** schema-now / UI-later is acceptable (master prompt §4 explicitly allows "implement only if approved" — I'm proposing schema-now, enforcement+UI-later).
