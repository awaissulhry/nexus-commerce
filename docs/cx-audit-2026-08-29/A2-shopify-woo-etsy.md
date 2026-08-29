# Audit A2 — Shopify, WooCommerce, Etsy channels (read-only)

Repo: `/Users/awais/nexus-commerce` · date 2026-08-29 · scope: routes, services, jobs, webhooks, web UI for SHOPIFY / WOOCOMMERCE / ETSY.
Every claim carries `path:line`. "unverified" = could not be proven from the code alone.

---

## 0. Registration status (apps/api/src/index.ts)

| Route file | Imported | Registered | Prefix |
|---|---|---|---|
| `routes/shopify.ts` (`shopifyRoutes`) | `apps/api/src/index.ts:24` | `apps/api/src/index.ts:620` | none → `/shopify/*` |
| `routes/shopify-webhooks.ts` | `index.ts:25` | `index.ts:621` | none → `/webhooks/shopify/*` |
| `routes/woocommerce.ts` | `index.ts:26` | `index.ts:622` | none → `/woocommerce/*` |
| `routes/woocommerce-webhooks.ts` | `index.ts:27` | `index.ts:623` | none → `/webhooks/woocommerce/*` |
| `routes/etsy.ts` (`estyRoutes`, sic) | `index.ts:28` | `index.ts:624` | none → `/etsy/*` |
| `routes/etsy-webhooks.ts` (`estyWebhookRoutes`) | `index.ts:29` | `index.ts:625` | none → `/webhooks/etsy/*` |
| `routes/shopify-setup.routes.ts` | `index.ts:189` | `index.ts:794` | `/api` → `/api/admin/setup-shopify-webhooks`, `/api/admin/shopify-webhook-status` |
| `routes/marketplaces.ts` (`marketplaceRoutes`, consumer of `marketplace.service`) | `index.ts:21` | `index.ts:617` | none → `/marketplaces/*` |

RBAC: `/webhooks/` prefix is `PUBLIC` (`apps/api/src/lib/auth/permissions-manifest.ts:61`); `/shopify`, `/woocommerce`, `/etsy` prefixes map to `listingsView` (read) / `channelsSync` (write) (`permissions-manifest.ts:336-338`). The manifest rule meant for the Shopify setup route matches `/api/shopify…/setup` (`permissions-manifest.ts:134`) but the route is actually mounted at `/api/admin/setup-shopify-webhooks` (`shopify-setup.routes.ts:82`, prefix at `index.ts:794`), so it falls through to the generic `/api/admin` rule (`permissions-manifest.ts:404`, `adminView`/`adminRepair`). RBAC mode defaults to `shadow` unless `NEXUS_RBAC_MODE=enforce` (`apps/api/src/lib/auth/rbac-hook.ts:29-30`), so in shadow mode none of the `/shopify/*`, `/woocommerce/*`, `/etsy/*`, `/marketplaces/*` write routes are actually denied — unverified what prod sets.

No raw-body plugin: there is no `addContentTypeParser` / `rawBody` / `fastify-raw-body` anywhere in `apps/api/src` (grep hits only `lib/typesense.ts:41-53` and `lib/auth/financial-fields.ts:61`, both unrelated). `apps/api/package.json` has no shopify/woocommerce/etsy SDK dependency (grep empty).

---

## 1. Auth mechanism

### Shopify
- **No OAuth connect/initiate/callback route exists.** grep for a Shopify authorize URL / token exchange returns nothing; the only "token response" type is a dead interface `ShopifyTokenResponse` in `apps/api/src/services/marketplaces/shopify.service.ts:6-17` that nothing uses.
- Credentials are **env vars, read at process start**: `SHOPIFY_SHOP_NAME`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET` (all three required or the channel is "not configured") plus optional `SHOPIFY_API_VERSION` — `apps/api/src/utils/config.ts:34-64`, initialised on module load `config.ts:268`.
- Several code paths bypass `ConfigManager` and read `process.env` directly (so config drift is possible): `marketplaces/shopify.service.ts:80-89` (constructor), `services/outbound-sync.service.ts:1840-1841` (also accepts an alternate var `SHOPIFY_ADMIN_API_TOKEN`), `services/images/shopify-image-publish.service.ts:110-111`, `services/images/shopify-live-images.service.ts:66,94-95`, `services/listing-wizard/shopify-publish.adapter.ts:157-158`, `services/channel-batch/shopify-bulk-mutation.service.ts:72-73`, `services/marketplaces/marketplace.service.ts:62`, `routes/listings-syndication.routes.ts:2644`.
- **ChannelConnection is never used for these channels.** grep for `channelType: 'SHOPIFY'|'WOOCOMMERCE'|'ETSY'` or `{ channel:'SHOPIFY', primary:true }` in `apps/api/src` returns zero hits. Only Amazon is seeded as env-managed (`apps/api/src/index.ts:331-391`, `channelType: "AMAZON"` at `index.ts:370,375`).
- What `shopify-setup.routes.ts` does: it is **not** a connect flow. It registers webhook subscriptions (REST `POST /admin/api/{v}/webhooks.json`) for 7 topics using the env token (`shopify-setup.routes.ts:40-48,97-106`) and lists registered webhooks (`:152-180`). Webhook address is built from `NEXUS_PUBLIC_API_URL` / `PUBLIC_API_URL` / `RAILWAY_PUBLIC_DOMAIN` (`:50-58`).
- `.env.example:8` documents `SHOPIFY_SHOP_NAME=mystore.myshopify.com`, but every client builds `https://${shopName}.myshopify.com/…` (`shopify.service.ts:111`, `shopify-enhanced.service.ts:230`, `shopify-setup.routes.ts:67`, `outbound-sync.service.ts:1869`, `shopify-image-publish.service.ts:126`, `shopify-publish.adapter.ts:186`, `shopify-bulk-mutation.service.ts:81`). Following the example yields `mystore.myshopify.com.myshopify.com`.

