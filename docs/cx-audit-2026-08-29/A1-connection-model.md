# Audit A1 — Channel connection model, credentials, tokens, OAuth state, encryption, multi-account

Read-only audit of `/Users/awais/nexus-commerce` on 2026-08-29. Every claim carries a `path:line`. Anything not confirmed from source is marked **unverified**. No file in the repo was modified.

Paths below are relative to `/Users/awais/nexus-commerce`.

---

## 1. Schema — connection and credential models

### 1.1 `model ChannelConnection` (`packages/database/prisma/schema.prisma:5982-6068`)

| Line | Column | Type | Group | Notes |
|---|---|---|---|---|
| 5983 | `id` | String @id cuid | key | |
| 5995 | `channelType` | String | channel | "AMAZON","EBAY","SHOPIFY","WOOCOMMERCE","ETSY" (comment 5986) |
| 5996 | `marketplace` | String? | channel | eBay rows null (comment 5987-5990) |
| 5997 | `managedBy` | String @default("oauth") | channel | `oauth` / `env` / `pending` (comment 5991-5994) |
| 6002 | `accessToken` | String? | **generic credential** | plaintext (see §4) |
| 6003 | `refreshToken` | String? | **generic credential** | plaintext (see §4) |
| 6004 | `tokenExpiresAt` | DateTime? | generic credential | |
| 6005 | `displayName` | String? | generic | |
| 6011 | `ebayAccessToken` | String? | **DEPRECATED dual-write** | comment 6007-6010: "Kept for one release" |
| 6012 | `ebayRefreshToken` | String? | **DEPRECATED dual-write** | |
| 6013 | `ebayTokenExpiresAt` | DateTime? | **DEPRECATED dual-write** | |
| 6014 | `ebayDevId` | String? | DEPRECATED (never written by app code — see §3) | |
| 6015 | `ebayAppId` | String? | DEPRECATED (never written by app code) | |
| 6016 | `ebaySignInName` | String? | DEPRECATED (still written) | |
| 6017 | `ebayStoreName` | String? | DEPRECATED (still written, no generic equivalent) | |
| 6018 | `ebayStoreFrontUrl` | String? | DEPRECATED (still written, no generic equivalent) | |
| 6021 | `isActive` | Boolean @default(false) | status | |
| 6022 | `lastSyncAt` | DateTime? | status | |
| 6023 | `lastSyncStatus` | String? | status | "SUCCESS","FAILED","PARTIAL" |
| 6024 | `lastSyncError` | String? | status | |
| 6031 | `accountLabel` | String? | **MAP.2a** | operator's own label |
| 6032 | `accountColor` | String? | **MAP.2a** | |
| 6034 | `isPrimary` | Boolean @default(false) | **MAP.2a** | one per channelType (partial index, raw SQL) |
| 6035 | `sortOrder` | Int @default(0) | **MAP.2a** | |
| 6040 | `externalAccountId` | String? | **MAP.2a** | identity at marketplace; NULL for eBay rows until re-consent |
| 6042 | `connectionMetadata` | Json? | misc | only `activeMarketplaces` is ever written (§7) |
| 6043 | `createdAt` | DateTime | | |
| 6044 | `updatedAt` | DateTime @updatedAt | | |
| 6046 | `variantListings` | VariantChannelListing[] | relation | cascades (comment 6047-6049) |
| 6050 | `channelListings` | ChannelListing[] | relation | ON DELETE SET NULL |
| 6051 | `sharedListingMemberships` | SharedListingMembership[] | relation | SET NULL |
| 6052 | `orders` | Order[] | relation | SET NULL |
| 6053 | `syncChannelPolicies` | SyncChannelPolicy[] | relation | SET NULL |
| 6057 | `ebayCampaigns` | EbayCampaign[] | relation | cascade |
| 6065-6067 | `@@index([channelType])`, `@@index([isActive])`, `@@index([managedBy])` | | | |

**Unique indexes.** The Prisma model declares NO `@@unique` (schema comment 6059-6064 says so). All uniqueness lives in raw SQL:

| Index | Where defined | Definition | Status |
|---|---|---|---|
| `ChannelConnection_channelType_marketplace_active_key` | `packages/database/prisma/migrations/20260506_h2_unify_channel_connection/migration.sql:72-74` | UNIQUE (channelType, marketplace) WHERE isActive | **DROPPED** by `20260819a_map2_account_dimension/migration.sql:220` |
| `ChannelConnection_active_account_key` | `20260819a_map2_account_dimension/migration.sql:221-223` | UNIQUE (channelType, COALESCE(marketplace,'~'), COALESCE(externalAccountId,'~')) WHERE isActive | current |
| `ChannelConnection_channelType_primary_key` | `20260819a_map2_account_dimension/migration.sql:226-227` | UNIQUE (channelType) WHERE isPrimary | current |

The schema comment at `schema.prisma:6059-6064` still describes the DROPPED index by name; it is stale. `accounts.routes.ts:262` still looks for the dropped index by name in `/api/accounts/diagnostics` (reports `present:false` — works, but the "blocker" it reports on is historical).

### 1.2 `model Channel` (`schema.prisma:2318-2327`)
`id`, `type`, `name`, `listings`, timestamps. Its `credentials` column was dropped (`schema.prisma:2321-2323`; `20260506_h2_unify_channel_connection/migration.sql:88`). Holds no credentials today.

### 1.3 `model Marketplace` (`schema.prisma:1670-1717`)
Catalogue of marketplaces: `channel`, `code`, `marketplaceId`, `region`, `currency`, `isActive` (operator toggle), `isParticipating`/`participationStatus`/`participationCheckedAt` (`1699-1702`, SP-API participation), `schemaMapping` Json. `@@unique([channel, code])` at `1715`. No credentials.

### 1.4 `model MarketplaceSync` (`schema.prisma:2305-2316`)
Per-product-per-channel sync status (`productId`, `channel`, `lastSyncStatus`, `lastSyncAt`). `@@unique([productId, channel])` at `2315`. No credentials.

### 1.5 `model AmazonAdsConnection` (`schema.prisma:3017-3059`)

| Line | Column | Notes |
|---|---|---|
| 3019 | `profileId` String @unique | Ads profile id |
| 3020 | `marketplace` | short code after HB.8 sweep (`20260521_hb8_marketplace_code_sweep/migration.sql:58-64`) |
| 3021 | `region` @default("EU") | |
| 3022 | `accountLabel` | |
| 3025 | `credentialsEncrypted` String? | **AES-256-GCM envelope** `{clientId, clientSecret, refreshToken}` (comment 3023-3024) |
| 3026 | `mode` @default("sandbox") | |
| 3027 | `writesEnabledAt` | operator opt-in |
| 3028 | `lastWriteAt` | |
| 3029 | `isActive` @default(false) | |
| 3030 | `lastVerifiedAt` | **no writer found in apps/api/src** (grep `amazonAdsConnection.update` — only `advertising.routes.ts:12031,12045,12070` write `writesEnabledAt`/`mode`) |
| 3031 | `lastErrorAt` | **no writer found** (same grep) |
| 3032 | `lastError` | **no writer found** |
| 3050 | `tokenIssuedAt` | stamped only at consent (`amazon-ads-auth.routes.ts:390,409,420`); schema comment 3039-3040 claims it is also stamped "on every refresh-token rotation" — **no such writer exists** (`grep tokenIssuedAt apps/api/src` → only `advertising.routes.ts:12227,12229` reads) |
| 3051 | `tokenExpiresAt` | consent + 365d (`amazon-ads-auth.routes.ts:391`) |
| 3052 | `tokenIssuedAtIsEstimate` | backfill flag |
| 3057-3058 | `@@index([marketplace,isActive])`, `@@index([tokenExpiresAt])` | |

