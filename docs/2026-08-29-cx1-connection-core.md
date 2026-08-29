# CX.1 — Connection core: exact change proposal

**Status:** PROPOSED — nothing built. Parent: `docs/2026-08-29-cx-channel-connections.md` §1.2 A–D and §4 (CX.1). Decisions §5 apply (API-host callback, KMS envelope encryption, archive-never-delete). Findings by S-number from the audit §5; research facts from `docs/cx-research-2026-08-29/` (R2 eBay, R8 Nango, R9/R9a).

**Goal.** Replace the eBay-only, plaintext, unlocked, unrecorded connection plumbing with the shared core every later connector plugs into — **without changing what the operator sees working today** (the eBay popup keeps working before and after the RuName is re-pointed). After CX.1: credentials are envelope-encrypted with a KMS master key and decrypted in exactly one module; refreshes are leased (no double refresh, ever); every grant/refresh/revoke/heartbeat is a ledger row; `authStatus` and four honest timestamps exist; scopes are recorded and drift is computed; eBay asks for the full EU-seller scope set and signs the calls eBay requires EU sellers to sign; the resolver never hands out a token again.

**Not in CX.1:** the Channels page rebuild (CX.2 — CX.1 only exposes the new fields and populates the existing Scopes card), Amazon SP-API/Ads OAuth (CX.3 — CX.1 lays the catalogue entries and the token service they will use), the ingress (CX.4), Shopify/Etsy connectors (CX.5/6).

---

## 1. Schema — one additive migration `20260830a_cx1_connection_core`

### 1.1 `ChannelConnection` — new columns (all nullable or defaulted; nothing dropped)
| Column | Type | Meaning |
|---|---|---|
| `authStatus` | `String @default("unknown")` | `connected · degraded · needs_reauth · revoked · disconnected · unknown` (§4.3 state machine) |
| `region` | `String?` | catalogue region key (eBay `GLOBAL`, Amazon `EU/NA/FE`, Shopify shop, Etsy shop) |
| `credentialsEnc` | `String?` | **the** credential blob: `v2:<kid>:<wrappedDek>.<iv>.<tag>.<ct>` over JSON `{accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt?, extra?}` |
| `credentialsKeyId` | `String?` | KMS key id / alias version used (rotation bookkeeping) |
| `grantedScopes` | `String[] @default([])` | scopes the channel actually granted (from the token response / introspection) |
| `accessTokenExpiresAt` | `DateTime?` | copy of the blob's expiry for cheap cron queries (never the token itself) |
| `refreshTokenExpiresAt` | `DateTime?` | eBay: consent + 47,304,000 s; Ads: consent + 365 d (tokens issued ≥ 2026-07-30); Etsy: last refresh + 90 d |
| `lastRefreshAt` · `lastHeartbeatAt` · `lastInboundAt` · `lastOutboundAt` | `DateTime?` | the four honest timestamps (B3-19) |
| `lastErrorAt` · `lastError` | `DateTime?` · `String?` | last auth/heartbeat failure, class-tagged (`auth_revoked`, `auth_expired`, `rate_limited`, `network`, `unknown`) |
| `consecutiveFailures` | `Int @default(0)` | refresh/heartbeat failures since the last success |
| `refreshLeaseUntil` · `refreshLeaseOwner` | `DateTime?` · `String?` | the distributed refresh lease (§4.2) |
| `identity` | `Json?` | `{ userId, username, storeName?, storeUrl?, sellerId?, shopDomain? }` — replaces the legacy `ebaySignInName/ebayStoreName/ebayStoreFrontUrl` trio going forward |
| `apiVersion` | `String?` | connector API version pinned at connect |
Indexes: `@@index([authStatus])`, `@@index([accessTokenExpiresAt])`, `@@index([refreshTokenExpiresAt])`.