### WooCommerce
- **No connect flow.** Credentials are env vars `WOOCOMMERCE_STORE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET`, `WOOCOMMERCE_WEBHOOK_SECRET` (all four required) + `WOOCOMMERCE_API_VERSION` — `apps/api/src/utils/config.ts:69-101`. `marketplace.service.ts:71-91` re-reads the same env vars independently.
- Auth to Woo is HTTP Basic `consumerKey:consumerSecret` (`apps/api/src/services/marketplaces/woocommerce.service.ts:221-228`). No check that `storeUrl` is https (`woocommerce.service.ts:199`), so the key pair could go over plaintext if misconfigured — unverified in prod.

### Etsy
- **No OAuth flow** (Etsy v3 requires OAuth 2.0 PKCE with 1-hour access tokens). Credentials are env vars `ETSY_SHOP_ID`, `ETSY_API_KEY`, `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN`, `ETSY_WEBHOOK_SECRET` (all five required) — `apps/api/src/utils/config.ts:106-139`. `marketplace.service.ts:101-121` re-reads them with only `ETSY_SHOP_ID` + `ETSY_ACCESS_TOKEN` required.
- Header bug: `x-api-key` is set to the **access token**, not the app keystring (`apps/api/src/services/marketplaces/etsy.service.ts:269-272`); `config.apiKey` is loaded but never used by `EtsyService` (`etsy.service.ts:243-252`). Etsy v3 rejects requests whose `x-api-key` is not the app key — every Etsy call is therefore expected to fail (unverified without a live call).

### What the UI offers instead
- Settings → Channels fetches `GET /api/connections` (`apps/web/src/app/settings/channels/ChannelsClient.tsx:160-161`). The API reads only `ChannelConnection` rows with `managedBy` oauth|env (`apps/api/src/routes/connections.routes.ts:104-108`) and pads SHOPIFY/WOOCOMMERCE/ETSY with a synthetic `pendingRow` (`connections.routes.ts:81-96,121-125`; header comment `:7-9` "Shopify/Woo/Etsy don't have adapters yet").
- The card therefore renders "Coming soon" and a disabled "Connector deferred" button (`ChannelsClient.tsx:424-426,532-536`; rendering lines `sed 380-560` offsets 45-47 and 153-160). There is no Connect button, no key-paste form, no per-channel detail link for pending rows (`ChannelsClient.tsx:441`).
- **Even with all SHOPIFY_* env vars set the UI still says "Coming soon"**, because nothing seeds a Shopify/Woo/Etsy `ChannelConnection` row.

---

## 2. API version / protocol

| Channel | Protocol | Version | Where |
|---|---|---|---|
| Shopify | REST Admin | `2024-01` default via `SHOPIFY_API_VERSION` | `utils/config.ts:45`; `shopify-setup.routes.ts:66` |
| Shopify | REST Admin, **hard-coded, ignores config** | `2024-01` | `marketplaces/shopify.service.ts:78`; `services/images/shopify-image-publish.service.ts:123,176`; `services/images/shopify-live-images.service.ts:96`; `services/listing-wizard/shopify-publish.adapter.ts:83`; `services/outbound-sync.service.ts:1869`; `services/sync/unified-sync-orchestrator.ts:54` |
| Shopify | GraphQL Admin | `2024-01` default from config | `marketplaces/shopify-enhanced.service.ts:208,214,230`; bulk: `channel-batch/shopify-bulk-mutation.service.ts:61,81` |
| WooCommerce | REST | `wc/v3` **hard-coded** (`config.apiVersion` ignored) | `marketplaces/woocommerce.service.ts:220`; `woocommerce-pushback/index.ts:5-6` (comment) |
| Etsy | REST | `https://openapi.etsy.com/v3` base, but v2-shaped endpoints/fields | `marketplaces/etsy.service.ts:239`; v2 field names `creation_tsz`/`last_modified_tsz` (`etsy.service.ts:19-22,131-132`); `/shops/{id}/listings/{id}/variations` (`:323,368`) and `PATCH /shops/{id}/receipts/{id}` with `was_shipped` (`:549-553`) are not v3 shapes — unverified against current Etsy docs |

Note: the GraphQL orders query requests `lineItems { … price … }` (`shopify-enhanced.service.ts` sed 740-775 offset 16) and maps `parseFloat(item.price)` (`:820` region, offset 91). `LineItem.price` is not a documented Admin GraphQL field (the money field is `originalUnitPriceSet`); this would be a GraphQL validation error at runtime — unverified without a live call.

---

## 3. Token refresh

- **Shopify**: offline Admin access tokens do not expire; no refresh needed. None implemented (correct).
- **WooCommerce**: consumer key/secret never expire; none needed. None implemented (correct).
- **Etsy**: v3 access tokens expire after 1 h and must be refreshed with `refresh_token`. `ETSY_REFRESH_TOKEN` is loaded (`utils/config.ts:110,120`) and copied (`marketplace.service.ts:108`, `unified-sync-orchestrator.ts:108`) but **no code ever calls a token endpoint** — grep for `refresh_token|oauth/token|api/v3/public/oauth` filtered to etsy/shopify finds only those three assignments. The static `ETSY_ACCESS_TOKEN` will be dead ≤1 h after issuance. **Not implemented.**

---

## 4. Multi-account

- All three channels are process-wide singletons: one config per channel in a static `Map` (`utils/config.ts:18,59,96,134`). `ShopifyService` has no constructor argument at all (`shopify.service.ts:80-82`). `marketplaceService` is a module-level singleton built once from env (`marketplace.service.ts:56-121,591`).
- `connection-resolver.service.ts` and its DECLARED-primary scope are never invoked for these channels (zero grep hits, see §1). `Order.channelConnectionId` / `ChannelListing.channelConnectionId` are never set by any Shopify/Woo/Etsy writer (webhook order upsert `shopify-webhooks.ts:335-367` and poll `sync/shopify-sync.service.ts:550-562` set no connection id).
- Only the publish gate's circuit breaker is keyed by shop domain (`shopify-publish-gate.service.ts:122-128`), which is nominally multi-shop but only ever receives the single env `SHOPIFY_SHOP_NAME` (`outbound-sync.service.ts:1840,1856`).

