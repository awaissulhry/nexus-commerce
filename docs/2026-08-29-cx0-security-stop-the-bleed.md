# CX.0 — Security stop-the-bleed: exact change proposal

**Status:** PROPOSED — nothing built. Parent: `docs/2026-08-29-cx-channel-connections.md` §4 (CX.0). Findings referenced by S-number from `docs/2026-08-29-cx-audit.md` §5.

**Goal:** close every Critical/High finding and the cheapest Mediums with the smallest diff that leaves the working system working. No schema change. No new subsystem — those start in CX.1. Every item below names the exact file, lines, and the change.

**Deliberately NOT in CX.0** (they belong to their phase and would widen the diff): the shared OAuth service and API-host callback (CX.1), eBay's real ECDSA notification verification and subscriptions (CX.4 — nothing arrives today: 0 eBay events on prod, no subscriptions exist), Shopify raw-body verification beyond the parser swap (CX.5), deleting Woo *services* that the live outbound engine and tracking-pushback still import (CX.5/CX.7), token encryption (CX.1), CSRF on body-less POSTs (S15, CX.1 with the new routes).

---

## 1. Deletions (dead or dangerous surfaces)

| # | Finding | Change | Files |
|---|---|---|---|
| D1 | S1 — PUBLIC stock-mutating routes with no caller | Delete `routes/webhooks.routes.ts` (both routes); remove import `index.ts:40` and `app.register(webhookRoutes)` `index.ts:642`; delete `scripts/verify-s1-shadow-path.mjs` (its only caller). Stock movements from real channels never used this path (file header says so). | `apps/api/src/routes/webhooks.routes.ts` (−), `apps/api/src/index.ts`, `scripts/verify-s1-shadow-path.mjs` (−) |
| D2 | S2 — six unauthenticated Etsy receivers for a webhook product that does not exist in that shape | Delete `routes/etsy-webhooks.ts`; remove import `index.ts:29` + register `:625`; remove `dispatchEtsyWebhook` import from `routes/sync-logs.routes.ts:41-43` and its replay branch; remove the Etsy entries from the sync-logs webhook replay switch. (Etsy's real order webhooks arrive in CX.6 through the ingress.) | `routes/etsy-webhooks.ts` (−), `index.ts`, `routes/sync-logs.routes.ts` |
| D3 | S7 + decision #5 — Woo receivers never reject; Woo is out of scope | Delete `routes/woocommerce-webhooks.ts` and `routes/woocommerce.ts` (no caller anywhere); remove imports `index.ts:26-27` + registers `:622-623`; remove `dispatchWooWebhook` from `sync-logs.routes.ts`; delete `validateWooCommerceSignature` from `utils/webhook.ts:41-65`. Woo services stay until CX.5 (imported by `outbound-sync.service.ts:2117`, `tracking-pushback.job.ts`, `marketplace.service.ts`). | `routes/woocommerce-webhooks.ts` (−), `routes/woocommerce.ts` (−), `index.ts`, `sync-logs.routes.ts`, `utils/webhook.ts` |
| D4 | S5 — PUBLIC write-capable probe | Delete `routes/amazon-auth-probe.routes.ts`; remove import `index.ts:186` + register `:786`; remove the manifest entry + its two comment lines `lib/auth/permissions-manifest.ts:54-56`. | `routes/amazon-auth-probe.routes.ts` (−), `index.ts`, `permissions-manifest.ts` |
| D5 | S16 — debug route that decrypts credentials and fires live report jobs | Delete the `GET /amazon-ads/debug/test-auth` handler, `routes/amazon-ads-auth.routes.ts:79-269`, and any helper used only by it. | `routes/amazon-ads-auth.routes.ts` |
| D6 | S8 — unsigned refund test route gated by an env value | Delete `POST /webhooks/shopify/refunds/create-test`, `routes/shopify-webhooks.ts:1402-1418`; update `scripts/verify-r41-shopify-refund-webhook.mjs` and `scripts/smoke-returns-end-to-end.mjs` to sign a request to the real route with the secret from env instead (or delete them if they cannot). | `routes/shopify-webhooks.ts`, two scripts |
| D7 | S19 — 20-char token echoed to the client | `routes/ebay-auth.ts:551-556`: replace `token: token.substring(0, 20) + "..."` with `refreshed: true` (route has no web caller; full removal is CX.1). | `routes/ebay-auth.ts` |

## 2. Guards and fail-closed verification

| # | Finding | Change | Files |
|---|---|---|---|
| G1 | S4 — Ads `/connect` PUBLIC; callback accepts any `code` without `state` | Manifest `permissions-manifest.ts:82`: change `p.startsWith('/api/amazon-ads/auth/')` to `p === '/api/amazon-ads/auth/callback'` so `/connect` falls through to the existing `RW(F.adsConnect…)` rule at `:138`. Callback `amazon-ads-auth.routes.ts:302-332`: `if (!state) return 400 {error:'missing_state'}`; `const pkce = PKCE_STORE.get(state)`; `if (!pkce || Date.now() >= pkce.expiresAt) return 400 {error:'invalid_state'}`; delete the entry; **always** send `code_verifier`. Add `PKCE_STORE` pruning of expired entries on each `/connect`. (The in-memory store is replaced by `OAuthSession` in CX.1; on a single Railway instance it is sufficient until then — instance count **unverified**, noted.) | `permissions-manifest.ts`, `routes/amazon-ads-auth.routes.ts` |
| G2 | S9 — HMAC over `JSON.stringify(body)`; `===` compare | In each receiver plugin function (they are plain async plugins, so Fastify encapsulation scopes the parser to that plugin's routes): `shopifyWebhookRoutes` (`shopify-webhooks.ts:918`), `ebayNotificationRoutes` (`ebay-notification.routes.ts:111`), `sendcloudWebhookRoutes` (`sendcloud-webhooks.routes.ts:97`) — add `app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, buf, done) => { (req as RawBodyRequest).rawBody = buf; try { done(null, JSON.parse(buf.toString('utf8'))) } catch (e) { done(e as Error) } })` and a `RawBodyRequest` type in `utils/webhook.ts`. Shopify routes (`:929,996,1063,1130,1197,1264,1338`): `const body = request.rawBody` (Buffer) instead of `JSON.stringify(request.body)`. eBay (`:349`): use `req.rawBody` only; drop the `?? JSON.stringify` fallback. Sendcloud (`:136`): same, drop the re-stringify comment block. `utils/webhook.ts:17-38` `validateShopifySignature(body: Buffer, hmacHeader, secret)`: compute base64 HMAC over the buffer; compare with `crypto.timingSafeEqual` after a length check; return `isValid:false` on any header absence. | `utils/webhook.ts`, `routes/shopify-webhooks.ts`, `routes/ebay-notification.routes.ts`, `routes/sendcloud-webhooks.routes.ts` |
| G3 | S6 — eBay push verification skipped when the env token is unset | `ebay-notification.routes.ts:348-357`: if `!token` → `reply.code(503).send({error:'notification verification not configured'})` and `logger.error` once; keep the existing HMAC check for the configured case (it is the wrong scheme, but it now fails **closed** in both cases; the correct ECDSA verification + subscriptions land in CX.4). The `GET` challenge handler is unchanged. | `routes/ebay-notification.routes.ts` |
| G4 | S12 — AMS ingest fails open, `!==` compare | `advertising.routes.ts:8406-8410`: `if (!secret) return 503 {error:'ams_ingest_secret_not_configured'}`; compare with `timingSafeEqual` over equal-length buffers. | `routes/advertising.routes.ts` |
| G5 | S11 — AccountsPanel disconnect keeps live tokens | `accounts.routes.ts:384-387`: for `row.channelType === 'EBAY' && row.managedBy === 'oauth'` call `ebayAuthService.revokeTokens(row.id)` first (revokes at eBay, nulls all six token columns, sets `isActive:false`; `services/ebay-auth.service.ts:380-437`), then the existing update with `isPrimary:false, lastSyncError:'Disconnected by operator'` (keep `lastSyncStatus:'FAILED'` so health reads "Failing — disconnected"). For any other `oauth` row: null `accessToken/refreshToken/tokenExpiresAt` in the same update. Env rows unchanged (no button exists). Wrap the eBay revoke in try/catch: a failed remote revoke still nulls locally and is logged. | `routes/accounts.routes.ts` |
| G6 | S20 (log hygiene) | `utils/logger.ts` (custom JSON console logger, not pino): add `redact(context)` that deep-replaces values whose **key** matches `/(access|refresh)?token|secret|authorization|password|code_verifier|client_secret|api[_-]?key/i` with `"[redacted]"` before `JSON.stringify`. | `utils/logger.ts` |

## 3. Secret scrub (S3)

Replace the three live connection strings in `docs/PHASE33-CLOUD-DEPLOYMENT-PREP.md:14,135,248` with `postgresql://<user>:<password>@<host>/<db>`. **The password must still be rotated in Neon by the Owner** — the value is in git history; the scrub only stops it being re-read from the tree. Railway `DATABASE_URL` must be updated in the same change window.

## 4. What is NOT changed (explicitly)

`ebay-auth.ts` connect/callback (works; CX.1 moves it), the SQS poll job, `AmazonAdsConnection` and the advertising page's manual form (CX.3 replaces it), all Woo/Etsy/Shopify *sync services and jobs*, `permissions-manifest` PUBLIC prefixes for `/webhooks/` (the remaining receivers — Shopify, eBay, Sendcloud, Cloudinary — are signature-verified and fail closed after G2/G3), RBAC mode, `oauth-state.ts`.

## 5. Tests

- `utils/webhook.vitest.test.ts` (new): Shopify HMAC over a byte-exact fixture containing `1.0`, unicode escapes and key order that `JSON.stringify` would change — passes over the raw buffer, and the old string path is shown to fail; missing header → invalid; length-mismatch → invalid without throwing.
- `routes/amazon-ads-auth.vitest.test.ts` (new): callback without `state` → 400; with unknown `state` → 400; with a stored `state` → exchange is attempted with `code_verifier`.
- `routes/accounts.vitest.test.ts` (extend): disconnect on an EBAY oauth row calls `revokeTokens` and the row ends with null token columns; env row untouched.
- Existing suites must stay green (`oauth-state.vitest.test.ts`, `connection-resolver.vitest.test.ts`, the eBay auth tests).

## 6. Verification on prod (after deploy)

| Check | Expected |
|---|---|
| `POST /api/webhooks/order-created`, `POST /webhooks/stock-adjustment`, `GET /api/admin/amazon-auth-probe`, `GET /api/amazon-ads/debug/test-auth`, `POST /webhooks/etsy/listings/update`, `POST /webhooks/woocommerce/orders/create`, `POST /webhooks/shopify/refunds/create-test` (all unauthenticated) | **404** |
| `GET /api/amazon-ads/auth/connect` (unauthenticated) | **401** (was 302) |
| `GET /api/amazon-ads/auth/callback?code=x` (no state) | **400 missing_state**; `?code=x&state=bogus` → **400 invalid_state** |
| `POST /api/webhooks/ebay-notification` with a JSON body and no signature | **503** if the token env is unset on prod, else **204** with `invalid signature` logged (never processed) |
| `GET /api/webhooks/ebay-notification?challenge_code=abc` | 200 `{challengeResponse}` (unchanged) |
| `POST /webhooks/shopify/products/update` unsigned | **401**; signed with the prod secret from Railway via a local script over a raw fixture → **200** (this is the only way to exercise the raw-body path on prod without a connected store; the secret is read from Railway, never printed) |
| `POST /api/advertising/marketing-stream/ingest` with no `x-ams-secret` | **401** if the secret is set, **503** if not |
| AccountsPanel Disconnect | **Only with the Owner present** to reconnect afterwards: disconnect `motovento` → DB row shows null token columns and `ConnectionEvent`-equivalent log line; the eBay token test for that id fails; Owner reconnects through the popup → green. If the Owner is not available, this item is verified by the unit test and reported as **not live-verified**. |
| Existing crons | `ebay-token-refresh`, `ebay-orders-sync`, `amazon-sqs-poll`, `ams-sqs-poll` green for 24 h after deploy (CronRun) |
| Screenshots | Channels page unchanged; Advertising page unchanged (the manual form is CX.3) |

## 7. Risk and rollback

Low: deletions of routes with no caller; two guard tightenings that only reject requests that were already either unauthenticated or unverifiable; one parser change scoped per plugin. Rollback = revert the single commit. The only behaviour an operator could notice is the eBay `POST` receiver returning 503 when the verification token is unset — which is the honest state.

## 8. Commit shape

One commit `fix(cx0): stop the bleed — delete public probes/receivers, fail-closed webhook verification, ads OAuth state check, revoke on disconnect`, pushed through the normal pre-push guards, then the prod checks in §6, then the report.

**Waiting for the Owner's go-ahead on this exact change.**