### 1.6 `model AmazonAdsProfile` (`schema.prisma:3071-3091`)
Profile metadata only (`profileId @unique` 3073, `countryCode`, `currencyCode`, `timezone`, `accountType`, `accountEntityId`, `accountName`, `validPaymentMethod`, `lastSyncedAt`, `lastProfileFetchAt`). No credentials.

### 1.7 Other models storing credentials/secrets (grep `accessToken|refreshToken|apiKey|clientSecret|consumerKey|sharedSecret|credentialsEncrypted|webhookSecret`)

| Model | Line | Column | Encrypted? |
|---|---|---|---|
| `Carrier` | `schema.prisma:8586` | `credentialsEncrypted` | yes (crypto.ts; `services/sendcloud/index.ts:104-119`) |
| `Carrier` | `schema.prisma:8615` | `webhookSecret` | encrypted-or-plaintext with `isEncrypted` check (`routes/sendcloud-webhooks.routes.ts:115-117`) |
| `CarrierAccount` | `schema.prisma:8778` | `credentialsEncrypted` | yes (`routes/fulfillment.routes.ts:15350-15354`) |
| `ChannelConnection` | 6002/6003/6011/6012 | tokens | **NO** (see §4) |
| `AmazonAdsConnection` | 3025 | `credentialsEncrypted` | yes |

No `consumerKey`/`sharedSecret`/`apiKey` columns exist for channels; Shopify/Woo/Etsy have no DB credential row at all (§4.3).

---

## 2. Migrations touching `ChannelConnection` / `AmazonAdsConnection` (chronological)

| # | Migration | What it did |
|---|---|---|
| 1 | `20260503_p0_31_channel_connection/migration.sql:20-51` | CREATE TABLE ChannelConnection with the eBay-specific columns `ebayAccessToken`, `ebayRefreshToken`, `ebayTokenExpiresAt`, `ebayDevId`, `ebayAppId`, `ebaySignInName`, `ebayStoreName`, `ebayStoreFrontUrl` (25-32); indexes on channelType/isActive (47-51); adds `VariantChannelListing.channelConnectionId` + FK (60-104). |
| 2 | `20260505_e1_variant_channel_listing_marketplace/migration.sql:51-72` | No column change on ChannelConnection; reshapes VariantChannelListing uniqueness around (variantId, channel, marketplace); comments reference eBay rows pinned to a ChannelConnection. |
| 3 | `20260506_h2_unify_channel_connection/migration.sql` | H.2: adds generic `accessToken`, `refreshToken`, `tokenExpiresAt`, `displayName`, `managedBy` (29-35); backfills generic from `ebay*` for EBAY rows (44-50); index on managedBy (53-54); **partial unique** `(channelType, marketplace) WHERE isActive` (72-74); drops `MarketplaceCredential` table (76-81) and `Channel.credentials` (83-88). Pre-flight note: refresh cron must be off during migration (17-19). |
| 4 | `20260507_c14_ebay_path_b/migration.sql:14-48` | `EbayCampaign` with FK `channelConnectionId` → ChannelConnection ON DELETE CASCADE. |
| 5 | `20260516_ad1_trading_desk_substrate/migration.sql:126-147` | CREATE TABLE `AmazonAdsConnection` (`profileId` UNIQUE, `accountLabel`, `credentialsEncrypted`, …) + index (marketplace, isActive). |
| 6 | `20260521_hb8_marketplace_code_sweep/migration.sql:57-64` | `UPDATE AmazonAdsConnection SET marketplace = CASE …` (Amazon marketplace ids → 'IT','DE','FR','ES','NL', …). |
| 7 | `20260528_um1_marketing_os_core/migration.sql:104-111` | `EbayPromotedDetail.channelConnectionId` (nullable, no FK shown in grep). |
| 8 | `20260728_axie0_correctness/migration.sql:11-26` | AX-IE.0: adds `tokenIssuedAt`, `tokenExpiresAt`, `tokenIssuedAtIsEstimate` to AmazonAdsConnection + index; backfills `tokenIssuedAt=createdAt`, `tokenExpiresAt=createdAt+365d`, `IsEstimate=true`. |
| 9 | `20260819a_map2_account_dimension/migration.sql` | MAP.2a: adds `accountLabel`, `accountColor`, `isPrimary`, `sortOrder`, `externalAccountId` (45-54); backfills one primary per channel (57-61) and `externalAccountId=displayName` for AMAZON only (67-68); adds `channelConnectionId` to ChannelListing/SharedListingMembership/Order/SyncChannelPolicy (74-77) with backfill (86-118) and SET NULL FKs (167-192); **DROPS** `ChannelConnection_channelType_marketplace_active_key` (220); creates `ChannelConnection_active_account_key` (221-223) and `ChannelConnection_channelType_primary_key` (226-227). |
| 10 | `20260819b_map2b_account_unique_keys/migration.sql:52-71` | Adds the account dimension to ChannelListing / VariantChannelListing / SyncChannelPolicy unique keys (NULLS NOT DISTINCT). No ChannelConnection DDL. |

**No migration has dropped the `ebay*` columns** (`grep "DROP COLUMN.*ebay"` across migrations → none). The "one release" promised at `schema.prisma:6008-6010` (2026-05-06) has not happened as of 2026-08-29.

---

## 3. Every read/write of token columns

### 3.1 Prisma access sites on `channelConnection` (exhaustive; `grep channelConnection\.(find|update|create|upsert|delete|count)`)