---

## 5. Webhooks

### 5.1 Shopify (`apps/api/src/routes/shopify-webhooks.ts`)
Topics handled (one route each, no switch on `X-Shopify-Topic`):

| Route | Handler | eventType written |
|---|---|---|
| `POST /webhooks/shopify/products/update` `:926` | `handleProductUpdate` `:54` | `product/update` `:952` |
| `POST /webhooks/shopify/products/delete` `:993` | `handleProductDelete` `:104` | `product/delete` `:1019` |
| `POST /webhooks/shopify/inventory/update` `:1060` | `handleInventoryUpdate` `:168` | `inventory/update` `:1086` |
| `POST /webhooks/shopify/orders/create` `:1127` | `handleOrderCreate` `:324` | `order/create` `:1153` |
| `POST /webhooks/shopify/orders/update` `:1194` | `handleOrderUpdate` `:530` | `order/update` `:1220` |
| `POST /webhooks/shopify/fulfillments/create` `:1261` | `handleFulfillmentCreate` `:862` | `fulfillment/create` `:1287` |
| `POST /webhooks/shopify/refunds/create` `:1335` | `handleRefundCreate` `:703` | `refunds/create` `:1359` |
| `POST /webhooks/shopify/refunds/create-test` `:1402` | same handler, **no signature, no dedupe**, 404 unless `NEXUS_ENV!=production` `:1403-1405` | — |

- **Mandatory compliance webhooks are NOT handled**: no route for `customers/data_request`, `customers/redact`, `shop/redact`; no `app/uninstalled` (grep of the file: zero hits). These are required for any public/custom app listing review.
- **Signature**: `WebhookValidator.validateShopifySignature(body, header, secret)` computes HMAC-SHA256 base64 (`apps/api/src/utils/webhook.ts:17-38`) but the `body` passed is `JSON.stringify(request.body)` — the **re-serialised parsed JSON, not the raw bytes** (`shopify-webhooks.ts:929,996,1063,1130,1197,1264,1338`). Shopify signs the raw body; any difference in float formatting, unicode escaping or key order between Shopify's serialiser and V8's makes the HMAC mismatch → 401. No raw-body capture is configured (§0). Result: **real Shopify deliveries will fail verification non-deterministically**. Comparison is `hash === hmacHeader`, not `crypto.timingSafeEqual` (`utils/webhook.ts:25`).
- **Persistence order**: the event is processed first, then upserted into `WebhookEvent` (`shopify-webhooks.ts:961-976`). Nothing is persisted before processing; a crash mid-handler leaves no record and Shopify retries.
- **Idempotency key is wrong**: `externalId = String(payload.id)` (`shopify-webhooks.ts:953,1020,1087,1154,1221,1288,1358`) and the unique key is `(channel, externalId)` (`packages/database/prisma/schema.prisma` WebhookEvent `@@unique([channel, externalId])`, model at `:4613`; lookup `utils/webhook.ts:173-182`). Consequences:
  - `products/update` for product X is applied **once ever**; every later update of X is skipped as "Already processed" (`:955-958`).
  - `products/delete` for X after any `products/update` for X is skipped (same id).
  - `orders/updated` for order Y after `orders/create` Y is **always skipped** (`:1223-1226`) — status changes, cancellations, address edits never land via webhook.
  - `inventory_levels/update` payloads have no `id` field (shape at `:155-156`), so `externalId = "undefined"` for **every** inventory webhook; after the first one, all are skipped (`:1087-1092`).
  - The `X-Shopify-Webhook-Id` header (the correct dedupe key) is never read (grep: zero hits).
- **Ordering**: none (no sequence/`updated_at` comparison except the O.7 terminal-status guard in `handleOrderUpdate` `:557-570`).
- **Retry / dead-letter**: none in-house; relies on Shopify's own retry on 5xx (`:982`). Failed events are not written to `WebhookEvent` with an error (the `markWebhookProcessed` error path exists in `utils/webhook.ts:201-243` but the routes only call it on success). Replay exists via `POST /api/sync-logs/webhooks/:id/replay` (`apps/api/src/routes/sync-logs.routes.ts:1021,1079-1093`) → `dispatchShopifyWebhook` (`shopify-webhooks.ts:1431-1455`). **Bug**: route writes eventType `refunds/create` (`:1359`) but the dispatcher expects `refund/create` (`:1450`) → replaying a refund throws "Unknown Shopify eventType".
- **Registration on the channel**: yes, REST `POST /webhooks.json` for the 7 topics (`shopify-setup.routes.ts:97-106`); `already_exists` is detected by string-matching a 422 body (`:109-115`). No GraphQL `webhookSubscriptionCreate`. No web caller for this endpoint (grep `setup-shopify-webhooks` in `apps/web/src`: zero hits) — operator must curl it.
- Raw payload is stored in `WebhookEvent.payload` (`utils/webhook.ts:222,236`) and, for orders, in `Order.shopifyMetadata` (`shopify-webhooks.ts:351,365`; update at handleOrderUpdate offset 57).