### 1.2 New tables
- **`ConnectionScope`** (`id`, `connectionId` FK → ChannelConnection **ON DELETE CASCADE** — a scope has no meaning without its grant, unlike listings/orders which are SET NULL), `kind` (`marketplace | shop | profile | storefront`), `externalId`, `label`, `region?`, `isActive @default(true)`, `metadata Json?`, `createdAt/updatedAt`; unique `(connectionId, kind, externalId)`). Backfill: eBay rows get one `marketplace` scope per `connectionMetadata.activeMarketplaces` entry (or IT/DE/FR/ES/UK when empty); the Amazon env row gets one per `Marketplace` row with `isParticipating` (11 on prod).
- **`ChannelApp`** (`id`, `channelKey` (`EBAY | AMAZON_SP | AMAZON_ADS | SHOPIFY | ETSY | …`), `environment` (`production | sandbox`), `clientId`, `clientSecretEnc` (v2 envelope), `redirectUris String[]`, `extra Json?` (eBay RuName, Etsy keystring, SP-API application id), `signingKeyEnc String?` (eBay Key Management private key, §6.3), `signingKeyId String?`, `secretExpiresAt DateTime?`, `rotatedAt DateTime?`, `createdAt/updatedAt`; unique `(channelKey, environment)`). Seeded at boot **once** from the existing env vars (`EBAY_CLIENT_ID/SECRET/RUNAME`, `AMAZON_LWA_CLIENT_ID/SECRET`, `AMAZON_ADS_CLIENT_ID/SECRET`, `AMAZON_ADS_REDIRECT_URI`) when no row exists — env stays the source until the row exists, then the row wins (documented in §9).
- **`OAuthSession`** (`id` = the `state` (32 random bytes, base64url), `channelKey`, `intent` (`connect | reconnect | adopt`), `targetConnectionId?`, `startedByUserId`, `codeVerifier?`, `redirectUri`, `cookieNonce` (double-submit value), `region?`, `expiresAt` (10 min), `consumedAt?`, `resultConnectionId?`, `error?`, `createdAt`). Swept by the heartbeat job (`expiresAt < now - 1 day` → delete).
- **`ConnectionEvent`** (`id`, `connectionId?` (SET NULL), `channelKey`, `type` (`grant | reconsent | adopt | refresh | refresh_failed | revoke | disconnect | heartbeat_ok | heartbeat_failed | scope_drift | status_change | secret_rotated | signing_key_created`), `actorUserId?`, `detail Json?` (never contains token material — the writer redacts), `createdAt`; `@@index([connectionId, createdAt])`, `@@index([type, createdAt])`). **Archive, never delete** (decision 9): a nightly job moves rows older than 90 days to the object-store archive and keeps the row with `detail = null` + `archivedRef` — this needs an S3-compatible bucket; until the bucket exists the archiver is a no-op that logs, and nothing is deleted.

### 1.3 Backfill inside the migration (SQL, transactional, gated)
1. `credentialsEnc` cannot be written by SQL (KMS). The migration only adds columns; the **`cx1-credentials-backfill` one-shot job** (§9) encrypts every row that has plaintext tokens and, per row, sets `credentialsEnc` then nulls `accessToken/refreshToken/ebayAccessToken/ebayRefreshToken` **in the same UPDATE** (`WHERE id=? AND credentialsEnc IS NULL`), so a row is never both. It refuses to null if the round-trip decrypt does not equal the plaintext it read.
2. `authStatus`: `isActive AND (tokens present OR managedBy='env') → 'connected'`; `NOT isActive → 'disconnected'`; the identity-superseded row (`lastSyncError LIKE 'Superseded%'`) → `'disconnected'`.
3. `refreshTokenExpiresAt` for eBay rows = `createdAt + 547 days` (conservative: the grant cannot be older than the row); replaced by the true value at the next re-consent.
4. `identity` for eBay rows from `ebaySignInName/ebayStoreName/ebayStoreFrontUrl/externalAccountId`; for the Amazon row from `externalAccountId`.
5. `ConnectionScope` backfill as in §1.2, with a `DO` block that RAISEs if the produced scope count is 0 for any active row (MAP precedent: prove the backfill before trusting it).

No unique key changes; MAP's `ChannelConnection_active_account_key` and `_channelType_primary_key` stay exactly as they are.

---

## 2. `ChannelCatalog` — `apps/api/src/services/cx/catalog.ts`