| File:line | Op | Channel | Touches token columns? |
|---|---|---|---|
| `apps/api/src/index.ts:369,387,397` | findFirst / update / create | AMAZON (env) | no tokens written — `managedBy:'env'`, `displayName=sellerId`, `isActive`, `lastSyncStatus` (`index.ts:373-384`) |
| `apps/api/src/jobs/ebay-token-refresh.job.ts:73,80` | findUnique (select expiry only) | EBAY | reads `tokenExpiresAt`, `ebayTokenExpiresAt` |
| `apps/api/src/routes/ebay-orders.routes.ts:37,130,170` | findUnique (`prisma as any`) | EBAY | full row loaded (tokens in memory), token used via `getValidToken` |
| `apps/api/src/routes/ebay-orders.routes.ts:75` | update | EBAY | status only |
| `apps/api/src/routes/ebay-auth.ts:68` | create (placeholder, `isActive:false`) | EBAY | no |
| `apps/api/src/routes/ebay-auth.ts:221,329,456` | findUnique (full row) | EBAY | reads full row incl. tokens; 456 serialises only legacy `ebay*` display fields (473-476) |
| `apps/api/src/routes/ebay-auth.ts:276,310,336,358` | delete (placeholder cleanup) | EBAY | |
| `apps/api/src/routes/ebay-auth.ts:415` | findMany (full row) | EBAY | returns `ebaySignInName/ebayStoreName/ebayStoreFrontUrl/ebayTokenExpiresAt` (425-428) — **legacy-only read, no generic fallback** |
| `apps/api/src/routes/dashboard.routes.ts:1573,1839,2976` | findMany (select status fields) | all | no tokens |
| `apps/api/src/routes/accounts.routes.ts:192,235,292,311,333,359` | findMany/findUnique (full row) | all | reads `tokenExpiresAt ?? ebayTokenExpiresAt` (164), `ebayStoreName` (100), `ebaySignInName` (104) |
| `apps/api/src/routes/accounts.routes.ts:320,346,350,384` | update/updateMany | all | label/colour/sortOrder; isPrimary; disconnect sets `isActive:false,isPrimary:false,lastSyncStatus:'FAILED'` (386) — **tokens NOT cleared** |
| `apps/api/src/routes/connections.routes.ts:105,156,271` | findMany/findFirst (full row) | all | reads `tokenExpiresAt ?? ebayTokenExpiresAt` (70), `ebaySignInName/ebayStoreName/ebayStoreFrontUrl` (66-68) |
| `apps/api/src/routes/connections.routes.ts:288` | update | all | `connectionMetadata.activeMarketplaces` only |
| `apps/api/src/routes/ebay.routes.ts:41,121` | findUnique | EBAY | full row |
| `apps/api/src/routes/ebay.routes.ts:65` | update | EBAY | status only |
| `apps/api/src/routes/ebay.routes.ts:495` | findFirst `orderBy updatedAt desc` (**bypasses resolver**) | EBAY | **reads `ebayAccessToken && ebayRefreshToken` only** (501) |
| `apps/api/src/services/ebay-auth.service.ts:236` | findUnique | EBAY | reads `accessToken ?? ebayAccessToken`, `refreshToken ?? ebayRefreshToken`, `tokenExpiresAt ?? ebayTokenExpiresAt` (248-250) |
| `apps/api/src/services/ebay-auth.service.ts:279` | update | EBAY | **WRITES** generic (282-284) **AND legacy** `ebayAccessToken/ebayRefreshToken/ebayTokenExpiresAt` (285-287) |
| `apps/api/src/services/ebay-auth.service.ts:305` | update | EBAY | `lastSyncStatus:'FAILED'`, `lastSyncError` on refresh failure |
| `apps/api/src/services/ebay-auth.service.ts:340` | update (saveTokens) | EBAY | **WRITES** generic (343-345) **AND legacy** (354-359), `externalAccountId` conditional (351-353), `isActive:true` (360) |
| `apps/api/src/services/ebay-auth.service.ts:382` | findUnique | EBAY | reads `accessToken ?? ebayAccessToken` (387) |
| `apps/api/src/services/ebay-auth.service.ts:417` | update (revokeTokens) | EBAY | **NULLs** generic and legacy token columns (420-425), `isActive:false` |
| `apps/api/src/services/ebay-orders.service.ts:723,812` | findUnique (`prisma as any`) | EBAY | full row; token via `getValidToken` (738, 824) |
| `apps/api/src/services/connection-resolver.service.ts:136,143,277,314,332` | findMany/findUnique/findFirst/count | any | returns **full rows** (tokens included) to every caller |
| `apps/api/src/services/ebay-category.service.ts:406` | via `tryResolveConnection` | EBAY | **reads `ebayAccessToken && ebayRefreshToken` only** (legacy-only gate) |
| `apps/api/src/routes/ebay-notification.routes.ts:117-124` | via `listActiveConnections` | EBAY | reads `refreshToken`, `ebayRefreshToken` into memory; serialises only `hasRefreshToken` boolean (133,145) |
| `apps/api/src/jobs/ebay-token-refresh.job.ts:47-49` | via `listActiveConnections` | EBAY | reads `refreshToken !== null \|\| ebayRefreshToken !== null` (48), `ebaySignInName` (49) |
| `apps/api/src/services/ebay-returns/ingest.service.ts:263,276` | via resolver | EBAY | reads `ebaySignInName` |
| `apps/web/src/app/products/resolve/page.tsx:31` | `new PrismaClient()` **in the web app**, `findFirst({ where: { channel:'EBAY', isActive:true } })` | EBAY | `channel` is not a column (it is `channelType`) — this query throws at runtime; hidden by `as any`. Web-side direct DB access loads plaintext tokens into the Next.js server. |

Raw SQL: `grep '"ChannelConnection"' apps/api/src apps/web/src` → only `accounts.routes.ts:256-261` (reads `pg_indexes`, not the table).

### 3.2 Direct answer: are the deprecated `ebay*` columns still read / written?

**Still WRITTEN — yes, on every token save, every refresh, every revoke:**
- `apps/api/src/services/ebay-auth.service.ts:285-287` (refresh) — `ebayAccessToken`, `ebayRefreshToken`, `ebayTokenExpiresAt`
- `apps/api/src/services/ebay-auth.service.ts:354-359` (saveTokens) — the three above plus `ebaySignInName`, `ebayStoreName`, `ebayStoreFrontUrl`
- `apps/api/src/services/ebay-auth.service.ts:423-425` (revoke) — set to null
- `ebayDevId`, `ebayAppId`: **never written and never read by any app code** (grep across apps/api/src, apps/web/src, packages → zero hits outside schema). Pure dead columns.

**Still READ — yes, and in three places WITHOUT the generic fallback:**
- `apps/api/src/routes/ebay.routes.ts:501` — `conn.ebayAccessToken && conn.ebayRefreshToken` (gate for token health check; falls through to "tokenOk unknown" if legacy columns are dropped)
- `apps/api/src/services/ebay-category.service.ts:406` — `conn.ebayAccessToken && conn.ebayRefreshToken` (falls back to client-credentials silently)
- `apps/api/src/routes/ebay-auth.ts:425-428, 473-476` — `ebaySignInName/ebayStoreName/ebayStoreFrontUrl/ebayTokenExpiresAt` returned as-is
Generic-first with legacy fallback (safe to drop tokens, but `ebayStoreName/ebayStoreFrontUrl/ebaySignInName` have no generic home): `ebay-auth.service.ts:248-250,299,387`; `connections.routes.ts:66-70`; `accounts.routes.ts:100,104,164`; `ebay-token-refresh.job.ts:48-49,75-86`; `ebay-notification.routes.ts:119-139,166-183`; `ebay-returns/ingest.service.ts:263,276`.

Conclusion: the legacy columns **cannot be dropped today** without touching 3 legacy-only gates and finding a generic home for `ebayStoreName`/`ebayStoreFrontUrl`/`ebaySignInName`.

### 3.3 Other `accessToken` identifiers (not the DB column)
Most of the 60+ files matching `accessToken` use it as a local variable for an LWA/Shopify/Etsy bearer (e.g. `clients/amazon-sp-api.client.ts:119`, `services/marketplaces/shopify.service.ts:77-82`, `services/marketplaces/etsy.service.ts:240-244`, `routes/shopify-setup.routes.ts:71,84`, `utils/config.ts:36,44,109,119-120`). The web hits (`apps/web/src/app/settings/advertising/page.tsx`, `marketing/aplus/*`, `marketing/brand-story/*`, `design-system/components/AccountSwitcher.tsx`) reference `tokenExpiresAt`/`accessToken` in API response shapes, not DB access — **unverified in detail** (not opened).

---

## 4. Encryption at rest

### 4.1 Primitives available
- `apps/api/src/lib/crypto.ts` — AES-256-GCM, wire `v1:<iv>.<tag>.<ct>` (10-20); key from `NEXUS_CREDENTIAL_ENC_KEY` base64 32 bytes (`55-71`, fails loudly if wrong); `encryptSecret` (85), `decryptSecret` (106), `isEncrypted` (129). Header comment line 5: "Carrier credentials today; **ChannelConnection tokens later**".
- `packages/shared/vault.ts:3-39` — a second AES-256-GCM `Vault` class (hex key, `<iv>:<tag>:<ct>` format). **Not imported by apps/api or apps/web** (`grep "new Vault\|shared/vault" apps` → none in api/web). Only `apps/factory` has its own third copy `apps/factory/src/lib/vault.ts:22-35` (used by `apps/factory/src/lib/google/oauth.ts` and `apps/factory/src/app/api/integrations/carriers/route.ts`). `apps/api/.env.example:5` still documents `ENCRYPTION_KEY` (the Vault key) and does NOT document `NEXUS_CREDENTIAL_ENC_KEY`.

