# Audit A4 — eBay channel (read-only, 2026-08-29)

Scope: connect flow, tokens, notifications, feeds, rate limits, data path, MAP, disconnect, health, dead code, security. Every claim carries `path:line`. "unverified" means I could not prove it from the repo (no live calls were made).

Paths are relative to `/Users/awais/nexus-commerce`. `api/` = `apps/api/src/`, `web/` = `apps/web/src/`.

---

## 1. Connect flow, step by step

| # | Step | Where |
|---|------|-------|
| 1 | Operator clicks Connect / Reconnect on the channel card or AccountsPanel | `web/app/settings/channels/ChannelsClient.tsx:579-580` (card) · `:383` (`onConnect={{ EBAY: handleConnectEbay }}`) · `:388` (`onReconnect={(a) => void handleConnectEbay(a.id)}`) |
| 2 | `window.open('', '_blank', 'width=1000,height=800')` is called **synchronously, before any await** (keeps the user gesture) | `ChannelsClient.tsx:188` |
| 3 | `POST /api/ebay/auth/initiate` with `{ redirectUri, adoptConnectionId }` — `redirectUri` is sent but **ignored** by the server | `ChannelsClient.tsx:193-201`; ignored at `api/routes/ebay-auth.ts:104-108` |
| 4 | Server mints a **signed** state `signOAuthState({ channel:'EBAY', adoptConnectionId })` | `ebay-auth.ts:112-115` → `api/lib/auth/oauth-state.ts:76-85` |
| 5 | `promptLogin` defaults to **true** unless body says `promptLogin:false` | `ebay-auth.ts:120` |
| 6 | Authorize URL built: `https://auth.ebay.com/oauth2/authorize?client_id&response_type=code&redirect_uri=<RuName>&scope&state&prompt=login` | `api/services/ebay-auth.service.ts:87-117`; host `:56`; `prompt:"login"` `:114` |
| 7 | Popup navigated to `authUrl`; **same-tab fallback** if popup blocked/closed: `window.location.href = data.authUrl` | `ChannelsClient.tsx:221-227` |
| 8 | eBay redirects to the RuName's configured URL → `/settings/channels/ebay-callback?code&state` (page) | `web/app/settings/channels/ebay-callback/page.tsx:22-28`, `EbayCallbackContent.tsx:16-17` |
| 9 | Callback page **first** `POST /api/ebay/auth/create-connection` → a placeholder `ChannelConnection` row `isActive:false` | `EbayCallbackContent.tsx:46-58`; `ebay-auth.ts:54-93` (create at `:68-73`) |
| 10 | Then `POST /api/ebay/auth/callback` `{ code, state, connectionId, redirectUri }` | `EbayCallbackContent.tsx:61-70` |
| 11 | Server: error → 400 `:161-170`; code required `:172-177`; state required `:179-184`; **`verifyOAuthState(state,'EBAY')` at `:194` — before the first DB read at `:221`** | `ebay-auth.ts:194-205` |
| 12 | `adoptConnectionId` is taken **from the signed payload only**, never the body | `ebay-auth.ts:206-211` |
| 13 | `connectionId` looked up (`findUnique`) — no check that it is the placeholder, inactive, or EBAY | `ebay-auth.ts:221-230` |
| 14 | Code exchange `POST https://api.ebay.com/identity/v1/oauth2/token` grant `authorization_code`, `redirect_uri=<RuName>`, Basic `client_id:client_secret` | `ebay-auth.service.ts:125-169` (body `:142-146`) |
| 15 | `getSellerInfo` → `GET /sell/account/v1/privilege` (returns literal "eBay seller (verified)") | `ebay-auth.ts:247`; `ebay-auth.service.ts:452-497` |
| 16 | `getSellerIdentity` → `GET https://apiz.ebay.com/commerce/identity/v1/user/` (host from `EBAY_IDENTITY_BASE`, default apiz) — returns `null` on any failure | `ebay-auth.ts:253`; `ebay-auth.service.ts:515-551` |
| 17 | **Re-consent**: `findAccountByExternalId('EBAY', userId, connectionId)` → `saveTokens(already.id)` and delete placeholder | `ebay-auth.ts:266-300`; resolver `api/services/connection-resolver.service.ts:309-327` |
| 18 | **Unmatched identity guard** `EBAY_IDENTITY_UNMATCHED` (409) when an active row has `externalAccountId=null` and no adopt intent; placeholder deleted | `ebay-auth.ts:307-323`; `countUnidentifiedAccounts` `connection-resolver.service.ts:331-335` |
| 19 | **Adopt**: target must exist and be EBAY → `saveTokens(target.id)`, placeholder deleted | `ebay-auth.ts:328-349` |
| 20 | **No identity + an unidentified account exists** → `EBAY_IDENTITY_UNAVAILABLE` (409) | `ebay-auth.ts:350-368` |
| 21 | New account: `saveTokens(connectionId, …)` → row becomes `isActive:true`, `managedBy:'oauth'` | `ebay-auth.ts:371-377`; `ebay-auth.service.ts:323-375` |
| 22 | Page posts `{type:'nexus:channel-connected', channel:'EBAY', sellerName}` to `window.opener` **with explicit origin** (`window.location.origin`), then `window.close()`; fallback `router.push('/settings/channels')` when no opener | `EbayCallbackContent.tsx:91-115` |
| 23 | Opener listens, **checks `e.origin`**, bumps `accountsReload`, re-fetches `/api/connections` | `ChannelsClient.tsx:124-145` |