One typed object per channel (Nango providers.yaml pattern, R8 #1, with the fields Nango lacks):

```ts
export interface ChannelSpec {
  key: ChannelKey; displayName: string;
  auth: { mode: 'oauth2_code' | 'oauth2_pkce' | 'oauth2_cc' | 'api_key' | 'hmac_key';
          authorizeUrl?: (ctx) => string; tokenUrl: (ctx) => string;
          authorizationParams?: Record<string,string>; tokenParams?: Record<string,string>; refreshParams?: Record<string,string>;
          tokenRequestAuth: 'basic' | 'body'; scopeSeparator: ' ' | ',';
          codeParamInCallback?: string;               // SP-API 'spapi_oauth_code'
          callbackMetadata?: string[];                // ['selling_partner_id'], ['sellerId']
          tokenResponseMetadata?: string[];
          pkce: boolean; promptParam?: Record<string,string>;   // eBay { prompt: 'login' }
          requiredScopes: string[]; reviewGatedScopes?: { scope: string; reason: string }[];
          accessTokenLifetimeSec?: number; refreshTokenLifetimeSec?: number | null; rotatesRefreshToken: boolean;
          revokeUrl?: string; introspectUrl?: string; };
  regions?: { key: string; label: string; hosts: Record<string,string> }[];
  identity: (handle) => Promise<{ userId: string; username?: string; extra?: Record<string,unknown> }>;
  heartbeat: (handle) => Promise<{ ok: true; scopes?: string[]; latencyMs: number } | { ok: false; errorClass: ErrorClass; message: string }>;
  discoverScopes?: (handle) => Promise<ConnectionScopeInput[]>;   // Amazon participations, Ads profiles, TikTok shops
  signing?: { scheme: 'ebay-rfc9421' | 'kaufland-hmac' | 'tiktok-sign'; appliesTo: (req) => boolean };
  rateLimit: { parse: (res) => RateLimitReading | null; model: 'token_bucket' | 'daily_quota' | 'leaky_bucket' | 'points' };
  webhooks: { scheme: 'ebay-ecdsa' | 'shopify-hmac' | 'sqs' | 'standard-webhooks' | 'none'; subscriptionApi: boolean; lifecycleTopics: string[] };
  apiVersion: string; sandbox?: { available: boolean; hosts?: Record<string,string> };
  connectException?: { reason: string; deepLink: string; keyFormat: RegExp; verify: (creds) => Promise<boolean> };
}
```
Entries in CX.1: **EBAY** (full — the ~20-scope EU set from research B1.3, `prompt=login`, `refreshTokenLifetimeSec: 47304000`, `rotatesRefreshToken: false`, revoke/introspect URLs, signing `ebay-rfc9421` applied to `/sell/finances/`, `issueRefund`, Trading `GetAccount`, Post-Order refunds, heartbeat = `GET /commerce/identity/v1/user/` on the `apiz` host, rate-limit parse of `X-EBAY-C-…`/429 `errorId 2001`), **AMAZON_SP** (consent URL builder per region host, `codeParamInCallback: 'spapi_oauth_code'`, `callbackMetadata: ['selling_partner_id']`, `pkce: false`, `refreshTokenLifetimeSec: 365 d` for public apps, heartbeat = `getMarketplaceParticipations`, `discoverScopes` = participations → `marketplace` scopes, rate-limit parse of `x-amzn-RateLimit-Limit`), **AMAZON_ADS** (EU consent host, scopes, `refreshTokenLifetimeSec: 365 d`, heartbeat = `/v2/profiles`, `discoverScopes` = profiles, `Retry-After`), **SHOPIFY** and **ETSY** (auth shape + scopes + heartbeat only; `available: false` until their phases — the catalogue is what lets CX.2 render honest "not yet available" cards instead of "Coming soon"). The UI, the OAuth service, the heartbeat job and the token service all read the catalogue; adding a channel later is one entry + one connector directory.

---

## 3. Crypto v2 — `apps/api/src/lib/crypto.ts` (extended, `v1` still decrypts)

- **Envelope:** `v2:<kid>:<wrappedDek>.<iv>.<tag>.<ct>` (base64url parts). Per blob: 32-byte DEK from `kms:GenerateDataKey` (AES_256), AES-256-GCM with a 12-byte IV and 16-byte tag, `wrappedDek` = the KMS `CiphertextBlob`. Decrypt: `kms:Decrypt` on the wrapped DEK (cached in memory for 10 min keyed by the wrapped blob's hash, bounded LRU of 256), then GCM.
- **Master key:** `NEXUS_KMS_KEY_ID` (alias, e.g. `alias/nexus-credentials-production`), region `AWS_REGION` (already `eu-west-1` for SQS), credentials = the existing `AWS_ACCESS_KEY_ID/SECRET` (the IAM user needs `kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey` on that key — **Owner prerequisite**, §10). Dependency: `@aws-sdk/client-kms` (same SDK family already in `apps/api/package.json`).
- **Break-glass:** if `NEXUS_KMS_KEY_ID` is unset, `encryptCredentials` uses the `v1` env-key path **and raises a `ConnectionEvent{type:'status_change', detail:{kmsFallback:true}}` + an `alert.service` warning once per boot**; `decryptCredentials` accepts both formats forever. Local dev runs on `v1` by design.
- **API:** `encryptCredentials(obj: Credentials): Promise<{ blob, keyId }>`, `decryptCredentials(blob): Promise<Credentials>`, `reencrypt(blob)` (used by the rotation job), `credentialsKeyIdOf(blob)`. `encryptSecret/decryptSecret` (v1) stay for the Ads/carrier callers until CX.3 migrates them.
- **Rotation:** KMS alias rotation is automatic yearly; because the DEK is wrapped under the key *version* at encryption time, old blobs keep decrypting; the `cx-reencrypt` job (manual trigger in the cron registry) re-wraps blobs whose `credentialsKeyId` is not the current key version.
- Tests: round-trip with a fake KMS client (`aws-sdk-client-mock`), tamper detection, `v1` fallback, cache eviction, and a test that the decrypted object never appears in `JSON.stringify(logger context)` (uses the CX.0 redactor).

---

## 4. Token service — `apps/api/src/services/cx/token.service.ts` (the only decryptor)

### 4.1 Public API
```ts
getAccessToken(connectionId, opts?: { restricted?: RdtRequest; forceRefresh?: boolean }): Promise<string>
refreshNow(connectionId, actor?: Actor): Promise<RefreshOutcome>            // manual + cron
revoke(connectionId, actor: Actor, reason: 'operator' | 'channel' | 'reauth'): Promise<void>
storeGrant(connectionId, grant: GrantResult, actor: Actor, event: 'grant'|'reconsent'|'adopt'): Promise<void>
handleOf(connection: ConnectionRow): ConnectionHandle                       // what connectors receive
```
`ConnectionHandle` carries id/channel/region/scopes/identity and a `token()` closure — **never the credentials**.

### 4.2 Refresh algorithm (Nango #3/#4 with the two fixes)
1. Read `accessTokenExpiresAt`; if `> now + buffer` (catalogue `token_expiration_buffer`, default 15 min; eBay 10 min) → decrypt and return.
2. In-process in-flight map keyed by connection id (collapses concurrent callers in one process).
3. **Lease** (distributed, pgbouncer-safe — no advisory locks held across HTTP): `UPDATE "ChannelConnection" SET "refreshLeaseUntil" = now() + interval '30 seconds', "refreshLeaseOwner" = $owner WHERE id = $id AND ("refreshLeaseUntil" IS NULL OR "refreshLeaseUntil" < now())` → 1 row = we own it; 0 rows = another worker is refreshing → poll the row every 250 ms up to 12 s for a new `accessTokenExpiresAt`, return the fresh token (double-check), else fail with `RefreshContended`.
4. Under the lease: re-read (double-check), call the catalogue's refresh, parse; **rotation rule:** if the response carries a `refresh_token`, store it and (for Etsy) reset `refreshTokenExpiresAt`; if not, keep the old one (eBay/Amazon never rotate — verified in R1/R2).
5. Success: write `credentialsEnc`, `accessTokenExpiresAt`, `lastRefreshAt = now`, `consecutiveFailures = 0`, `authStatus` per §4.3, release the lease, `ConnectionEvent{refresh}`. **Never touch `lastSyncAt/lastSyncStatus`** — that is the lie CX.1 removes.
6. Failure: classify (`invalid_grant`/`401`/eBay `errorId 1001`/revoked → `auth_revoked`; `refreshTokenExpiresAt < now` → `auth_expired`; 429 → `rate_limited`; network → `network`), `consecutiveFailures++`, `lastError*`, release the lease, `ConnectionEvent{refresh_failed}`, 30-s cooldown before the next attempt; `auth_revoked/auth_expired` → `authStatus = needs_reauth` **immediately**; other classes → `degraded` after 3 consecutive failures, `needs_reauth` after 10 (≈ 5 h of 30-min crons) — consecutive, not calendar days (R8 §8).
7. `needs_reauth` pauses writes: `OutboundSyncService.dispatch` and the eBay push paths call `tokenService.assertWritable(connectionId)` which throws `ConnectionNeedsReauth` → the queue row is deferred (auth-class deferral already exists at `outbound-sync.service.ts:100-112`), reads keep using the access token while it lives.
8. RDT (`opts.restricted`): SP-API `createRestrictedDataToken` per `{method, path, dataElements}`, cached 50 min per key — used by CX.3; the interface is fixed here.

### 4.3 `authStatus` state machine
`unknown` → `connected` on grant/heartbeat_ok/refresh; `connected` → `degraded` on 3 consecutive non-auth failures; `degraded` → `connected` on the next success (+ `ConnectionEvent{status_change}` + recovery alert); `connected|degraded` → `needs_reauth` on `auth_revoked/auth_expired` or on scope drift when a **required** scope is missing for a write path; `→ revoked` only from a channel signal (CX.4 `AUTHORIZATION_REVOCATION`, `app/uninstalled`) ; `→ disconnected` on operator disconnect; `needs_reauth|revoked|disconnected` → `connected` on a new grant (`reconsent`/`adopt`). Every transition writes `ConnectionEvent{status_change}` and — for `→ needs_reauth`, `→ revoked`, and 30/7/1-day-before `refreshTokenExpiresAt` — an `alert.service` **SYNC_FAILURE**-class alert (email + in-app via the existing channels; new `AlertType.CONNECTION_HEALTH`).

---

## 5. OAuth service + routes — `services/cx/oauth.service.ts`, `routes/cx-connect.routes.ts`

- `POST /api/cx/connect/:channel/start` (`channelsConnect`): body `{ intent, targetConnectionId?, region? }` → validates against the catalogue (intent `adopt` requires an existing row of that channel), creates `OAuthSession` (state = id, `codeVerifier` when `pkce`, `cookieNonce`), sets cookie `nexus_oauth_<state>=<nonce>; Path=/api/cx/callback; HttpOnly; Secure; SameSite=None; Max-Age=600` (SameSite=None because the callback arrives as a cross-site top-level navigation from the channel), returns `{ authorizeUrl, state, expiresIn: 600 }`. Authorize URL = catalogue builder with **all `requiredScopes`**, `promptParam`, PKCE S256, `redirect_uri` = `ChannelApp.redirectUris[0]` (eBay: the RuName). Web opens the popup synchronously as today.
- `GET /api/cx/callback/:channel` (PUBLIC, the only public route): reads `state` + the channel's code param (`code` or `spapi_oauth_code`) + `error/error_description`; loads the session (`consumedAt IS NULL`, not expired) and **marks it consumed in the same UPDATE** (single use); checks the double-submit cookie (`nexus_oauth_<state>` must equal `cookieNonce`) — **enforced**, with a `NEXUS_OAUTH_COOKIE_ENFORCE=0` escape hatch for one release in case a browser strips it (event logged either way); exchanges the code (PKCE verifier when set; Basic or body auth per catalogue); captures `callbackMetadata`/`tokenResponseMetadata`; records `grantedScopes` from the token response `scope` (eBay returns none on the code grant → call `introspect`; SP-API none → roles are implicit; Ads `scope` present); runs `identity`; applies the MAP rules **moved verbatim** from `routes/ebay-auth.ts:266-377` into `services/cx/identity.service.ts` (fold by `externalAccountId`, adopt onto `targetConnectionId`, `EBAY_IDENTITY_UNMATCHED`/`_UNAVAILABLE` generalised to `IDENTITY_UNMATCHED`/`IDENTITY_UNAVAILABLE`); `tokenService.storeGrant(...)`; `discoverScopes` → `ConnectionScope` upsert; `ConnectionEvent{grant|reconsent|adopt}`; renders the **callback page** (server-rendered HTML using DS tokens, same look as the current success screen): `postMessage({type:'nexus:channel-connected', channel, connectionId, sellerName}, ORIGIN)` to `window.opener` **and** a `BroadcastChannel('nexus-oauth')`, waits up to 1.5 s for `{type:'nexus:ack'}`, then `window.close()`; without an opener it links back to `/settings/channels`. Provider errors (`error`, `error_description`) are shown verbatim and written to `OAuthSession.error`.
- **eBay compatibility bridge (no Owner action required):** the existing web page `/settings/channels/ebay-callback` becomes a one-line forwarder: `location.replace(`${API}/api/cx/callback/ebay?${location.search}`)`. The RuName keeps pointing at the web page; once the Owner re-points it to the API callback (decision §5.1) the bridge is dead code and is removed in CX.2. `POST /api/ebay/auth/initiate`, `/callback`, `/create-connection`, `/refresh`, `/revoke`, `/test` become thin shims over the new service (initiate → `start`, callback → 410 with a message, test → heartbeat) so nothing external breaks in the same release; the three routes with no caller are deleted.
- `ChannelsClient.tsx` `handleConnectEbay` → `POST /api/cx/connect/ebay/start` with `{ intent: adoptConnectionId ? 'adopt' : 'connect', targetConnectionId }` and `credentials: 'include'`; listener also accepts the `BroadcastChannel` message and replies with the ACK. That is the **only** web change in CX.1 besides the forwarder.

---

## 6. eBay connector directory — `services/cx/connectors/ebay/`

- `spec.ts` (the catalogue entry), `client.ts` (`fetch` wrapper that injects the bearer, marketplace header, **request signing** for the catalogue's `appliesTo` paths, parses rate-limit headers, classifies errors), `auth.ts` (code exchange, refresh, revoke, introspect, identity — moved from `ebay-auth.service.ts`), `signing.ts`.
- **Scopes requested** (`spec.auth.requiredScopes`): `api_scope, sell.inventory, sell.inventory.readonly, sell.account, sell.account.readonly, sell.marketing, sell.marketing.readonly, sell.fulfillment, sell.fulfillment.readonly, sell.finances, sell.payment.dispute, sell.analytics.readonly, sell.logistics, sell.stores, sell.stores.readonly, sell.listing.read (if present on the keyset), commerce.identity.readonly, commerce.notification.subscription, commerce.notification.subscription.readonly, commerce.catalog.readonly, commerce.message, commerce.feedback, commerce.shipping`. The eBay consent page lists exactly what is requested; a scope the keyset is not entitled to makes eBay return `invalid_scope` on the authorize URL — CX.1 verification includes the real consent page, so the final list is whatever the production keyset accepts, recorded in `grantedScopes` (§11).
- **Scope drift:** `driftOf(connection) = requiredScopes − grantedScopes`; exposed on `/api/connections` and `/api/accounts` as `scopeDrift: string[]`; existing accounts (`xaviaracing`, `motovento`) will show drift until reconnected — the Accounts panel's existing **Reconnect** button already runs the adopt flow, so the operator's action is one click + sign-in.
- **Request signing (S-none, R2 §H — mandatory for EU/UK sellers):** `signing.ts` implements RFC 9421/9530: `Content-Digest: sha-256=:<b64(sha256(body))>:` (omitted on GET), `x-ebay-signature-key: <JWE from Key Management>`, `Signature-Input: sig1=("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created=<unix>`, `Signature: sig1=:<b64(ED25519 over the signature base)>:`. The signing key is created once via `POST /developer/key_management/v1/signing_key` (ED25519) using the **application** token; the private key + JWE are stored in `ChannelApp.signingKeyEnc` (v2 envelope) — eBay does not store the private key, so losing it means creating a new pair (event-logged). Applied to `/sell/finances/**`, `POST …/issueRefund`, Trading `GetAccount`, Post-Order refund/cancellation approvals. `ebay-financial-events.service.ts` is switched to `connectors/ebay/client.ts` so **the daily prod 403 (errorId 215001) stops** — that is the CX.1 acceptance test for signing.
- Callers that read tokens directly (`ebay-orders.routes.ts:37,130,170`, `ebay.routes.ts:495-501`, `ebay-category.service.ts:406`, `ebay-notification.routes.ts:117-149`, `ebay-token-refresh.job.ts:47-49`, `ebay-returns/ingest.service.ts`, the flat-file routes' 12 `getValidToken` calls) keep calling `ebayAuthService.getValidToken(id)` which becomes `tokenService.getAccessToken(id)` — one shim, zero behavioural change for them.

---

## 7. Heartbeat + expiry job — `jobs/cx-heartbeat.job.ts` (`*/15 * * * *`, registry key `cx-heartbeat`, default on)

For every `ChannelConnection` with `managedBy IN ('oauth','env') AND authStatus NOT IN ('disconnected','revoked')`: run the catalogue `heartbeat` (eBay identity call; Amazon env row → `getMarketplaceParticipations`, which also refreshes `ConnectionScope` and `Marketplace.participation*` — today stale since 2026-06-24), record `lastHeartbeatAt`, `latencyMs` into `OutboundApiCallLog`, apply §4.3, compute drift, emit expiry alerts at 30/7/1 days before `refreshTokenExpiresAt` and `ChannelApp.secretExpiresAt`, proactively refresh access tokens expiring within 2× the cron interval (replaces `ebay-token-refresh.job.ts`, which is deleted; its registry key is kept as an alias for one release). Also: prune expired `OAuthSession` rows; release stale leases (`refreshLeaseUntil < now - 5 min`).

---

## 8. Resolver and read APIs

- `connection-resolver.service.ts`: `listActiveConnections`, `resolveConnection`, `tryResolveConnection`, `findAccountByExternalId` add `select: CONNECTION_PUBLIC_SELECT` (every column **except** `accessToken, refreshToken, ebayAccessToken, ebayRefreshToken, credentialsEnc`); return type `ConnectionRow` (a Prisma `Omit`). `tsc` then flags every site that touched a token through a resolver row — the audit's list (§6 above) — and they move to the token service. The resolver's contract, scopes and ratchet are unchanged.
- `/api/connections` and `/api/accounts` rows gain `authStatus, grantedScopes, scopeDrift, region, scopes[] (ConnectionScope), lastRefreshAt, lastHeartbeatAt, lastInboundAt, lastOutboundAt, refreshTokenExpiresAt, identity`; `deriveHealth` reads `authStatus` first (`needs_reauth/revoked → error`, `degraded → warn`, `connected → ok`, `unknown → unknown`) and only then `lastSyncStatus` — the AccountsPanel copy changes from "Healthy" to the truthful word without any layout change (CX.2 redesigns the card).
- `/api/settings/channels/:type/detail` returns `scopes = grantedScopes` and `scopeDrift`; the existing ScopesCard text "the OAuth callback writes them to connectionMetadata.scopes" is replaced by the real state ("N scopes granted · M missing — Reconnect to grant new permissions"). `connectionMetadata.scopes` is never written (the column is not the home).

---

## 9. Boot, one-shot jobs, feature flags

- Boot: `seedChannelApps()` (env → `ChannelApp` rows once), `seedEnvManagedConnections()` unchanged except it no longer stamps `lastSyncStatus:'SUCCESS'` (it sets `authStatus:'unknown'` and lets the heartbeat decide within 15 min — S-honesty).
- One-shot `cx1-credentials-backfill` (registry-triggered, idempotent, logs `{encrypted, nulled, skipped}`; refuses to null on a failed round-trip) — run once on prod after deploy, verified by the DB query in §11.
- Flags: `NEXUS_CX_TOKEN_SERVICE` (default `1`; `0` routes `getValidToken` back to the legacy path for one release — rollback without redeploy), `NEXUS_OAUTH_COOKIE_ENFORCE` (default `1`), `NEXUS_KMS_KEY_ID` (unset = v1 fallback with alert).

---

## 10. Owner prerequisites (outside code)
1. **AWS KMS key**: create a symmetric key with alias `alias/nexus-credentials-production` in `eu-west-1`, enable automatic rotation, and grant the IAM user that already holds `AWS_ACCESS_KEY_ID` the actions `kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey` on it; set `NEXUS_KMS_KEY_ID` on Railway. Without it CX.1 still ships on the `v1` env key (with the alert) — but the enterprise bar says KMS, so this is the ask.
2. **eBay**: nothing required for CX.1 to work (the web forwarder bridges the RuName). Optional now, required by CX.2: re-point the RuName's *Auth Accepted URL* to `https://nexusapi-production-b7bb.up.railway.app/api/cx/callback/ebay`.
3. Be available for **one reconnect** of `xaviaracing` (the primary) so the full-scope grant, signing key and heartbeat can be verified live (§11). `motovento` can be reconnected later.

---

## 11. Verification on prod (after deploy + backfill)
| Check | Expected |
|---|---|
| DB: `SELECT count(*) FROM "ChannelConnection" WHERE "credentialsEnc" IS NOT NULL` vs rows with plaintext tokens | every active oauth row has `credentialsEnc` starting `v2:` (or `v1:` if KMS is not yet configured — reported honestly) and **NULL** in all four plaintext columns |
| Reconnect `xaviaracing` via the panel (popup → eBay sign-in → consent lists the full scope set → callback page → ACK → closes) | row folds by `externalAccountId`; `grantedScopes` populated; `scopeDrift = []`; `refreshTokenExpiresAt ≈ now + 547 d`; `ConnectionEvent{reconsent}` with `actorUserId`; `OAuthSession.consumedAt` set; replaying the callback URL → 400 `state_consumed` |
| Cookie enforcement | a callback without the `nexus_oauth_<state>` cookie → 400 `state_cookie_missing` (curl) |
| Concurrency | two parallel `POST /api/cx/connections/:id/refresh` (new admin route, `settingsIntegrationsManage`) → exactly one token exchange in `OutboundApiCallLog`, one `ConnectionEvent{refresh}`, second call returns the same `accessTokenExpiresAt` |
| Signing | `ebay-financial-sync` triggered from the registry → **200** from `/sell/finances/v1/transaction` (was 403/215001 daily); `ConnectionEvent{signing_key_created}` once |
| Heartbeat | within 15 min every active row has `lastHeartbeatAt`; Amazon row's `ConnectionScope` = 11 marketplaces; `Marketplace.participationCheckedAt` advances |
| Honesty | Amazon card no longer says "Last sync: never" beside a green status — it shows `authStatus` from a real heartbeat and no `lastSyncStatus` stamp |
| Existing crons | `ebay-orders-sync`, `ebay-readback`, `amazon-sqs-poll`, `ams-sqs-poll`, all Amazon crons green for 24 h on the new token path |
| Old routes | `POST /api/ebay/auth/callback` → 410; `GET /api/ebay/auth/connections` → 404 |
| Screenshots | Channels page (unchanged layout, truthful health words + drift chip), eBay detail ScopesCard populated, the new callback page |

## 12. Tests (vitest)
crypto v2 (fake KMS) · token service lease under 50 concurrent callers (one refresh) · rotation rule (Etsy-style rotate vs eBay-style keep) · state machine transitions · OAuth start/callback (state single-use, cookie enforced, PKCE verifier sent, provider error surfaced) · identity fold/adopt/unmatched (moved tests) · eBay RFC 9421 signature against the published eBay SDK test vector · heartbeat job classification · resolver select excludes credentials (a type-level test + a runtime `expect(row).not.toHaveProperty('accessToken')`).

## 13. Risks · rollback
Medium. The token path is behind `NEXUS_CX_TOKEN_SERVICE`; the backfill is idempotent and nulls plaintext only after a verified round-trip; the migration is additive; the web forwarder keeps the RuName working. Rollback = flag off + revert commit; the encrypted blobs are ignored by the legacy path (plaintext columns would have to be restored from the blobs by the `cx1-credentials-restore` counterpart job, which ships with the backfill).

## 14. Files
New: `services/cx/{catalog,token.service,oauth.service,identity.service,events.service,connectors/ebay/*}.ts`, `routes/cx-connect.routes.ts`, `routes/cx-connections.routes.ts` (refresh/revoke admin), `jobs/cx-heartbeat.job.ts`, `jobs/cx1-credentials-backfill.job.ts`, `lib/crypto.ts` (v2), migration `20260830a_cx1_connection_core`, tests. Touched: `connection-resolver.service.ts`, `accounts.routes.ts`, `connections.routes.ts`, `ebay-auth.ts` (shims), `ebay-auth.service.ts` (delegates), `ebay-financial-events.service.ts`, `ebay-token-refresh.job.ts` (deleted), `index.ts`, `cron-registry.ts`, `permissions-manifest.ts` (`/api/cx/connect` → channelsConnect, `/api/cx/callback` → PUBLIC), `apps/web/.../ChannelsClient.tsx`, `apps/web/.../ebay-callback/EbayCallbackContent.tsx` (forwarder), `ChannelDetailClient.tsx` (ScopesCard copy), `apps/api/package.json` (`@aws-sdk/client-kms`).

**Waiting for the Owner's go-ahead on this exact change** (and the KMS key, which can land in parallel).