### 5.2 WooCommerce (`apps/api/src/routes/woocommerce-webhooks.ts`)
Routes: `products/update` `:287`, `products/delete` `:355`, `inventory/update` `:423`, `orders/create` `:491`, `orders/update` `:559`, `orders/delete` `:627`; replay dispatcher `dispatchWooWebhook` `:695-716`.
- **Signature verification is dead code**: `validateWooCommerceSignature` returns an object `{isValid, error}` (`utils/webhook.ts:44-65`), but every route does `const isValid = WebhookValidator.validateWooCommerceSignature(...)` then `if (!isValid)` (`woocommerce-webhooks.ts:297-306,365-374,433-442,501-510,569-578,637-646`). An object is always truthy → **never rejects**. Also computed over `JSON.stringify(payload)` not raw body (same defect as Shopify), and the check is skipped entirely if `webhookSecret` is unset (`:295`). Net: **all six Woo webhook endpoints are effectively unauthenticated**.
- Idempotency key `woo_product_${id}_update` etc. (`:310,378,446,514,582,650`) — again per-entity not per-delivery, so a second update of the same product/order is skipped forever. Woo's `X-WC-Webhook-ID` / `X-WC-Webhook-Delivery-ID` headers are never read.
- Persisted after processing (`:324-340`). No retry/DLQ.
- **Order handlers write columns that do not exist**: `amazonOrderId`, `totalAmount`, `buyerName`, `channelId` (`woocommerce-webhooks.ts:144,170-175,213,239`), and create a `Channel` row with `credentials` (`:158-164`) which was dropped (`schema.prisma` model Channel comment at `:2318+4-7`). `Order` has `channel`/`channelOrderId`/`totalPrice`/`customerName` only (`schema.prisma` Order at `:4879`, `@@unique([channel, channelOrderId])`). Status map emits `COMPLETED`/`FAILED` (`:222-230`) which are not in `enum OrderStatus` (`schema.prisma:4866`). Every Woo order webhook therefore throws a Prisma validation error (types are bypassed with `(prisma as any)`).
- No code registers Woo webhooks (`POST /wc/v3/webhooks`): grep `wc/v3/webhooks|/webhooks` in `woocommerce.service.ts`: zero.

### 5.3 Etsy (`apps/api/src/routes/etsy-webhooks.ts`)
- **Etsy has no webhook product.** This file is a fictional receiver: `listings/update` `:317`, `listings/delete` `:376`, `inventory/update` `:427`, `orders/create` `:478`, `orders/update` `:529`, `orders/delete` `:580`, expecting a payload `{event_type, timestamp, data}` (`:13-18`).
- **Zero signature verification**: `WebhookValidator` is imported (`:8`) but `validateEtsySignature` is never called (grep in file: zero). Only the first route even checks that Etsy is configured (`:324-328`); the other five accept anything. **Six unauthenticated PUBLIC endpoints that write to Product/Order/StockLevel-adjacent tables** (`:41-48,74-77,117-131,144-147,194-226,264-272,298-301`).
- Idempotency key `${event_type}-${timestamp}-${listing_id}` via `findFirst` (`:331-334`) — attacker-controlled fields.
- Same non-existent columns as Woo: `Product.etsyListingId` (Product model has none; only `ProductVariation.etsyListingId` exists — `schema.prisma` ProductVariation offsets 59-62 vs Product grep "etsy" → empty), `amazonOrderId`/`totalAmount`/`buyerName`/`channelId`/`Channel.credentials` (`:170,179-211`), status `PAID` not in enum (`:197,257`).

### 5.4 Common
- `WebhookEvent` model: `channel, eventType, externalId, payload, signature?, isProcessed, processedAt, error, providerTimestamp` (`schema.prisma:4613-4637`). `signature` is never written by any route.
- Web viewer `/sync-logs/webhooks` reads/replays (`apps/web/src/app/sync-logs/webhooks/WebhooksClient.tsx` → `/api/sync-logs/webhooks`, `/replay`).
- Test coverage: `apps/api/src/routes/__tests__/shopify-webhooks-events.test.ts:41-115` tests only the SSE fan-out of the dispatcher; nothing tests signature verification, raw body, or dedupe. `woocommerce-pushback/index.test.ts` tests the dry-run note composer.

---

## 6. Polling fallbacks

- Jobs exist: `apps/api/src/jobs/shopify-sync.job.ts` (`syncShopifyProducts` `:15`, `syncShopifyInventory` `:71`, `syncShopifyOrders` `:146`, `runAllShopifySyncJobs` `:200`), `woocommerce-sync.job.ts` (`:15,71,154,208`), `etsy-sync.job.ts` (`:15,71,154,208`).
- **None is scheduled.** The only importers are the manual-trigger registry `apps/api/src/jobs/cron-registry.ts:81-83,219-221`, which powers `POST /api/sync-logs/cron/<jobName>/trigger` (`cron-registry.ts:6-8`; web trigger `apps/web/src/app/sync-logs/SyncLogsHubClient.tsx:356`). grep of `index.ts` for `runAllShopify|runAllWooCommerce|runAllEsty` → zero. **Cadence: on-demand only.**
- What they poll when triggered:
  - Shopify: GraphQL `products(first:100, query:"status:active")` paged (`shopify-enhanced.service.ts:463-472`, driven by `sync/shopify-sync.service.ts:76-105`); `getInventoryLevels` per product (`shopify-enhanced.service.ts:667`; job loops **every** product with `shopifyProductId` — `shopify-sync.job.ts:83-106`, N+1); `orders(first:50)` paged (`shopify-enhanced.service.ts:728`; `sync/shopify-sync.service.ts:457-484`). No `updated_at_min`/cursor persistence — full re-scan every run.
  - Woo: `GET /products?per_page&page` + `/products/{id}/variations` per variable product (`woocommerce.service.ts:305-320`), `GET /orders?…&status=any` (`:439-442`). `hasNextPage` heuristic = `response.length === perPage` (`:327,449`); `totalPages` is computed wrongly from one page (`:328,450`). No `modified_after`.
  - Etsy: `GET /shops/{id}/listings/active?limit&offset` (`etsy.service.ts:356`), `/receipts?…&was_paid=true` (`:486`).
- Etsy inventory job filters `product.etsyListingId` (`etsy-sync.job.ts:83-86`) — column does not exist on Product → the job throws on its first query.

---

## 7. Rate-limit handling