**Exact scope array** (`ebay-auth.service.ts:91-112`):
```
"https://api.ebay.com/oauth/api_scope",
"https://api.ebay.com/oauth/api_scope/sell.account",
"https://api.ebay.com/oauth/api_scope/sell.inventory",
"https://api.ebay.com/oauth/api_scope/sell.fulfillment",
"https://api.ebay.com/oauth/api_scope/sell.marketing",
"https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
```

**redirect_uri / RuName**: from env `EBAY_RUNAME` (`ebay-auth.service.ts:42`), used in both authorize (`:90`) and token exchange (`:145`). Not hard-coded. `EBAY_ENVIRONMENT=SANDBOX` switches hosts (`:43,52-58`).

**State guards** (`api/lib/auth/oauth-state.ts`):
- Format `base64url(payload).base64url(HMAC-SHA256)` `:23,83-84`; key = HMAC(`NEXUS_CREDENTIAL_ENC_KEY || EBAY_CLIENT_SECRET`, "nexus.oauth.state.v1"), fails closed if both missing `:59-68`.
- Constant-time compare `:110-113`; channel check `:122`; TTL 10 min `:41,123-125`.
- **No one-time use**: the nonce `n` (`:79`) is never stored or checked; the file itself says replay is "bounded by eBay itself" (`:34-36`). **Not bound to a user session** either — the state carries no user id.
- On a rejected state the placeholder row created at step 9 is **not deleted** (`ebay-auth.ts:195-205` returns before any cleanup) → orphan inactive rows accumulate (accounts.routes.ts:188-190 comment: "11 rows exist, 9 of them revoked eBay grants").

**Response-shape hazard**: the callback page reads `result.connection.sellerName` (`EbayCallbackContent.tsx:79`); all three 2xx branches return that shape (`ebay-auth.ts:288-299, 340-348, 384-394`).

---

## 2. Token storage

Columns (`packages/database/prisma/schema.prisma`, model starts `:5982`):
- Generic: `accessToken` `:6002`, `refreshToken` `:6003`, `tokenExpiresAt` `:6004`, `displayName` `:6005`.
- Deprecated eBay-specific: `ebayAccessToken` `:6011`, `ebayRefreshToken` `:6012`, `ebayTokenExpiresAt` `:6013`, `ebayDevId/ebayAppId` `:6014-6015`, `ebaySignInName/ebayStoreName/ebayStoreFrontUrl` `:6016-6018`. Schema comment: "Kept for one release" `:6007-6009`.
- Identity: `externalAccountId` `:6040`; partial unique index `ChannelConnection_active_account_key` is raw SQL only `:6059-6064`.

**Plaintext.** `grep -n -i 'encrypt|decrypt|cipher' ebay-auth.service.ts ebay-account.service.ts ebay-auth.ts` → no matches. An AES-256-GCM helper exists (`api/lib/crypto.ts:1-8`, whose header says "ChannelConnection tokens later") but is used only by `api/services/sendcloud/index.ts` (grep).

**Dual-write still on** for every write:
- `saveTokens` writes generic `:341-343` and legacy `:352-357` (`ebay-auth.service.ts`).
- refresh path in `getValidToken` writes both `:279-292`.
- `revokeTokens` nulls both `:417-430`.

**Legacy columns still read**:
- `getValidToken` reads generic-first with legacy fallback `ebay-auth.service.ts:248-250`; `revokeTokens` `:387`.
- `GET /api/ebay/auth/connections` and `/connection/:id` read **legacy only** (`ebaySignInName`, `ebayStoreName`, `ebayStoreFrontUrl`, `ebayTokenExpiresAt`) `ebay-auth.ts:425-428, 473-476`.
- `GET /api/ebay/diagnostics` gates the token check on **legacy only** `conn.ebayAccessToken && conn.ebayRefreshToken` `api/routes/ebay.routes.ts:501` — a row that (in some future) holds only generic columns would report `tokenOk:false`.
- `connections.routes.ts:66-70` and `accounts.routes.ts:100-104` fallback; `ebay-notification.routes.ts:120-123,132-133`; token-refresh job `:48,75,85-86`.

---

## 3. Refresh (`api/jobs/ebay-token-refresh.job.ts`)

- **Cadence**: `NEXUS_EBAY_TOKEN_REFRESH_SCHEDULE ?? '*/30 * * * *'` `:134`; default-ON in `api/index.ts:1046-1047` (opt-out `NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON=0`). Also triggerable via cron-registry key `ebay-token-refresh` (`api/jobs/cron-registry.ts:170`) and `POST /api/admin/refresh-ebay-tokens` (`ebay-notification.routes.ts:154-191`).
- **Margin**: `getValidToken` refreshes when `now >= expiresAt - 5 min` `ebay-auth.service.ts:257-263`.
- **Scope**: `listActiveConnections('EBAY')` filtered `managedBy==='oauth' && (refreshToken||ebayRefreshToken)` `:47-48` → **all active accounts (MAP)**, sequential loop `:67`.
- **Lock**: none. Only an in-process "already started" guard against double scheduling `:125-128`. `getValidToken` has no advisory lock, no `updatedAt` CAS, no in-flight promise map — two concurrent callers (e.g. the 30-min sweep and the 5-min orders poll, or two API replicas) can both call `/identity/v1/oauth2/token` for the same refresh token. eBay returns the same refresh token so it is not destructive, but it is unguarded (unverified whether eBay rotates).
- **Refresh-token expiry (18 months)**: **not tracked**. `EbayTokenResponse` has no `refresh_token_expires_in` field `ebay-auth.service.ts:8-13`; nothing stores a refresh-token expiry; no pre-emptive re-consent prompt. The job header only mentions it in prose `:4`.
- **When refresh fails**: `getValidToken` catches, writes `lastSyncStatus:'FAILED'`, `lastSyncError:<message>` and rethrows `:299-317`; the job counts `failed++` and logs `:97-106`. `isActive` stays `true`; no notification/email; writes are **not** paused — every subsequent job just fails per-call. Health goes red via `deriveHealth` (`accounts.routes.ts:128-143`).
- **Side effect**: a *successful token refresh* writes `lastSyncAt: now, lastSyncStatus:'SUCCESS', lastSyncError:null` `ebay-auth.service.ts:288-290` — so the health signal is refreshed by a token call, not by a data call (see §10).
- `POST /api/ebay/auth/refresh` returns the first 20 chars of the access token to the client `ebay-auth.ts:555`.

