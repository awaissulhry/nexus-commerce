# Channel connections — RESEARCH (short version)

Written 2026-09-19. What was **found** about how Nexus connects to sales channels, and how it reads and changes products on them. It covers the channels connected today and every channel researched for the future.

- The plans are in [PLAN.md](PLAN.md).
- The word-for-word text of every source is in [full/RESEARCH-FULL.md](full/RESEARCH-FULL.md).
- Source tags in brackets: `[A0]`–`[A7]` = `docs/cx-audit-2026-08-29/`, `[R1]`–`[R9a]` = `docs/cx-research-2026-08-29/`.
- Studio-level channel work (publish, delist, per-market features) is in `docs/product-sheet/`. See topics 06, 11 and 12 there.

## Read this first — the 12 biggest findings

Source keys: `[cx-audit §n]` = docs/2026-08-29-cx-audit.md · `[A0]`–`[A7]` = docs/cx-audit-2026-08-29/A0–A7 · `[cx-research Bn]` = docs/2026-08-29-cx-research.md · `[R1]`–`[R9a]` = docs/cx-research-2026-08-29/R1–R9a · `[ops-research]` = docs/2026-09-01-channel-ops-research.md · `[amz-review]` = docs/2026-09-08-amazon-managed-connection-review.md · `[SE-0908]` = docs/audits/2026-09-08-shopify-etsy-connections.md · `[shop-local]` = docs/audits/2026-09-09-shopify-local-connect.md · `[etsy-local]` = docs/audits/2026-09-10-etsy-local-connect.md · `[BP]` = docs/audits/2026-09-08-business-profiles/README.md. The audit is dated 2026-08-29 and describes the code on that day. Later docs describe work "per the doc".

1. On 2026-08-29 only eBay had a real "sign in → Allow" flow. Amazon SP-API was one env refresh token turned into a fake `managedBy:'env'` row at boot. Amazon Ads was a paste-your-secret form (an OAuth route existed, but no UI called it). Shopify, WooCommerce and Etsy were env-only, and the card said "Coming soon" whatever the env held. Owner decision the same day: WooCommerce is out of scope. [cx-audit §0.1, header]
2. eBay access and refresh tokens were stored in plaintext, twice (the generic columns and the legacy `ebay*` columns). The resolver hands full rows, tokens included, to about 60 call sites. The Neon DB password is in tracked docs, so a database leak is a live risk. [cx-audit §0.2, S3, S10]
3. The eBay grant has only 6 scopes, and `sell.finances` is missing. The daily Finances sync fails on prod with 403 errorId 215001. That error means the request signature is missing: RFC 9421 signing is mandatory for EU/UK sellers. eBay needs full re-consent to add any scope, so ask for the full set of about 20 scopes once. [A0][R2 §A, §H]
4. "Connected" says nothing true about the channel. For Amazon it means the env vars were present at boot (including the unused `AWS_ROLE_ARN`), and `lastSyncStatus:'SUCCESS'` is stamped at boot. For eBay the green dot means the last token refresh worked. There is no heartbeat, and "Test" returns the literal text "eBay seller (verified)". [cx-audit §0.4]
5. Webhook ingress is unsafe or broken. No raw-body parser exists anywhere. eBay uses the wrong scheme (HMAC instead of ECDSA) and skips the check when the env var is unset. The Woo check never rejects, and the Etsy receivers have no check at all. Two generic routes that change stock are public with no auth. On prod only Amazon events ever arrived. [cx-audit §0.5]
6. Idempotency is keyed on the entity, not the delivery. The second Shopify `orders/updated` for an order is skipped forever. Every `inventory_levels/update` after the first is dropped (`externalId="undefined"`). The eBay fallback key contains `Date.now()`. [cx-audit §0.6]
7. There is one real push engine (`OutboundSyncService` + BullMQ) and four ghosts. The Phase-27 `channel-sync` lane builds a payload, never sends it, and still marks listings `IN_SYNC`. Operator field mappings (536 ChannelSchema rows, 0 rules) never reach a real push. [cx-audit §0.10]
8. Amazon removed `ORDER_STATUS_CHANGE` on 2026-07-29, and prod stopped receiving it that day. `ORDER_CHANGE` with an `eventFilter` replaces it. [R1 §D][A0]
9. Hard channel deadlines:
   - Amazon removed XML and flat-file listing feeds on 2025-12-03; only `JSON_LISTINGS_FEED` remains.
   - Amazon Orders v0 is removed 2027-03-27 and Finances v0 2027-08-27.
   - Ads refresh tokens issued from 2026-07-30 expire after 365 days.
   - The LWA client secret must rotate every 180 days.
   - eBay `UploadSiteHostedPictures` ends 2026-09-30.
   - Shopify REST is legacy, and we pin `2024-01` in 9 places.
   - The Google Content API was sunset 2026-08-18.
   - Walmart delegated keys die at the end of September 2026.
   [R1][R2][R3][R6]
10. Security: 3 Critical and 5 High findings.
    - Critical: public routes that change stock, unverified Etsy receivers, and the Neon password in docs.
    - High: Ads `/connect` + `/callback` are public with no state check (verified on prod: 302), a public probe that can write, the eBay webhook scheme, the Woo receivers, and an unsigned Shopify refund test route.
    [cx-audit §5]
11. Research verdict: take these pieces from each reference.
    - Nango: connection, token, OAuth-session, records and task mechanics.
    - Airbyte: error vocabulary and the async retriever.
    - Saleor: the delivery ledger.
    - Medusa: sagas.
    - Shopify: callback hardening and reconcile-to-desired-state webhooks.
    - Apideck: the connection state enum. Rutter: the Job object.
    - Then invert the unified model: the channel's full typed schema is primary, and the PIM core is a derived view.
    - Nango and the Airbyte connectors are ELv2: read and re-implement, never copy.
    [cx-research B2]
12. Later docs (09-08 to 09-10), per the docs:
    - Amazon's registered app is PRIVATE: its auth goes through the Solution Provider Portal, not website OAuth. A managed, encrypted connection was released with live heartbeats.
    - The Shopify and Etsy OAuth connectors were hardened.
    - Locally, Shopify reached the Install screen; consent is still pending.
    - Locally, Etsy shop ItalianHideCraft connected with all 12 scopes.
    - Business profiles give each seller account one owning profile; prod was not migrated as of 09-08.
    [amz-review][SE-0908][shop-local][etsy-local][BP]

## How Nexus talks to channels today (all channels)

### Connection model and accounts
- `ChannelConnection` = one row per channel account. It holds: `channelType` (AMAZON/EBAY/SHOPIFY/WOOCOMMERCE/ETSY), `marketplace`, `managedBy` (oauth/env/pending), generic `accessToken/refreshToken/tokenExpiresAt/displayName`, status `isActive/lastSyncAt/lastSyncStatus/lastSyncError`, MAP.2a `accountLabel/accountColor/isPrimary/sortOrder/externalAccountId`, and `connectionMetadata` Json. [A1 §1.1]
- The 8 deprecated `ebay*` columns have been dual-written since 2026-05-06 ("kept for one release"). `ebayDevId/ebayAppId` are never read or written. Three legacy-only readers, plus no generic home for store name / store URL / sign-in name, block the drop. [A1 §3.2][cx-audit D1]
- There is no Prisma `@@unique`; uniqueness is raw SQL: `ChannelConnection_active_account_key` (channelType, marketplace, externalAccountId WHERE isActive) and `…_channelType_primary_key`. A schema comment still describes the dropped singleton index, and `/api/accounts/diagnostics` still looks for it. [A1 §1.1][cx-audit D3]
- `connectionMetadata`: only `activeMarketplaces` is ever written. `scopes` is read by the detail page but nothing writes it (NULL on all 14 prod rows). [A1 §7.2][A0]
- 10 migrations touched the model. H.2 (20260506) added the generic columns and dropped `MarketplaceCredential` and `Channel.credentials`. MAP.2a (20260819a) added the account columns plus `channelConnectionId` on ChannelListing, SharedListingMembership, Order and SyncChannelPolicy. None dropped the `ebay*` columns. [A1 §2]
- `AmazonAdsConnection` is one row per Ads profile: `credentialsEncrypted` {clientId, clientSecret, refreshToken}, `mode` (default sandbox), `writesEnabledAt`.
  - `lastVerifiedAt/lastErrorAt/lastError` have zero writers, but the UI shows them.
  - `tokenIssuedAt` is set only at consent. The schema claims it is re-stamped on rotation and that a /health alert exists; neither is true.
  - `AmazonAdsProfile` has readers but zero writers.
  [A1 §1.5–1.6]
- Dead or legacy models: `Channel` (0 prod rows) + `Listing`; `MarketplaceSync` (242 rows, all FAILED, 0 creators); `ChannelListingOverride` (written, never read); `SyncLog/SyncError` (only the manual Shopify/Woo/Etsy jobs write them). [A5 models][cx-audit D16]
- `connection-resolver.service.ts` (MAP.3) resolves three kinds of scope:
  - NAMED `{accountId}`.
  - DERIVED from `listingId`, `variantListingId`, `itemId`, `orderId` or `channel+channelOrderId`. It falls back to the primary account when the row has no `channelConnectionId`.
  - DECLARED `{channel, primary:true}`.
  - It fails closed on ambiguity, but `tryResolveConnection` swallows every error and returns null.
  - It returns full rows, plaintext tokens included.
  - It is bypassed in `ebay.routes.ts:495` and `connections.routes.ts`.
  [A1 §9]
- Multi-account on 08-29:
  - Amazon: one env token, one global region; the env row cannot be duplicated.
  - Ads: one row per profile (9 on prod, one encrypted blob copied 9 times).
  - eBay: MAP, with 2 active accounts.
  - Shopify/Woo/Etsy: one config per process; the resolver is never used for them.
  [cx-audit §1.1][A2 §4]
- eBay jobs:
  - Run for every account: orders, token refresh, item-status reconcile, returns, notification fan-out.
  - Run for the primary only: feed poll, status reconcile, Trading read-back, financial sync (its own comment says finance is "PER ACCOUNT"), label guard, notification setup, pull-listing, policies, import.
  [A4 §4]
- `processOrder(order, _connectionId)` ignores the connection id, so eBay `Order.channelConnectionId` stays NULL. Shipping pushback for the second account's orders then uses the primary account's token: the wrong seller. [A4 §4]
- There are two disconnect paths:
  - The card revokes at eBay, nulls the tokens and sets `isActive:false` (and writes `lastSyncStatus:'SUCCESS'`).
  - AccountsPanel only sets `isActive:false` (and `FAILED`); it keeps the plaintext refresh token and never revokes.
  - Ads delete removes the row but never revokes at LWA. Amazon SP has no disconnect ("remove creds in Railway").
  [A1 §8]