- `apps/api/src/services/channel-batch/rate-limit.ts` is **not a limiter**: it exports `RateLimitError` (`:24-34`), `isRateLimitError()` (structural/string sniff for 429, "rate limit", "throttled" — `:43-62`), `extractRetryAfterMs()` (reads `retryAfterMs`, `retryAfter`, `headers['retry-after']` — `:69-87`), and a backoff ladder 1s→30s (`:96-99`). Users: `services/bulk-action.service.ts:608` (lazy import inside the bulk-job item loop) and `services/marketing/ebay-ads-api.service.ts:23`. **No Shopify/Woo/Etsy client uses it.**
- `apps/api/src/utils/rate-limiter.ts` is an in-process token bucket (Shopify 2 rps / burst 40 — `:18-24`; Woo & Etsy 10 rps / 100 — `:26-40`). Buckets start at `tokens: 0` (`:66`) so the first call always waits. Used by:
  - `ShopifyEnhancedService` — **new instance per service instance** (`shopify-enhanced.service.ts:223`), and a new service is built per request/job (`routes/shopify.ts:53,110,156,195,243`; `sync/shopify-sync.service.ts:51`), so the bucket never accumulates across calls; it sleeps on the returned wait (`:238-241`).
  - `WooCommerceService` and `EtsyService` call the shared `rateLimiter.consumeToken()` but **discard the returned wait time** (`woocommerce.service.ts:218`, `etsy.service.ts:262`; `consumeToken` returns ms, `rate-limiter.ts` offsets 8-15) → the limiter is inert for Woo/Etsy.
- 429 / `Retry-After` / GraphQL cost handling:
  - `shopify-enhanced.service.ts:255-262` throws on any `!response.ok` with no 429 branch, no `Retry-After`, no `extensions.cost` / `THROTTLED` parse (grep `throttl|cost|429|Retry-After` in the file: zero except the generic error message).
  - `shopify.service.ts:139-144` same (text body only).
  - `woocommerce.service.ts:240-248`, `etsy.service.ts:282-290` same.
  - The **only** retry-on-429 path is the listing-wizard adapter: `shopify-publish.adapter.ts:90-132` retries 429/5xx with fixed delays (`SHOPIFY_RETRY_DELAYS_MS`), does not read `Retry-After` (sed 92-135 offsets 8-29).
  - `marketplace.service.ts:419-508` "batch with retry" does one blind retry after a fixed sleep for failed items regardless of cause.
  - `shopify-publish-gate.service.ts` adds a token-bucket + circuit breaker (3 failures/5 min → open 10 min — `:12,107-195`) but is wired only into `outbound-sync.service.ts:1856-1866` and dashboard display (`routes/dashboard.routes.ts:3921,3937`).

---

## 8. Data path (channel payload → PIM row)