---

## 4. Multi-account (MAP) as applied to eBay

Enumerate-all (`listActiveConnections`): orders poll `ebay-orders-sync.job.ts:44`; token refresh `:47`; item-status reconcile `ebay-item-status-reconcile.job.ts:42`; returns poll `ebay-returns/ingest.service.ts:261`; webhook fan-out `ebay-notification.routes.ts:479,522`; admin token-status `:117,164`; accounts disconnect siblings `accounts.routes.ts:365`.

Primary-only (`resolveConnection/tryResolveConnection({channel:'EBAY', primary:true})`): feed poll `ebay-feed-poll.job.ts:147`; status reconcile `ebay-status-reconcile.job.ts:92`; Trading read-back `ebay-inventory-readback.service.ts:328`; financial sync `ebay-financial-events.service.ts:153-155` (comment admits "MAP.7: financial events are PER ACCOUNT"); label guard `ebay-label-guard.service.ts:80`; notification setup `ebay-notification.routes.ts:42`; pull-listing `ebay.routes.ts:362`; policies `ebay.routes.ts:631`; eBay import `ebay-import.service.ts:18,91`.

Derived scope: pushback `ebay-pushback/index.ts:235` (`resolveConnection({orderId})`); live images `images/ebay-live-images.service.ts:173` (`{itemId}`). Derived scopes fall back to the primary when the row has no `channelConnectionId` (`connection-resolver.service.ts:204-210, 195-199`).

**Gap — eBay orders are never attributed**: `processOrder(order, _connectionId)` ignores its connection id `ebay-orders.service.ts:326`, and `grep channelConnectionId ebay-orders.service.ts` is empty; `orderData` `:366-400` has no `channelConnectionId`. So `Order.channelConnectionId` (`schema.prisma`, Order model `channelConnectionId String?`) stays NULL for eBay → shipping pushback for a second account's order resolves to the **primary** account's token (`connection-resolver.service.ts:204-210`), i.e. the wrong seller.

**No connection at all**: the Inventory-lane read-back uses the legacy `EbayService` with an **application** token (`ebay-inventory-readback.service.ts:117,142` → `marketplaces/ebay.service.ts:46-100`, `grant_type: client_credentials`, scope `api_scope` only `:78-79`). That token is not tied to any seller; see §11.

**The connections=2 guard**: `EBAY_IDENTITY_UNMATCHED` `ebay-auth.ts:307-323`, `EBAY_IDENTITY_UNAVAILABLE` `:350-368`, `findAccountByExternalId` / `countUnidentifiedAccounts` in the resolver `:309-335`; plus `chooseConnection` throws `AmbiguousConnectionError` when >1 active and no single primary `connection-resolver.service.ts:103-132`.

---

## 5. Notifications (`api/routes/ebay-notification.routes.ts`, registered with prefix `/api` at `api/index.ts:776`)

**Endpoints**: `GET /api/webhooks/ebay-notification` (challenge) `:326-342`; `POST /api/webhooks/ebay-notification` `:345-590`; admin `GET /api/admin/ebay-token-status` `:115`, `POST /api/admin/refresh-ebay-tokens` `:154`, `POST /api/admin/setup-ebay-notifications` `:199`, `GET /api/admin/ebay-notification-status` `:292`. `/api/webhooks/*` is PUBLIC (`api/lib/auth/permissions-manifest.ts:62`); none of the four admin routes has a web caller (grep, §11).

**Topics handled**: `ItemRevised` / `marketplace.inventory_item.updated` → `recordChannelStockEvent` `:418-464`; legacy Trading sale topics `AuctionCheckoutComplete|FixedPriceTransaction|ItemSold` `:105-109,473-507` → 30-min ranged order sync per account; `marketplace.order.created` `:513-546` (same); `marketplace.order.cancelled` `:547-583`; everything else logged "unhandled" `:585`. **`MARKETPLACE_ACCOUNT_DELETION` is not handled** (`grep -i account_deletion apps/api/src` empty).

**Challenge-response**: `SHA256(challenge_code + EBAY_NOTIFICATION_VERIFICATION_TOKEN + EBAY_NOTIFICATION_ENDPOINT_URL)` hex, returned as `{challengeResponse}` `:332-341`. This is eBay's documented scheme. Both env values default to `''` `:332-333` — with an empty token/endpoint the hash is still computed and returned (no refusal).