### 4.2 ChannelConnection tokens — **PLAINTEXT**
- Writes at `ebay-auth.service.ts:282-287` and `:343-345,354-356` store `newTokenData.access_token` / `refreshToken` verbatim. No call to `encryptSecret` anywhere in `ebay-auth.service.ts`, `ebay-auth.ts`, `index.ts`, or `accounts.routes.ts` (`grep encryptSecret|decryptSecret` → hits only in fulfillment, advertising, amazon-ads-auth, sendcloud, ads-api-client, ads-debug-probe).
- Reads at `ebay-auth.service.ts:248-250` use the raw column value as the Bearer token.
- Every resolver call (`connection-resolver.service.ts:136,143,314`) returns the full row, so plaintext tokens travel through ~60 call sites and any `logger.*({ connection })` would leak them (none found — §11).

### 4.3 AmazonAdsConnection — **ENCRYPTED**
- Write: `routes/amazon-ads-auth.routes.ts:376-382` → `encryptSecret(JSON.stringify({clientId, clientSecret, refreshToken}))`; manual create `routes/advertising.routes.ts:12271-12279` likewise.
- Read: `services/advertising/ads-api-client.ts:387-397`, `routes/amazon-ads-auth.routes.ts:84-93`, `services/advertising/ads-debug-probe.service.ts:20,481` → `decryptSecret`.
- `GET /api/advertising/connections` selects named fields (`advertising.routes.ts:12211-12232`) and does not return `credentialsEncrypted`.

### 4.4 Env-derived credentials (no `env.ts` schema; `apps/api/src/env.ts:1-19` only loads dotenv)
There is **no typed env schema**; services read `process.env.*` directly. Counts (`grep -o process.env.<VAR>` across apps/api/src):
- Amazon SP-API: `AMAZON_REFRESH_TOKEN` ×31, `AMAZON_LWA_CLIENT_ID` ×31, `AMAZON_LWA_CLIENT_SECRET` ×30, plus legacy aliases `AMAZON_CLIENT_ID/SECRET` (`clients/amazon-sp-api.client.ts:132-133`, `routes/amazon-auth-probe.routes.ts:37-38`). Central factory exists at `lib/amazon-sp-client.ts:22-39` but 18 other `new SellingPartner(...)` constructions exist (§Dead/duplicated).
- `AMAZON_SP_API_ACCESS_TOKEN` — a **static access token** read at `services/amazon-catalog.service.ts:106` (LWA access tokens live 1h; this can never be valid for long — dead path or misconfiguration; **unverified** whether the env var is set on prod).
- Amazon Ads: `AMAZON_ADS_CLIENT_ID/SECRET` (`routes/amazon-ads-auth.routes.ts:31-32`) copied INTO each encrypted `credentialsEncrypted` blob at consent (376-382).
- eBay OAuth app: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`, `EBAY_ENVIRONMENT` (`services/ebay-auth.service.ts:34-43`). eBay Trading (legacy Auth'n'Auth): `EBAY_APP_ID/CERT_ID/DEV_ID/TOKEN/SITE_ID` (`providers/ebay.provider.ts:36-41`; `EBAY_TOKEN` also gates `routes/stock.routes.ts:578`). eBay client-credentials: `services/marketplaces/ebay.service.ts:52-53,80`.
- Shopify: `SHOPIFY_SHOP_NAME`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET` via `utils/config.ts:35-45` and directly in `services/marketplaces/shopify.service.ts:81-82`, `services/outbound-sync.service.ts:1841` (also `SHOPIFY_ADMIN_API_TOKEN` alias). **No Shopify OAuth flow exists**; `routes/shopify-setup.routes.ts` has only `/admin/setup-shopify-webhooks` (82) and `/admin/shopify-webhook-status` (152), both env-based.
- WooCommerce: `WOOCOMMERCE_CONSUMER_KEY/SECRET/STORE_URL/WEBHOOK_SECRET` (`utils/config.ts:70-82`).
- Etsy: `ETSY_API_KEY`, `ETSY_ACCESS_TOKEN`, `ETSY_REFRESH_TOKEN`, `ETSY_SHOP_ID` (`utils/config.ts:107-120`); `services/marketplaces/etsy.service.ts:269-271` sends the access token as BOTH `Authorization: Bearer` and `x-api-key` (the latter should be the API key — bug).

The ChannelConnection row for Amazon is synthetic (`index.ts:373-384`, `managedBy:'env'`), holds no tokens, and is `isActive` iff env is configured.

---

## 5. OAuth state / CSRF / PKCE / redirect URIs