- There are four definitions of "connected": the card's `isActive`; AccountsPanel's `deriveHealth(lastSyncStatus)` (ignores token expiry); the listing wizard's `connection-status` (Amazon = env, eBay = count, Shopify/Woo = `not_implemented`); and `PublishModeBadge` (Shopify env presence). [cx-audit §6.3][A6 §1.11]
- No audit row is written for any grant, re-consent, refresh, revoke, primary change, mode change or write-enable. Only the marketplace-scope PATCH is audited. Prod AuditLog has never had a connect/oauth action. [A1 §10][A0]
- On 08-29 the app was single-tenant (no org/tenant model), so RBAC was the only boundary. [A7]
- Env: there is no typed env schema (`api/env.ts` is 19 lines of dotenv). There are about 30 `AMAZON_*`/`AWS_*` names with aliases and two eBay credential pairs (`EBAY_CLIENT_ID/SECRET` vs `EBAY_APP_ID/CERT_ID`). `EBAY_ENVIRONMENT` is compared to "SANDBOX" in one file and 'sandbox' in another, so no single value satisfies both. [cx-audit §1.8][A4 §11]
- Research: extend MAP, don't fork it. `ChannelConnection` gains `region` and a child `ConnectionScope` table (marketplace/shop/profile/storefront), so one grant can own many scopes. The resolver keeps its contract. [cx-research B3#7]
- Research: add `authStatus ∈ {connected, degraded, needs_reauth, revoked, disconnected}` plus `lastSuccessAt/lastErrorAt/lastError/consecutiveFailures/refreshTokenExpiresAt`.
  - Run a heartbeat cron per channel: SP-API `getMarketplaceParticipations`, eBay `commerce/identity`, Shopify `shop`, Etsy `getMe`, Ads `/v2/profiles`.
  - Keep a `ConnectionEvent` ledger (grant, refresh, revoke, heartbeat, scope change, who did it).
  - Send alerts through the existing `alert.service`.
  [cx-research B3#4]
- Research: split "Last sync" into `lastRefreshAt`, `lastHeartbeatAt`, `lastInboundAt` and `lastOutboundAt`. The card shows all four, never one aggregate. [cx-research B3#19]
- Research: scope drift = `requiredScopes − grantedScopes`, computed on read. It drives a "Reconnect to grant new permissions" badge and button. [cx-research B3#5]
- Research: add a `ChannelApp` table for our own app credentials (channelKey, environment, clientId, encrypted secret, redirectUris, `secretExpiresAt`, `rotatedAt`). App credentials are never copied into connection rows. Add a listener for SP-API secret rotation. [cx-research B3#13]

### Tokens, secrets and sign-in (OAuth, refresh, rotation, scopes, storage)
- Auth in use on 08-29:
  - Amazon SP: LWA refresh token from env. It is read per call, or captured once at module load, so a rotated token needs a restart.
  - Ads: LWA refresh token pasted into a form, stored as an AES-GCM blob.
  - eBay: OAuth authorization code with a RuName.
  - Shopify: static env token.
  - Woo: env consumer key/secret over Basic auth, with no https check.
  - Etsy: env access token, plus a refresh token that is never used.
  [cx-audit §1.1][A2 §1]
- Encryption: `api/lib/crypto.ts` is AES-256-GCM `v1:<iv>.<tag>.<ct>` with key `NEXUS_CREDENTIAL_ENC_KEY` (base64, 32 bytes).
  - It has no key-id, so the key cannot rotate without downtime.
  - It is used for Ads, carriers and Sendcloud, but not eBay; its header says "ChannelConnection tokens later".
  - `.env.example` documents the wrong variable (`ENCRYPTION_KEY`).
  - Two more unused Vault copies exist: `packages/shared/vault.ts` and `apps/factory/src/lib/vault.ts`.
  - `crypto.test.ts` is a tsx script, and whether CI runs it is unverified.
  [A1 §4][A7 §2.1]
- OAuth state (`oauth-state.ts`, eBay only): `base64url(payload).base64url(HMAC)` with payload {channel, n, iat, adoptConnectionId?}, a 10-minute TTL, constant-time compare, bound to the channel.
  - It is NOT one-time (the nonce is never stored) and NOT bound to the session.
  - Its key is `NEXUS_CREDENTIAL_ENC_KEY || EBAY_CLIENT_SECRET`, so one secret serves two purposes.
  [A1 §5.1]
- eBay callback:
  - The state is verified before any DB read, and the adopt intent comes only from the signed state.
  - The `connectionId` in the body is not checked (any row, not only the placeholder or an EBAY row), which opens an account-substitution path.
  - A rejected state leaves an orphan placeholder row behind; 11 of the 14 eBay rows on prod are leftovers.
  [A4 §1][cx-audit §1.4]
- Amazon Ads OAuth route (not wired to any UI):
  - Scopes `profile advertising::campaign_management`.
  - State + PKCE S256 live in an in-memory Map: lost on restart, not shared between instances, never pruned.
  - The callback never validates state, and PKCE is optional.
  - Profiles are discovered on the EU host only, and the consent URL is hard-coded to `www.amazon.com/ap/oa`.
  - It writes `region:'EU'`, `mode:'sandbox'`, `isActive:true`, `tokenExpiresAt=now+365d`, and copies the app client secret into every row.
  - It echoes a 10-character token prefix in the HTML, and hard-codes the Railway redirect and web URLs.
  - Its `MARKETPLACE_COUNTRY` map is wrong: DE and ES are swapped, and `A1PA7PVP2ZEA0` is not an EU id (the same wrong id is the web form's "Amazon.it" default).
  [A3 §5]
- Refresh on 08-29:
  - eBay: refreshes when under 5 minutes remain, plus a `*/30` cron (on by default) and an admin route. There is no lock of any kind. Rotation is handled.
    - The 18-month refresh-token expiry is not tracked: `EbayTokenResponse` has no `refresh_token_expires_in` field.
    - A failure writes `lastSyncStatus:'FAILED'`, the same field a data sync uses. `isActive` stays true, nobody is alerted, and writes are not paused.
    - A success writes `lastSyncAt/SUCCESS`, so a token refresh looks like a sync.
    [A4 §3]
  - Amazon SP: a per-instance memory cache with a fixed 50 minutes (it ignores `expires_in`), no lock, and a 401 does not evict the token. A failure writes no status.
    - There are 14 `new SellingPartner(...)` constructions, each with its own cache, plus 5 hand-rolled LWA exchanges.
    - The static `AMAZON_SP_API_ACCESS_TOKEN` path is dead.
    [A3 §1–2]
  - Ads: caches for `expires_in−60s` with a per-profile in-flight dedupe (the only client that dedupes).
    - Rotation is ignored, and a failure writes nothing.
    - No cron or alert covers the 365-day cliff.
    - The manual form does not stamp `tokenIssuedAt`, so its countdown shows "unknown".
    [A3 §5]
  - Shopify and Woo use static credentials, so no refresh is needed. Etsy tokens die after 1 hour and no refresh code exists. [A2 §3]
- Secrets in logs and responses: no log prints a token, secret or code, but responses leak prefixes. [A1 §11][A7 §2.4–2.5]
  - `POST /api/ebay/auth/refresh` returns 20 characters of the access token.
  - `GET /api/amazon-ads/debug/test-auth` returns the client id and a 15-character refresh prefix, and fires 3 live report jobs per GET.
  - The Ads callback HTML shows 10 characters of the token.
  - The full Ads `state` is logged, and pino has no `redact` config.
- Tokens in URLs: none. The eBay code arrives in the page query and moves into a POST body. The Ads code lands on the API host; whether Railway logs query strings is unverified. [A1 §12]
- Research — encryption: use true envelope encryption.
  - Each blob gets an AES-256-GCM data key, wrapped by an AWS KMS master key (annual auto-rotation, CloudTrail audit of decrypts).
  - Envelope format `v2:<kid>:<wrappedDek>.<iv>.<tag>.<ct>`.
  - Decrypt only inside the token service; the resolver never returns tokens; the logger redacts.
  - The env key stays for local dev and a documented break-glass only.
  [cx-research B3#1]
- Research — the R8 Nango study disagrees: it says AES-GCM with iv+tag columns and a re-encrypt routine is enough for one tenant, "no KMS needed". [R8 pattern 19, "not worth cloning"]
- Research — OAuth session:
  - Add an `OAuthSession` table: id = state, `codeVerifier`, `channelKey`, `startedByUserId`, `intent` (new/reconnect/adopt), `redirectUri`, `expiresAt` (10 min), `consumedAt`.
  - Use PKCE by default and enforce the cookie double-submit.
  - Take the callback allow-list from the catalogue.
  - Use a popup first, with a same-tab fallback.
  [cx-research B3#2]
- Research — refresh:
  - Refresh ahead of expiry (a buffer), dedupe in-flight refreshes, take a Postgres advisory lock, then re-read to double-check.
  - Keep the old refresh token if the response omits one.
  - Mark the grant exhausted after N consecutive failures, not after N calendar days.
  - On failure: `NEEDS_REAUTH`, writes paused, reads continue while the access token lives, operator notified.
  [cx-research B3#3]
- Research — expiry calendar: `refreshTokenExpiresAt` and `secretExpiresAt` drive a "reconnect before <date>" banner 30 days ahead. [cx-research B3#18]
  - SP-API public apps: 365 days, and again whenever a role is added.
  - Ads: 365 days (for tokens issued from 2026-07-30).
  - LWA secret: 180 days.
  - eBay: 18 months. Etsy: 90 days. Allegro: 3 months.
- Research — request signing: the connector interface gets a `signRequest` hook, and the catalogue declares the scheme: eBay RFC 9421, Kaufland HMAC, TikTok/SHEIN per-call signatures, Walmart `WM_SEC.*`. [cx-research B3#15]
- Research — Restricted Data Tokens: the token service exposes `getAccessToken({restricted})`. RDTs are cached about 50 minutes, and PII fields are typed as restricted. [cx-research B3#16]
- Research — Airbyte's `advanced_auth` splits OAuth config into four blobs (user input / OAuth output / server input / server output). Rotated refresh tokens flow back as a CONTROL message, so the connection store is the only writer. [R9a][R9 patterns]

### How a product change goes from Nexus to a channel (write paths, queue, BullMQ, feeds, flat files, the "ghost" engines)
- There is one real engine: E12 `OutboundSyncService`.
  - It drains `OutboundSyncQueue` rows through a BullMQ worker, with a 60-second DB-polling backstop.
  - It dispatches Amazon (`syncToAmazon`), eBay, Shopify and Woo. Etsy cannot be dispatched.
  [A5 §0, E12]
- Queue: BullMQ + ioredis, with queues `outbound-sync`, `channel-sync`, `read-cache`, `search-index`, `bulk-job` and `ads-sync`. [A5 §6]
  - Jobs retry 3 times with exponential backoff from 2 seconds.
  - Workers start only when `ENABLE_QUEUE_WORKERS=1`. The 60-second autopilot always runs.
  - Outbound concurrency is 5 globally, not per channel; channel-sync concurrency is 3.
  - `addJobSafely` has a 2.5-second timeout and a 30-second circuit, and every enqueue is backed by a PENDING DB row.
  - Order-driven reasons get priority 1.
- Failure handling (`computeFailureDisposition`): [A5 §6]
  - Circuit-open, rate-limited or debounced → deferred, with jitter.
  - Auth-class errors → 15-minute deferral.
  - Non-retryable → terminal; otherwise a retry ladder (`maxRetries` 3).
  - eBay 400/404/409/422 are terminal and do not trip the circuit.
  - Dead letters go to `isDead/diedAt` (`SYNC_DEAD`), with a janitor every 15 minutes and a Dead Letters tab in the hub.
- Gates on the real push: `NEXUS_ENABLE_<CH>_PUBLISH` + `<CH>_PUBLISH_MODE` ∈ gated/dry-run/sandbox/live. A non-live "success" is recorded as `SKIPPED`. Every attempt is audited in `ChannelPublishAttempt` (mode, outcome, payload digest). [A5 §7]
- Amazon publish gate: a token bucket per (seller, marketplace) at 2 req/s, burst 20, plus a circuit breaker (3 failures in 5 minutes → open 10 minutes). State lives in one process. The Shopify gate has the same shape but is wired only into `outbound-sync.service`. [A3 §3][A2 §7]
- Direct-to-API pushes that bypass the queue (E18): [A5 E18]
  - `/products/:id/listings/:channel/:marketplace/publish` → `putListingsItem`.
  - Amazon flat-file `POST /api/amazon/flat-file/submit` → `createFeedDocument` + `JSON_LISTINGS_FEED` → `AmazonFlatFileFeedJob`.
  - eBay flat-file + `ebay-variation-push` → Inventory API → `EbayPushJob`.
  - `pricing-outbound` (price PATCH).
  - eBay cockpit.
  - The listing-wizard `submission.service` only composes ("putListingsItem is the missing integration").
- eBay push split (`ebay-push-mode.ts`): [A4 §8]
  - Feed API (`INVENTORY_TASK`) only for unique-SKU, non-shared pushes over 50 rows.
  - Shared-SKU listings go through Trading (`AddFixedPriceItem`, `ReviseInventoryStatus`, `EndFixedPriceItem`).
  - Unique SKUs go through the Inventory API (`inventory_item`, `inventory_item_group`, `offer`).
  - The Trading lane needs `NEXUS_EBAY_REAL_API=true` and throws in prod otherwise.
- The ghost engines: [A5 §1.1]
  - Dead: E1 `UnifiedSyncOrchestrator`; E2 `ProductSyncService`; E3 barrel.
  - Broken: E6 `inbound-sync` (invalid unique key, own PrismaClient).
  - Mostly dead: E13 `outbound-sync-phase9`.
  - E14 `variation-sync-processor`: has no producer, hard-codes USD, and goes straight to SP-API, bypassing the gates.
  - E16 Phase-27 `channel-sync` (harmful): it builds a payload and never sends it. Its `'noop'` guard never matches, so it writes `IN_SYNC/SUCCESS` and creates fake `_US` listings. It is reachable from `ManageInventoryClient` and `MarketplaceActionsDropdown`.
  - E17 `channel-publish`: sandbox-only; the live branch returns "not yet wired".
  - E7 catalog status endpoint: always 404.
- `POST /marketplaces/inventory/update` pushes the raw number from the request body (Amazon answers "Not implemented"). Two `marketplaces.ts` routes are declared inside a request handler and never register. [A5 §1.2][A6 §0.8]
- Quantity source of truth: one pure resolver, `resolveIntendedQuantity`, with precedence FBA_EXCLUDED > CLOSED > PAUSED(policy) > PAUSED(listing) > PINNED > FOLLOW.
  - Only 5 of the 16 `QUANTITY_UPDATE` producers call it; dispatch re-derives quantity, which mitigates this.
  - These push without the queue: `marketplaces.ts`, `variation-sync-processor`, and possibly the eBay flat-file/variation push (unverified).
  - `SyncChannelPolicy` has 0 rows on prod.
  [A5 §3][A0]
- Title/description/price/images/bullets: `followMaster*` booleans are honoured by about 28 files, with no single function. The master snapshots and the drift job exist because writes bypassed the cascade. There is no per-field, per-channel "channel wins" policy table. [A5 §3.1]
- `ChannelListing` has 40 writer files, and several engines write the same fields: quantity, price, syncStatus, title/description, platformAttributes. [A5 §1.2]
- Mappings: `/settings/mappings` + ChannelSchema (536 rows) + `Marketplace.schemaMapping` (0 rules). `sync-mapping-merge` runs per channel via `FM_SYNC_<CH>` ∈ off/shadow/merge (default off), and its only consumers are the E16 no-send lane. So the mapping editor is a preview tool; it does not control what ships. [A5 §2.5, §10]
- Shopify write specifics: 7 HTTP clients pin `2024-01`. "Set inventory" actually sends a relative adjust. `?query=sku:` is not supported on REST products. The listing-wizard adapter is the only client that retries on 429. [A2 §10]
- Operator outbound webhooks: only `alert.service` emits them (5 alert types). No sync, listing or stock event is ever forwarded. [A5 §5.3]
- Research — keep `OutboundSyncQueue` + BullMQ as the executor, but add: [cx-research B3#9]
  - concurrency groups per (channel, connection);
  - a token bucket per connection, fed by the channel's rate-limit headers;
  - an `AsyncJob` model for report/feed/bulk lifecycles;
  - first-class bulk paths for Amazon, Shopify and eBay;
  - a per-field, per-channel source-of-truth policy table.
  Dry-run = the existing `ChannelPublishAttempt` modes; progress = job rows + SSE.
- Research — every outbound write carries an idempotency key = `OutboundSyncQueue.id`, mapped to the channel's own mechanism. Shopify `@idempotent(key:)` is mandatory from 2026-04. [cx-research B3#17]
- Research — above a threshold, prefer bulk/feed paths. Bound queued tasks per connection, show headroom on diagnostics, and never fan out unbounded per-SKU calls (today's Shopify inventory job is N+1). [cx-research B3#20]
- Research — Medusa sagas fit multi-channel writes: `createStep(invoke, compensate)`, persisted `WorkflowExecution`, and external resume by idempotency key. This is the shape of "push to Amazon, wait for the feed result, then continue or roll back". [R9 §3.2]
- Research — Nango alternative: a Postgres-only task table (states, heartbeat, 3 timeouts, `group_max_concurrency`, `FOR UPDATE SKIP LOCKED` dequeue, one active task per schedule) needs no Redis or BullMQ. [R8 pattern 14]

### How Nexus reads from channels (sync, pulls, reports)
- Amazon polls (all running on prod): orders `*/15`, FBA inventory `*/15`, zero-totals `*/15`, MCF `*/15`, returns hourly, order-items retry `0 */2`, financial `0 2`, settlements `30 3`, catalog `0 3` (gate `NEXUS_ENABLE_CATALOG_SYNC_CRON`), reconcile `45 3`, A+ `0 4`, schema refresh `0 4` (gated), qty read-back `15 4`, FBA drift `0 5`, attr-hydrate `17 */3`, flat-file feed poll `*/2`. Four jobs are missing from `cron-registry.ts`, so they cannot be triggered by hand: attr-hydrate, flat-file-feed-poll, qty-readback, sqs-poll. [A3 §10][A5 cron table]
- Amazon orders: `getOrders` with `LastUpdatedAfter/CreatedAfter`, a 3-minute clock-skew guard and NextToken paging, upserted on (AMAZON, channelOrderId).
  - The raw order is kept in `Order.amazonMetadata`, with about 15 typed columns.
  - Typed but dropped: `NumberOfItemsShipped/Unshipped`, `SalesChannel`, `ShipmentServiceLevelCategory`, `IsBusinessOrder`, `EarliestDeliveryDate`, `LastUpdateDate`.
  - Whether buyer PII uses an RDT is unverified.
  [A3 §6]
- Amazon FBA inventory: only `fulfillableQuantity` is saved, into StockLevel `AMAZON-EU-FBA`. Inbound and reserved quantities are dropped, SKUs missing from the response are not zeroed, and no raw payload is kept. [A3 §6]
- Amazon catalog: the `GET_MERCHANT_LISTINGS_ALL_DATA` report is polled 30 × 10 s and only 9 TSV fields are kept. The separate `amazon-catalog.service` reads a static token with an `'na'` default and is dead. [A3 §6]
- Amazon listing attributes → `ChannelListing.platformAttributes` + `flatFileSnapshot`, raw kept (flat-file pull, attr-hydrate). [cx-audit §3.2]
- Amazon health: `getMarketplaceParticipations` runs on demand only, with its own uncached LWA call; it last ran 2026-06-24. `amazon-account-health` is computed locally from Order rows, not from SP-API. [A3 §9]
- eBay polls (defaults; each can be overridden by env): [A4 §6]
  - Orders `*/5`: off by default in code, but running 288 times a day on prod. `GET /sell/fulfillment/v1/order?filter=creationdate:[<7d>]&limit=200`. There is no paging on the rolling fetch, and the range filter is missing its `..` terminator.
  - Token refresh `*/30`.
  - Feed poll every 120 s (primary only, up to 10 tasks).
  - Returns `*/5` (off by default; reads the first page only).
  - Status reconcile `0 2` (off by default).
  - Item-status `30 2` (all accounts, cap 100).
  - Read-back `*/30`.
  - Label guard `15 */6` (this one WRITES `ReviseFixedPriceItem`).
  - Image read-back `45 */6`.
  - Financial `30 3` (primary only; "yesterday" is computed in server-local time, not UTC).
  - Ads: 8 schedules.
  - Not in the cron registry: feed-poll, returns-poll, status-reconcile, item-status-reconcile, readback.
- eBay order mapping: [A4 §8]
  - The raw payload is NOT kept; only a 5-field `ebayMetadata`.
  - `marketplace:'EBAY-GLOBAL'`, `fulfillmentLatency:1` and `shipByDate=+24h` are hard-coded.
  - Buyer email is synthesised as `@buyer.ebay.invalid` when missing.
  - Dropped: `legacyOrderId`, `salesRecordReference`, `sellerId`, `pricingSummary.*`, `paymentSummary.payments[]`, `refunds[]`, `buyer.taxAddress`, `shippingServiceCode`, `ebaySupportedFulfillment`, `program.*`, `lineItems[].listingMarketplaceId/purchaseMarketplaceId`, `lineItemFulfillmentStatus`, `appliedPromotions`, `ebayCollectAndRemitTaxes`.
- eBay listings: [A4 §8]
  - `ebay-sync.service` calls `GET /sell/inventory/v1/inventory`, which does not exist (expect 0 results or 404).
  - `ebay-import.service` uses the correct `inventory_item?limit&offset`, but drops description, images, condition, available quantity, mpn/isbn/epid and locale, and hard-codes `productType:'APPAREL'` and `basePrice:0`.
  - Trading `GetItem` is used only for read-back, status and images.
- The eBay Inventory-lane read-back, draft publish, bulk-list worker and flat-file pull preview all use the legacy `EbayService` application token (`api_scope` only) against seller endpoints, which eBay is expected to refuse (unverified live). [A4 §11]
- Shopify: the jobs exist but are never scheduled (manual trigger only). [A2 §6, §8]
  - Each run is a full rescan: GraphQL `products(first:100)`, inventory N+1 per product, `orders(first:50)`, no cursor.
  - Products keep name/price/stock/ids and drop bodyHtml, handle, vendor, productType, tags, images, compareAtPrice, barcode, weight, metafields and the inventoryItem id. No raw is kept.
- Shopify orders: [A2 §8]
  - The webhook keys on the numeric id and keeps raw `shopifyMetadata`; the poll keys on the GraphQL gid, so each order gets duplicate Order rows.
  - The poll hard-codes EUR, sets `purchaseDate=now()`, keeps no raw, and `deleteMany`s the line items on every run.
  - The GraphQL query asks for `lineItems{price}`, which is not a documented field.
- Woo/Etsy: ingest writes columns and enum values that do not exist, so every order ingest throws. Woo simple products land as price 0 / stock 0. Etsy writes `Product.etsyListingId`, which does not exist, so it throws; its inventory job throws on the first query. [A2 §8]
- Rate limits on reads: [cx-audit §1.1][A2 §7][A4 §7]
  - Amazon: a global 200 ms gap and 1/2/4 s retries. It never reads `Retry-After` or `x-amzn-RateLimit-Limit`, and does not tell `QuotaExceeded` apart.
  - eBay: reads no rate-limit headers and never calls Developer Analytics `rate_limit`. Token, orders, Trading, account, feed and import calls have no 429 handling. Parallel batch runs 8 at a time (cap 32) with backoff.
  - Shopify: no 429 or `extensions.cost` handling, and the bucket starts at 0 in each instance.
  - Woo/Etsy: the limiter's wait is discarded.
  - `rate-limit.ts` only detects rate limits; it does not limit.
  - Ads is the best client: a Redis ledger of 9000 calls/h, `Retry-After`, and jitter.
- Raw payload kept: Amazon orders, listing attributes, `WebhookEvent.payload`, `ChannelStockEvent.rawPayload`, Shopify webhook orders. Not kept: eBay orders, Shopify/Woo/Etsy products, FBA inventory. `channelSpecificData`/`marketplaceMetadata` are written only by CSV import. [A5 §2.3]
- External ids follow no single pattern: [A5 §4]
  - Product has one column per channel: `amazonAsin`, `ebayItemId`, `shopifyProductId`, `woocommerceProductId` (an Int).
  - Listing ids live in three parallel tables: ChannelListing, VariantChannelListing, SharedListingMembership.
  - Order and webhook ids are consistent.
- Monitoring: [A5 §8][A0]
  - `SyncHealthLog` is real: 2,285 unresolved Amazon warnings and 7,714 eBay on prod.
  - `sync-monitoring.service` keeps alerts in memory, and its dashboards are unmounted.
  - Operators actually see the `/sync-logs` hub, sync-control and Control Tower.
  - `OutboundApiCallLog` holds the truth per call, but the cards don't show it.
- Research — add a `ChannelRecord` (connection, entityType, externalId, raw jsonb, rawHash, fetchedAt, deletedAt) as the typed per-channel truth, with TS types generated from each channel's schema. Core Product/Variant/ChannelListing/Order become derived views, and `ChannelSchema` becomes the catalogue of writable fields per product type. [cx-research B3#10]
- Research — use Airbyte's `AsyncRetriever` (create/poll/download, status map, job cap, timeout) for SP-API reports/feeds, Ads reports, Shopify bulk and the eBay Feed API. Also from Airbyte: reuse a recent DONE report; `DatetimeBasedCursor` time windows with a lookback; per-stream state checkpoints; `SubstreamPartitionRouter` (orders→refunds, profiles→campaigns). [cx-research B2.3][R9a]
- Research — Nango records: `external_id` unique per (connection, model), `data_hash`, a `deleted_at` tombstone, and a one-statement upsert that labels each row inserted/changed/unchanged/deleted. Detect deletes by generation. [R8 patterns 11–12]
- Research — keep a reconciliation poll even where webhooks exist: Amazon, Shopify, eBay and Etsy all say delivery is not guaranteed. [R1 §D][R3 §D.3][R2 §E][R4 §D.2]
- Research — observability: extend `OutboundApiCallLog` with connectionId, parsed rate-limit headroom, latency and error class. Add a "Connection diagnostics" panel that runs the heartbeat plus one live read per capability. [cx-research B3#12]
- Research — `apiVersion` per connector. Add a `DeprecationWatch` job (it parses deprecation headers and the SP-API schedule page) and contract tests that replay recorded fixtures. Offer a sandbox-connect mode wherever the channel has a sandbox. [cx-research B3#11]

### Webhooks and notifications (ingress, signatures, raw body)
- No raw-body parser is registered anywhere (no `fastify-raw-body`, no `addContentTypeParser`). eBay's `config:{rawBody:true}` does nothing, so every HMAC receiver signs `JSON.stringify(request.body)`. [cx-audit §0.5][A7 §2.2]
- `WebhookEvent`: `(channel, externalId)` is unique. It has no retry count, attempt, next-retry or dead-letter columns, and `signature` is never written. Replay exists: `POST /api/sync-logs/webhooks/:id/replay`. [A5 §5.1]
- Shopify: 7 routes, `/webhooks/shopify/{products/update, products/delete, inventory/update, orders/create, orders/update, fulfillments/create, refunds/create}`. [A2 §5.1]
  - The HMAC is computed over re-serialised JSON and compared with `===`, so real deliveries fail at random.
  - The event is stored AFTER processing, and idempotency uses `payload.id`. `X-Shopify-Webhook-Id` is never read.
  - Refund replay breaks: the route writes `refunds/create`, the dispatcher expects `refund/create`.
  - The mandatory `customers/data_request`, `customers/redact`, `shop/redact` and `app/uninstalled` are missing.
  - Webhooks are registered with REST `POST /webhooks.json` (7 topics) from an admin route that no screen calls.
  - `refunds/create-test` is unsigned unless `NEXUS_ENV=production`.
- WooCommerce: 6 routes, and the check never rejects (`if(!isValid)` tests an object). It is skipped entirely when the config is null. Idempotency is per entity, events are stored after processing, and nothing registers the webhooks. [A2 §5.2][A7 F7]
- Etsy: 6 made-up receivers built for a webhook product Etsy did not have then. They check no signature, are PUBLIC, and can flip products to INACTIVE and overwrite stock. Their idempotency key is controlled by the attacker. [A2 §5.3]
- eBay: `GET/POST /api/webhooks/ebay-notification`. [A4 §5]
  - The challenge (SHA-256 of challenge + token + endpoint) is correct, but it still answers when the token is empty.
  - Push messages are checked with HMAC over the body, when eBay actually signs with ECDSA via `getPublicKey(kid)`. The check is skipped when the token env is unset, and the route always answers 204.
  - Messages are stored before processing, but already stamped `isProcessed:true`. The fallback id uses `Date.now()`.
  - Topics handled: `ItemRevised`/`marketplace.inventory_item.updated` → stock event; legacy sale topics and `marketplace.order.created` → a 30-minute order sync per account; `marketplace.order.cancelled` → the cancellation cascade.
  - `MARKETPLACE_ACCOUNT_DELETION` is not handled.
  - No code creates Notification API destinations or subscriptions.
  - A Trading `SetNotificationPreferences` admin route exists (site 101 hard-coded, OAuth token placed in `<eBayAuthToken>`).
  - There is no `text/xml` parser, so SOAP Platform Notifications are rejected. Prod has received 0 events.
- Amazon SP-API (SQS): the poll runs every minute with a 55-second budget of 20-second long-polls (gate `NEXUS_ENABLE_AMAZON_SQS_POLL=1`). [A3 §4]
  - It subscribes to 7 types: `ORDER_CHANGE, ORDER_STATUS_CHANGE, FBA_OUTBOUND_SHIPMENT_STATUS, FBA_INVENTORY_AVAILABILITY_CHANGES, ANY_OFFER_CHANGED, FEED_PROCESSING_FINISHED, ACCOUNT_STATUS_CHANGED`. The code and admin still say "8" and keep a dead `LISTINGS_ITEM_STATUS_CHANGE` parser.
  - The destination ARN is built by splitting the SQS URL. It self-heals at boot, re-pointing subscriptions aimed at a foreign destination.
  - Each message is stored on its `messageId` before processing and deleted after success. Unknown types are deleted silently.
  - `ORDER_CHANGE` runs a 5-minute `syncNewOrders`; FBA changes → `ChannelStockEvent`; the other types → SSE only.
  - No SNS signature or `SellerId` check. The documented queue policy accepts any SNS topic.
  - A DLQ monitor runs `*/5`.
- Check this mismatch: the code unwraps an SNS envelope (`JSON.parse(outer.Message)`), while R1 says SP-API SQS messages are raw JSON with no SNS envelope and no signature (dedupe on `NotificationId`). [A3 §4][R1 §D]
- AMS (Ads Marketing Stream): an SQS poll every minute with no `WebhookEvent` storage and no signature check. Its HTTP twin `/api/advertising/marketing-stream/ingest` is PUBLIC, and when the secret is unset it lets everything through (`!==` compare). [A3 §4]
- Generic `POST /api/webhooks/order-created` and `POST /webhooks/stock-adjustment`: PUBLIC, no auth, and they change stock (Critical). [A7 F1]
- Sendcloud and Cloudinary receivers are fine (timing-safe compare, 503 when no secret), apart from re-serialised bodies. [A7 §2.2]
- Outbound operator webhooks (`/settings/webhooks`): only the Test button fires, the secret is stored in plaintext in a column named `secretHash`, and the test fire is an SSRF risk (it will call private addresses and store the response body). [A5 §5.3][A7 F13]
- Research — build one ingress, `POST /api/ingress/:channel/:topic?`: [cx-research B3#8]
  - raw body captured on that prefix only, with a verifier per channel;
  - an `InboundEvent` stored BEFORE processing, deduped on the delivery id;
  - `status` + `attempts` + `nextRetryAt` + a dead letter;
  - ordered processing per (channel, entityKey);
  - replay from the channel where possible;
  - a reconciliation poll per channel;
  - subscriptions that self-heal (reconcile to the desired state on connect and on a cron).
- Research — lifecycle webhooks (Shopify `app/uninstalled`, eBay `MARKETPLACE_ACCOUNT_DELETION`/`AUTHORIZATION_REVOCATION`, TikTok `SELLER_DEAUTHORIZATION`) set `authStatus = revoked`. A heartbeat classifier catches the silent cases: SP-API sends no revoke notification, only a 403. [cx-research B3#6]
- Research — handle the compliance topics in the ingress with a `DataRequest` ledger. Keep raw events for about 90 days (the ledger row stays). Minimise PII: store RDT-gated fields encrypted or not at all. [cx-research B3#14]
- Research — Nango handler contract: `(ctx, headers, body, rawBody, query) → {statusCode, content, connectionIds, toForward}`. Verify HMAC on the raw body with `timingSafeEqual`, find the connection from a config field, answer fast, process async. [R8 pattern 16]
- Research — Saleor's three-table delivery log (payload / delivery / attempt, with request and response headers, status, duration, capped body) gives the "what we sent, what came back" ledger in both directions. [R9 §2.3]

### Security findings
Ranked as in the audit. The A7 F-numbers map onto these S-numbers.
- S1 Critical — `POST /api/webhooks/order-created` and `POST /webhooks/stock-adjustment` change stock with no signature and no guard (PUBLIC prefix). Fix: API key or HMAC, and an explicit manifest entry. [cx-audit §5][A7 F1]
- S2 Critical — the 6 Etsy receivers check nothing, are PUBLIC, and can deactivate products and overwrite stock. Fix: delete them and rebuild on Etsy's real Standard-Webhooks scheme. [cx-audit §5][A7 F2]
- S3 Critical — the live Neon `DATABASE_URL`, password included (`npg_…`), sits in `docs/PHASE33-CLOUD-DEPLOYMENT-PREP.md` (3 places). Rotation is still open. Fix: rotate now and scrub. [cx-audit §5][A7 F3]
- S4 High, prod-verified — Amazon Ads `/connect` and `/callback` are PUBLIC. The callback checks no state, drops PKCE when it is absent, and upserts active connections, so anyone can inject foreign Ads profiles into bid automation. [cx-audit §5][A7 F4]
- S5 High — `GET /api/admin/amazon-auth-probe` is PUBLIC, gated only by the last 6 characters of the seller id. `?write=1` does a live listings PATCH, and it echoes the LWA client ids. It returned 404 on prod, reason unverified. [cx-audit §5][A7 F5]
- S6 High — the eBay push webhook uses the wrong scheme, is skipped when the token is unset, and has no raw body. Either every real push is dropped, or the endpoint is open and can cancel orders or inject stock events. [cx-audit §5][A7 F6]
- S7 High — the Woo receivers never reject, and are skipped when the config is null. [cx-audit §5][A7 F7]
- S8 High — `POST /webhooks/shopify/refunds/create-test` runs the real refund handler unsigned unless `NEXUS_ENV==='production'` (the prod value is unverified). [cx-audit §5][A7 F8]
- S9 Medium — every HMAC receiver signs `JSON.stringify(body)`, and Shopify and Woo compare with `===`. Fix: a raw-body parser on the ingress routes plus `timingSafeEqual`. [cx-audit §5][A7 F9]
- S10 Medium — eBay tokens are plaintext in two column sets and fan out to about 60 sites. Fix: envelope encryption. [cx-audit §5][A7 F10]
- S11 Medium — the AccountsPanel disconnect keeps live refresh tokens and never revokes. Fix: one disconnect path (revoke + null + audit). [cx-audit §5][A7 F11]
- S12 Medium — the eBay state can be replayed and is not tied to the session; the key falls back to `EBAY_CLIENT_SECRET`; the callback `connectionId` is unchecked. Fix: a one-time nonce ledger, a session claim, a dedicated `OAUTH_STATE_SECRET`, and a placeholder check. [cx-audit §5][A7 F14]
- S13 Medium — AMS ingest is PUBLIC, lets everything through when the secret is unset, and compares with `!==`. [cx-audit §5][A7 F12]
- S14 Medium — the outbound-webhook secret is stored in plaintext in `secretHash`, and the test fire is an SSRF risk that stores the response body. [cx-audit §5][A7 F13]
- S15 Medium — no CSRF on body-less state-changing POSTs (`/api/accounts/:id/disconnect`, `/api/admin/refresh-ebay-tokens`, `/api/admin/setup-*`). How Fastify treats an empty body is unverified. CSRF is applied only to `/api/auth/*` and `/api/team/*`. [cx-audit §5][A7 F15]
- S16 Medium — `GET /api/amazon-ads/debug/test-auth` returns the client id and token prefixes and fires live report jobs behind `adsView`. [cx-audit §5][A7 F16]
- S17 Medium — eBay refresh has no lock; a refresh failure overwrites `lastSyncStatus`; the 18-month cliff is untracked; the Ads 365-day cliff has no alert. [cx-audit §5]
- S18 Medium — SQS/SNS payloads are trusted with no signature or `SellerId` check, and the documented queue policy accepts any SNS topic. The real AWS policy is unverified. [cx-audit §5][A7 F19]
- S19 Low — token prefixes appear in HTTP responses, the full Ads `state` is logged, and pino has no `redact`. [cx-audit §5][A7 F17, F20]
- S20 Low — hard-coded prod hosts (Ads redirect, the web link, the CORS list) and no callback allow-list. [cx-audit §5][A7 F18]
- S21 Low — `.env.example` documents `ENCRYPTION_KEY` instead of `NEXUS_CREDENTIAL_ENC_KEY`, and the envelope has no key-id. Fix: a `v2:<kid>:…` envelope. [cx-audit §5][A7 F21]
- S22 Low — no audit row for grant, re-consent, refresh, revoke, primary change, mode change or write-enable. Fix: a `ConnectionEvent` ledger (CX.1). [cx-audit §5]
- S23 Info — the `EBAY_IDENTITY_BASE` env override sends the bearer token to any host. Etsy sends the OAuth token as `x-api-key`. [cx-audit §5]
- No log prints a token. No real `.env` was ever committed. The session cookie is `SameSite=None; Secure` (interim cross-site setup). [cx-audit §5][A7]
- Prod runs RBAC in enforce mode (unauthenticated `GET /api/connections` → 401). RBAC is one global preHandler plus a first-match manifest, with no per-route guards. In shadow mode everything is allowed through. [cx-audit §1.8][A7]
- A7 fix order: F1/F2/F5 the same day → rotate Neon → Ads state/PKCE and put `/connect` behind auth → one change covering raw body + fail-closed + timing-safe compare + real eBay scheme → encrypt eBay tokens and webhook secrets, revoke on disconnect → the remaining medium items. [A7 §3]
- Research — use Nango's egress policy for any URL a user supplies (Woo/Shopware store URL, outbound webhooks): deny private and metadata ranges, validate redirects. [R8 pattern 18]

### Screens and routes (UI)
- Settings nav: Integrations → Channels, Advertising, AI providers; Developer → API keys, Webhooks. `/settings/mappings` is not in the nav (URL only). The Channels subtitle says "Amazon, eBay, Shopify OAuth connections", but only eBay was OAuth. [A6 §1.2]
- `/settings/channels` (on 08-29): [A6 §1.3]
  - The channel list is hard-coded (AMAZON, EBAY, SHOPIFY, WOOCOMMERCE, ETSY). `GET /api/connections` returns one row per channel and pads the rest with `pending` placeholders.
  - Badges: Env-managed / Connected / Coming soon / Misconfigured / Not connected.
  - Buttons:
    - Test: always calls the eBay endpoint.
    - Diagnose: scoped to `marketplaceId=EBAY_IT`, not to the account.
    - Disconnect: revokes at eBay.
    - Connect: works for eBay only; every other channel shows "{name} connector is deferred".
  - The footer says tokens refresh every 30 minutes (true) and that disconnect revokes (true only for the card).
- eBay connect UX: `window.open` runs synchronously before any await → `POST /api/ebay/auth/initiate` → popup to the authorize URL; if the popup is blocked, the same tab navigates. The callback page posts `nexus:channel-connected` to `window.location.origin`, and the opener checks `e.origin` (correct). [A4 §1]
- AccountsPanel (design system): [A6 §1.4]
  - Shows active rows from `GET /api/accounts`. Health text is "Healthy / Degraded / Failing / Not yet reported", taken from `lastSyncStatus` only.
  - Flags "no name from the channel — rename it" and "identity unavailable — reconnect".
  - Actions: Rename, colour, Make primary, Reconnect, and Disconnect (which shows a blast-radius count first).
  - Env rows say "Set by environment — no grant to revoke". "+ Connect another account" appears only for eBay.
- Detail `/settings/channels/[type]`: [A6 §1.5]
  - Shows the Active pill, token/sync health, and a scopes card that is always empty and makes a false claim.
  - Marketplace toggles cover IT/DE/FR/ES/UK only. The PATCH writes `activeMarketplaces` plus an audit row, and it "succeeds" on a revoked row.
  - Shows the last 50 webhook events and the raw metadata.
  - It has no connect, disconnect or sync-now control, though the file header promises a Reconnect card.
  - It needs only `settingsView`, while `/api/connections` needs `settingsIntegrationsManage`.
- `/settings/channels/ebay-callback`: Tailwind, not the design system. It creates the placeholder row BEFORE the token exchange. [A6 §1.6]
- `/settings/advertising`: [A6 §1.10]
  - Status badge Sandbox / Live (read-only) / Live + writes.
  - Actions: Test, Promote / Back to sandbox, Enable writes (two steps: preview, then confirmation token), Disable writes, Allowlist campaigns, Delete — using native `confirm`/`alert`.
  - The paste form is autofilled like a login form.
- `/settings/mappings`: marketplace picker + per-field rules + payload preview + a click-to-bind canvas (`pimManage`). `/settings/webhooks` is outbound only. `/settings/api-keys` holds PIM personal tokens, not channels. [A6 §1.7–1.9]
- Other surfaces: [A6 §1.11]
  - `AppNavRail` and `ProductsNextClient` read `/api/connections`; `GlobalAccountChip`/`AccountSwitcher` show the worst health.
  - The listing wizard's Step1Channels uses a fourth definition of "connected".
  - The inventory `SyncTriggerButton` fakes a sync: a Next route invents a `syncId`, and the status route hard-codes success 100%.
  - `ChannelResolverClient` posts to a relative route that 404s in prod.
  - `RealTimeStockMonitor` is dead.
  - The `channel-publish` dashboard is sandbox-only.
  - The sync-logs cron "trigger" is the only "run now" button.
- Design system: only AccountsPanel, the Card adapter and Listbox use it. The channel detail, callback, webhooks and advertising screens are Tailwind with native `confirm`/`alert`. Every CX screen must move to the design system (rule 7). [cx-audit §6.3][A6 §1.1]
- Every error string the connect UI can show is catalogued for the copy audit. [cx-audit §6.4]
- Routes: 157 channel routes. 77 have an in-app caller and 80 do not: 25 inbound receivers, 7 reached only from scripts, and 48 with no caller anywhere. The 48 are: all of `shopify.ts` (7), `etsy.ts` (6), `woocommerce.ts` (6), `marketplaces.ts` (8, 2 never registered), `amazon-ads-auth` (4), `shopify-setup` (2), probe, diagnostics, `ebay-auth` ×3, and others. [cx-audit §6.2][A6 §2.4]
- Registration oddities: [cx-audit §6.1]
  - `ebay-auth.ts`, `shopify*.ts`, `woocommerce*.ts`, `etsy*.ts`, `marketplaces.ts` and `webhooks.routes.ts` are registered without `/api`.
  - There are two `marketplaces` namespaces.
  - Dead manifest rules: `:134` (the Shopify setup rule matches nothing), `:138` (shadowed by the PUBLIC `:82`), `:390` (inventory-sync diagnostics).
- Docs on 08-29: 4 current (`INVENTORY-SYNC.md`, `ebay-integration-map.md`, `FULFILLMENT-PER-CHANNEL.md`, `2026-08-19-map-multi-account-profiles.md`), 7 partly stale, 11 dead (for example `MARKETPLACE-API-DOCUMENTATION.md` calls never-registered routes "Production Ready", and the `AMAZON-SYNC-*` set describes the fake sync). [cx-audit §6.5][A6 §3]

### What production showed (A0)
Read-only checks on 2026-08-28/29. Web: nexus-commerce-three.vercel.app; API: Railway.
- Channels page: [A0]
  - Amazon "Env-managed" (seller AFXSELLER8BC38).
  - eBay "Connected" (xaviaracing, token expires in 1h 12m, last sync 47m ago).
  - Shopify/Woo/Etsy "Coming soon" with a disabled "Connector deferred" button.
- AccountsPanel: Amazon 1 (env, "Healthy · no name from the channel"); eBay 2: xaviaracing (primary) and motovento. [A0]
- Test → "Connection OK. Seller: eBay seller (verified)" (a placeholder). Diagnose → marketplace-scoped EBAY_IT "OK". [A0]
- The eBay authorize URL on prod: `client_id=Muhammad-XaviaRac-PRD-…`, RuName `Muhammad_Awais-Muhammad-XaviaR-bnkamqjw`, 6 scopes, state = payload.HMAC. [A0]
- eBay detail: connected since 03/07/2026, no scopes captured, IT/DE/FR/ES/UK pickers, 0 webhook events ever. Amazon detail: "Last sync: never", 50 OK events, connected since 06/05/2026, 5 pickers (though 11 markets participate). [A0]
- Advertising: 9 connections (DE/ES/FR/IT live + writes; IE/NL/PL/SE/UK sandbox). The add form is paste-only, with no "Connect with Amazon" control. [A0]
- Mappings: Amazon DE 111 / ES 109 / FR 109 / IT 166 fields; eBay IT 41 and DE/ES/FR/UK 21; 0 rules anywhere. Outbound webhooks: 0 subscriptions. API keys: 0. [A0]
- DB — ChannelConnection: 14 rows. [A0]
  - Amazon 1: env row, tokens NULL, `lastSyncAt` NULL, `lastSyncStatus` SUCCESS.
  - eBay 13: 2 active and 11 inactive leftovers (5 all-NULL rows from 2026-05-02/03, 3 named "eBay seller (verified)", 1 superseded duplicate, 1 empty placeholder from 2026-08-20).
  - eBay tokens are plaintext (`v^1.1#`, access 2,504 chars, refresh 96), and the legacy columns are filled too.
  - `connectionMetadata` is NULL on all rows.
- AmazonAdsConnection: 9 rows with the same encrypted prefix `v1:pJXnz1CNl` (one blob copied 9 times). `lastVerifiedAt` is 2026-05-18 on all; `tokenExpiresAt` 2027-05-17 is an estimate; `lastWriteAt` 2026-08-28. [A0]
- WebhookEvent: Amazon only. ANY_OFFER_CHANGED 2,797; ORDER_CHANGE 1,348; ORDER_STATUS_CHANGE 1,013 (stopped 2026-07-29). All processed, 0 errors, signature NULL. Zero rows for eBay, Shopify, Etsy and Woo. [A0]
- CronRun (24 h): [A0]
  - Run counts: amazon-sqs-poll 1,440; ams-sqs-poll 1,440; ebay-orders-sync 288; amazon-orders-sync 96; amazon-inventory-sync 96; ebay-token-refresh 48; ebay-readback 48; sync-drift-detection 48; amazon-returns-poll 24; ebay-listing-discovery 6; amazon-notifications-setup 1 (at deploy).
  - **ebay-financial-sync FAILS daily**: `GET /finances/v1/transaction` → 403 errorId 215001.
  - No Etsy, Shopify or Woo job has ever run.
- Marketplace: Amazon 11 EU markets PARTICIPATING (BE DE ES FR IE IT NL PL SE TR UK; last checked 2026-06-24) + US inactive; eBay DE ES FR IT UK; ETSY/SHOPIFY/WOO GLOBAL rows. [A0]
- MarketplaceSync: 242 rows, all FAILED, last on 05-03 (dead). SyncChannelPolicy 0; Channel 0; SyncHealthLog: 2,285 Amazon and 7,714 eBay unresolved (still being written). [A0]
- Orders: Amazon 4,433 (4,390 attributed to a connection); eBay 4. AuditLog: no connect/oauth/token actions ever. [A0]
- Unauthenticated HTTP: `/api/connections` 401; `/api/ebay/auth/test` 401; `/api/amazon-ads/auth/connect` **302 to Amazon consent**; ads callback 400; `amazon-auth-probe` 404. [cx-audit §7]

## Channel by channel

### Amazon SP-API
**How we connect today**
- On 08-29 the LWA refresh token came from env (`AMAZON_REFRESH_TOKEN`, read in 31 files) with `AMAZON_LWA_CLIENT_ID/SECRET`. No seller OAuth existed (no `spapi_oauth_code` anywhere in the code). [A3 §1]
- At boot, `seedEnvManagedConnections()` creates `ChannelConnection{AMAZON, managedBy:'env'}`. [A3 §1]
  - It is `isActive` only if six env vars are set, including the `AWS_*` keys and `AWS_ROLE_ARN`, which the SP library never uses.
  - It stamps `lastSyncStatus` SUCCESS, and sets `displayName` = seller id.
- Region: one global `AMAZON_REGION` (default eu).
  - The default marketplace is IT `APJ6JRA9NG5V4`, and `XAVIA_ACTIVE_MARKETPLACES` = IT/DE/FR/ES/UK is hard-coded.
  - Two routes misuse the region as a marketplace code (they produce `AMAZON_EU`).
  - Three more region env names exist (`AMAZON_SP_REGION`, `AMAZON_SP_API_REGION` defaulting to "na", `AMAZON_DEFAULT_MARKETPLACE`).
  - NA and FE are not supported.
  [A3 §1]
- Per the 09-08 doc:
  - Seller credentials now sit in the encrypted connection store. Env access is only a migration path for a row explicitly marked env-managed.
  - The registered app is private, and its supported authorization is through the Solution Provider Portal.
  [amz-review]

**API calls we use today**
- Areas with their own SP-API client or LWA exchange: [A1 §Dead][A3 §1]
  - flat-file routes, cockpit publish, reports, settlements, pricing, Data Kiosk, image feed, pushback + Buy Shipping, batch feed, order cancellation, `amazon.service`;
  - hand-rolled LWA calls in FBA inbound v2, A+ pull, financial events, participations, channel reconciliation, and the `/aplus/probe` and `/finance/probe` routes.
- Reads: `getOrders`/`getOrder` + order items (v0); FBA inventory summaries; report `GET_MERCHANT_LISTINGS_ALL_DATA`; `getMarketplaceParticipations` (on demand only). Writes: `putListingsItem`/`patchListingsItem` (live read/write probe route); `createFeedDocument` + `JSON_LISTINGS_FEED`. [A3 §6, §9][A5 E18]
- Notifications: grantless `GET/POST /notifications/v1/destinations`, `getGrantlessToken('sellingpartnerapi::notifications')`, subscriptions per type. [A3 §4]
- Rate limits: [A3 §3]
  - The hand-rolled client waits 200 ms between calls globally and retries 1/2/4 s.
  - Library instances use `auto_request_throttled` (feeds wrapped in a 25-second `withTimeout`).
  - The publish gate allows 2 rps, burst 20.

**How product changes reach it today**
- Through the queue: E12 `syncToAmazon`, behind `NEXUS_ENABLE_AMAZON_PUBLISH` + `AMAZON_PUBLISH_MODE` (gated/dry-run/sandbox/live); sandbox mode swaps the host. [A3 §6][A5 §7]
- Directly: the listing publish route (`putListingsItem`); the flat-file submit (`JSON_LISTINGS_FEED` → `AmazonFlatFileFeedJob`, polled `*/2`); the pricing dispatcher; the cockpit publish. [A5 E18]
- Guards: the EU shared-quantity guard (`NEXUS_EU_SHARED_QTY_GUARD` kill switch), the publish-gate circuit, and the quantity resolver at dispatch. [A3 §6][A5 §7]
- Dead or dangerous: `variation-sync-processor` (straight to SP-API, USD); E6 `inbound-sync` (Vacuum). [A5]

**What is broken or missing**
- Before 09-08: no seller OAuth, one region, env-only, no revoke, and a boot-time status that lies. [A3]
- Auth is built 19 different ways (14 SellingPartner + 5 LWA). The token cache is fixed at 50 minutes, has no lock, and a 401 does not evict. No `Retry-After` / `x-amzn-RateLimit-Limit` handling. [A3 §2–3]
- Notifications: [A3 §4][R1 §D][A0]
  - Still subscribed to `ORDER_STATUS_CHANGE`, which Amazon removed 2026-07-29.
  - No SNS or `SellerId` check, and the queue policy allows any SNS topic.
  - "8 subscriptions" is claimed, but there are 7.
  - The `LISTINGS_ITEM_*` family (status, issues, MFN quantity) is not subscribed.
- Participations are checked on demand only (last 2026-06-24). Account health is computed locally. There is no heartbeat. [A3 §9]
- Data dropped: FBA inbound/reserved quantities, catalog fields past the 9 TSV fields, and typed order fields. [A3 §6]
- Dead: `amazon-catalog.service` (static token, 'na'); root `amazon-sync.service` status endpoint (always 404); two unrelated `amazon-sync.service.ts` files. [A3 §10]
- `AMAZON_REGION` is misused as a marketplace code, and 4 jobs are missing from the cron registry. [A3 §10]
- The public write-capable probe (S5). [A3 Sec#2]

**What the research recommends**
- Auth for a public app (website OAuth): [R1 §A1]
  - Send the seller to `https://<Seller Central host of region>/apps/authorize/consent?application_id=…&state=…[&version=beta while Draft][&redirect_uri=…]`.
  - The callback returns `state`, `selling_partner_id`, `spapi_oauth_code`. The code dies in 5 minutes, and the whole flow must finish in 10.
  - Exchange at `POST https://api.amazon.com/auth/o2/token` (`authorization_code`, then `refresh_token`).
  - Set `Referrer-Policy: no-referrer`. An Appstore-start variant uses `amazon_callback_uri` + `amazon_state`.
- Tokens: [R1 §A1][R1 §G]
  - The access token lasts 1 h and goes in `x-amz-access-token` (max 2048 bytes).
  - The refresh token is not rotated, and it survives a client-secret rotation.
  - Public apps must re-authorise every 365 days, and whenever a role is added.
  - The client secret expires after 180 days. The self-auth refresh-token lifetime is unverified.
- One grant = one region: [R1 §A1, §G]
  - EU endpoint `sellingpartnerapi-eu.amazon.com` (eu-west-1) covers UK DE FR IT ES NL PL SE BE IE TR, plus AE SA EG ZA and IN.
  - NA and FE need separate grants.
  - A wrong region is a 403 "Region mismatch", so route each call by the region of its grant.
- EU marketplace ids: UK `A1F83G8C2ARO7P`, DE `A1PA6795UKMFR9`, FR `A13V1IB3VIYZZH`, IT `APJ6JRA9NG5V4`, ES `A1RKKUPIHCS9HS`, NL `A1805IZSGTT6HS`, PL `A1C3SOZRARQ6R3`, SE `A2NODRKZP88ZB9`, BE `AMEN7PMS3EDWL`, IE `A28R8C7NBKEWEA`, TR `A33AVAJ2PDY3EV`. [R1 §A1]
- Registration: [R1 §A2–A3]
  - The Solution Provider Portal is the single console. The primary account user registers, with a dev profile of ≤500 words, a security questionnaire, a Data Protection Policy and a roles review.
  - Private app: self-authorization only, max 10, and only by the account's primary user.
  - Public app: 25 OAuth authorizations while unlisted, unlimited once listed on the Appstore, plus 10 self-auths for testing. Over the cap → `CONSENT_LIMIT_REACHED`.
- Roles (4 are restricted and need extra verification + RDT): Account Information SP, Amazon Fulfillment, AWD, Brand Analytics, Buyer Communication, Buyer Solicitation, **Direct-to-Consumer Shipping (restricted)**, Finance and Accounting, Inventory and Order Tracking, Notifications in Seller Central, Payment Initiation SP, Pricing, Product Listing, **Professional Services (restricted)**, Selling Partner Insights, **Tax Invoicing (restricted)**, **Tax Remittance (restricted)**. [R1 §A2]
- Authorization errors: `MD1000` (draft without `version=beta`), `MD5101` (redirect mismatch), `MD5110` (`#` in redirect), `MD9100`, `SPDC8143` (not the primary user), `SPSA0404`, `SPSA2043`. [R1 §A1]
- Revocation: the seller clicks "Disable authorization" in Manage Your Apps. The app gets no push notification, only 403 "Expired or revoked" (LWA `invalid_grant`). [R1 §A1]
- Grantless scopes: `sellingpartnerapi::notifications` (destinations, and subscription get/delete by id), `::client_credential:rotation`, `::shipments:track`. The Authorization API and `::migration` are gone. [R1 §A2]
- RDT: `POST /tokens/2021-03-01/restrictedDataToken`, 1 rps / burst 10. It is needed for order address/buyer info, restricted reports, Merchant Fulfillment, Easy Ship and External Fulfillment. Pass the RDT in `x-amz-access-token`. [R1 §A2]
- API versions to use: [R1 §B]
  - Listings Items 2021-08-01 + Product Type Definitions (JSON Schema) + `JSON_LISTINGS_FEED`.
  - Catalog Items 2022-04-01.
  - **Orders v2026-01-01** (`getOrder` + `searchOrders`, includedData) — v0 is removed 2027-03-27.
  - **Finances 2024-06-19** (`listTransactions/listSummary/listBalances`) — v0 is removed 2027-08-27.
  - Inbound 2024-03-20; Outbound (MCF) 2026-07-04; Pricing 2022-05-01; Reports/Feeds 2021-06-30; Promotions 2025-12-01; Tracking 2026-01-30.
  - Also: Data Kiosk (GraphQL), Vehicles (EU fitment), Listings Restrictions, Transfers (EU payout), Seller Wallet, Messaging, Solicitations, A+ Content, Uploads, Supply Sources, Application Integrations.
  - About 45 sections in all.
- Legacy listing feeds were removed 2025-12-03: `POST_PRODUCT_DATA`, `POST_INVENTORY_AVAILABILITY_DATA`, `POST_PRODUCT_PRICING_DATA`, `POST_FLAT_FILE_LISTINGS_DATA`, `POST_FLAT_FILE_PRICEANDQUANTITYONLY_UPDATE_DATA`, and more. Order and FBA feeds remain (for example `POST_ORDER_FULFILLMENT_DATA`, `UPLOAD_VAT_INVOICE`). [R1 §B]
- There are 15 report families. Two settlement types are removed 2026-11-11. [R1 §B]
- Rate limits: [R1 §C]
  - A token bucket per (operation × seller × app × region).
  - `x-amzn-RateLimit-Limit` is advisory — don't depend on it being there.
  - 429 = `QuotaExceeded` (retryable). Plans adjust dynamically to seller metrics, not to call volume.
  - Code against notifications and batch calls. The sandbox allows 5 rps / burst 15.
- Notifications: [R1 §D]
  - Destinations: SQS **standard** queues only, or one EventBridge destination per AWS account.
  - `createSubscription` runs per type per seller, with the seller's token. Options: `processingDirective.eventFilter` and `filterExpression` (CEL, since 2026-05).
  - The SQS policy principal is `arn:aws:iam::437568002678:root` (add KMS grants if the queue uses SSE).
  - Messages are raw JSON with no signature. Order is best-effort and duplicates happen, so dedupe on `NotificationId` and keep a reconciliation poll.
- Types a PIM should subscribe to: `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE` (v1.0 removed 2026-08-26), `LISTINGS_ITEM_MFN_QUANTITY_CHANGE`, `ITEM_PRODUCT_TYPE_CHANGE`, `PRODUCT_TYPE_DEFINITIONS_CHANGE`, `BRANDED_ITEM_CONTENT_CHANGE`, `ORDER_CHANGE` (with `OrderChangeType` filter), `FEED_PROCESSING_FINISHED`, `REPORT_PROCESSING_FINISHED`, `ANY_OFFER_CHANGED`, `PRICING_HEALTH`, `FBA_INVENTORY_AVAILABILITY_CHANGES`, `ACCOUNT_STATUS_CHANGED`. [R1 §G]
- Secret rotation: every 180 days, with 90 days' notice; the old secret dies 7 days after a new one is made. [R1 §G]
  - `rotateApplicationClientSecret` delivers the new secret ONLY to the preregistered SQS queue (`APPLICATION_OAUTH_CLIENT_NEW_SECRET`).
  - `APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY` warns ahead.
- Sandbox: static (pattern-matched) and dynamic (stateful). Auth is the same as prod, and RDTs must be minted in prod. [R1 §E]
- Design notes: [R9a][R8]
  - From Airbyte: an RDT authenticator on top of LWA with a 403 fallback; waiting `1/x-amzn-RateLimit-Limit` after a 429; reusing a recent DONE report.
  - The Nango SP-API entry models `spapi_oauth_code`, `selling_partner_id`, applicationId/domain/region, but has no RDT, no retry and no marketplace ids.

**Open questions**
- Stay private (self-auth through the Solution Provider Portal, primary user, ≤10 accounts) or register a public app (review, yearly re-auth, 25 unlisted)? The 09-08 doc says the app is private and a disconnected private account needs replacement authorization. [amz-review][R1 §A3]
- Has `ORDER_STATUS_CHANGE` been removed from the subscription list and the `LISTINGS_ITEM_*` types added? [A3 §4][R1 §G]
- Plan the Orders v0 → v2026-01-01 migration (deadline 2027-03-27) and Finances v0 → 2024-06-19 (deadline 2027-08-27). [R1 §B]
- What is the real SQS queue policy? Does the code's SNS-envelope unwrap match raw SP-API messages? [A3 §4][R1 §D]
- Will NA/FE ever be needed (one grant per region)? [R1 §A1]
- Who rotates the LWA secret every 180 days, and is the rotation SQS queue registered? [R1 §G]

### Amazon Ads
**How we connect today**
- On 08-29: a paste form (Profile ID, label, marketplace, region, LWA Client ID, Client Secret, Refresh Token) → `POST /api/advertising/connections`.
  - The setup guide tells the operator to run LWA consent themselves and set `NEXUS_AMAZON_ADS_MODE=live` in Railway.
  - An OAuth route exists but is not wired.
  - Prod has 9 profiles sharing one encrypted blob.
  [A0][A3 §5]
- Per the 09-08 doc: account names are shared across advertising profiles, and a live Amazon Ads heartbeat passed (127 ms). [amz-review]

**API calls we use today**
- `/v2/profiles` (EU host only); campaign entity sync hourly; reports daily; polling `*/3`; AMS via SQS; the debug route creates `/reporting/reports` jobs. [cx-audit §1.1][A3 §5]
- Rate limits: a regional hourly ledger `amz:ads:<region>`, 9000/3600 s (Redis, memory fallback). Reads fail open and writes fail closed. It honours `Retry-After`, backs off exponentially up to 8 s with full jitter, and `NEXUS_AMAZON_ADS_QUOTA_MODE=off` bypasses it. [A3 §3]

**How product changes reach it today**
- Writes are gated per profile: mode production + `writesEnabledAt`, set through a two-step preview → enable (confirmation token), plus campaign allowlisting (`/campaigns/live-writes/bulk`). [A6 §1.10]

**What is broken or missing**
- S4 (public OAuth routes, no state check); the NA consent host is used for EU; EU-only profile discovery; `region:'EU'` is hard-coded. [A3 §5]
- `lastVerifiedAt/lastErrorAt/lastError` are never written. There is no alert for the 365-day cliff. Rotation is ignored. The manual form does not stamp `tokenIssuedAt`. Delete never revokes. [A3 §5]
- The app client secret is copied into every row. The `MARKETPLACE_COUNTRY` map is wrong. The debug route leaks prefixes and fires live reports. [A3 §5]
- AMS: nothing is stored, no signature is checked, and the public HTTP ingest lets everything through when its secret is unset. [A3 §4]

**What the research recommends**
- Consent is per region: NA `www.amazon.com/ap/oa`, **EU `eu.account.amazon.com/ap/oa`**, FE `apac.account.amazon.com/ap/oa`. [R1 §F]
  - Params: `client_id`, `scope`, `response_type=code`, an HTTPS `redirect_uri` listed in Allowed Return URLs, and `state`. PKCE is recommended. The code is single-use and dies in 5 minutes.
  - The token host differs by region (EU `api.amazon.co.uk/auth/o2/token`), but the tokens work globally.
- Access token 60 min. The refresh token is not rotated. **Refresh tokens issued on or after 2026-07-30 expire 365 days after consent**. Revoke, expiry or a credential change → 400 `invalid_grant`. [R1 §F]
- Scopes: `advertising::campaign_management`; `advertising::test:create_account`; `advertising::audiences` (needs separate approval). Every call sends `Amazon-Advertising-API-ClientId`, Bearer, and `Amazon-Advertising-API-Scope: <profileId>`. [R1 §F]
- Profiles: `/v2/profiles` returns only the region of the host you call (max 5000). One token covers every profile the login manages. Endpoints: NA `advertising-api.amazon.com`, EU `advertising-api-eu.amazon.com`, FE `advertising-api-fe.amazon.com`. [R1 §F]
- Rate limits are dynamic, with `Retry-After`. Report queues are tiered, so spread backfills. Extended-data list calls weigh 5×, so prefer Exports. [R1 §F]
- Surface: v1 common model (SP/SB/SD/STV/DSP), SP v3, Reporting v3, Exports, AMS, DSP, Data Provider, test accounts, user permissions, Brand Metrics, Insights, Stores, Posts, Billing. Attribution, Portfolios and Change history are unverified. [R1 §F]
- AMS: [R1 §F]
  - Hourly deltas: dedupe on `idempotency_id`; restatements arrive as new deltas.
  - Datasets: `sp-traffic/conversion`, `sb-*`, `sd-*`, `budget-usage`, recommendations, `ads-campaign-management-*`.
  - Delivery to an SQS standard queue or Firehose, in eu-west-1 for EU.
  - One subscription per profile × dataset. The SNS `SubscriptionConfirmation` must be confirmed within 3 days.
  - Subscriptions are archived, not deleted. There is no backfill, and times are in the profile's timezone.
- App approval: create an LwA profile → apply as a Partner (Partner Network) or a Direct Advertiser (≤1 business day) → an email link assigns the scope, and that assignment is permanent. [R1 §F]
- Airbyte models profiles as a partition via the Scope header, with 53 streams and at most 10 async report jobs at once. [R9a]

**Open questions**
- Wire a "Connect with Amazon" button (EU host, state + PKCE, session-bound) and retire the paste form? [cx-research B1.2][R1 §F]
- When do the current Ads tokens expire? Their rows show an estimated 2027-05-17. Tokens issued after 2026-07-30 get a hard 365-day expiry. [A0][R1 §F]
- Keep the 9-row copy of one blob, or move the app secret into `ChannelApp`? [cx-research B3#13]

### eBay
**How we connect today**
- The only real OAuth flow on 08-29: [A4 §1]
  1. Popup → `POST /api/ebay/auth/initiate` (HMAC-signed state) → `auth.ebay.com/oauth2/authorize` (RuName, `prompt=login`).
  2. The callback page creates a placeholder row → `POST /api/ebay/auth/callback` exchanges the code (Basic auth).
  3. It reads `/sell/account/v1/privilege` (which returns a literal placeholder name) and `apiz.ebay.com/commerce/identity/v1/user/`.
  4. Identity rules: re-consent folds into the matching `externalAccountId`; `EBAY_IDENTITY_UNMATCHED` (409); `EBAY_IDENTITY_UNAVAILABLE` (409).
  5. The page posts a message to the opener and closes.
- Scopes (6): `api_scope`, `sell.account`, `sell.inventory`, `sell.fulfillment`, `sell.marketing`, `commerce.identity.readonly`. [A4 §1]
- Tokens are plaintext and dual-written. 2 accounts are active (xaviaracing primary, motovento). [A0]

**API calls we use today**
- Identity: `/identity/v1/oauth2/token` (exchange/refresh) and `/token/revoke`.
- Sell: Fulfillment `GET /sell/fulfillment/v1/order`; Feed `/sell/feed/v1/task`; Inventory `inventory_item`, `inventory_item_group`, `offer`, `location`, `publish`; Account `/privilege`; Finances `/sell/finances/v1/transaction`.
- Other: Post-Order `/post-order/v2/return/search`; Marketing (ads) with a 9000/day Redis budget.
- Trading: `GetItem`, `AddFixedPriceItem`, `ReviseInventoryStatus`, `ReviseFixedPriceItem`, `EndFixedPriceItem`, `SetNotificationPreferences` (header `X-EBAY-API-IAF-TOKEN`).
- Legacy app-token `EbayService`.
[A4 §5–8, §11]
- Rate limits: parallel batch 8 (cap 32), 429 backoff `1s·2^n` ×3; status reconcile 20 per 500 ms; Trading read-back 300 ms apart. No rate-limit headers are read. [A4 §7]

**How product changes reach it today**
- E12 `syncToEbay` through the queue: eBay 400/404/409/422 are terminal. [A5 §6]
- Push-mode split: [A4 §8]
  - Feed API for unique-SKU pushes over 50 rows;
  - Trading for shared-SKU listings;
  - Inventory API for unique SKUs (flat-file routes, `ebay-variation-push`, cockpit).
- `NEXUS_EBAY_REAL_API` must be true for the Trading lane. The label guard writes `ReviseFixedPriceItem`. [A4 §6, §8]

**What is broken or missing**
- Scopes: 6 of about 20; none recorded (`connectionMetadata.scopes` has no writer). Finances fails with 403 215001 because the RFC 9421 signature is missing (and `sell.finances` too). [A0][A4 §10]
- Webhooks: [A4 §5]
  - The wrong verification scheme, skipped when unset.
  - No Notification API subscriptions.
  - `MARKETPLACE_ACCOUNT_DELETION` not handled.
  - SOAP notifications cannot be parsed.
  - A `Date.now()` idempotency key.
  - 0 events on prod.
- Orders: [A4 §6, §8]
  - The rolling fetch is not paginated and its filter is malformed.
  - No raw payload is kept, and the marketplace is always `EBAY-GLOBAL`.
  - Orders are not attributed to an account → wrong-seller pushback.
- Refresh: no lock; the 18-month expiry is untracked; failure overwrites the sync status; success fakes "Last sync". [A4 §3]
- Disconnect has two paths, and one keeps the tokens. The state can be replayed and the callback `connectionId` is unchecked. [A4 §9, Sec#4]
- Returns reads the first page only. Financial sync runs for the primary account only, on server-local "yesterday". The app-token lanes cannot reach seller data. `ebay-sync.service` calls a wrong endpoint. [A4 §6, §11]
- Clutter: 12 routes with no caller; two Trading-API callers with different env names; `EBAY_ENVIRONMENT` casing conflict; legacy columns. [A4 §11]

**What the research recommends**
- Auth: [R2 §A]
  - Authorize at `auth.ebay.com/oauth2/authorize` (`client_id`, `redirect_uri`=RuName, `response_type=code`, space-separated `scope`, `state`, `prompt=login`, `locale`).
  - The code is single-use, about 299 s. The token endpoint uses Basic auth.
- Tokens: [R2 §A]
  - Access token 7200 s.
  - Refresh token `refresh_token_expires_in: 47304000` (about 18 months), **not rotated**.
  - The refresh `scope` must be a subset of the consent scopes, and **adding any scope later needs a new grant from every user**.
  - A password or login-name change revokes the tokens. Revoke: `…/token/revoke`. Introspect: `…/token/introspect` (`active:false` when revoked).
- Token-mint limits per day: client_credentials 1,000; authorization_code 10,000; refresh_token 50,000. Guidance: refresh after an "Invalid access token" error (401, errorId 1001). [R2 §A]
- One grant covers every marketplace. This is inferred (the marketplace is chosen per request via `X-EBAY-C-MARKETPLACE-ID`); no explicit sentence confirms it. [R2 §A]
- Sandbox and production have separate keysets, RuNames and possibly different scope sets. [R2 §A]
- Trading API v1477 accepts OAuth via `X-EBAY-API-IAF-TOKEN`. Which scopes each call needs is unverified. [R2 §A]
- Full EU seller scope set (about 20): [R2 §B]
  - `sell.inventory(.readonly)`, `sell.account(.readonly)`, `sell.marketing(.readonly)`, `sell.fulfillment(.readonly)`
  - `sell.finances`, `sell.payment.dispute`, `sell.analytics.readonly`, `sell.logistics`, `sell.stores`, `sell.listing.read`
  - `sell.cancellation(.read)`, `sell.return(.read)`, `sell.inquiry(.read)`
  - `commerce.identity.readonly`, `commerce.notification.subscription(.readonly)`, `commerce.catalog.readonly`, `commerce.message`, `commerce.feedback`, `commerce.shipping`
  - Unverified: `sell.reputation`, `sell.item(.draft)`, `commerce.identity.status.readonly`.
  - Gated: `commerce.vero` (VeRO members only), Buy scopes (extra licence), `sell.edelivery` (China only), `sell.leads` (limited).
- Prerequisites: [R2 §C]
  - **A marketplace account-deletion endpoint, live BEFORE the first production call** (or an opt-out if no eBay data is stored).
    - Challenge: `GET ?challenge_code` → SHA-256(code + token + endpoint); the token is 32–80 characters.
    - Payloads: userId/eiasToken. Ack with 200/201/202/204.
    - After 24 h unacknowledged the URL is marked down; after 30 days, non-compliant.
  - The Application Growth Check is needed to raise limits or use restricted APIs.
  - The Inventory API needs `optInToProgram(SELLING_POLICY_MANAGEMENT)` (it can take 24 h) plus payment, return and fulfillment policies per marketplace.
  - Listings created through the Inventory API are locked away from Seller Hub. `bulkMigrateListing` takes 1–5 ids.
- Digital signatures (mandatory for EU/UK sellers): [R2 §H]
  - Needed on every Finances method, Fulfillment `issueRefund`, Trading `GetAccount`, and the Post-Order refund/return/cancellation approvals.
  - Headers: `x-ebay-signature-key` (JWE public key from the Key Management API `createSigningKey`, ED25519 recommended), `Content-Digest`, `Signature`, `Signature-Input` covering `("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created`.
  - Failures: 403 with codes 215000–215122. eBay never stores the private key.
  - The sandbox can test signing only if the test user is domiciled in the EU/UK.
- API surface (versions from the specs): [R2 §D]
  - Sell: Account v1.9.3 (+ v2), Analytics 1.3.2, Feed 1.3.1, Finances 1.19.0 (`apiz`), Fulfillment 1.20.7, Inventory 1.18.5, Logistics v1_beta, Marketing 1.23.2, Metadata 1.12.1, Negotiation, Recommendation, Stores.
  - Commerce: Catalog v1_beta, Identity v2.0.0, Media v1_beta (images/video/docs; replaces `UploadSiteHostedPictures`, which ends **2026-09-30**), Notification 1.6.7, Taxonomy 1.1.1, Translation, VeRO v2, Message, Feedback.
  - Developer: Analytics (`getRateLimits/getUserRateLimits`), Key Management.
- Gone or going: [R2 §D]
  - Gone: Compliance API (decommissioned 2026-03-30); Finding/Shopping (2025-02-04); Product API (2026-08-15); Trading `GetCategories/GetCategoryFeatures/GetCategoryMappings` (use Taxonomy/Metadata); 29 Post-Order methods decommissioned in 2026; `setupQuickCampaign/launchCampaign` (2026-03-31); `ItemMarkedPaid` (2026-06-22).
  - Scheduled: `GetAdFormatLeads` → 2026-09-21; shipping discount profiles → 2027-01-19.
- Trading-only capabilities still in use: `ReviseFixedPriceItem`, `ReviseInventoryStatus`, `GetItemTransactions`, `GetMyeBaySelling`, `GetBestOffers/RespondToBestOffer`, `SetStoreCategories`. [R2 §D]
- Events (Commerce Notification API): [R2 §E]
  - Setup: `createDestination` (the challenge) → `getTopics` → `createSubscription`.
  - Verify: Base64 `X-EBAY-SIGNATURE` → `getPublicKey/{kid}` (app token, cache about 1 h) → ECC check. 3 delivery attempts.
  - 29 topics, including `ORDER_CONFIRMATION`, `ITEM_MARKED_SHIPPED`, `ORDER_CANCELLATION_ACTIVITY`, `ORDER_RETURN_ACTIVITY`, `ORDER_INQUIRY_ACTIVITY`, `OFFER_ACTIVITY`, `LISTING`, `AUTHORIZATION_REVOCATION`, `MARKETPLACE_ACCOUNT_DELETION`, `NEW_MESSAGE`, `BUYER_QUESTION`, `FEEDBACK_*`, `PLA_CAMPAIGN_BUDGET_STATUS`, `SELLER_STANDARDS_PROFILE_METRICS`.
  - There is **no ITEM_SOLD topic and no order-status topic**, so poll `getOrders?filter=lastmodifieddate:[…]`.
  - Legacy Trading platform notifications are SOAP (up to 25 URLs), and eBay itself says to keep polling. Client Alerts status is unverified.
- Rate limits (per app per day): Inventory 2M; Fulfillment 100k; Finances 15k; Account 25k; Feed 100k; Marketing Ads 10k; Trading 5k; Post-Order 5k per resource; Notification 10k; Taxonomy/Identity 5k; Media 1M images (50 POST per 5 s per user). 429 = ACCESS error 2001. Read reset times from Developer Analytics. [R2 §F]
- Bulk: [R2 §F]
  - `bulkCreateOrReplaceInventoryItem` and `bulkPublishOffer` take 25 each; `bulkMigrateListing` takes 1–5.
  - Feed LMS types: `LMS_ADD/REVISE/END/RELIST_FIXED_PRICE_ITEM`, `LMS_REVISE_INVENTORY_STATUS`, `LMS_ORDER_ACK`, `LMS_SET_SHIPMENT_TRACKING_INFO`, `LMS_ACTIVE_INVENTORY_REPORT`, `LMS_ORDER_REPORT`.
  - Errors come back in the result file.
- Also: [R2 §H]
  - From 2025-09-26 usernames are being replaced by immutable userIds, so key accounts on the userId via Identity `getUser`.
  - Out-of-Stock control keeps a listing at 0 for up to 90 days.
  - Real-time Inventory Check.
  - Translation API for IT/DE/FR/ES.
  - Right-of-Withdrawal return reasons; size standardisation from August 2026.
- Nango's eBay entry does not model the 18-month refresh expiry, the RuName, the marketplace or rate limits. [R8 §2]

**Open questions**
- Request the full set of about 20 scopes now? Both accounts would need a fresh re-consent. [R2 §A–B]
- Build Key Management signing (ED25519) for Finances and refunds? Without it, Finances stays 403. [R2 §H][A0]
- Is the account-deletion endpoint subscribed on the production keyset, or opted out? The code does not handle the topic. [R2 §C][A4 §5]
- Move from Trading `SetNotificationPreferences` to Notification API subscriptions? [R2 §E]
- Is `EBAY_NOTIFICATION_VERIFICATION_TOKEN` set on prod? If yes, every push is dropped; if not, the endpoint is open. [A4 Sec#1]
- How did the 4 eBay orders on prod get attributed, when `processOrder` ignores the id? [A0][cx-audit §1.4]

### Shopify
**How we connect today**
- On 08-29 there was no connect flow: only env vars `SHOPIFY_SHOP_NAME`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET` (plus an undocumented alias `SHOPIFY_ADMIN_API_TOKEN`), re-read in 8 files. [A2 §1]
  - No `ChannelConnection` row existed, so the card always said "Coming soon".
  - `.env.example` says `mystore.myshopify.com`, but the code appends `.myshopify.com` again.
- Per the 09-08/09-09 docs: [SE-0908][shop-local]
  - An OAuth connector exists: encrypted tokens, a `ChannelApp` row, a callback at `/api/cx/callback/shopify`, and a readiness check.
  - Locally, the Dev Dashboard app "Nexus Commerce" (org Xavia Racing 79081726) reached the Install screen for `xaviaracing.myshopify.com`. Consent is still pending.

**API calls we use today**
- REST `2024-01`, hard-coded in 6 clients that ignore `SHOPIFY_API_VERSION`: products, `inventory_levels/adjust`, fulfillments, images, `POST /webhooks.json`. [A2 §2, §10]
- GraphQL (`ShopifyEnhancedService`): products, inventory levels, orders, bulk mutation. [A2 §2, §10]
- 7 independent HTTP clients in total. [A2 §10]
- Rate limits: no 429, `Retry-After` or `extensions.cost` handling. A token bucket per instance starts at 0. Only the listing-wizard adapter retries 429 (fixed delays). The publish gate's circuit is keyed by shop domain. [A2 §7]

**How product changes reach it today**
- E12 `syncToShopify`: the only path behind the publish gate (`NEXUS_ENABLE_SHOPIFY_PUBLISH`/`SHOPIFY_PUBLISH_MODE`), using an inline REST client. [A2 §10][A5 E12]
- Also: image publish services; the listing-wizard adapter; the bulk-mutation service (via bulk actions); `channel-publish` (sandbox-only); the no-send `marketplaces/shopify-sync.service`. [A2 §10][A5]
- "Set inventory" actually sends `available_adjustment` (a relative change, not a set). [A2 §10]

**What is broken or missing**
- Webhooks: re-serialised HMAC, `===` compare, stored after processing, dedupe on `payload.id`, no `X-Shopify-Webhook-Id`, the refund replay bug, no compliance or `app/uninstalled` topics, and the unsigned test route. [A2 §5.1]
- Polling is never scheduled. It rescans everything, polls inventory N+1, keeps no cursor, duplicates orders (gid vs numeric id), hard-codes EUR and drops product fields. [A2 §6, §8]
- REST `2024-01` is legacy; the GraphQL orders query uses an invalid field. [A2 §2]

**What the research recommends**
- Auth options (the Dev Dashboard is where apps are made): [R3 §A.1–A.6]
  - Custom-distribution app + **authorization-code grant**: no review. One store per app, or several stores in one Plus org.
  - **Client-credentials grant**: for stores in our own Dev Dashboard org. No consent screen; 24 h tokens (`expires_in` 86399).
  - Admin-created custom apps **can no longer be made** (existing ones keep working).
  - A public app needs review, even when unlisted.
- Authorization-code contract: [R3 §A.2]
  - `https://{shop}/admin/oauth/authorize` with `client_id`, comma-separated `scope`, exact `redirect_uri`, `state`, optional `grant_options[]=per-user`.
  - Anchored shop regex `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$`.
  - Callback HMAC: drop `hmac`, sort the params, HMAC-SHA256, timing-safe compare.
  - Token at `POST https://{shop}/admin/oauth/access_token` (`expiring:'1'` is required for new public apps).
  - A write scope implies its read scope.
- Token lifetimes: [R3 §A.3]
  - Custom apps: offline tokens that never expire.
  - Public apps must use expiring offline tokens by 2027-01-01: 1 h access + 90-day refresh token, rotated on every refresh.
  - Online tokens: 24 h, no refresh.
  - Uninstall or a secret revocation ends access.
- Identity: `shop { id myshopifyDomain … }` needs no scope. Key each account on `shop.id` + domain. One token per shop. [R3 §A.7]
- Scopes: [R3 §B]
  - `read_all_orders` (older than 60 days) needs a request.
  - Protected customer data is "Always available" for custom apps.
  - Changing scopes on a standalone app means running the authorize URL again. `optional_scopes` exist.
  - `app/scopes_update` fires on a scope change; `currentAppInstallation.accessScopes` reads the current grant.
- API: [R3 §C]
  - GraphQL Admin only (REST is legacy since 2024-10, and new public apps have been GraphQL-only since 2025-04). Latest version `2026-07`.
  - A new version every quarter, each supported ≥12 months. `X-Shopify-API-Deprecated-Reason` lists what you use that is deprecated.
- Key PIM mutations: [R3 §C, §G]
  - `productSet` upsert (lists are replaced; max 2048 variants; synchronous in bulk).
  - `inventorySetQuantities` with a `compareQuantity` compare-and-set; `@idempotent(key:)` is mandatory from 2026-04 on inventory and refund mutations.
  - `stagedUploadsCreate` for media.
  - `translationsRegister` (≤20 locales).
  - Markets, catalogs and price lists.
  - `publishablePublish`, with variant-level publishing from 2026-07.
  - Metafield and metaobject definitions with `$app` ownership.
- Bulk: `bulkOperationRunQuery/RunMutation`. From 2026-01, up to 5 concurrent per type per shop. JSONL output with `__parentId`. A mutation file is ≤100 MB and must finish within 24 h. Bulk is exempt from rate limits. [R3 §C.3]
- Webhooks: [R3 §D]
  - Subscriptions defined in TOML apply to every shop; API-made ones are per shop. HTTPS, Pub/Sub or EventBridge. Filters and `include_fields` are available.
  - Verify HMAC-SHA256 over the RAW body with a timing-safe compare.
  - Dedupe on `X-Shopify-Webhook-Id`, and order events by `X-Shopify-Triggered-At`.
  - Answer within 5 s. Shopify retries **8 times over 4 hours**; after 8 failures, an API-made subscription is deleted.
  - Ordering and delivery are not guaranteed, so reconcile.
  - Mandatory: `customers/data_request`, `customers/redact`, `shop/redact` (48 h after uninstall, finish within 30 days).
- Rate limits: [R3 §E]
  - GraphQL restore rate: Standard 100, Advanced 200, Plus 1000, Enterprise 2000 points/s. One query ≤1,000 points.
  - REST: bucket 40, leak 2/s (Plus 400/20).
  - After 500,000 variants, at most 10,000 new variants per day.
- Sandbox: dev stores from the Dev Dashboard (Bogus gateway; they cannot become production stores). Custom apps can be installed on transfer-disabled dev stores. [R3 §F]
- From `@shopify/shopify-api`: a signed 60-second state cookie; sorted-query HMAC plus a 90-second timestamp window; `Session.isActive(scopes)` with implied scopes; webhook registration as reconcile-to-desired-state; `app/uninstalled` purges; `app/scopes_update` rewrites the scope. [R9 §5]
- Airbyte's Shopify connector: bulk streams with an adaptive time window, cancel-to-checkpoint via `partialDataUrl`, and throttling from `X-Shopify-Shop-Api-Call-Limit` at a 0.9 threshold. [R9a]

**Open questions**
- Custom distribution (auth code, one store unless Plus) or client credentials (our own org, 24 h tokens)? [R3 §A.4][shop-local]
- Approve the 7 restricted scopes held behind `ChannelApp.extra.approvedScopes`? Request `read_all_orders`? [shop-local][R3 §B]
- The production HTTPS callback, and actual consent on the deployed origin, are still to do. [SE-0908][shop-local]
- Retire the 7 REST clients and move to GraphQL `2026-07`? [A2 §10][R3 §C]

### Etsy
**How we connect today**
- On 08-29: env only (`ETSY_SHOP_ID`, `ETSY_API_KEY`, `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN`, `ETSY_WEBHOOK_SECRET`). [A2 §1, §3]
  - No refresh ever happened.
  - `x-api-key` was set to the access token instead of the keystring.
  - Endpoints were v2-shaped on a v3 base.
  - Every call was expected to fail (unverified).
- Per the 09-08/09-10 docs: [SE-0908][etsy-local]
  - An OAuth + PKCE connector exists, requesting all 12 scopes and sending `keystring:shared-secret`.
  - Locally the seller app "Nexus Commerce" (id 1513907185612, 10 QPS / 10K QPD) connected shop ItalianHideCraft (57783036).

**API calls we use today**
- On 08-29: `GET /shops/{id}/listings/active`, `/receipts?was_paid=true`, v2-style `/variations`, and `PATCH receipts … was_shipped`. The limiter's wait is discarded. [A2 §2, §6–7]

**How product changes reach it today**
- On 08-29: nowhere. Etsy cannot be dispatched in E12. [A5 E12]

**What is broken or missing**
- On 08-29: 6 made-up, unauthenticated webhook receivers (S2). Ingest writes columns that don't exist and throws. No raw data kept. No jobs scheduled. [A2]

**What the research recommends**
- Auth: [R4 §A.1]
  - OAuth 2.0 authorization code with **mandatory PKCE S256** (a 43–128-character verifier).
  - `https://www.etsy.com/oauth/connect` → `POST https://api.etsy.com/v3/public/oauth/token`.
  - The redirect URI must be HTTPS and match exactly (case-sensitive).
- Tokens: the access token lasts 1 h. The refresh token lasts 90 days and **is rotated on every refresh**, so store the newest one each time. The token format is `{user_id}.{token}`. [R4 §A.1]
- Every call sends `x-api-key: keystring[:shared_secret]` plus Bearer. `tokenScopes` introspects a token; `openapi-ping` checks the key. [R4 §A.1]
- There is no revoke endpoint. A 401 or 403 on refresh means the grant is lost → reconnect. [R4 §A.3]
- One grant = one shop (an Etsy user owns at most one shop), and `user_id` = shop id. [R4 §A.4]
- No sandbox: test on real shops, put "test" in titles, and cancel any accidental purchase. [R4 §A.5]
- Rate limits are per key (QPS + a sliding 24 h QPD). Headers: `x-limit-per-second`, `x-remaining-this-second`, `x-limit-per-day`, `x-remaining-today`. 429 + `retry-after`. `offset` maxes out at 12,000. [R4 §A.6]
- App tiers: [R4 §A.7]
  - **Seller App**: own shop only, approved in minutes.
  - Personal App: ≤5 shops, deeper review.
  - Commercial: needs review.
  - The application process was being revisited in 2026-05.
  - Terms: listing content may be at most 6 h stale, other content 24 h.
- EU gating: new keys for FR/DE shops (from 2025-07-17) lose `createReceiptShipment` and the receipt address fields unless the app is a Preferred Partner. Address fields are nullable. Whether a Seller App key counts as "new" is unverified. [R4 §A.8]
- 12 scopes: `address_r/w`, `email_r`, `listings_d/r/w`, `profile_r/w`, `shops_r/w`, `transactions_r/w`. [R4 §B]
- Surface: 76 paths. [R4 §C]
  - Listings: create draft, update, delete; images (≤20); 1 video; files; inventory through `updateListingInventory` (products/offerings/`*_on_property`, a 3rd variation via `max_variations_supported=3`); properties; variation images; translations (de, en, es, fr, it, ja, nl, pl, pt); personalization (≤5 questions).
  - Receipts: `createReceiptShipment` (emails the buyer); `updateShopReceipt` (`was_shipped/was_paid`).
  - Also: payments and ledger, shipping profiles, readiness states (mandatory for physical listings), return policies, sections, reviews (read-only), taxonomy.
- Absent from the API: messaging, coupons, Ads, bulk/feed writes (only 100-id batch reads), refund/cancel, vacation write, and **GPSR / product-safety fields**. [R4 §C.6]
- Webhooks (since 2025-12): [R4 §D.1]
  - 4 order events only: `order.paid`, `order.canceled`, `order.shipped`, `order.delivered`.
  - Set up in the portal only (no API), per app.
  - Standard-Webhooks signing: `webhook-id.webhook-timestamp.raw_body`, HMAC with the `whsec_` secret, a 5-minute window.
  - Retries at 0, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h.
  - The payload is thin: GET its `resource_url`.
- Polling: [R4 §D.2]
  - Receipts by `min_last_modified` with a 5–10 minute overlap.
  - Listings per state, sorted by `updated`.
  - Inventory and shipping in 100-id batches.
  - The ledger needs `min/max_created`.
  - A full pass on a 2,000-listing shop costs about 60 calls.
- Listing rules: [R4 §E.1, §F]
  - Required: `who_made`, `when_made`, `taxonomy_id`, `shipping_profile_id`, `readiness_state_id`.
  - Title max 140; 13 tags of ≤20 characters; ≤2 styles.
  - EU shops do not need `return_policy_id`. `should_auto_renew` renews for 4 months.
  - Legacy personalization fields were removed 2026-04-09.
  - Reading third-variation listings was due by 2026-08-17.

**Open questions**
- Seller App (own shop) is enough, or will other shops need a Personal App (≤5)? [R4 §A.7]
- The production HTTPS callback: locally an ngrok helper is used, and Chrome blocked the automatic return. [etsy-local]
- GPSR / economic-operator data is not in the API. Keep it outside the Etsy sync, or embed it in the description? [R4 §F]
- Does the FR/DE address gating apply to our key? Probe one receipt after Allow. [R4 §A.8]

### WooCommerce
- **Owner decision 2026-08-29: out of scope for the new programme.** The code was inventoried only for the delete/park decision. [cx-audit header]
- On 08-29: env consumer key/secret (`WOOCOMMERCE_STORE_URL/CONSUMER_KEY/CONSUMER_SECRET/WEBHOOK_SECRET`), Basic auth, `wc/v3` hard-coded, no https check. [A2 §1–2]
  - 6 receivers never reject (S7).
  - Order ingest writes columns that don't exist (`amazonOrderId`, `totalAmount`, `buyerName`, `channelId`, `Channel.credentials`) and enum values COMPLETED/FAILED, so it throws.
  - Simple products land as price 0 / stock 0.
  - No webhook registration; jobs never scheduled.
  - `woocommerce-pushback` is dry-run unless `NEXUS_ENABLE_WOO_SHIP_CONFIRM=true`.
  - `syncToWoo` exists in E12.
- Per the 09-08 doc, Woo has no adapter in the connector registry. [BP]
- Research: Nango models Woo as BASIC + `storeURL` with a verification endpoint `/wp-json/wc/v3/customers`. The Airbyte connector uses 21 streams with cursor `date_modified_gmt`. A user-supplied store URL is an SSRF risk (needs an egress policy). [R8 §2][R9a][R8 pattern 18]
- Open question: delete the Woo code, or park it? [cx-audit header]

### OTTO Market (DE)
- Today: no code. [cx-audit §1]
- Access: public API. Sellers self-serve in OTTO Partner Connect (user right "API-Zugriff" → "Neue App erstellen"; the secret is shown once). Service Partners register separately (30 days of sandbox, then a self-disclosure form). [R5 §1]
- Auth: OAuth 2.0 at `https://api.otto.market/v1/token`. [R5 §1]
  - A seller's own app uses client credentials with scopes (products, orders, receipts, returns, price-reduction, shipments, shipping-profiles, availability, returns-warehouse-*, advertising-services); tokens last 30 minutes.
  - A Service Partner app uses an **authorization code** (`scope=installation partnerId`) → an installation → an installation token.
- Sign in + Allow: YES only as a registered Service Partner; otherwise copy a key. The refresh lifetime is unverified. [R5 §1]
- Scope: DE only, with no market parameter. [R5 §1]
- API: Products (v4 supported until 2025-12-10), Availability, Shipping Profiles, Orders V4, Shipments, Returns V3, Return Shipments, Returns Warehouse, Price-Reductions, Receipts V3, Sponsored Product Ads + reporting. [R5 §1]
- Events: none. Writes are async (202 + a task with `pingAfter`). [R5 §1]
- Limits: 1200 req/min per partner; token endpoint 10/s per IP; 20 req/s per partner id; 429. [R5 §1]
- Sandbox `sandbox.api.otto.market` (reset on the first Sunday of each month). Versions are in the path, with 6 months' notice and a `Sunset` header. [R5 §1]
- Open question: register as a Service Partner to get true OAuth? [cx-research B1.2]

### Zalando (zDirect + Connected Retail)
- Today: no code. [cx-audit §1]
- Access is by invitation: a Fashion Partner invites the developer, and each app serves one Fashion Partner (it may serve several of that partner's Merchants). Connected Retail credentials come from an Onboarding Manager. [R5 §2]
- Auth: client credentials at `POST https://api.merchants.zalando.com/auth/token` (Basic auth, `scope=access_token_only`, 2 h, no refresh). The app is created at `zdirect.zalando.com/applications` and starts in sandbox mode. **Key-copy, no OAuth.** Test call: `GET sales-channels?merchant_ids=…`. [R5 §2]
- Countries: 33 sales-channel ids, one per country, chosen per request. [R5 §2]
- API: Products, Attributes, Onboarding, Submissions, Status Report, Prices, Stocks, Article Availability, Orders, ZFS fulfilment, returns. [R5 §2]
- Events: none in zDirect (poll orders). Connected Retail OEA webhooks use an API key and must answer 200 within 10 s. [R5 §2]
- Limits vary per API (for example Attributes 1000/min, Submissions 25/s), with `Retry-After` and `X-Rate-Limit`. Sandbox at `api-sandbox.merchants.zalando.com` does not persist data. [R5 §2]

### Kaufland Global Marketplace (DE AT CZ SK PL FR IT ES NL)
- Today: no code. [cx-audit §1]
- Keys are self-serve at `sellerportal.kaufland.de/settings/api`. [R5 §3]
- Auth: HMAC request signing. [R5 §3]
  - Headers `Shop-Client-Key`, `Shop-Timestamp` (±5 min), `Shop-Signature` = base64 HMAC-SHA256 of `METHOD\nURI\nBODY\nTIMESTAMP`, and a `User-Agent` naming the software.
  - The secret is a string, not hex. **Key-copy.** Test call: `GET /v2/info/storefront`.
- One key pair covers 9 storefronts via the `storefront` parameter. [R5 §3]
- API v2: products, units (= offers), categories, orders, order-units, returns, shipping labels/groups, warehouses, tickets, subscriptions, CSV import files, vouchers, commission rates, VAT rates. [R5 §3]
- Events: push subscriptions, **15 events** (`order_new`, `order_unit_status_changed`, `item_changed`, `return_*`, `item_unit_*`, `buy_box_changed` and more). [R5 §3]
  - Signed with the same HMAC. Answer within 5 s. Retries for about 12 h, then the subscription is disabled and an email sent.
- Limits: 111 req/s per seller across all endpoints. CSV bulk is available. [R5 §3]
- The Playground sandbox uses the same keys (and the "Try it out" buttons in the main docs hit LIVE data). [R5 §3]

### bol.com (NL BE)
- Today: no code. [cx-audit §1]
- Credentials come from Seller Dashboard → Settings → Services → API Settings. [R5 §4]
- Auth: client credentials at `https://login.bol.com/token` (Basic auth). Tokens last 299 s — reuse them, or risk an IP block. **Key-copy.** [R5 §4]
- NL + BE in one account (`countryAvailabilities`). [R5 §4]
- API: Offers v11, Orders/Shipments v10, Returns, Labels, FBB inventory, Invoices, Promotions, Insights, Commissions, Subscriptions v11, Process Status, Product Content, Advertising v11. [R5 §4]
- Events: Subscriptions v11 via webhooks, Pub/Sub or SQS, **RSA-SHA256 signed** (public keys from an endpoint), 10 attempts over 10 minutes. Every write is async (process status). [R5 §4]
- Limits: published in machine-readable form (for example Offers POST 50/s, Orders list 25/min). CSV export for offers. A demo environment returns hard-coded examples. Old versions are removed 12 months after deprecation. [R5 §4]

### Allegro (PL CZ SK HU)
- Today: no code. [cx-audit §1]
- Apps are registered at `apps.developer.allegro.pl` (needs 2FA; max 5 keys per account). [R5 §5]
- Auth: authorization code (consent), device flow, client credentials, or dynamic registration. [R5 §5]
  - `allegro.pl/auth/oauth/authorize|token|device`.
  - Access 12 h; refresh 3 months, single-use with a 60-second overlap; the code is valid for 10 s; PKCE S256; 27 scopes.
  - **Sign in + Allow: YES.**
- One token covers every market. `GET /me` gives the base marketplace; `marketplaceId` sets CZK/HUF prices. [R5 §5]
- API: offers (catalog, parameters, images, translations, batch commands, pricing), orders, sale settings (including responsible persons/producers), One Fulfillment, messaging, billing. [R5 §5]
- Events: **no webhooks.** Poll `/order/events` (60 days) and `/sale/offer-events` (24 h). [R5 §5]
- Limits: 9000 req/min per client. Bulk price/quantity commands handle 1000 offers each. A full sandbox exists. Versioning is by media type. [R5 §5]

### Cdiscount (via Octopia)
- Today: no code. [cx-audit §1]
- Integration goes through the Octopia REST API (the SOAP API is gone). It is not Mirakl. The seller creates a clientId/secret on the API Credentials page. [R5 §6]
- Auth: client credentials at `auth.octopia-io.net/…/token`, 2 h (a refresh exists), plus a `SellerId` header on each call. **Key-copy.** [R5 §6]
- API `api.octopia-io.net/seller/v2/`: seller config, product referential, products, offers, orders + invoices, discussions, fulfilment, finance. [R5 §6]
- No webhooks. The only published limit is the token endpoint at 500/h. No sandbox. [R5 §6]

### ManoMano
- Today: no code. [cx-audit §1]
- Public docs at `manomano.dev`: Orders REST, Offers, ManoFulfillment stock, Categories. The XML order API ended 2025-03-31. [R5 §7]
- Auth: an `x-api-key` from Toolbox + a seller contract id. This comes from third parties only (unverified). **Key-copy.** [R5 §7]
- Events, limits and multi-country behaviour are unverified. The sandbox works limited hours only. [R5 §7]

### Mirakl-based marketplaces (Leroy Merlin, Decathlon, Carrefour, MediaMarkt, Conforama, Galeries Lafayette, Worten, Debenhams, Conrad, El Corte Inglés, B&Q, Home24, Maisons du Monde, …)
- Today: no code. [cx-audit §1]
- Each operator runs its own instance. The seller generates a key in that operator's back office. Mirakl Connect OAuth is for partners only. [R5 §8]
- Auth: `Authorization: <API key>`, plus `shop_id` when a user has several shops. **Key-copy, one key per operator.** Test call: `GET /api/account`. [R5 §8]
- API: products imports (P41–P43), offers imports (OF01), async exports, orders, messages (inbox threads), invoices, promotions, returns, incidents. [R5 §8]
- No seller webhooks (poll). 429 with `Retry-After`; pages of ≤100. Delivery is continuous and backward compatible. [R5 §8]
- Douglas is unverified. Fnac/Darty is no longer on Mirakl, and Cdiscount is not Mirakl-facing. [R5 §8]

### eMAG (RO BG HU PL)
- Today: no code. [cx-audit §1]
- Basic auth with `base64(username:password)` and an IP whitelist. **Key-copy.** One account per country platform (`marketplace-api.emag.{ro,bg,hu,pl}/api-3`). [R5 §9]
- Limits: 1 request per 3 s and 20 per minute per resource. Bulk saves take 50. Callback URLs (order, cancel, return, AWB) are set in the UI. [R5 §9]

### Fnac / Darty
- Today: no code. [cx-audit §1]
- Its own platform: `vendeur.fnac.com/api.php/`, a staging catalogue, and docs behind a login or on request. Shop id + API key (unverified). **Key-copy.** [R5 §10]

### Miravia (ES)
- Today: no code. [cx-audit §1]
- `open.miravia.com`: app key/secret + a seller authorization grant (a "Seller Access Token", OAuth-like). A Feed API and an automation feed exist. Lifetimes and signing are unverified. [R5 §11]

### Privalia / Veepee
- Today: no code. [cx-audit §1]
- PinkConnect with a shop ID + token, documented only by partners (unverified). **Key-copy.** [R5 §12]

### Real.de → Kaufland
- real.de became Kaufland.de on 2021-04-14 (third-party source). Use the Kaufland API. [R5 §13]

### TikTok Shop (DE FR IT ES IE UK; AT BE NL PL from 2026-06-15)
- Today: no code. [cx-audit §1]
- Portal: Partner Center. A seller developer needs an active shop and an account manager. Custom apps need no review (under 25 sellers). Public apps are reviewed per market; US/UK need "3+ weeks". [R6 §1.1]
- Auth: [R6 §1.2]
  - Authorize at `services.tiktokshop.com/open/authorize?service_id=` (US: `services.us.tiktokshop.com`).
  - The `auth_code` lasts 30 minutes and works once. Exchange at `GET auth.tiktok-shops.com/api/v2/token/get` with `grant_type=authorized_code` (sic).
  - Access tokens last 7 days, and **the refresh token rotates**.
  - Every call is signed with the app secret (`app_key`, `timestamp`, `sign`, `shop_cipher`, `x-tts-access-token`). The exact recipe is unverified.
  - **Sign in + Allow: YES.**
- One authorization covers many shops (`/authorization/202309/shops` returns the `shop_cipher`). US and rest-of-world are split. [R6 §1.3]
- API: Seller, Products, Orders, Fulfillment, Logistics, Finance (moving to 202605), Promotions, Affiliate, Global Product. The version sits in the path (202309+); legacy versions died 2024-12-31. [R6 §1.4, §1.8]
- Webhooks: 16 topics, including `ORDER_STATUS_CHANGE`, `PRODUCT_STATUS_CHANGE`, `SELLER_DEAUTHORIZATION`, `UPCOMING_AUTHORIZATION_EXPIRATION`, `RETURN_STATUS_CHANGE`, `PRODUCT_AUDIT_STATUS_CHANGE`. [R6 §1.5]
  - The `Authorization` header = hex HMAC-SHA256(app_key + raw body).
  - Dedupe on `tts_notification_id`. Retries are undocumented — "don't rely on webhooks only".
- Limits are dynamic (baselines 0.2–20 rps). Throttling shows as 429 / code 36009002. A Development Shop sandbox exists. [R6 §1.6–1.7]

### Walmart Marketplace (US; CA/MX via Global APIs)
- Today: no code. [cx-audit §1]
- A seller's own keys are self-serve. A multi-seller app must be an approved Solution Provider (3–5 weeks). Delegated Access keys: creation retired 2026-07-30, and they die at the end of September 2026. [R6 §2.1–2.2]
- EU eligibility: UK and DE are listed for W-8BEN-E; FR/IT/ES/IE are not. A US return warehouse (or WFS) is required. [R6 §2.1]
- Auth: `POST marketplace.walmartapis.com/v3/token`. Access 15 minutes; refresh 1 year. Headers `WM_SEC.ACCESS_TOKEN`, `WM_QOS.CORRELATION_ID`, `WM_SVC.NAME`, `WM_PARTNER.ID`, `WM_MARKET`. OAuth goes through App Store Connect → `login.account.wal-mart.com/authorize`. No scopes. [R6 §2.2]
- API: items, feeds (`MP_INVENTORY`, `PRICE_AND_PROMOTION`, `MP_ITEM_INTL`; 10,000 items per feed), orders, returns, prices, promotions, reports, insights, advertising. [R6 §2.4]
- Webhooks: 15 event types; retries at 5, 15 and 45 minutes; HMAC `WM_SEC.SIGNATURE`. [R6 §2.5]
- Limits: a token bucket with `x-current-token-count`. The dynamic sandbox (`WM_SANDBOX: v2`) is wiped every 2 days. [R6 §2.6–2.7]
- Research tier: "Not now". [cx-research B1.2]

### Temu
- Today: no code. [cx-audit §1]
- Partner portals for US, EU and global. The path is registration → app → a compliance and security assessment → publish (each step can take about 1 day). [R6 §3.1]
- Auth has three modes: [R6 §3.2]
  - manual (the token is shown to the operator to copy);
  - callback (a code is sent to the redirect URL);
  - in-app URL.
  - Grants return `apiScopeList`. Signing and lifetimes are unverified. **MIXED.**
- API scopes: goods add/list/update, orders, logistics shipments, after-sales, stock edit, prices, categories, `bg.tmc.message`. Events, limits and sandbox are unverified. Research tier: "Not now". [R6 §3.3–3.8][cx-research B1.2]

### SHEIN
- Today: no code. [cx-audit §1]
- The Open Platform is gated by an application review. The grant happens in Seller Hub: `tempToken` → `POST /open-api/auth/get-by-token` → `openKeyId` + an encrypted `secretKey`. [R6 §4.1–4.2]
- Each call is signed: `HMAC-SHA256(OpenKeyId&Timestamp&Path, SecretKey+RandomKey)`. Limit 40 QPS. A test-store CLI exists. **Partial / unverified.** Research tier: "Not now". [R6 §4][cx-research B1.2]

### Google Merchant Center (Merchant API)
- Today: no code. [cx-audit §1]
- **Mandatory developer registration** (`developerRegistration:registerGcp`) links the Cloud project; without it calls get 401. API keys are not supported. [R6 §5.1]
- Auth: Google OAuth, scope `…/auth/content` (**sign in + Allow: YES**), or a service account added as an MC user. [R6 §5.2]
- Advanced accounts with sub-accounts (`accountAggregation`). [R6 §5.3]
- API: products / `productInputs` (only in API data sources; refresh ≥ every 30 days), inventories, data sources, reports, promotions, reviews, notifications. No orders. [R6 §5.4]
- Events: `PRODUCT_STATUS_CHANGE` pushes to an HTTPS callback. [R6 §5.5]
- Quotas are daily plus per minute (reset at 12:00 UTC). No customBatch. Test accounts (max 5). [R6 §5.6–5.7]
- Merchant API v1 went GA in 2025-07. **The Content API was sunset 2026-08-18.** [R6 §5.8]
- Research tier: 2. [cx-research B1.2]

### Meta Commerce (Facebook / Instagram catalog)
- Today: no code. [cx-audit §1]
- The catalog side is self-serve after App Review (`catalog_management`, which depends on `business_management`) and Business Verification. The on-platform Commerce API is invite-only, and **Shops checkout ended 2025-09-04** (orders now go offsite). [R6 §6.1]
- Auth: Facebook Login for Business. System-user tokens never expire; long-lived user tokens last about 60 days. **YES.** [R6 §6.2]
- Catalog: `items_batch` (≤5000 per request, `allow_upsert`) and scheduled product feeds (hourly/daily/weekly). [R6 §6.4]
- Webhooks: `X-Hub-Signature-256`, retries for 36 h. The commerce topic is unverified (poll orders). [R6 §6.5]
- Rate limits: Business Use Case limits (`X-Business-Use-Case-Usage`). Graph versions live ≥2 years; current v26.0. Shops: open beta in DE/FR/IT/ES/UK; IE is not listed. [R6 §6.6–6.8]
- Research tier: 2. [cx-research B1.2]

### BigCommerce
- Today: no code. [cx-audit §1]
- Single-click app OAuth (auth code → `login.bigcommerce.com/oauth2/token`, a non-expiring `X-Auth-Token`). BUT draft apps install only on stores owned by the developer's email; unlisted apps need partner approval; public apps need Marketplace review. [R7 §1.1]
  - Fallback: a store-level API account (paste the token + store hash).
  - Load/uninstall callbacks carry a JWT signed with HS256.
- Multi-storefront via channels and sites; account-level tokens span stores. [R7 §1.2]
- API: v3 catalog, inventory, price lists, channels; v2 orders. Webhooks are **unsigned** (custom headers only); they retry for about 48 h, then deactivate. [R7 §1.3–1.4]
- Limits: 150–450 per 30 s depending on plan, with `X-Rate-Limit-*` headers. [R7 §1.5]

### Magento Open Source / Adobe Commerce
- Today: no code. [cx-audit §1]
- OAuth 1.0a integrations are started **from the Magento admin** ("Activate"), not from the PIM. [R7 §2.1]
  - Integration tokens are long-lived; admin bearer tokens last 4 h.
  - From 2.4.4, using an integration token as a Bearer needs a setting enabled.
  - **No PIM-side redirect.** Test call: `GET /rest/default/V1/store/websites`.
- Structure: websites / stores / store views, addressed as `/rest/<store_code>/V1`. MSI sources and stocks. [R7 §2.2]
- Bulk: `/async/bulk/V1` (needs RabbitMQ). [R7 §2.3]
- Open Source has **no native webhooks**; I/O Events need Adobe Commerce ≥2.4.4. No rate limiter. Each release gets 3 years of support. [R7 §2.4–2.7]

### Wix (Stores)
- Today: no code. [cx-audit §1]
- An unlisted app + share install link, **no review** → the merchant picks the site and grants permissions → `instanceId`. Then client credentials at `wixapis.com/oauth2/token` (4 h tokens). **YES.** Fallback: API key + `wix-site-id`. [R7 §3.1]
- One store per site. Catalog V1 and V3 cannot mix on a site: check the catalog version first. [R7 §3.2, §3.7]
- API: Products V3 (bulk up to 100), inventory, orders, fulfillments. [R7 §3.3]
- Webhooks are JWT-signed with 12 retries. A free dev site is available. Wix does not sunset deprecated APIs. [R7 §3.4–3.7]

### Squarespace
- Today: no code. [cx-audit §1]
- OAuth exists (30-minute access, 7-day one-time refresh), but client registration is **reviewed by Squarespace**. Fallback: a Developer API key, which needs the Commerce Advanced plan. [R7 §4.1]
- API: products v2, inventory (needs an `Idempotency-Key`), orders, transactions, contacts, discounts. [R7 §4.3]
- Webhooks cover only order, contact and extension topics — no product or inventory topics. HMAC hex. The subscription API is OAuth-only. [R7 §4.4]
- Limit: 300 req/min. No sandbox. [R7 §4.5–4.6]

### PrestaShop
- Today: no code. [cx-audit §1]
- **No OAuth redirect.** Auth is a Webservice key (32 characters, Basic auth) or, in 9.x, an Admin API client (client credentials, 3600 s JWT). **Key-copy.** [R7 §5.1]
- Multi-shop via `id_shop`. 69 Webservice resources. No native webhooks (PHP hooks only). No rate limits. A Docker image serves as the sandbox. [R7 §5.2–5.6]
- The legacy Webservice "is expected to disappear in the next few years". [R7 §5.7]

### Shopware 6
- Today: no code. [cx-audit §1]
- **No redirect OAuth.** Auth is an integration access key/secret → `/api/oauth/token` client credentials. The App System handshake (a signed registration) works only for installed apps; on SaaS that means a Store-listed app. **Key-copy.** [R7 §6.1]
- Sales channels control product visibility. The Sync API (`/api/_action/sync`) handles bulk. [R7 §6.2–6.3]
- Webhooks carry an HMAC `shopware-shop-signature`. Built-in limits apply to login/oauth only. Majors come yearly (6.8 is planned for 2027). [R7 §6.4–6.7]

## How the industry builds connections (Nango, Airbyte, other references — R8, R9, R9a): what to copy, what not to copy, licence limits

**Licence limits**
- **Nango: Elastic License 2.0 across the WHOLE monorepo**, including every npm package and integration-templates. There are no MIT parts. Self-hosting is Enterprise-only. We may read it and re-implement the patterns; we must never copy code or offer it as a service. [R8 §1]
- Airbyte: the protocol and Python CDK are **MIT**; the platform **and the connectors** are **ELv2**. Study only; do not copy connector code. [R9a]
- Saleor: BSD-3. Medusa: MIT. Supaglue: MIT (archived 2024). Panora: AGPL-3 (archived 2025). Revert: AGPL-3 (joined Ampersand). `@shopify/shopify-api`: MIT. [cx-research B2.1][R9]

**Nango — copy these patterns** [R8 patterns]
1. A declarative catalogue of providers (auth mode, URLs, `authorization_params/token_params/refresh_params`, `scope_separator`, `token_request_auth_method`, `authorization_code_param_in_callback` (SP-API's `spapi_oauth_code`), `redirect_uri_metadata`/`token_response_metadata` (for example `selling_partner_id`, Walmart `sellerId`), and typed `connection_config` fields).
2. Health columns: `credentials_expires_at`, `last_refresh_success/failure`, `refresh_attempts`, `refresh_exhausted` — plus our own `refresh_token_expires_at`.
3. Refresh-if-needed: a 15-minute buffer, an in-process in-flight map, a lock, a re-read after taking the lock, and keeping the old refresh token when the response omits one.
4. A 30-second cooldown after a failure, then exhaustion; an active-error record, cleared on recovery with a recovery event.
5. An OAuth session row keyed by `state` (single use, holds `code_verifier`), PKCE always on, a state cookie double-submit, and the provider's error params folded into the message the user sees.
6. Capture metadata from the callback query and the token response.
7. Popup → opener: `postMessage` + a `BroadcastChannel` fallback + an ACK before close; an error page that stays open.
8. Verify credentials at connect time (a declarative endpoint or a small function), and reuse that check as the periodic health test for key-based channels.
9. A proxy retry table: error-code list/ranges, header-driven waits (`at`/`after`, the longest wins), a body regex, exponential backoff capped at 10 minutes; fetch the credentials again on every attempt.
10. Interpolated base URLs and headers (`${connectionConfig.x}`, `${accessToken}`), with safe stripping of absolute URLs.
11. A records table: `external_id` unique per (connection, model), `data_hash`, a tombstone, one upsert statement that labels rows inserted/changed/unchanged/deleted, and an advisory lock.
12. Delete detection by generation (start/end markers; batched; heals itself next run).
13. A keyset cursor `base64(updated_at||id)` plus per-record metadata (`first_seen_at`, `last_action`).
14. A Postgres task table: states, heartbeat, 3 timeouts, `retry_key`, `group_max_concurrency`, a `FOR UPDATE SKIP LOCKED` dequeue, an expiry daemon, and one active task per schedule.
15. A sync-conflict guard in the executor.
16. The inbound webhook handler contract on the raw body.
17. Outbound delivery with a stable body, HMAC, bounded retries, no retry on 4xx, and a circuit breaker per destination.
18. An egress URL policy for any URL a user supplies.
19. AES-256-GCM with the iv and tag stored beside the ciphertext, and a re-encrypt routine for key changes.

**Nango — do not copy**: the multi-tenant control plane (accounts, environments, billing, metering, capping); connect sessions; WebSocket + Redis pub/sub result delivery; the five-service topology; per-customer runners; the `node:vm` sandbox; the YAML→zod deploy pipeline; 256 hash partitions; `records_data`; daily `records_seen` partitions; MAR accounting; per-record and KMS encryption; the 982-provider catalogue and 17 auth modes (we need OAUTH2, OAUTH2_CC, API_KEY/BASIC); `X-Nango-Signature`; and their commerce entries verbatim. [R8 "Not worth cloning"]

**Nango — weaknesses to avoid**: [R8 §8]
- The refresh lock is "not a distributed lock" and has no fencing token.
- `refresh_attempts` counts calendar days, so exhaustion only comes after 4 days.
- There is no `refresh_token_expires_at`, and `credentials_expires_at` defaults to now + 1 day.
- The state cookie is measured but not enforced; HMAC uses `===`; the popup posts to `'*'`.
- `X-Nango-Signature` (sha256 of secret + payload) is open to length-extension attacks.
- Retry headers are assumed to be in seconds; the `A || B` base-URL fallback is parsed by regex.
- `data_hash` = md5(JSON.stringify), which depends on key order.
- **None of the commerce entries carry rate-limit metadata**, so there is no outbound limiter per connection.
- Sync groups are unbounded, so one connection can starve the rest.
- Webhook forwarding is fire-and-forget, with no outbox.
- Its catalogue lacks tiktok-shop, zalando, bol, allegro, GMC, kaufland, otto, mirakl and cdiscount.

**Airbyte — copy** [R9a]
- The four verbs `spec/check/discover/read`. Catalog vs ConfiguredCatalog (the source proposes the cursor and primary key; the operator chooses).
- Per-stream STATE checkpointed every N records, with `is_resumable`.
- `ErrorResolution{action, failure_type}` with the actions SUCCESS/FAIL/RETRY/IGNORE/RATE_LIMITED/REFRESH_TOKEN_THEN_RETRY, and backoffs `WaitTimeFromHeader`/`WaitUntilTimeFromHeader`/exponential with `max_waiting_time`. Default map: 401/403 → config error; 429 → rate-limited.
- `DatetimeBasedCursor` windows with a lookback; `SubstreamPartitionRouter`.
- `AsyncRetriever` (create/poll/download, status map, job cap, retries, timeout).
- Shopify bulk: an adaptive window, cancel-to-checkpoint, `__parentId` re-nesting.
- `ReportCreationRequester`, which reuses a DONE report.
- An RDT authenticator.
- The `advanced_auth` four-blob split, with rotated refresh tokens sent back as a CONTROL message.
- An availability check that reads the first record; streams filtered by the granted scopes.
- `continue_sync_on_stream_failure` + STREAM_STATUS.
- A concurrent reader with back-pressure from a bounded queue.

**Airbyte — what it lacks**: [R9a]
- It is read-only and record-only: there is no write/action verb and no idempotency key.
- No cross-stream transactions.
- Its JSON-Schema config cannot do live lookups.
- OAuth lives outside the protocol.
- Connector-as-container is impossible in a request path.
- Report streams block inside `read`.
- The schema is discovered once.
- Its connectors are ELv2.
- eBay, Etsy and Zalando connectors are absent; BigCommerce and Magento are archived.

**Saleor — copy**: [R9 §2]
- The install handshake (a manifest; the installer chooses permissions; the token is POSTed; rollback on failure).
- A hashed app token + `token_last_4`.
- A **three-table delivery log** (payload / delivery / attempt).
- Webhooks scoped to channels.
- A sync-call cache + failure sentinel + circuit breaker.
- An `AppProblem` problem ledger, deduplicated (key, count, critical, dismissed).
- JWS RS256 detached signatures (JWKS); SQS/PubSub targets.
- A retention sweeper.
- Loses: apps are outbound-only (no inbound sync or cursor); a channel listing is one fixed-column row (it cannot hold Amazon or eBay attributes); `metadata` is untyped; payloads are deleted (so it is not an audit trail).

**Medusa — copy**: [R9 §3]
- `createStep(invoke, compensate)`, compensation in reverse order, a persisted `WorkflowExecution`, and external resume via `setStepSuccess/Failure` by idempotency key.
- Step knobs: `maxRetries`, `retryInterval`, `timeout`, `async`, `noCompensation`, `continueOnPermanentFailure`.
- Module links with no FKs.
- Provider classes with a static `identifier` + `validateOptions`.
- Loses: a sales channel is membership only; providers are per capability, not per marketplace; workflow state lives in Redis by default.

**Supaglue / Panora / Revert**: all three keep the raw payload beside the unified row (Supaglue `_supaglue_raw_data` + `_mapped_data` in one row; Panora a `remote_data` side table + an `events` call ledger + `webhook_delivery_attempts`; Revert a bring-your-own OAuth `apps` row). All three had to bolt on a field-mapping layer, and two are archived. Lesson: **start from the provider's full schema and derive a thin common view, not the reverse.** [R9 §4]

**Shopify SDK — copy**: a signed 60-second state cookie; sorted-query HMAC plus a 90-second window with a timing-safe compare; an anchored shop regex as the tenant key; `Session.isActive(scopes)` with implied scopes (`write_x ⇒ read_x`); webhook registration that reconciles to a desired state (query, diff, create/update/delete); `app/uninstalled` → purge; `app/scopes_update` → rewrite the scope; token exchange / managed install where offered. Avoid: the online/offline split leaking into 17 columns, scope stored as a comma string, and expiry added later instead of from day one. [R9 §5]

**Paid platforms — the idea to keep, and what each loses** [R9 §6][cx-research B2.5]
- Merge: `remote_data` + Field Mapping + passthrough. Loses: no commerce category; provider-only fields go stale.
- Rutter: a `platform_data` raw field and a Job object `{prequeued, pending, success, failure}` + `force_fetch`. Loses: reads come from a stale cache, and there is no per-marketplace attribute dictionary.
- Apideck: a Vault connection `state` enum (`available/callable/added/authorized/invalid`) — the reusable idea. Loses: only 4 read-mostly ecommerce resources.
- Paragon / Prismatic: per-integration workflows, a user settings portal, connection ownership types, alert triggers as data (execution failed, connection throttled/failed). Loses: the unit is a workflow, not a channel data model.
- ChannelEngine / Feedonomics / Rithum: feed-and-optimise, with per-channel mapping owned by the vendor. Loses: the merchant never sees the marketplace schema, and rejections never land on the product record (Rithum encodes fields as naming conventions in a flat `Attributes[]` bag).

**Anti-patterns** [R9 anti-patterns]
- Common model first, with the raw payload as a paid side-car.
- A field-mapping layer bolted on later.
- A fixed-column row per (entity, channel).
- A sales channel that is membership only.
- Providers per capability instead of per marketplace.
- An outbound-only extension model.
- Marketplace fields encoded as naming conventions.
- Feed-out with channel errors reported afterwards.
- Deleting payloads with no archive.
- Scope stored as a comma string, with expiry added later.
- Reads backed by a cache.
- Replacing Shopify OAuth with "paste an Admin token".
- Registering webhooks by appending instead of diffing.
- Keeping workflow state only in Redis.

**Design conclusion**: take Nango's mechanics, Airbyte's error vocabulary + async retriever + per-stream state, Saleor's delivery ledger, Medusa's sagas with external resume, Shopify's callback hardening and reconciling webhooks, Apideck's state enum and Rutter's Job — and **invert the unified-model premise**: the channel's full typed schema is primary, and the PIM core is a derived view. [cx-research B2.5]

## Later checks (09-01 to 09-10): channel-ops research, Amazon managed connection review, Shopify/Etsy local connect, business profiles audit

**Channel-ops research (2026-09-01)** — commissioned for ruling #105 D1: where should the 22 per-listing channel operations live in the rebuilt studio? [ops-research]
- Sources: Rithum, Salsify, Akeneo, Plytix, ChannelEngine, Channable, Linnworks, Sellercloud, Feedonomics and Lengow, plus Airtable, Notion, Monday, Retool, Linear, IBM Carbon, Shopify, Webflow and Contentful. [ops-research]
- Five patterns are in use: [ops-research §1]
  - A. A channel console per channel (Akeneo Activation, Salsify, Rithum, Plytix, ChannelEngine). Right for queue-shaped work; no incumbent documents a drawer on the master grid.
  - B. A per-channel property page opened from the row (Sellercloud, Linnworks right-click on the channel cell).
  - C. Fix-by-rule pipelines (Channable, Lengow, Feedonomics). Ideas worth stealing: Channable's error→fix jump and Lengow's normalised error vocabulary.
  - D. A record drawer / side sheet (Airtable, Notion, Retool, Carbon: use a full page when most fields are editable).
  - E. A selection action bar + row menu + a palette mirror, all backed by ONE action registry (Linear, Carbon, Akeneo, Sellercloud).
- Every mature platform runs a hybrid. Replicating to a sibling market is config-level everywhere, so offering it per listing sets us apart. **Publish-snapshot/restore is missing from commerce tools** (Akeneo removed its channel snapshots in Feb 2024); the CMS playbook is snapshot on publish, restore into DRAFT, auto-snapshot before a restore, field-level rollback. [ops-research §2]
- Recommendation, three legs: [ops-research §3]
  1. The drawer is the home for depth (panes, with full screen for fitment and aspects).
  2. Verbs go through the row menu / ⋯ column / selection bar, backed by one action registry — never through the drawer only.
  3. Queues get a console: a studio TAB "Errors & Sync", grouped by error type, each row jumping to the grid row or drawer pane.
  4. Publish/restore follows the CMS doctrine.
- Evidence strength: Akeneo, Linnworks, Sellercloud, Channable, ChannelEngine, Airtable, Notion, Carbon, Webflow and Contentful are documented; Rithum, Salsify, Lengow and Monday come from snippets; Feedonomics is inferred. The drawer-on-master-grid shape is imported from data apps. [ops-research]

**Amazon managed connection review (2026-09-08)** — per the doc: [amz-review]
- Seller credentials sit in the encrypted connection store. Seller, region and authorization are resolved together. Env access is only a migration path for a row explicitly marked env-managed.
- Disconnect is respected by SDK objects, new calls, pagination and startup. A restart does not recreate env access once an OAuth connection has existed.
- Order cancellation, shipment confirmation and Buy Shipping resolve the order's own connection. Legacy single-account consumers fail closed when several Amazon sellers make routing ambiguous.
- Re-authorization cannot swap in a different seller or region. Imported grants and marketplace scopes commit together.
- Private-app verification checks the stored grant. A successful refresh clears the synthetic expiry only for grants marked as private imports.
- Account names are shared everywhere (lists, switcher, details, diagnostics, consent, Ads profiles, campaigns, publishing). Opaque keys stay internal. Rename supplies a human label.
- The callback payload escapes characters that could break a script.
- Verification: 298 API, 129 Web and 68 Factory tests passed. Live heartbeats: Amazon Seller 253 ms, Amazon Ads 127 ms, xaviaracing 562 ms, motovento 474 ms. The prod account was renamed XAVIA RACING, and startup logs confirmed env synthesis was skipped.
- Limits: **the registered Amazon app is private; the supported authorization is through the Solution Provider Portal, not public website OAuth.** Importing the existing grant adds no roles. A disconnected private account needs a replacement authorization (no secret-entry workflow was added). Requests already in flight cannot be recalled.

**Shopify + Etsy connection re-audit (2026-09-08)** — hardening, verified locally. Per the doc: [SE-0908]
- Fixes:
  - Per-response nonces open the global CSP for the callback page only.
  - The business-profile relay marker is stripped before Shopify's HMAC check.
  - Shopify requires a verified identity, an immutable shop ID, a matching permanent domain and a complete GraphQL response (HTTP-200 throttling is classified).
  - Token exchange/refresh is bounded to 20 s, redirects are rejected, token shapes are validated, and token error bodies are never persisted.
  - A refresh is guarded against the credential/status/lease snapshot, so it cannot overwrite a newer consent or restore a disconnected account; expiry is cleared on disconnect.
  - Every shared flow is correlated with its state, even when profiles are off.
  - Closing the sign-in window cancels the attempt.
  - Actual grants are recorded, and an empty scope list updates drift.
- Scopes: Shopify requests 95 configured scopes, plus up to 5 restricted ones — only if approved in `ChannelApp.extra.approvedScopes` / `SHOPIFY_APPROVED_SCOPES`. Etsy requests all 12. The returned grant is authoritative, and custom-distribution offline tokens may never expire.
- Tests: 324 API and 80 Web passed. No real provider grant was submitted.
- Needed before prod sign-off: the deployed app credentials, exact HTTPS callbacks, the web callback origin, encryption config, Shopify entitlements and Etsy approval; real consent; return-to-tab; saved identity and scopes; renewal, cancel/retry and disconnect; the cookie policy on deployed origins.
- NOT certified: product/order sync and webhook install/delivery.

**Shopify local connect (2026-09-09)** — per the doc: [shop-local]
- Cause of the failure: the local API (port 8091, DB 127.0.0.1:55439) had no Shopify/Etsy `ChannelApp` rows and no app credentials or public URLs.
- Fixes:
  - Missing config is now a typed setup failure (a friendly 503, with no session or cookie created).
  - A new read-only `GET /api/cx/connect/:channel/readiness` endpoint; the dialogs check it before enabling Continue ("Check again").
  - A stored app is never silently replaced by the env app.
  - A Shopify-only loopback callback needs `NODE_ENV=development` + `NEXUS_SHOPIFY_LOCAL_OAUTH=1` (exact `/api/cx/callback/shopify` path).
  - The Dev Dashboard rejected `read_marketplace_fulfillment_orders` and `read_merchant_approval_signals`, so the default request is now 93 accepted scopes, with 7 held behind approval.
- Config: org Xavia Racing `79081726`; app Nexus Commerce `421328781313`; version `local-connect-2026-09-09`; App URL `http://localhost:3000/settings/channels` (standalone); callback `http://localhost:8091/api/cx/callback/shopify`; legacy install enabled; webhooks API `2026-07`. The secret is kept in the ignored `apps/api/.env`.
- Status: the Install screen was reached for `xaviaracing.myshopify.com`, but **installation approval and the callback are pending**. Production still needs HTTPS and its own verified callback. Tests: 339 API and 86 Web passed. Mobile visual checks are outstanding.

**Etsy local connect (2026-09-10)** — per the doc: [etsy-local]
- The first seller-app registration was **rejected**: the shop ItalianHideCraft showed "account suspended" and "Developer Mode". After the owner corrected the account, it was approved: app `nexus-commerce` id `1513907185612`, 10 QPS / 10K QPD.
- The callback was registered as an HTTPS ngrok URL (`…ngrok-free.dev/api/cx/callback/etsy`) through a loopback helper, `scripts/etsy-local-callback.mjs` (127.0.0.1:8093; strict path and params; no logging).
- Connected: shop ItalianHideCraft `57783036`, user `1051233836`, connection `cmtvy3wta00fjnjpxl22lly3k`. All 12 scopes, no drift. Test OK in 532 ms; a forced renewal succeeded; the heartbeat after renewal was OK (1013 ms). The connection survives a reload.
- Limit: Chrome blocked the automatic HTTPS→localhost return (`ERR_BLOCKED_BY_CLIENT`), so the callback was opened by hand. **A seamless return is not verified.** No listing changes or sync were done.

**Business profiles (2026-09-08)** — local implementation; prod not migrated, enabled or deployed as of this doc: [BP]
- One login can own or join several business profiles. Each profile owns its catalog, stock, settings, connections, team and roles. Several accounts per channel are allowed. Routes, DB, jobs, inbound events, caches and credentials carry the business context.
- Connecting asks which profile to use (the dialog is prefilled). Only profiles where the user has `channels.connect` or Owner are offered. The OAuth session keeps the chosen profile even if the user switches during sign-in; revoked access stops completion before the exchange. The popup bridge correlates workspace, channel and state. Reconnect pins the existing account and its profile.
- A seller account has exactly ONE owning profile. "Assign profile" moves only unused, disconnected accounts (checked under DB locks). The destination gets a new inactive connection id and needs fresh marketplace authorization. The source keeps its history. Accounts with linked listings or orders are blocked.
- Migrations: `20260908a_business_workspaces`, `…b_workspace_data_isolation`, `…c_sync_log_result_columns` (rehearsal: 409 tables with forced RLS).
- Rollout conditions:
  - Snapshot and reconcile the DB first. The migration stops if `UserRole.channelScope` or pending invitation restrictions exist.
  - Rehearse on a production-like snapshot.
  - Set `NEXUS_WORKSPACES_ENABLED=1` / `NEXT_PUBLIC_WORKSPACES_ENABLED=1` / `NEXUS_API_PROXY_TARGET` / `NEXUS_UNSUBSCRIBE_SECRET`.
  - Verify the provider redirect URLs and run controlled Amazon, eBay and Ads reconnects.
  - Never roll back to the unscoped app.
- Limits:
  - The connector registry = Amazon SP, Amazon Ads, eBay, Shopify, Etsy; **no WooCommerce adapter**. Server credentials cannot be borrowed by a new business.
  - Redis leases cannot recall a request already sent.
  - Queue metrics scan the shared queue, so large installs will need partitioning.
- Tests: 7,028 API tests passed (4 pre-existing failing assertions). Web: 3,524 passed.

## Open questions for the Owner
- **Amazon app type**: stay private (self-auth through the Solution Provider Portal, primary user, ≤10 accounts, a disconnect needs replacement authorization) or register a public app (review, re-auth every 365 days, 25 unlisted grants)? [amz-review][R1 §A2–A3]
- **eBay scopes**: re-consent both accounts (xaviaracing, motovento) now to get the full set of about 20 scopes, including `sell.finances`, `commerce.notification.subscription`, returns/cancellation/inquiry and message? [R2 §A–B][A0]
- **eBay signing**: build Key Management + RFC 9421 signing (ED25519) so Finances, `issueRefund` and Post-Order refunds work for our EU seller? [R2 §H]
- **eBay account deletion**: is the production keyset subscribed to account deletion, or opted out? The code does not handle the topic. [R2 §C][A4 §5]
- **Encryption bar**: AWS KMS envelope encryption (cx-research B3#1), or AES-GCM with a key-id (the R8 view that KMS is not needed for one tenant)? [cx-research B3#1][R8]
- **Job engine**: keep BullMQ and add per-connection groups (cx-research B3#9), or move to a Postgres task table (Nango pattern 14)? Business profiles already use Redis leases. [cx-research B3#9][R8][BP]
- **Refresh lock**: a Postgres advisory lock (research) vs the Redis leases now in use (per the BP and SE-0908 docs)? [cx-research B3#3][BP][SE-0908]
- **Next channels**: Tier 2 = Allegro, TikTok Shop, Google Merchant Center, Meta catalog. Register as an OTTO Service Partner to get OAuth? [cx-research B1.2]
- **Key-paste exceptions**: accept Kaufland, bol.com, Mirakl, Cdiscount/Octopia, Zalando, ManoMano and eMAG as documented key-copy connectors (a deep link + key validation + a test call)? [cx-research B1.2]
- **Not now**: confirm Walmart (partial EU eligibility, US warehouse), Temu/SHEIN (review-gated, unverified docs), Privalia/Veepee and Fnac/Darty. [cx-research B1.2]
- **WooCommerce**: delete the code, or park it? [cx-audit header]
- **Shopify**: custom-distribution auth code vs client credentials? Approve the 7 restricted scopes and request `read_all_orders`? Then set up the production HTTPS callback and real consent. [shop-local][SE-0908][R3]
- **Etsy**: is a Seller App enough (own shop only)? Where will production callbacks live (HTTPS required)? GPSR data is not in the API — keep it separate, or embed it in the description? [R4][etsy-local]
- **Amazon Ads**: wire OAuth (EU consent host) and retire the paste form? Plan re-consent before the 365-day expiry. [R1 §F][A3 §5]
- **Mappings**: operator mappings reach no real push. Wire them into the real engine, or treat them as preview only? [A5 §2.5]
- **Normalisation**: approve the inverted model (a raw `ChannelRecord` as truth, the core derived)? [cx-research B3#10]
- **Business profiles rollout**: are there production `UserRole.channelScope` / invitation restrictions that would stop the migration? [BP]
- **Unverified prod values**:
  - `EBAY_NOTIFICATION_VERIFICATION_TOKEN` set?
  - `NEXUS_ENV` value (the Shopify test route)?
  - The real AWS SQS queue policy?
  - Why does `amazon-auth-probe` return 404?
  - Neon password rotated?
  [cx-audit §5][A7]
- **Channel-ops UI**: accept the three-leg model (drawer for depth + one action registry for verbs + an "Errors & Sync" console tab) and the CMS publish/restore doctrine? [ops-research §3]

## Older guides (June–August) — not summarised

These older docs describe earlier versions of the channel code. Some may describe code that was changed or deleted, so check the code before you trust them. Their full text is in Part B of [full/RESEARCH-FULL.md](full/RESEARCH-FULL.md).

| File | Title | Main sections |
|---|---|---|
| `docs/README.md` | Nexus Commerce Marketplace Integration Documentation | Welcome to Nexus Commerce Documentation; Quick Navigation; Documentation Overview; Common Tasks; Key Features; Documentation Statistics; Supported Marketplaces; Getting Help |
| `docs/MARKETPLACE-API-DOCUMENTATION.md` | Marketplace Integration API Documentation | Table of Contents; Overview; Authentication; Shopify API; WooCommerce API; Etsy API; Unified Marketplace API; Error Handling |
| `docs/NEXUS-ENGINE-BLUEPRINT.md` | Nexus Commerce Engine — Architecture Blueprint | MODULE 1 — Product-Centric Unified Data Graph & TimescaleDB Core; MODULE 2 — Hybrid Bidding Engine & Autonomous Atomic Fabric; MODULE 3 — AMC Clean Room Orchestration & Cross-Channel Budget Shifter; MODULE 4 — Zero-Latency High-Density Workspace UI; MODULE 5 — Natural-Language Rules Engine & SOV Tracker; How this maps onto the shipping app |
| `docs/SETUP-GUIDES.md` | Marketplace Setup Guides | Table of Contents; Shopify Setup Guide; WooCommerce Setup Guide; Etsy Setup Guide; Environment Configuration; Verification Checklist; Support Resources |
| `docs/GO-LIVE.md` | Go-Live Runbook — Channel Publishing (Amazon / eBay / Shopify) | 1. The mental model — every channel has a 2-flag gate; 2. Check current state (do this first — and any time); 3. Go-live procedure; 4. The honest-UI guarantees (so "Done" can't lie again); 5. Troubleshooting; 6. Worker / queue env knobs |
| `docs/AMAZON-SYNC-API.md` | Amazon Sync API Documentation | Overview; Base URL; Authentication; Endpoints; Status Values; Error Handling; Rate Limiting; Best Practices |
| `docs/AMAZON-SYNC-IMPLEMENTATION.md` | Amazon Sync Feature Implementation Guide | Overview; What's Been Implemented; Architecture; Key Features; Usage Guide; API Examples; Configuration; Testing |
| `docs/AMAZON-SYNC-QUICKSTART.md` | Amazon Sync Quick Start Guide | Prerequisites; Step 1: Navigate to Inventory; Step 2: Prepare Your Products; Step 3: Trigger Sync; Step 4: Monitor Progress; Step 5: Review Results; Common Scenarios; Tips & Tricks |
| `docs/AMAZON-SYNC-TESTING.md` | Amazon Sync Testing Guide | Test Files Created; Running Tests; Test Scenarios; Performance Benchmarks; Error Handling Tests; Database Verification; Continuous Integration; Test Coverage Goals |
| `docs/AMAZON-SYNC-TROUBLESHOOTING.md` | Amazon Sync Troubleshooting Guide | Common Issues and Solutions; Performance Optimization; Monitoring and Logging; Getting Help; Quick Reference |
| `docs/AMAZON-ORDERS-SYNC-ARCHITECTURE.md` | Amazon Orders & Financials Sync Architecture | Phase 2: Orders Management System; Executive Summary; 1. Database Schema Enhancements; 2. Amazon Orders Sync Engine Service; 3. Sync API Endpoints; 4. Frontend Integration |
| `docs/AMAZON_DATA_STRATEGY.md` | Amazon Data & Reports Strategy | 0. The core question: "Can't we just use Amazon's reports instead of building our own?"; 1. What already exists (strong foundation); 2. What needs doing (the gaps); 3. Every option for getting Amazon data in — flexibility & trade-offs; 4. Recommended architecture: "Mirror + Overlay"; 5. Proposed phased plan (each approval-gated + verified, like ACP); 6. Open questions / decisions needed before building; 7. Honest caveats |
| `docs/PROJECT-COMPLETION-SUMMARY.md` | Amazon Catalog Sync - Project Completion Summary | Executive Summary; Project Overview; Deliverables; Technical Highlights; Key Features; Metrics & Performance; Remaining Tasks (In Progress); Code Statistics |
| `docs/PHASE12F-LIVE-AMAZON-SP-API.md` | Phase 12f: Live Amazon SP-API Connection | Overview; Architecture; Authentication Flow; Error Handling; Data Flow; Configuration; Implementation Details; Logging |
| `docs/PHASE12F-COMPLETION-SUMMARY.md` | Phase 12f: Completion Summary | Executive Summary; What Was Built; Technical Implementation; Data Flow; Integration Points; Logging; Testing; Performance Characteristics |
| `docs/PHASE12F-QUICK-REFERENCE.md` | Phase 12f: Quick Reference | What Changed; Key Components; Environment Variables; How It Works; Logging; Testing Checklist; Common Errors; Performance |
| `docs/PHASE12F-VERIFICATION-CHECKLIST.md` | Phase 12f: Verification Checklist | Implementation Verification; Integration Verification; Code Quality Verification; Runtime Verification; Data Flow Verification; Documentation Verification; Test Scenarios; Performance Verification |
| `docs/IMAGES-MIRROR.md` | Nexus → Amazon Image Mirror | Model; Slots (schema-driven); Operating flow; Safety (layered); Order & count; Key files; Cross-market copy (CM-series); Bulk editing (BE-series) |
| `docs/amazon-image-upload.md` | Amazon image upload — operator reference | The two paths; Resolver cascade (9 levels); Pre-publish preview; Validation gate (IA.4); Publish flow (direct); Retry-rejected-only (IA.6); Stale detection (IA.5); ZIP fallback |
| `docs/ebay-integration-map.md` | eBay Integration Map | TL;DR; Listing — Sell Inventory API (/sell/inventory/v1/…) — primary; Bulk pull — Sell Feed API (/sell/feed/v1/task); Fast price / quantity — Trading API (XML, /ws/api.dll); Supporting APIs; The eBay flat file (/products/ebay-flat-file); The cockpit publish (/products/[id]/edit?tab=EBAY); What we deliberately do NOT use |
| `docs/PHASE3-EBAY-AUTH-IMPLEMENTATION.md` | Phase 3.2: eBay Auth Service & Routes Implementation | Overview; Architecture; Database Schema; Security Considerations; Environment Variables; Testing; Files Created/Modified; Next Steps (Phase 3.3) |
| `docs/PHASE3-EBAY-SYNC-IMPLEMENTATION.md` | Phase 3.3: eBay Sync & Auto-Match Service Implementation | Overview; Architecture; Database Integration; Workflow; Auto-Matching Strategy; Error Handling; Performance Considerations; Files Created/Modified |
| `docs/ebay-import-runbook.md` | eBay Import — Verification Runbook | 1. What shipped (EI series, 2026-07-17); 2. Invariants; 3. Regression battery; 4. Owner E2E — the GALE 5-listing file; 5. Gotchas; Deleting rows (2026-07-18); Images on multi-listing (shell) families — EB-IMG, 2026-07-19; Variation order on LIVE listings without a publish — 2026-07-20 |
| `docs/ebay-flat-file-fields.md` | eBay Flat-File Fields — pick-or-type catalog | Modes; Column catalog; Where values come from / go; Engine; Constraint |
| `docs/flat-file-trust-runbook.md` | Flat-File Trust (FFT) — runbook | The Zero-Data-Loss Invariant (what the system now guarantees); The battery — apps/api/scripts/_fft-roundtrip-probe.mts; Prod probes (no auth needed); Browser E2E (the operator-truth check); Owner E2E script (the real-file pass); Read-model (/products) health; Deferred tail (tracked in the plan doc) |
| `docs/xlsm-hybrid-runbook.md` | XLSM Hybrid — Verification Runbook | 1. What shipped (commit map); 2. Invariants (never weaken); 3. Regression battery (run before touching this area); 4. Owner E2E script (prod); 5. Architecture pointers; 6. Gotchas (hard-won) |
| `docs/PHASE27-SSOT-SYNC-ENGINE.md` | Phase 27: Multi-Channel Synchronization Layer - Intelligent Sync Services | Overview; Architecture; Data Flow; Override Intelligence; Testing; Key Features; Files Modified/Created; Verification Checklist |
| `docs/PHASE27-QUICK-REFERENCE.md` | Phase 27: Quick Reference - Multi-Channel Synchronization Layer | 🎯 What Was Built; 📦 New Files Created; 📝 Files Modified; 🚀 Quick Start; 🔍 Key Concepts; 📊 Data Flow; ✅ Verification Checklist; 🧪 Testing Scenarios |
| `docs/INVENTORY-SYNC.md` | Inventory Sync Operator Runbook | Overview; Kill-Switch Flags; Events; Scheduled Jobs; Admin & Diagnostic Endpoints; Operator Control Tower — /fulfillment/stock/control-tower; Runbook: Common Situations; Baseline Capture (Post-Deploy) |
| `docs/IS-SETUP.md` | IS.2 — Real-Time Cross-Channel Inventory Sync Setup | How it works; Amazon SQS Setup (one-time); eBay Notification Platform Setup (one-time); Verification |
| `docs/SYNC-CONTROL.md` | Sync Control — operator runbook | The precedence ladder (highest wins); Two views: Products (default) and Listings; Excel round-trip (dedicated); Common jobs; Spreadsheets; Guarantees; Bulk-write contract (SCT.3, 2026-07-26); Amazon EU shared quantity (SCT.4, 2026-07-26) |
| `docs/SYNC-MONITORING-GUIDE.md` | Sync Monitoring and Alerting Guide | Overview; Architecture; API Endpoints; Alert Types; Notification Channels; Health Status Levels; Integration with Sync Service; Frontend Integration |
| `docs/WEBHOOK-DOCUMENTATION.md` | Webhook Documentation | Table of Contents; Overview; Webhook Security; Shopify Webhooks; WooCommerce Webhooks; Etsy Webhooks; Webhook Delivery; Error Handling |
| `docs/FULFILLMENT-PER-CHANNEL.md` | Fulfillment per channel (FCF series) | The model; The two stock pools; MCF — selling FBA stock on eBay (FCF.5); Oversell guards at publish time; Endpoints; Phase log |
| `docs/DATA-MAPPING-REFERENCE.md` | Data Mapping Reference | Table of Contents; Product Mapping; Variant Mapping; Inventory Mapping; Price Mapping; Order Mapping; Image Mapping; Attribute Mapping |
| `docs/INTEGRATION-TESTING-GUIDE.md` | Integration Testing Guide | Table of Contents; Overview; Test Environment Setup; Unit Tests; Integration Tests; End-to-End Tests; Performance Tests; Test Data |
| `docs/FULL-SYNC-TEST-GUIDE.md` | Full Sync Test Guide | Overview; Test Environment Setup; Unit Tests; Integration Tests; End-to-End Tests; Performance Testing; Regression Testing; Test Results Documentation |
| `docs/TROUBLESHOOTING-GUIDE.md` | Troubleshooting Guide | Table of Contents; Common Issues; Authentication Issues; Sync Issues; Webhook Issues; Data Consistency Issues; Performance Issues; Debugging Tools |