**Signature verification of pushes — wrong scheme**: `verifyEbaySignature` computes `HMAC-SHA256(rawBody, verificationToken)` base64 and compares it to `x-ebay-signature` `:86-101,352-357`. eBay's Commerce Notification API signs with an **ECDSA key pair**; `x-ebay-signature` is a base64 JSON envelope `{kid, signature, …}` and must be verified against the public key fetched from `GET /commerce/notification/v1/public_key/{kid}`. There is no `getPublicKey`/`public_key`/ECDSA code anywhere (`grep -rn -i 'public_key|getPublicKey|ecdsa' apps/api/src` → only the two comment/header lines in this file). Consequences:
- If `EBAY_NOTIFICATION_VERIFICATION_TOKEN` is set, **every genuine eBay push fails verification** and is dropped with 204 `:354-357` (logged "invalid signature").
- If it is unset, verification is **skipped entirely** `:351-352` and any unauthenticated POST is processed.
- Whether the token is set on prod: unverified (env only).
- **No raw body**: `config: { rawBody: true }` `:346` has no effect because no `fastify-raw-body` (or `addContentTypeParser`) is registered — `grep -rn 'fastify-raw-body|rawBody' apps/api/src/index.ts apps/api/package.json` empty; `grep addContentTypeParser apps/api/src/index.ts` empty. `(req as any).rawBody` is therefore `undefined` and the code signs `JSON.stringify(req.body)` `:349`, which would not match a byte-exact signature even with the right algorithm.
- **Trading (SOAP/XML) Platform Notifications** cannot reach the JSON branches: Fastify has no `text/xml` parser (grep above) so such a POST is rejected before the handler, and the handler reads `payload.metadata.topic` `:361` (JSON envelope only). The `LEGACY_SALE_TOPICS` branch `:473` is therefore reachable only by a JSON body carrying those names — unverified whether eBay ever sends that.

**Persistence/idempotency**: `webhookEvent.upsert` on `(channel:'EBAY', externalId)` `:386-398` — written **before** the async processing, and with `isProcessed:true, processedAt:now` at insert `:393-394` (a receipt log, not a work queue). `externalId = notificationId || \`${topic}:${orderId}:${Date.now()}\`` `:379` — the fallback includes `Date.now()`, so a retry without `notificationId` is **not** deduped. Persist failure is swallowed `:399-407`. Processing is fire-and-forget (`void (async…)`), always 204 `:463,506,589`.

**Registration on eBay's side**:
- **No** Commerce Notification API destination/subscription code: `grep -rn 'commerce/notification' apps/api/src docs` → empty. REST topics (`marketplace.order.*`, `marketplace.inventory_item.updated`) are handled but never subscribed to from code; if they arrive it is because someone configured them in the developer console (unverified).
- Trading `SetNotificationPreferences` exists: `POST /api/admin/setup-ebay-notifications` `:199-288` enables `AuctionCheckoutComplete, FixedPriceTransaction, ItemSold, ItemMarkedAsShipped` `:235-240`, site hard-coded `101` `:68`, credentials `EBAY_CLIENT_ID/EBAY_CLIENT_SECRET/EBAY_DEV_ID` `:33,65-67`, OAuth token put in `<eBayAuthToken>` `:252` (the Auth'n'Auth slot, not the `X-EBAY-API-IAF-TOKEN` header that `ebay-trading-api.service.ts:257` uses — unverified whether eBay accepts a user OAuth token there). `ApplicationDeliveryPreferences` sets no `<ApplicationURL>` `:254-257`, so the delivery URL is assumed to be configured in the dev console (unverified). Header comments record eBay rejecting `ItemRevised` etc. `:215-234`.

---

## 6. Polling jobs (defaults; all schedules env-overridable)