### 5.1 `apps/api/src/lib/auth/oauth-state.ts`
- Format `<b64url(payload)>.<b64url(HMAC-SHA256)>` (23, 76-85); payload `{channel, n (16 random bytes), iat, adoptConnectionId?}` (43-52).
- TTL 10 min (`MAX_AGE_MS` 41; checked 123-125). Channel binding (122). Constant-time compare (110-113).
- **Signing secret** = `NEXUS_CREDENTIAL_ENC_KEY || EBAY_CLIENT_SECRET` (60) — the encryption key doubles as an HMAC key (domain-separated at 67, but any leak of one is a leak of both).
- **No one-time use**: the nonce `n` is never stored or checked; replay within the 10-minute window is accepted (comment 34-36 relies on eBay's single-use code).
- **Not bound to a user session** — the state carries no session/user id, so it proves "minted by this server", not "minted for this browser". Combined with the callback being PUBLIC (§5.3), any browser holding a fresh state+code can complete a connect.
- Users: only `routes/ebay-auth.ts:112` (sign) and `:194` (verify). Nothing else imports it.

### 5.2 Flows that do NOT use it
| Flow | State handling | PKCE | prompt=login / nonce | Redirect URI |
|---|---|---|---|---|
| eBay (`routes/ebay-auth.ts`) | signed state ✔ (112, 194) | no | `prompt=login` default ON (`ebay-auth.ts:120`, `ebay-auth.service.ts:114`) | `redirect_uri` = `EBAY_RUNAME` (`ebay-auth.service.ts:90,145`); actual URL lives in eBay console; web callback page is `/settings/channels/ebay-callback` (`EbayCallbackContent.tsx:68`) |
| Amazon Ads LWA (`routes/amazon-ads-auth.routes.ts`) | `state` = random hex (281) stored in **in-memory `PKCE_STORE`** (21, 284); on callback **state is NOT validated** — `pkce` lookup is optional (315-316) and the exchange proceeds without it (330-332) | yes, S256 (282-293) but **optional on callback** | none | **hard-coded** `https://nexusapi-production-b7bb.up.railway.app/api/amazon-ads/auth/callback` fallback (35-37); success HTML links to hard-coded `https://nexus-commerce-web.up.railway.app/settings/advertising` (455) |
| Amazon SP-API | no OAuth flow in code; refresh token from env (`lib/amazon-sp-client.ts:23`) | n/a | n/a | n/a |
| `routes/amazon-auth-probe.routes.ts` | not an OAuth flow; refresh-token grant from env (29-47); self-gated by `?k=` = last 6 chars of `AMAZON_SELLER_ID` (56-60) | n/a | n/a | n/a |
| Shopify / Woo / Etsy | no OAuth flow exists | n/a | n/a | n/a |

Other hard-coded hosts: `lib/cors-origins.ts:16-17` (vercel), `NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app'` defaults in reviews/emails (`routes/reviews.routes.ts:1070,1366`, `services/email/auth-emails.ts:17`, etc.), `apps/web/src/lib/backend-url.ts:13`. No callback URL allow-list anywhere.

### 5.3 Auth guard on the connect routes (`lib/auth/permissions-manifest.ts`, first-match-wins)
| Route | Manifest | Effective |
|---|---|---|
| `POST /api/ebay/auth/callback` | PUBLIC (83) | unauthenticated by design |
| `POST /api/ebay/auth/{create-connection,initiate,revoke,refresh}`, `GET .../connections`, `.../connection/:id`, `.../test` | `RW(F.channelsConnect, …, pfx('/api/ebay/auth'))` (137) | session + `channelsConnect` |
| `GET /api/amazon-ads/auth/connect` **and** `/callback` | `PUBLIC` prefix `/api/amazon-ads/auth/` (82) | **unauthenticated — including `/connect`** |
| entry 138 `RW(F.adsConnect, …, pfx('/api/amazon-ads/auth'))` | shadowed by 82 | **dead manifest entry** |
| `GET /api/amazon-ads/debug/test-auth` | falls to `RW(F.adsView, F.adsCampaignsManage, pfx('/api/amazon-ads'))` (234) | `adsView` |
| `GET /api/admin/amazon-auth-probe` | PUBLIC (56); comment says "AWS_ROLE_ARN suffix" but code uses seller-id suffix (`amazon-auth-probe.routes.ts:51-58`) | weak self-gate |
| `/api/connections`, `/api/settings/channels/:type/*` | `settingsIntegrationsManage` (133) / `settingsView`+`settingsWorkspaceEdit` (`/api/settings` at ~129) | session |
| `/api/accounts` (GET) / writes | `PG.dashboard` / `settingsIntegrationsManage` (132); diagnostics 125 | session |
| `/api/admin/setup-shopify-webhooks`, `/api/admin/shopify-webhook-status` | manifest entry 134 requires `/api/shopify…/setup` — does not match; falls to `/api/admin` (404: `adminView/adminRepair`) | entry 134 is **dead** |
| `/api/admin/ebay-token-status`, `/api/admin/refresh-ebay-tokens` | `/api/admin` (404) | admin |

Enforcement depends on `NEXUS_RBAC_MODE=enforce` (`lib/auth/rbac-hook.ts:29-30`; default `shadow` lets everything through). `docs/security/S3-REPORT.md:3` states enforce is LIVE on prod — **runtime state unverified in this audit**.

---

## 6. Token refresh

| Channel | Where | Proactive/reactive | Cadence | Lock | Rotation | On failure |
|---|---|---|---|---|---|---|
| **eBay user token** | reactive: `services/ebay-auth.service.ts:225-318` (`getValidToken`, refresh when <5 min left, 259); proactive: `jobs/ebay-token-refresh.job.ts:31-122` calling the same fn | both | cron `*/30 * * * *` default (`job.ts:134`), default-ON (`index.ts:1046`); also `POST /api/admin/refresh-ebay-tokens` (`ebay-notification.routes.ts:154`) and cron-registry (`jobs/cron-registry.ts:170`) | **none** — no advisory lock, no in-flight promise; two concurrent callers within the 5-min window each POST a refresh and race the UPDATE (`ebay-auth.service.ts:268-292`) | handled: `newRefreshToken = refresh_token \|\| old` (272) written to both column sets | `lastSyncStatus:'FAILED'` + `lastSyncError` (305-311) — **overloads the sync-status field**; `isActive` untouched; no operator notification beyond the channels UI; writes are not paused; the cron only counts `failed++` (`job.ts:98-103`) |
| **Amazon SP-API LWA** (`clients/amazon-sp-api.client.ts:155-204`) | reactive, per-instance in-memory cache | 50-min cache (191) | none (concurrent first calls each refresh; harmless — LWA refresh tokens do not rotate) | n/a | throws (200-203); no DB status (env-managed row never updated after boot) |
| Amazon SP-API via `amazon-sp-api` npm (`lib/amazon-sp-client.ts:37`, `auto_request_tokens:true`) + 18 other `new SellingPartner` sites | reactive inside the library | library-managed | per-instance | n/a | throws |
| 12 hand-rolled LWA `grant_type:'refresh_token'` copies (`clients/amazon-fba-inbound-v2.client.ts:46`, `routes/amazon.routes.ts:2046,2142`, `services/amazon-participations.service.ts:64`, `services/channel-reconciliation.service.ts:74`, `services/aplus-amazon-pull.service.ts:53`, `services/amazon-financial-events.service.ts:435`, `services/fba-inbound.service.ts:54`, `routes/amazon-auth-probe.routes.ts:35`) | reactive | some cache (`fba-inbound.service.ts:45-70`, `amazon-fba-inbound-v2.client.ts:61-62`), others none (`amazon.routes.ts` probes) | none | n/a | throws |
| **Amazon Ads LWA** (`services/advertising/ads-api-client.ts:208-247`) | reactive | cache `expires_in − 60s` (241) | **yes** — per-profile in-flight promise map (`_tokenInflight` 206, 218-219, 244-247) | Ads refresh tokens do not rotate; `tokenIssuedAt` only stamped at consent (`amazon-ads-auth.routes.ts:390`) | throws with response text (234-237); `AmazonAdsConnection.lastError/lastErrorAt` **never written** (§1.5); `daysToTokenExpiry` computed only in `GET /api/advertising/connections` (`advertising.routes.ts:12240`) — **no cron/health alert on the 365-day expiry** (`grep amazonAdsConnection routes/health.ts jobs/` → only `jobs/sqp-ingest.job.ts:133`), contradicting `schema.prisma:3039-3041` ("the /health alert") |
| eBay client-credentials app token (`services/marketplaces/ebay.service.ts:46-60`) | reactive, cached with 60s buffer (48-49) | — | none | n/a | throws |
| Shopify / WooCommerce | static env tokens; no refresh | — | — | — | — |
| Etsy | `ETSY_REFRESH_TOKEN` read into config (`utils/config.ts:110,120`) but **no refresh code** in `services/marketplaces/etsy.service.ts` (`grep refresh` → only the field) | — | — | — | Etsy tokens expire hourly → integration cannot work (**unverified** whether Etsy is configured) |

`apps/api/src/services/ebay-account.service.ts:74` obtains its token through `getValidToken` (no refresh logic of its own).

---

## 7. Connection status semantics and routes

### 7.1 Fields meaning "connected"
| Field | Set by |
|---|---|
| `isActive` | eBay saveTokens → true (`ebay-auth.service.ts:360`); revoke → false (426); accounts disconnect → false (`accounts.routes.ts:386`); Amazon env seed ← `amazonConfigured` (`index.ts:377`); Ads: `amazon-ads-auth.routes.ts:408,417` |
| `managedBy` | `'oauth'` on saveTokens (347); `'env'` in seed (`index.ts:376`); default `'oauth'` (schema 5997) |
| `lastSyncStatus/lastSyncError/lastSyncAt` | eBay refresh success (`ebay-auth.service.ts:288-290`), refresh failure (308-309), saveTokens (361-363), revoke (427-428, writes `SUCCESS` on revoke), disconnect (`accounts.routes.ts:386` writes `FAILED`/"Disconnected by operator"), eBay sync routes (`ebay.routes.ts:65-70`, `ebay-orders.routes.ts:75`), env seed (`index.ts:378-382`), plus `listings-syndication.routes.ts`, `marketplaces.routes.ts`, `sync-control.routes.ts` (files match `lastSyncStatus:` + `channelConnection`; contents **unverified**) |
| `isPrimary` | migration backfill; `POST /api/accounts/:id/primary` (`accounts.routes.ts:345-351`); cleared on disconnect (386) |
| `externalAccountId` | eBay saveTokens when identity scope returned it (351-353); migration backfill for AMAZON (`20260819a…:67-68`) |
| `tokenExpiresAt` | eBay only (284, 345) |

Health derivation for the UI (`accounts.routes.ts:128-143`): `!isActive → error`; `lastSyncStatus SUCCESS→ok, PARTIAL→warn, FAILED→error, null→unknown`; deliberately ignores token expiry (header 20-27). **Heartbeat / live health call:** only `GET /api/ebay/auth/test?connectionId=` (`ebay-auth.ts:572-614`, calls `getSellerInfo`) and the token cron. No periodic health probe of Amazon/Ads connections; the Amazon env row's status is frozen at boot.

### 7.2 `apps/api/src/routes/connections.routes.ts` — all routes (registered with `prefix:'/api'`, `index.ts:770`)
| Method Path | Lines | Guard | Returns | "connected" from |
|---|---|---|---|---|
| `GET /api/connections` | 100-139 | `settingsIntegrationsManage` (manifest 133) | one `ConnectionRow` per channel (`toConnectionRow` 58-77), `pending:` placeholders for missing channels (81-97); filter `managedBy in (oauth, env)` (107); active first then `updatedAt desc` (109) | `isActive`, `isManagedBy`, `lastSync*`, `tokenExpiresAt` (generic ?? legacy) |
| `GET /api/settings/channels/:type/detail` | 146-235 | `/api/settings` rule (settingsView) | freshest row + `scopes`/`activeMarketplaces` from `connectionMetadata` (170-178) + last 50 `webhookEvent` rows + stats | same |
| `PATCH /api/settings/channels/:type/marketplaces` | 246-320 | settingsWorkspaceEdit | validates against `ALLOWED_MARKETPLACES` (327-333), writes `connectionMetadata.activeMarketplaces` (288-296), **writes settings audit** (300-306) | picks row by same ordering (271-277) — not via resolver |

`connectionMetadata.scopes` is read (171) but never written anywhere (`grep connectionMetadata:` → only `connections.routes.ts:291`).

### 7.3 MAP accounts routes (`apps/api/src/routes/accounts.routes.ts`, prefix `/api`, `index.ts:771`)
| Method Path | Lines | Guard | Effect |
|---|---|---|---|
| `GET /api/accounts` | 186-228 | `PG.dashboard` | active oauth/env rows, `AccountRow` (152-169), `canSwitch` |
| `GET /api/accounts/diagnostics` | 233-289 | `settingsIntegrationsManage` | totals, byChannel, `pg_indexes` dump (256-261) |
| `GET /api/accounts/:id/blast-radius` | 291-303 | settingsIntegrationsManage | counts of dependent rows (172-182) |
| `PATCH /api/accounts/:id` | 306-329 | settingsIntegrationsManage | `accountLabel/accountColor/sortOrder`; colour regex (316) |
| `POST /api/accounts/:id/primary` | 332-355 | settingsIntegrationsManage | transaction clear-then-set (345-351) |
| `POST /api/accounts/:id/disconnect` | 358-391 | settingsIntegrationsManage | refuses if primary with siblings (369-377); sets `isActive:false, isPrimary:false, lastSyncStatus:'FAILED'` (384-387). **No channel-side revoke, tokens left in the row.** |

### 7.4 eBay-specific routes (`apps/api/src/routes/ebay-auth.ts`, registered WITHOUT prefix, `index.ts:627`; paths carry `/api/ebay/auth/...` literally)
`POST create-connection` (54-93), `POST initiate` (100-142; returns `authUrl` + raw `state` in body 127-132), `POST callback` (149-404), `GET connections` (413-444), `GET connection/:connectionId` (450-491), `POST revoke` (497-528), `POST refresh` (534-566; **returns first 20 chars of the access token** 555), `GET test?connectionId=` (572-614). Web uses only `initiate`, `revoke`, `test`, `create-connection`, `callback` (`ChannelsClient.tsx:193,239,317`; `EbayCallbackContent.tsx:46,61`). `GET connections`, `GET connection/:id`, `POST refresh` have **no web caller** (dead surface).

---

## 8. Disconnect / revoke

| Path | Channel-side revoke? | Local effect |
|---|---|---|
| `POST /api/ebay/auth/revoke` → `ebayAuthService.revokeTokens` (`ebay-auth.service.ts:380-437`) | **yes** — `POST {apiBaseUrl}/identity/v1/oauth2/token/revoke` with the ACCESS token (395-404); non-200 only warns (406-410) | nulls all six token columns, `isActive:false`, `lastSyncStatus:'SUCCESS'` (417-430) |
| `POST /api/accounts/:id/disconnect` (`accounts.routes.ts:358-391`) — used by `AccountsPanel.tsx:202` | **no** | `isActive:false` only; **plaintext access+refresh tokens remain in the row** (384-387) |
| Amazon Ads `DELETE /api/advertising/connections/:profileId` (`advertising.routes.ts:12302`) | **no** LWA revoke | row deleted |
| Amazon SP-API | no revoke path (env-managed) | — |
| Shopify / Woo / Etsy | none | — |

eBay revoke sends the access token, not the refresh token; eBay's endpoint revokes the grant either way (**unverified** — vendor behaviour). The 9 historical revoked eBay rows on prod (`accounts.routes.ts:188-190` comment) were revoked through which path is **unverified**.

---

## 9. `connection-resolver.service.ts` contract (10 lines)
1. `resolveConnection(scope)` (`163-229`) returns a full `ChannelConnection` row or throws `NoConnectionError` (55) / `AmbiguousConnectionError` (38).
2. Scopes (`77-90`): NAMED `{accountId}`; DERIVED `{listingId}`, `{variantListingId}`, `{itemId, marketplace?}`, `{orderId}`, `{channel, channelOrderId}`; DECLARED `{channel, primary:true}`.
3. NAMED → `byId` (142-151) requires `isActive`, else throws.
4. DERIVED reads the row's `channelConnectionId` (MAP.2a attribution) and falls back to `resolveDeclared(channel)` when null (172-173, 182-184, 198-199, 208-209, 222-223).
5. `resolveDeclared` (232-236) = `listActiveConnections` (135-140: `isActive`, ordered isPrimary desc, sortOrder, createdAt) + `chooseConnection` (103-132): 1 active → it; >1 → the single `isPrimary` row or throw.
6. `tryResolveConnection` (252-260) swallows every error → `null` (including ambiguity; comment 247-250 warns against ambiguous scopes but nothing enforces it).
7. `primaryConnectionIds(channels)` (273-294) batches the DECLARED resolution; `null` for channels with no active row.
8. `findAccountByExternalId` (309-322) and `countUnidentifiedAccounts` (331-335) serve the OAuth callback.
9. `resolveConnectionId` (338-340) convenience.
10. Channel-agnostic by design (28-31); every function returns the full row including plaintext tokens.

Bypasses still present: `routes/ebay.routes.ts:495-498` (`findFirst orderBy updatedAt desc`) and `routes/connections.routes.ts:105-110,156-163,271-277` (own ordering).

---

## 10. Audit logging of grants / refreshes / revokes
`grep -i audit` on `ebay-auth.ts`, `amazon-ads-auth.routes.ts`, `accounts.routes.ts`, `shopify-setup.routes.ts`, `ebay-auth.service.ts`, `ebay-token-refresh.job.ts`, and the Ads connection routes in `advertising.routes.ts:12015-12310`:
- **Only** `PATCH /api/settings/channels/:type/marketplaces` writes an audit row (`connections.routes.ts:300-306`, `writeSettingsAudit`).
- eBay connect (`ebay-auth.ts:371`), re-consent/adopt (268, 333), revoke (511), manual refresh (548), Ads consent (`amazon-ads-auth.routes.ts:399`), Ads manual credential upsert/delete (`advertising.routes.ts:12275,12302`), enable/disable writes and set-mode (`12031,12045,12070`), account disconnect / primary change (`accounts.routes.ts:350,384`): **no audit row**, only `logger.info`.
- `writeAuthAudit` (`lib/auth/audit.ts:36`) exists and is used by the RBAC hook for denials (`rbac-hook.ts:75-83`) and by auth routes; not by any connection flow.
- eBay token exchange/refresh calls are recorded in the outbound API call log via `recordApiCall` (`ebay-auth.service.ts:127-134,177-184`) — success rows have no payload; failure rows store the eBay error body only (`services/outbound-api-call-log.service.ts:92,281`). Not an audit of who did what.

---

## 11. Secrets in logs (connect / auth / refresh paths)
Every `logger.*` in `ebay-auth.ts`, `ebay-auth.service.ts`, `ebay-token-refresh.job.ts`, `amazon-ads-auth.routes.ts`, `amazon-auth-probe.routes.ts`, `shopify-setup.routes.ts`, `ads-api-client.ts`, `amazon-sp-api.client.ts`, `ebay-notification.routes.ts` was listed. Findings:

| File:line | What is logged | Risk |
|---|---|---|
| `routes/ebay-auth.ts:124` | `state.substring(0,8)+"..."` | prefix only — fine |
| `routes/amazon-ads-auth.routes.ts:297` | full `state` | the state is the key into `PKCE_STORE`; log-reader could pair it with a stolen code — low |
| `services/ebay-auth.service.ts:151,200` | eBay error body (`errorBody`) | vendor error JSON; no token — fine |
| `services/ebay-auth.service.ts:166,215,301,372,434` | `{ error }` object | if `error.body` carried a token it would print; eBay error bodies do not — fine |
| `clients/amazon-sp-api.client.ts:184-185` (throw) → `:200-202` | `LWA auth failed: <status> - <errorText>` | LWA error text contains no token — fine |
| `services/advertising/ads-api-client.ts:234-237` | `[ADS-LWA] token exchange failed <status>: <text>` | same |
| `routes/amazon-ads-auth.routes.ts:340,345` | LWA/profile error text | same |
| `services/ebay-auth.service.ts:294,367` | `expiresAt` only | fine |

**No log line prints an access token, refresh token, client secret, or authorization code** in these paths. Non-log exposures instead:
- `POST /api/ebay/auth/refresh` returns `token.substring(0,20)+"..."` in the HTTP response (`ebay-auth.ts:555`).
- `GET /api/amazon-ads/debug/test-auth` returns `refreshTokenPrefix` (15 chars, 143), access-token prefixes (145-146, 165, 259), the stored `clientId` (139) and fires live report-creation requests at Amazon (205-225) on every GET.
- Ads callback success HTML echoes a 10-char access-token prefix (`amazon-ads-auth.routes.ts:431,445`).
- `POST /api/ebay/auth/initiate` returns the raw `state` in the JSON body (`ebay-auth.ts:130`) — by design, needed for the redirect.

---

## 12. Tokens / codes in URL query strings
| Site | What | Direction |
|---|---|---|
| `GET /api/amazon-ads/auth/callback?code=&state=` (`amazon-ads-auth.routes.ts:302-303`) | authorization code in query | inbound from Amazon (standard) — landed on the API host directly, so it appears in API access logs (**unverified** whether Railway logs query strings) |
| `/settings/channels/ebay-callback?code=&state=` (`EbayCallbackContent.tsx:16-17`) then `POST /api/ebay/auth/callback` JSON body (61-70) | code in query on the web page, moved to a POST body | inbound from eBay (standard) |
| `GET /api/ebay/auth/test?connectionId=` (`ebay-auth.ts:572-576`) | connection id only | fine |
| `GET /api/admin/amazon-auth-probe?k=<6 chars of seller id>` (`amazon-auth-probe.routes.ts:56-58`) | gate key in query | weak secret in URL |
| `GET /r/:token` review links (`schema.prisma:11475`, `routes/reviews.routes.ts:1320`) | out of scope (review tokens) | — |
No route emits an access/refresh token in a URL. `grep access_token|token=` across `apps/web/src` → only the eBay callback `code` read.

---

## Security findings (ranked)

1. **HIGH — ChannelConnection eBay access + refresh tokens stored in plaintext**, in six columns (`schema.prisma:6002-6003,6011-6012`; writes `ebay-auth.service.ts:282-287,343-345,354-356`). `lib/crypto.ts:5` has promised "ChannelConnection tokens later" since CR.1; the Neon credential is already known-exposed in git history (memory: `project_neon_credential_exposed_in_git.md`), which makes DB-at-rest exposure a live threat, not theoretical. Every resolver call (`connection-resolver.service.ts:136,143,314`) fans the plaintext row out to ~60 call sites.
2. **HIGH — Amazon Ads LWA callback does not validate `state`** and treats PKCE as optional (`amazon-ads-auth.routes.ts:315-316,330-332`), and both `/connect` and `/callback` are PUBLIC (`permissions-manifest.ts:82`). An attacker can complete the flow with their own Amazon Ads consent and bind their profiles as `isActive:true` connections (399-425), replacing the operator's encrypted credentials for any colliding `profileId`, or adding foreign profiles the crons then act on. Also the `PKCE_STORE` is process-local (`:21`) so any multi-instance deploy silently loses PKCE.
3. **HIGH — `POST /api/accounts/:id/disconnect` leaves live tokens in the row** (`accounts.routes.ts:384-387`): no eBay revoke, no token null-out. A "disconnected" account's refresh token (18-month lifetime) stays usable by anyone with DB read.
4. **MEDIUM — Signed OAuth state is replayable and not session-bound** (`oauth-state.ts:34-36,76-85,101-127`): no one-time-use record, no user/session claim; the callback is PUBLIC. Any browser holding a valid state+code can attach a grant to a placeholder connection it creates itself (`ebay-auth.ts:54-93` is behind `channelsConnect`, but `EbayCallbackContent.tsx:46` calls it without `credentials:'include'` unless the global fetch patch `apps/web/src/lib/auth/install-fetch.ts:42` is active — **unverified** on the callback page).
5. **MEDIUM — HMAC signing key reuse**: state secret = `NEXUS_CREDENTIAL_ENC_KEY || EBAY_CLIENT_SECRET` (`oauth-state.ts:60`). Leaking the client secret (or the encryption key) lets an attacker mint states; a dedicated secret would decouple them.
6. **MEDIUM — Debug/probe endpoints in production code**: `GET /api/amazon-ads/debug/test-auth` (`amazon-ads-auth.routes.ts:82-269`, comment "Remove once auth is stable") decrypts stored credentials, prints prefixes, and creates real Ads reports; `GET /api/admin/amazon-auth-probe` is PUBLIC with a 6-char gate derived from a semi-public seller id (`amazon-auth-probe.routes.ts:56-60`, `permissions-manifest.ts:56`) and can issue a live listings PATCH with `?write=1` (61). `GET /aplus/probe`, `/finance/probe` in `amazon.routes.ts:2034,2125` do their own LWA exchange.
7. **MEDIUM — Hard-coded redirect URI and web URL** (`amazon-ads-auth.routes.ts:35-37,455`), no callback allow-list; a host move silently breaks or misroutes the LWA flow.
8. **MEDIUM — No concurrency control on eBay refresh** (`ebay-auth.service.ts:259-292`): the 30-min cron (`job.ts:134`), any sync, and the manual route can refresh the same row simultaneously; eBay may rotate the refresh token (272), so a lost-update race can persist a stale refresh token and dead-lock the account until re-consent. Only the Ads client dedupes in-flight refreshes (`ads-api-client.ts:206-247`).
9. **MEDIUM — Refresh failure is indistinguishable from sync failure** (`ebay-auth.service.ts:305-311` writes `lastSyncStatus:'FAILED'`); revoke writes `SUCCESS` (427). There is no `status`/`lastError`-style auth-health field on ChannelConnection, no operator alert, and writes are not paused on auth failure.
10. **MEDIUM — Amazon Ads refresh-token expiry (365 days) has no alert**: `lastError/lastErrorAt/lastVerifiedAt` are never written (§1.5); `daysToTokenExpiry` exists only in one GET (`advertising.routes.ts:12240`); schema comment claims a `/health` alert that does not exist (`schema.prisma:3039-3041`).
11. **LOW — Prefix leakage in HTTP responses**: 20-char eBay token prefix (`ebay-auth.ts:555`), 15-char Ads refresh-token prefix + client id (`amazon-ads-auth.routes.ts:139,143`), 10-char access token in HTML (445).
12. **LOW — No audit trail** for any grant, refresh, revoke, primary change, mode change or write-enable (§10); only marketplace scope edits are audited.
13. **LOW — Web app opens its own PrismaClient** and would read plaintext tokens server-side (`apps/web/src/app/products/resolve/page.tsx:28-36`); currently crashes on the non-existent `channel` field (hidden by `as any`).
14. **LOW — Etsy sends the OAuth access token as `x-api-key`** (`services/marketplaces/etsy.service.ts:269-271`) and has no refresh logic; `AMAZON_SP_API_ACCESS_TOKEN` static access token (`amazon-catalog.service.ts:106`).
15. **INFO — RBAC is shadow by default** (`rbac-hook.ts:29-30`); everything in §5.3 assumes `NEXUS_RBAC_MODE=enforce` on prod (documented at `docs/security/S3-REPORT.md:3`, runtime **unverified**).

---

## Dead / duplicated code found in this area

| Item | Evidence |
|---|---|
| `ChannelConnection.ebayDevId`, `ebayAppId` | never read or written by app code (grep → schema only) |
| `ChannelConnection.ebayAccessToken/ebayRefreshToken/ebayTokenExpiresAt` dual-write | "one release" promise `schema.prisma:6008-6010` (2026-05-06) still live at `ebay-auth.service.ts:285-287,354-356,423-425`; 3 legacy-only readers block the drop (§3.2) |
| Stale schema comment describing the dropped singleton index | `schema.prisma:6059-6064` vs `20260819a…:220` |
| `ConnectionMetadata.scopes` read but never written | `connections.routes.ts:171` vs single writer at 291 |
| `packages/shared/vault.ts` (Vault class) | zero importers in apps/api or apps/web; third copy in `apps/factory/src/lib/vault.ts`; `apps/api/.env.example:5` documents its `ENCRYPTION_KEY` instead of the real `NEXUS_CREDENTIAL_ENC_KEY` |
| Permission-manifest entries shadowed/unmatched | `permissions-manifest.ts:138` (shadowed by 82); `:134` (`/api/shopify…/setup` matches nothing — routes are `/api/admin/setup-shopify-webhooks`, `shopify-setup.routes.ts:82,152`) |
| `accounts.routes.ts:262-281` looks for the dropped index by name | always `present:false` |
| eBay auth routes with no caller | `GET /api/ebay/auth/connections` (413), `GET /api/ebay/auth/connection/:id` (450), `POST /api/ebay/auth/refresh` (534) — web calls none of them; `_redirectUriIgnored` params and `redirectUri` body fields (`ebay-auth.service.ts:71,125`; `ebay-auth.ts:21,104-108,234-236`; `EbayCallbackContent.tsx:68`; `ChannelsClient.tsx:197`) |
| `GET /api/amazon-ads/debug/test-auth` | self-described temporary (`amazon-ads-auth.routes.ts:79-81`) |
| `GET /api/admin/amazon-auth-probe` | self-described TEMPORARY (`amazon-auth-probe.routes.ts:2`), manifest comment describes a different gate key (`permissions-manifest.ts:54-55`) |
| 14 hand-rolled LWA `refresh_token` exchanges | `amazon-sp-api.client.ts:175`, `amazon-fba-inbound-v2.client.ts:46`, `amazon.routes.ts:2046,2142`, `amazon-auth-probe.routes.ts:35`, `amazon-participations.service.ts:64`, `amazon-ads-auth.routes.ts:100,247`, `channel-reconciliation.service.ts:74`, `aplus-amazon-pull.service.ts:53`, `amazon-financial-events.service.ts:435`, `fba-inbound.service.ts:54`, `ads-debug-probe.service.ts:44`, `ads-api-client.ts:228` (the last two are the Ads pair, legitimately separate) |
| 18 `new SellingPartner(...)` constructions besides the shared factory | `lib/amazon-sp-client.ts:30` (shared) vs `amazon-flat-file.routes.ts:118-126`, `amazon-cockpit-publish.routes.ts:49-57`, `sp-api-reports.service.ts:105`, `amazon-settlements.service.ts:46`, `sp-api-pricing.service.ts:52`, `amazon/data-kiosk.service.ts:79`, `images/amazon-image-feed.service.ts:543`, `amazon-pushback/index.ts:171`, `amazon-pushback/buy-shipping.ts:240-242`, `channel-batch/amazon-batch-feed.service.ts:254,343`, `order-cancellation/channel-cancel.ts:89`, `marketplaces/amazon.service.ts:312` |
| `AMAZON_CLIENT_ID/SECRET` legacy env aliases | `amazon-sp-api.client.ts:132-133`, `amazon-auth-probe.routes.ts:37-38,67,69`, `amazon-notifications.routes.ts:67` |
| `AMAZON_SP_API_ACCESS_TOKEN` static token path | `amazon-catalog.service.ts:106-108` |
| `EBAY_TOKEN` Auth'n'Auth provider | `providers/ebay.provider.ts:36-41` — used by `ebay-trading-api.service.ts` header comment says the static token path "is left untouched" (`:7`); `stock.routes.ts:578` gates on it |
| `apps/web/src/app/products/resolve/page.tsx:28-36` | web-side PrismaClient querying a non-existent `channel` column on ChannelConnection |
| `AmazonAdsConnection.lastVerifiedAt/lastErrorAt/lastError` | columns with no writer |
| `ebayNotificationRoutes` re-implements the token-status projection twice | `ebay-notification.routes.ts:117-149` and `:165-190` (near-identical blocks) |