### Shopify
- **Products (poll)**: `ShopifyEnhancedService.getAllProducts` GraphQL → `ShopifyProductSync` (`shopify-enhanced.service.ts:463-572`; mapping at offsets 74-99: `productId (gid)`, `sku` (parent SKU = common prefix of variant SKUs via `extractParentSku` `:341-357`), `title`, `handle`, `vendor`, `productType`, `isParent`, `variationTheme`, variants `{variantId, sku, title, price, compareAtPrice, inventory, selectedOptions}`, `images{id,src,alt}`) → `ShopifySyncService.syncProduct` (`sync/shopify-sync.service.ts:123-216`): `product.upsert` on `sku` writing `name, basePrice, totalStock, shopifyProductId, variationTheme, status` (`:142-159,185-202`); variants `productVariation` create/update on `sku` writing `price, stock, shopifyVariantId, variationAttributes` (`:233-253`); `variantChannelListing` upsert on `(variantId, channelId:'SHOPIFY')` writing `channelVariantId, channelSku, channelPrice, channelQuantity` (`:284-310`).
  - **Dropped**: description/bodyHtml, handle, vendor, productType, tags, status, images, compareAtPrice, barcode, weight, metafields, inventoryItem id (the GraphQL query doesn't even request bodyHtml/tags/barcode — `:463-520`). **No raw JSON stored** for products. `created vs updated` is inferred by `createdAt === updatedAt` (`:161-162,204-205`) — wrong after any later update.
  - The legacy `VariantChannelListing.channelId` path is used, not the canonical `ChannelListing` (`schema.prisma` ChannelListing at `:1423`); the inventory webhook looks up `ChannelListing.externalListingId contains inventory_item_id` first (`shopify-webhooks.ts:207-213`), which the poll never writes → falls back to the legacy path (`:215-228`).
- **Products (webhook)**: only `name` is updated (`shopify-webhooks.ts:72-78`); delete → `status: INACTIVE` (`:117-120`).
- **Orders (webhook)**: `handleOrderCreate` upserts `Order` on `(channel:'SHOPIFY', channelOrderId: String(order.id))` with `status` from `mapShopifyOrderStatus` (`:316-322`), `totalPrice`, `currencyCode`, `customerName`, `customerEmail`, `shippingAddress`, `purchaseDate`, and the **full raw payload in `shopifyMetadata`** (`:335-367`); items upserted on `(orderId, externalLineItemId=line_items[].id)` (`:377-401`); stock reserved at `IT-MAIN` (`:411-427`, hard-coded location code). `handleOrderUpdate`/`handleFulfillmentCreate` consume reservations and run the cancellation cascade (`:592-616`, `:875-895`).
- **Orders (poll)**: `syncOrder` (`sync/shopify-sync.service.ts:512-626`) writes `channelOrderId: shopifyOrder.orderId` which is the **GraphQL gid** (`shopify-enhanced.service.ts` offset 74 `orderId: order.id`), whereas the webhook writes the numeric REST id (`shopify-webhooks.ts:326`) → **the same Shopify order gets two `Order` rows** (`gid://shopify/Order/123` vs `123`). Poll also hard-codes `currencyCode:'EUR'` (`:543`) despite having `order.currencyCode` (`shopify-enhanced.service.ts` offset 82), sets `purchaseDate: new Date()` instead of `createdAt` (`:556`), stores **no** `shopifyMetadata`, and `deleteMany`s items on every run (`:565`), defeating the stable line-id design the webhook relies on (`shopify-webhooks.ts:369-376`).
- **Inventory (webhook)**: routed through `recordChannelStockEvent` with `rawPayload` preserved (`shopify-webhooks.ts:240-247,263-270`) — this is the only Shopify path with drift gating.

### WooCommerce
- Products: `WooCommerceService.mapProductToSync` (`woocommerce.service.ts:557-588`; keeps `id, sku, name, slug, type, parent_id, attributes-as-theme, variations{id,sku,price,regular,sale,stock,attributes,image}, images`; **drops** description, short_description, status, categories, tags, weight/dimensions, meta_data, manage_stock, tax) → `syncProduct` (`sync/woocommerce-sync.service.ts:118-224`) writes `name, basePrice, totalStock, woocommerceProductId, variationTheme, status` and variants with `woocommerceVariationId` (`:239-261`). Simple products take price/stock from `variations[0]` which is empty for simple products → `basePrice: 0, totalStock: 0` (`:186-187`). `productsCreated` is never incremented (`if (!parent.id)` `:156-160,208-212`). No `VariantChannelListing`/`ChannelListing` row is written. No raw JSON stored.
- Orders: `mapOrderToSync` (`woocommerce.service.ts:606-637`) → `syncOrder` (`sync/woocommerce-sync.service.ts:437-518`) writes `amazonOrderId: woo_${id}`, `totalAmount`, `buyerName`, `channelId` (`:443-450`) — **none of these columns exist**; `channel.create({credentials})` (`:586-592`) also invalid. **Every Woo order ingest throws.** The comment at `:552-563` claims O.1 fixed this by fixing the enum only.
- Webhook path: same invalid columns (§5.2).

### Etsy
- Listings: `mapListingToSync` (`etsy.service.ts:633-663`; keeps `listing_id, sku, title, description, state, price, quantity, currency, variations, images`) → `syncListing` writes `Product` with `etsyListingId` (`sync/etsy-sync.service.ts:142-176`) — **column absent on Product** → throws. Variants write `etsyListingId`/`etsySku` on `ProductVariation` (`:247-258`, valid columns). `Listing` rows keyed on legacy `Channel` (`:202-224`).
- Orders: `mapReceiptToSync` (`etsy.service.ts:668-702`) → `syncOrder` writes `amazonOrderId: ETSY-${id}`, `totalAmount`, `buyerName`, `channelId`, status `PAID` (`sync/etsy-sync.service.ts:473-499,519-522`) — invalid columns/enum → throws. Status pushback parses `order.amazonOrderId` (`:553,595`).
- No raw JSON stored anywhere for Etsy.

---

## 9. What the UI shows as "connected"

| Surface | Web call | API | Computed from |
|---|---|---|---|
| Settings → Channels card | `apps/web/src/app/settings/channels/ChannelsClient.tsx:160-161` → `GET /api/connections` | `apps/api/src/routes/connections.routes.ts:99-130` | `ChannelConnection` rows with `managedBy in (oauth, env)`; SHOPIFY/WOOCOMMERCE/ETSY have no rows → `pendingRow()` (`:81-96`) → UI "Coming soon" + disabled "Connector deferred" (`ChannelsClient.tsx:424-426,532-536`). **Independent of env config.** |
| Settings → Channels detail | `ChannelDetailClient.tsx:146-147` → `/api/settings/channels/:type/detail` | (not reachable for pending rows — link hidden `ChannelsClient.tsx:441`) | — |
| Publish-mode badge | `apps/web/src/components/PublishModeBadge.tsx:27` → `GET /api/listings/publish-readiness` | `routes/listings-syndication.routes.ts:2639-2668` | Shopify `configured` = `SHOPIFY_SHOP_NAME && (SHOPIFY_ACCESS_TOKEN || SHOPIFY_ADMIN_API_TOKEN)` env (`:2644`), `enabled`/`mode` from `NEXUS_ENABLE_SHOPIFY_PUBLISH` / `SHOPIFY_PUBLISH_MODE` (`shopify-publish-gate.service.ts:26-35`). No Woo/Etsy entry. |
| `/listings/shopify` page | `apps/web/src/app/listings/shopify/ShopifyListingsClient.tsx:43` → `GET /api/listings/path-a/overview?channel=SHOPIFY` | `listings-syndication.routes.ts:2209-2281` | counts of `ChannelListing` rows by `listingStatus`/`isPublished` (offsets 15-33). Says nothing about connectivity. |
| Shopify locations | `apps/web/src/app/fulfillment/stock/shopify-locations/ShopifyLocationsClient.tsx:85,100,115` | `routes/stock.routes.ts:2689,2703,2730` | `StockLocation` rows; discover builds `new ShopifyService()` from env (`:2710`) and logs "Shopify not configured" on failure (`:2713`). |
| `/marketplaces/status` (no web caller) | — | `routes/marketplaces.ts:43-62` | `marketplaceService.isMarketplaceAvailable` = service instance constructed from env (`marketplace.service.ts:385-400`). `getMarketplaceHealthStatus` never calls the channel — always `isAvailable:true` (`:517-548`). |

Bottom line: there is no surface that turns env-configured Shopify/Woo/Etsy credentials into a "Connected" state; the only truthful signal is the `PublishModeBadge` "configured" boolean for Shopify.

---

## 10. Duplicates / dead code

### Shopify clients (7 independent HTTP clients, all env-driven, all `2024-01`)
| File | Protocol | Importers (non-test) | Verdict |
|---|---|---|---|
| `services/marketplaces/shopify.service.ts` (`ShopifyService`, REST, env in ctor) | REST | `routes/stock.routes.ts:77`, `services/channel-delist.service.ts:46`, `services/images/shopify-image-publish.service.ts:21`, `services/marketplaces/marketplace.service.ts:8` | live; but `updateVariantInventory` uses `inventory_levels/adjust` with `available_adjustment: quantity` — an **adjust, not a set** (`:252-256`), and `getProductBySku` uses `?query=sku:` which REST `products.json` does not support (`:178`) |
| `services/marketplaces/shopify-enhanced.service.ts` (`ShopifyEnhancedService`, GraphQL) | GraphQL | `services/sync/shopify-sync.service.ts:7`, `jobs/tracking-pushback.job.ts:218`, `services/order-cancellation/channel-cancel.ts:254`, `services/refunds/refund-publisher.service.ts:556`, `routes/shopify.ts:281,321` | live |
| `services/marketplaces/shopify-sync.service.ts` (`syncProductToShopify`) | none — payload builder only (`:51-213`), makes no HTTP call | `workers/channel-sync.worker.ts:15` which itself logs "payload built but NOT sent" (`:331`) | **effectively dead** (builds a payload nobody sends) |
| `services/sync/shopify-sync.service.ts` (`ShopifySyncService`) | via Enhanced | `routes/shopify.ts:8`, `jobs/shopify-sync.job.ts:7`, `services/sync/unified-sync-orchestrator.ts:8` | live via manual trigger only |
| `services/outbound-sync.service.ts:1826-2110` inline client | REST | queue consumer | live — the only path behind the publish gate |
| `services/images/shopify-image-publish.service.ts:108-130`, `shopify-live-images.service.ts:94-101` | REST | `routes/product-images-crud.routes.ts:56` etc. | live |
| `services/listing-wizard/shopify-publish.adapter.ts` | REST | `services/listing-wizard/channel-publish.service.ts:24` | live; only client with 429 retry |
| `services/channel-batch/shopify-bulk-mutation.service.ts` | GraphQL bulk | `services/bulk-action.service.ts:2451-2476` (lazy) | live |
| `routes/shopify-setup.routes.ts:60-79` inline client | REST | — | live, no web caller |

### Woo / Etsy
- `services/marketplaces/woocommerce.service.ts` ← `sync/woocommerce-sync.service.ts:7`, `marketplace.service.ts:9`. `sync/woocommerce-sync.service.ts` ← `routes/woocommerce.ts:8`, `jobs/woocommerce-sync.job.ts:7`, `woocommerce-pushback/index.ts:94`, `unified-sync-orchestrator.ts:9`.
- `services/woocommerce-pushback/index.ts` ← `jobs/tracking-pushback.job.ts:47-50,182` (live; dry-run unless `NEXUS_ENABLE_WOO_SHIP_CONFIRM=true` — `:52-54`).
- `services/marketplaces/etsy.service.ts` ← `sync/etsy-sync.service.ts:11`, `marketplace.service.ts:10`. `sync/etsy-sync.service.ts` ← `routes/etsy.ts:8`, `jobs/etsy-sync.job.ts:7`, `unified-sync-orchestrator.ts:10`.

### Dead
- `services/sync/unified-sync-orchestrator.ts` — zero importers (only a comment mention in `routes/listings.ts:150`; not exported from `services/sync/index.ts:1-3`).
- `services/marketplaces/shopify-sync.service.ts` — see above (payload never sent).
- `utils/webhook.ts` `WebhookProcessor.getEventType/getExternalId` (`:126-162`) and `WebhookSignatureGenerator` (`:249-286`) — no callers outside the file (grep).
- `validateEtsySignature` (`utils/webhook.ts:71-92`) — never called.
- `ShopifyTokenResponse` interface (`shopify.service.ts:6-17`) — unused.
- `routes/marketplaces.ts:481-549`: `GET /marketplaces/health` and `POST /marketplaces/products/:productId/sync` are declared **inside the `sync-all` handler's per-listing loop** (inside `if (listing)` at `:472`). They are never registered at boot; at runtime the first listing hit would call `app.get` on a started instance and throw (Fastify forbids adding routes after ready) — unverified by execution.

### Routes with no web caller (grep `apps/web/src`, excluding i18n)
- All of `/shopify/*` (`routes/shopify.ts:40,82,135,182,222,267,307`), `/woocommerce/*` (`routes/woocommerce.ts:40,82,133,180,220,265`), `/etsy/*` (`routes/etsy.ts:40,82,126,174,214,259`), `/marketplaces/*` (`routes/marketplaces.ts:43,69,145,221,349,398`), `/api/admin/setup-shopify-webhooks`, `/api/admin/shopify-webhook-status`.
- Web hits only: `/api/stock/shopify-locations*` (`ShopifyLocationsClient.tsx:85,100,115`) and cron trigger `/api/sync-logs/cron/:job/trigger` (`SyncLogsHubClient.tsx:356`).

### Web files referencing the channels (225 files total; the load-bearing ones)
- `app/settings/channels/ChannelsClient.tsx`, `[type]/ChannelDetailClient.tsx` — connection cards (pending).
- `app/listings/shopify/ShopifyListingsClient.tsx`, `page.tsx` — listing counts overview.
- `app/fulfillment/stock/shopify-locations/ShopifyLocationsClient.tsx` — location mapping.
- `app/products/[id]/edit/tabs/images/shopify/ShopifyPanel.tsx`, `ImagesTab.tsx`, `CrossChannelPublishModal.tsx`, `ImageActionBar.tsx`, `MasterPanel.tsx` — image publish to Shopify (via `/api/products/:id/images`).
- `app/sync-logs/webhooks/WebhooksClient.tsx` — WebhookEvent viewer/replay.
- `components/PublishModeBadge.tsx` — publish-readiness badge.
- `app/catalog/[id]/edit/tabs/PlatformTab.tsx:43,256,795` — per-platform fields (Shopify `GLOBAL` marketplace, gid placeholder).
- `components/catalog/MarketplaceActionsDropdown.tsx` — 34 string hits, no Shopify-specific API call (grep of fetch paths: none).
- The remainder are labels, icons, enums, i18n (`lib/i18n/messages/{en,it}.json`).

---

## Security findings (ranked)

1. **Etsy webhook endpoints are fully unauthenticated and PUBLIC** — no signature check at all (`routes/etsy-webhooks.ts:317-625`; `PUBLIC` via `permissions-manifest.ts:61`). Anyone can POST to flip products `INACTIVE` (`:74-77`), overwrite `totalStock` (`:144-147`) or variant stock (`:117-120`), or set order status (`:264-272`). Order create/update currently throws on bad columns, but listing/inventory writes succeed.
2. **WooCommerce webhook signature check never fails** (`routes/woocommerce-webhooks.ts:297-306` and 5 siblings; object truthiness bug against `utils/webhook.ts:44-65`). Product deactivation and stock overwrite (`:72-75,110-121`) are reachable unauthenticated.
3. **Shopify HMAC is computed over re-serialised JSON, not the raw body** (`routes/shopify-webhooks.ts:929` et al.; no raw-body parser in `index.ts`). This is a correctness failure (legit deliveries rejected) rather than a bypass, but it pushes operators toward disabling verification. Comparison is non-constant-time (`utils/webhook.ts:25,52,79`).
4. **Un-signed test endpoint** `POST /webhooks/shopify/refunds/create-test` creates `Return` rows with no signature or dedupe, gated only by `NEXUS_ENV` not equal to `production` (`shopify-webhooks.ts:1402-1418`). If `NEXUS_ENV` is unset on any deployed environment, it is open.
5. **Idempotency keyed on entity id, not delivery id** (Shopify `:953…1358`; Woo `:310…650`) — blocks legitimate updates forever and, because a forged first event "claims" the id, a spoofed delivery (see 1-2) can permanently suppress real ones.
6. **Sync/write routes with side-effects have no auth in shadow RBAC mode**: `/shopify/sync/*`, `/shopify/fulfillments/create`, `/woocommerce/orders/:id/status`, `/etsy/orders/:id/status`, `/marketplaces/prices/update`, `/marketplaces/inventory/update`, `/marketplaces/sync-all` (`routes/shopify.ts:40-260`, `routes/woocommerce.ts:219-296`, `routes/etsy.ts:213-290`, `routes/marketplaces.ts:68-214,398`) are mapped (`permissions-manifest.ts:336-338`) but only enforced when `NEXUS_RBAC_MODE=enforce` (`rbac-hook.ts:29-30,74`). Prod value unverified.
7. **Etsy sends the OAuth access token as `x-api-key`** (`etsy.service.ts:271`) — leaks the bearer into a header Etsy logs as an app identifier; also functionally wrong.
8. **Secrets in env only, no rotation surface**; webhook secret must equal the app secret for HMAC, and `SHOPIFY_ADMIN_API_TOKEN` is an undocumented alias accepted only by `outbound-sync.service.ts:1841` and `listings-syndication.routes.ts:2644` — drift risk. No secrets are logged (grep of console/logger calls with token/secret args: zero) — good.
9. **Woo Basic-auth key pair sent to whatever `WOOCOMMERCE_STORE_URL` is**, no https enforcement (`woocommerce.service.ts:199,220-228`).
10. No hard-coded store URLs or tokens found in source (`grep myshopify.com` hits are all template strings; `.env.example` placeholders only).

---

## Dead / duplicated code

- **Dead**: `services/sync/unified-sync-orchestrator.ts` (no importers); `services/marketplaces/shopify-sync.service.ts` (payload builder whose output is never sent — `workers/channel-sync.worker.ts:326-340`); `utils/webhook.ts:71-92` `validateEtsySignature`, `:126-162` `getEventType/getExternalId`, `:249-286` `WebhookSignatureGenerator`; `shopify.service.ts:6-17` `ShopifyTokenResponse`; `routes/marketplaces.ts:481-549` (routes declared inside a request handler loop); the entire `routes/etsy-webhooks.ts` (no upstream producer exists); `ShopifyConfig.apiVersion` is ignored by 6 of 8 Shopify clients (§2).
- **Broken-at-runtime (not dead, but cannot succeed)**: Woo order sync + webhooks (`sync/woocommerce-sync.service.ts:439-450,580-593`; `routes/woocommerce-webhooks.ts:143-177,212-242`); Etsy listing/order sync + job (`sync/etsy-sync.service.ts:142-160,473-499`; `jobs/etsy-sync.job.ts:83-86`); Etsy API auth header (`etsy.service.ts:271`) and missing refresh (§3); Shopify inventory/order-update webhooks after the first delivery (§5.1).
- **Duplicated**: 7 Shopify HTTP clients (§10 table) with the API version pinned in 9 places; env reads duplicated in `utils/config.ts`, `marketplace.service.ts:62-121`, `unified-sync-orchestrator.ts:54,108`, `outbound-sync.service.ts:1840-1841`, `shopify-image-publish.service.ts:110-111`, `shopify-live-images.service.ts:94-95`, `shopify-publish.adapter.ts:157-158`, `shopify-bulk-mutation.service.ts:72-73`; two Shopify order writers with incompatible `channelOrderId` formats (webhook numeric `shopify-webhooks.ts:326` vs poll gid `sync/shopify-sync.service.ts:521,554`); order-status mapping implemented three times (`shopify-webhooks.ts:316-322`, `sync/shopify-sync.service.ts:528-533`, `woocommerce-webhooks.ts:222-230` vs `sync/woocommerce-sync.service.ts:564-575` with different outputs); Shopify webhook route body repeated 7× verbatim (`shopify-webhooks.ts:926-1395`) and Woo 6× (`woocommerce-webhooks.ts:287-689`).