| Job | Default cadence | Gate | eBay endpoint | Scope / window / dedupe |
|---|---|---|---|---|
| `ebay-orders-sync.job.ts` | `*/5 * * * *` `:136` | `NEXUS_ENABLE_EBAY_ORDERS_CRON=1` `index.ts:1154` (default **off**) | `GET /sell/fulfillment/v1/order?filter=creationdate:[<7d ago>]&limit=200` `ebay-orders.service.ts:150-158` | all accounts `:44`; **no pagination** on the rolling fetch (`:158`, single call; range fetch paginates `:206-262`); filter lacks the `..` range terminator (`:158` vs `:215`); dedupe = `findUnique(channel_channelOrderId)` then update/create `:409-455`; terminal-status guard `:426-438` |
| `ebay-token-refresh.job.ts` | `*/30 * * * *` `:134` | default on `index.ts:1046` | `POST /identity/v1/oauth2/token` (refresh) | all oauth accounts `:47-48` |
| `ebay-feed-poll.job.ts` | `setTimeout` every 120 s `:31,271` | unconditional `index.ts:1074` | `GET /sell/feed/v1/task/{taskId}` `ebay-feed.service.ts:225`; result download `:276` | primary account only `:147`; `EbayPushJob` rows SUBMITTED ≤24 h `:33,120-122`, ≤10 per tick `:32` |
| `ebay-returns-poll.job.ts` | `*/5 * * * *` `:53` | `NEXUS_ENABLE_EBAY_RETURNS_POLL=1` `:49` (default off) | `GET /post-order/v2/return/search?return_state=OPEN&limit=N&offset=0` `ebay-returns/ingest.service.ts:282` | all accounts `:261`; **first page only** (offset fixed 0); dedupe by `channelReturnId` `:115-120` |
| `ebay-status-reconcile.job.ts` | `0 2 * * *` `:278` | `NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON=1` `:73` (default off) | `GET /sell/inventory/v1/offer?sku=` `:185` | primary `:92`; batches of 20 / 500 ms `:39-40,258` |
| `ebay-item-status-reconcile.job.ts` | `30 2 * * *` `:119` | default on, `NEXUS_EBAY_ITEM_RECONCILE=0` opts out `:114` | Trading `GetItem` via `getItemListingStatus` `:75` | all accounts `:42`; cap 100 `:45` |
| `ebay-readback.job.ts` | `*/30 * * * *` `:30` | default on, `NEXUS_EBAY_READBACK=0` `:21` | Inventory lane: `GET /sell/inventory/v1/inventory_item/{sku}` via **legacy `EbayService` app token** `ebay-inventory-readback.service.ts:117,142` → `marketplaces/ebay.service.ts:114-118`; Trading lane: `GetItem` quantities `:393` | Inventory lane: no account; Trading lane: primary `:328`; caps 200/50 `:31-32`; 300 ms spacing `:33` |
| `ebay-label-guard.job.ts` | `15 */6 * * *` `:45` | `NEXUS_EBAY_REAL_API==='true'` and enable flag `:38-39` | `GetItem` + `ReviseFixedPriceItem` `ebay-label-guard.service.ts:168,177` (**writes**) | primary `:80` |
| `ebay-image-readback.job.ts` | `45 */6 * * *` `:40` | `NEXUS_EBAY_REAL_API` + flag `:33-34` | `GetItem` `images/ebay-live-images.service.ts:59-70,183` | per-item derived `:173` |
| `ebay-financial-sync.job.ts` | `30 3 * * *` `:30` | `NEXUS_ENABLE_EBAY_FINANCIAL_CRON=1` `index.ts:1202` | `GET /sell/finances/v1/transaction` `ebay-financial-events.service.ts:57` | primary `:155`; "yesterday" computed in **server local time** midnight `:189-191`, not UTC |
| `ebay-ads-sync.job.ts` | 8 schedules `:101-111` (entities hourly, discovery `25 */4`, reports `40 2`, poll `*/3`, economics `15 5`, evaluate `45 5`, anomaly `50 *`, digest `30 4 * * 1`) | `NEXUS_ENABLE_EBAY_ADS_SYNC` (prod default on) `:24-27` | Marketing API via `marketing/ebay-ads-api.service.ts` | out of scope beyond rate limiting (§7) |

Registry-triggerable keys (`cron-registry.ts:154-170,352,359`): `ebay-financial-sync`, eight `ebay-ads-*`, `ebay-orders-sync`, `ebay-token-refresh`, `ebay-label-guard`, `ebay-image-readback`. **Not** in the registry: feed-poll, returns-poll, status-reconcile, item-status-reconcile, readback.

---

## 7. Rate limits

- **No** code reads eBay rate-limit headers or the Developer Analytics `rate_limit` API: `grep -rn 'X-EBAY-C-|rate_limit|developer/analytics|Retry-After'` over all eBay code returns only `X-EBAY-C-MARKETPLACE-ID` request headers and the ads client.
- Per-app daily limits are only mentioned in comments (`ebay-parallel-batch.service.ts:12-15`, `ebay-orders.service.ts:261`).
- **429 handling that exists**:
  - `channel-batch/ebay-parallel-batch.service.ts`: concurrency default 8, hard cap 32 `:63,215`; 429 → backoff `1s·2^(attempt-1)` up to 3 retries `:148-157`; 5xx → `500ms·2^(n-1)` `:160-164`; other 4xx fail fast `:165`; never throws per SKU `:112-113`. Uses `getValidToken` `:240-241`.
  - `channel-batch/rate-limit.ts`: `RateLimitError`, string/status detector `:43-62`, `Retry-After` extraction `:69-87`, ladder 1→30 s `:96-99`. Consumers: `marketing/ebay-ads-api.service.ts:128-131` (honours `retry-after`, 4 attempts, retries 429+5xx `:113-133`) and a Redis quota ledger with a 9000/day read budget `:62` (`NEXUS_EBAY_ADS_DAILY_CALL_BUDGET`).
  - Pacing only: status-reconcile 20/500 ms `ebay-status-reconcile.job.ts:39-40`; range order fetch 250 ms/page `ebay-orders.service.ts:262`; Trading read-back 300 ms `ebay-inventory-readback.service.ts:33`.
- **No retry / no 429 handling** in: token exchange & refresh (`ebay-auth.service.ts:150-158,199-207` throw), rolling orders fetch (`:176-184`), `callTradingApi` (`ebay-trading-api.service.ts:263` throws on any `!res.ok`, no status distinction), `ebay-account.service.ts:156-163` (returns `[]` on any error), `ebay-feed.service.ts`, `ebay-import.service.ts`, `ebay-sync.service.ts`.

---

## 8. Data path

### Order (Fulfillment API → `Order`/`OrderItem`)
- Fetch: `ebay-orders.service.ts:149-196` (rolling) / `:206-262` (ranged). Mapping: `processOrder` `:326-403`.
- Kept: `orderId`→`channelOrderId` `:370`; `pricingSummary.total`→`totalPrice` `:327,372`; currency `:373-374`; `buyer.username`→`customerName` `:375`; `buyer.email` or shipTo email or synthesised `@buyer.ebay.invalid` `:358-362`; `shipTo` (fullName + contactAddress) → `shippingAddress` Json `:355-357`; `creationDate`→`purchaseDate` `:379`; status derived from `cancelStatus.cancelState` / `orderPaymentStatus` `:346-352`; `fulfillmentMethod:'MFN'` `:381`; `fulfillmentLatency:1` + `shipByDate=+24h` hard-coded `:387-388`; `marketplace:'EBAY-GLOBAL'` hard-coded `:369`.
- **Raw payload not preserved**: only a 5-field `ebayMetadata` `:393-399`; items keep `lineItemId, legacyItemId, title` (`:606-620` region, grep lines 15-19 rel.).
- **Dropped concrete fields** (present on live Fulfillment payloads, absent from the mapping): `legacyOrderId`, `salesRecordReference`, `sellerId`, `pricingSummary.priceSubtotal/deliveryCost/tax/adjustment/priceDiscount`, `paymentSummary.payments[]` (method, paymentDate, paymentReferenceId) and `refunds[]`, `buyer.taxAddress`, `fulfillmentStartInstructions[].shippingStep.shippingServiceCode` and `ebaySupportedFulfillment`, `program.authenticityVerification` / eBay International Shipping, `lineItems[].listingMarketplaceId` and `purchaseMarketplaceId` (hence the `'EBAY-GLOBAL'` placeholder), `lineItems[].lineItemFulfillmentStatus`, `deliveryCost`, `appliedPromotions`, `ebayCollectAndRemitTaxes`, `properties.buyerProtection`, `fulfillmentHrefs`. `taxes` and `discounts` are summed only `:121-127` (rel. to 470).
- No `channelConnectionId` written (§4).

### Listing → PIM
Two importers, both Inventory API, neither preserves raw:
- `services/ebay-sync.service.ts` (`POST /api/sync/ebay/inventory`, `ebay.routes.ts:27-70`): calls `GET https://api.ebay.com/sell/inventory/v1/inventory` `:104` and parses `data.inventories[]` `:134-146`. That path and shape are not the Inventory API's (`/sell/inventory/v1/inventory_item` → `inventoryItems[]`). Expected result: 0 listings or 404 on every run (unverified live). Auto-match `:161`; writes `VariantChannelListing` with `externalListingId, externalSku, channelPrice, quantity, quantitySold, listingStatus:'ACTIVE'` `:433-447`; `listingUrl` fabricated from the SKU `:437`.
- `services/ebay-import.service.ts` (`importEbayCatalog`, caller `catalog.routes.ts`): correct `GET /sell/inventory/v1/inventory_item?limit&offset` `:50`, user token `:91`. Product mapping `:100-140`: keeps title, brand/manufacturer/material/color/size aspects (4 synonyms each), ean/upc, package weight/dims; **drops** `product.description`, `product.imageUrls`, `condition`, `conditionDescription`, `availability.shipToLocationAvailability.quantity`, `mpn`, `isbn`, `epid`, `locale`, all other aspects; `productType:'APPAREL'` hard-coded `:125`; `basePrice: 0` on create `:150`.
- Trading `GetItem` is used only for read-back/status/images (§6), not for creating PIM rows.

### Inventory API vs Trading API split
- Decision `services/ebay-push-mode.ts:36-65`: `feed` (Sell Feed API `INVENTORY_TASK`, `ebay-feed.service.ts:147-290`) only for a unique-SKU, non-shared push above 50 rows; any shared/duplicate SKU forces `api` mode. Rationale in header `:5-16` (feed cannot express shared-SKU listings).
- Within `api` mode: **shared-SKU listings go through the Trading API** (`AddFixedPriceItem`, `ReviseInventoryStatus`, `EndFixedPriceItem` — `ebay-shared-listing-push.service.ts:258,289`; `ebay-trading-api.service.ts:285-302,403-409,442`); **unique-SKU rows go through the Inventory API** (`inventory_item`, `inventory_item_group`, `offer` — `ebay-variation-push.service.ts` 15 `offer` + 3 `inventory_item_group` refs; `ebay-flat-file.routes.ts` 12 `offer` refs, 12 `getValidToken` calls). Both push lanes use the user OAuth token. The Trading lane gates on `NEXUS_EBAY_REAL_API==='true'` and throws in production when unset `ebay-trading-api.service.ts:235-246`.

---

## 9. Disconnect / revoke

Two different disconnects exist:
1. **Card "Disconnect"** → `POST /api/ebay/auth/revoke` (`ChannelsClient.tsx:235-260,565-569`) → `revokeTokens` `ebay-auth.service.ts:380-437`: calls `POST /identity/v1/oauth2/token/revoke` with `token=<accessToken>` `:395-405` (non-200 only warns `:407-410`), then nulls all six token columns, `isActive:false`, and sets `lastSyncStatus:'SUCCESS'` `:417-430`.
2. **AccountsPanel "Disconnect"** → `POST /api/accounts/:id/disconnect` (`AccountsPanel.tsx:176-202`) → `accounts.routes.ts:358-389`: **local deactivation only** (`isActive:false, isPrimary:false, lastSyncStatus:'FAILED'` `:380-383`); **tokens are left in the row** and **eBay is not called**. Refuses to disconnect the primary while siblings exist `:368-376`.

The UI copy says "Disconnecting revokes the token" (`ChannelsClient.tsx:603`) — true for path 1 only.

Marketplace account deletion endpoint: not implemented (§5).

---

## 10. "Connected" state and health

- Card: `isConnected = !!connection?.isActive` `ChannelsClient.tsx:397`, from `GET /api/connections` `:161` → `api/routes/connections.routes.ts:100-134` rows ordered `isActive desc, updatedAt desc` `:109`; fields `isActive :64`, `sellerName = displayName ?? ebaySignInName :66`, `tokenExpiresAt` with legacy fallback `:69-70`, `lastSync*` `:71-73`.
- AccountsPanel: `GET /api/accounts` `AccountsPanel.tsx:108` → `accounts.routes.ts:186-232`, active `oauth|env` rows `:192`; `health` = `deriveHealth` **from `lastSyncStatus` only** `:128-143` (`SUCCESS→ok`, `PARTIAL→warn`, `FAILED→error`, `null→unknown`); explicitly not from `tokenExpiresAt` `:20-24`.
- **There is no heartbeat call.** `lastSyncAt/lastSyncStatus` are written by: `saveTokens` `ebay-auth.service.ts:362-364`; **every successful token refresh** `:288-290`; every refresh failure `:306-311`; the manual sync routes `ebay-orders.routes.ts:75-82`, `ebay.routes.ts:65-70`; account disconnect `accounts.routes.ts:383`. The 5-min orders cron and every other job do **not** write them on success (grep `channelConnection.update` in `ebay-orders-sync.job.ts` → none). So a green dot means "the last token refresh (≤2 h ago) worked", not "a data call succeeded".
- "Test" button → `GET /api/ebay/auth/test?connectionId` → `getValidToken` + `/sell/account/v1/privilege` `ebay-auth.ts:572-614`; writes nothing.
- Per-call truth exists in `OutboundApiCallLog` (`outbound-api-call-log.service.ts:260`) but is not surfaced on the card (unverified beyond grep of the two web files).
- `ChannelDetailClient.tsx:395` tells the operator "The OAuth callback writes [scopes] to connectionMetadata.scopes when granted — … eBay sign-in … expose this". **No writer exists**: `saveTokens` writes no `connectionMetadata` `ebay-auth.service.ts:341-365`; the only `scopes` reference is a reader `connections.routes.ts:171-172`. The message is false for eBay.

---

## 11. Dead / duplicated code

- **`services/marketplaces/ebay.service.ts` (legacy `EbayService`) vs `services/ebay-auth.service.ts` + per-feature services.** The legacy class mints its own **application** token (`grant_type: client_credentials`, scope `https://api.ebay.com/oauth/api_scope` only) from `EBAY_APP_ID/EBAY_CERT_ID` `:46-100` and then calls seller-scoped Inventory API endpoints (`inventory_item`, `offer`, `location`, `publish`) `:114-118,163-165,268-273,499,576-578,799`. The Inventory API requires a **user** token with `sell.inventory`; an application token is expected to be refused (unverified live — an `OutboundApiCallLog` query for `operation='clientCredentialsToken'`/`getPublishedInventoryItem` would settle it). Live callers of this class: `ebay-inventory-readback.service.ts:117` (the default-ON 30-min Inventory read-back lane), `ebay-publish.service.ts:2,28` → `listings.ts:287-288` (`POST /listings/:draftId/publish` `:269-270`, **no web caller**), `workers/bulk-list.worker.ts` (started `index.ts:428`, enqueued from `listings.ts:502,545` and `bulk-list.routes.ts:2` — no `register(bulkListRoutes` in `index.ts`, unverified elsewhere), `ebay-flat-file-pull-preview.service.ts`.
- **`services/marketplaces/ebay-sync.service.ts`** (`syncProductToEbay`, builds a payload only `:22-38`; imported by `workers/channel-sync.worker.ts`) vs **`services/ebay-sync.service.ts`** (`ebaySyncService.syncEbayInventory`, wrong endpoint `:104`; imported only by `ebay.routes.ts:13` for `POST /api/sync/ebay/inventory`, which has **no web caller**). Same file name, unrelated jobs.
- **`routes/ebay-phase3.routes.ts`**: listing-gap analysis + bulk schedule (`/api/ebay/phase3/{gap,progress,schedule}`) `:20-97`, backed by `ebay-listing-gap.service.ts`. **Alive** — called from `web/app/listings/ebay/gaps/EbayGapsLoader.tsx` and `EbayGapsClient.tsx`.
- **Two Trading-API callers**: `ebay-notification.routes.ts:48-84` (hard-coded site 101, `EBAY_CLIENT_ID/SECRET` as APP/CERT, `EBAY_ENVIRONMENT==='sandbox'` lowercase `:55`) vs `ebay-trading-api.service.ts:230-282` (`EBAY_APP_ID/EBAY_CERT_ID`, IAF header, per-market site, `NEXUS_EBAY_REAL_API` gate). `ebay-auth.service.ts:43` compares `EBAY_ENVIRONMENT` to uppercase `"SANDBOX"`; the notification file to lowercase `'sandbox'` — the two cannot both be satisfied by one value.
- **Two credential conventions**: `EBAY_CLIENT_ID/EBAY_CLIENT_SECRET` (auth, notification) vs `EBAY_APP_ID/EBAY_CERT_ID` (trading, legacy service, diagnostics `ebay.routes.ts:521-522`). `.env.example` documents only the first pair `apps/api/.env.example:66-67`. `api/env.ts` (19 lines) validates no `EBAY_*` variable at all (grep empty) — `EBAY_RUNAME`, `EBAY_DEV_ID`, `EBAY_NOTIFICATION_*` are read raw from `process.env`.
- **Routes with no web caller** (grep of `apps/web/src` for the path string): `GET /api/ebay/auth/connections`, `GET /api/ebay/auth/connection/:id`, `POST /api/ebay/auth/refresh`, `POST|GET /api/sync/ebay/orders*` (3 routes), `POST /api/sync/ebay/inventory`, `POST /api/ebay/financials/sync`, `GET /api/admin/ebay-token-status`, `POST /api/admin/refresh-ebay-tokens`, `POST /api/admin/setup-ebay-notifications`, `GET /api/admin/ebay-notification-status`, `POST /listings/force-sync-ebay`, `POST /listings/:draftId/publish`.
- `ebay-orders.routes.ts` still uses `(prisma as any).channelConnection` `:37,75,130,170` — the same cast class that hid the `getValidToken(row)` bug for 7 days (`ebay-orders.service.ts:734-738`).
- `ebay-auth.ts:7` imports `randomBytes` and never uses it.

---

## Security findings (ranked)

1. **Webhook signature verification does not implement eBay's scheme** — HMAC over a re-serialised body with the verification token (`ebay-notification.routes.ts:86-101,349-357`) instead of ECDSA against `getPublicKey(kid)`; no raw-body plugin registered. With the token set, all genuine pushes are dropped (silent loss of real-time order/stock signals, poll-only latency); with it unset, the endpoint accepts **unauthenticated** JSON and will (a) run ranged order syncs for every account on demand `:479-490`, (b) flip any known eBay order to `CANCELLED` and run the cancellation cascade given only an `orderId` `:547-576`, (c) inject `ChannelStockEvent`s for any SKU `:445-454`. Which mode prod is in: unverified (env).
2. **OAuth tokens stored in plaintext**, twice (`schema.prisma:6002-6004,6011-6013`); `lib/crypto.ts` exists and is unused for them. A DB read (or the `/api/admin/ebay-token-status` handler that selects `refreshToken` `ebay-notification.routes.ts:122-123`) exposes long-lived refresh tokens (~18 months).
3. **AccountsPanel disconnect keeps the tokens and never revokes at eBay** (`accounts.routes.ts:379-383`) — "disconnected" rows remain live credentials.
4. **Callback `connectionId` is client-chosen and unchecked** (`ebay-auth.ts:213-230`): any existing `ChannelConnection` id (not necessarily EBAY, not necessarily the placeholder) can be handed a fresh grant via `saveTokens` `:371-377`, overwriting an active account's tokens/identity. Combined with the publicly mintable state (`POST /api/ebay/auth/initiate`) this is a login-CSRF / account-substitution path: the state proves "issued by Nexus", not "issued to this user". The identity guards `:266,307-323` mitigate only when identity is returned and an unidentified row exists.
5. **RBAC is shadow by default** (`api/lib/auth/rbac-hook.ts:29-30`); `/api/ebay/auth/*` is mapped to `channelsConnect` (`permissions-manifest.ts:137`) and `/api/admin/*` to `adminView/adminRepair` `:404-405`, but unless `NEXUS_RBAC_MODE=enforce` on prod (unverified) `create-connection`, `revoke`, `refresh`, `refresh-ebay-tokens`, `setup-ebay-notifications` are effectively unauthenticated. `/api/ebay/auth/callback` is intentionally PUBLIC `:83`.
6. **State is replayable within 10 min and unbound to a session** (`oauth-state.ts:34-36,79,101-127`); a rejected state leaves an orphan `ChannelConnection` row (`ebay-auth.ts:195-205`; unauthenticated row creation at `:68-73`).
7. **Refresh-token expiry is untracked** (`ebay-auth.service.ts:8-13`) — the 18-month cliff will surface as `FAILED` on every job with no advance warning; no lock around refresh (§3).
8. **Partial token echoed to the client**: `POST /api/ebay/auth/refresh` returns the first 20 chars of the access token `ebay-auth.ts:555`. No full token is logged: `logger` calls in the auth/refresh paths carry status + error body only (`ebay-auth.service.ts:151,200`); `getSellerIdentity` logs the caught error object `:548`; legacy `EbayService` `console.error`s the error object `marketplaces/ebay.service.ts:104`.
9. **`EBAY_IDENTITY_BASE` env override** redirects the bearer token to an arbitrary host `ebay-auth.service.ts:518` (only matters if env is compromised).
10. **Hard-coded**: eBay site `101` (Italy) in the notification setup `ebay-notification.routes.ts:68`; RuName is env-driven (fine).

## Dead / duplicated code (summary)

- `services/marketplaces/ebay.service.ts` — app-token Inventory API client; every caller (readback Inventory lane, draft publish, bulk-list worker, flat-file pull preview) is on a token that cannot reach seller inventory; draft publish and bulk-list have no web caller.
- `services/ebay-sync.service.ts` — hits a non-existent Inventory endpoint; only caller is a route with no web caller. `services/marketplaces/ebay-sync.service.ts` is a different, payload-only module.
- Duplicate Trading-API caller in `ebay-notification.routes.ts:48-84` vs `ebay-trading-api.service.ts:230-282`, with divergent env names and sandbox-flag casing.
- Duplicate credential env pairs (`EBAY_CLIENT_ID/SECRET` vs `EBAY_APP_ID/CERT_ID`); none validated in `env.ts`.
- Twelve eBay routes with no web caller (list in §11); legacy `ebay*` columns still dual-written and read by four call sites; unused `randomBytes` import `ebay-auth.ts:7`; `_connectionId` unused `ebay-orders.service.ts:326`.
- `ebay-phase3.routes.ts` is **not** dead (two web callers).
