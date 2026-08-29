# A7 — Security audit: channel-integration layer

Scope: Amazon SP-API, Amazon Ads, eBay, Shopify, WooCommerce, Etsy connect/receive paths plus the generic webhook / OAuth / crypto helpers. Read-only; repo at `/Users/awais/nexus-commerce`, branch `main`, audited 2026-08-29. Every claim cites `path:line`. Anything not provable from the repo is marked **unverified**. No secret values are reproduced — where one was found, only its location and first 4 characters are given.

Deployment-model facts that frame every finding below:

- RBAC is a single global `preHandler` (`apps/api/src/index.ts:595`) that is deny-by-default **only when** `NEXUS_RBAC_MODE=enforce` (`apps/api/src/lib/auth/rbac-hook.ts:29-31,74`). In shadow mode every deny is allowed through (`rbac-hook.ts:87-97`). Whether prod runs `enforce` is a Railway env value — **unverified** from the repo (docs in a worktree claim it is live; the main tree has no committed evidence).
- The app is **single-tenant**: there is no `Organization`/`Tenant`/`Workspace` model in `packages/database/prisma/schema.prisma` (grep for `^model (Org|Organization|Tenant|Workspace|Team|Account)\b` returns nothing). Connection ids are global; the only boundary is the RBAC permission key. Item 9 (tenant boundary) is therefore N/A by design.
- Session cookie is `SameSite=None; Secure` in the interim cross-site topology (`apps/api/src/lib/auth/cookies.ts:9-14,54-58`); CSRF double-submit exists (`apps/api/src/lib/auth/csrf.ts`) but is applied only to `/api/auth/*`, `/api/auth/2fa/*` and `/api/team/*` (`apps/api/src/routes/auth.routes.ts:123,254,263,306,362`, `mfa.routes.ts:28`, `team.routes.ts:37`).

---

## 1. Ranked findings

| # | Sev | Finding | Evidence | Recommended fix |
|---|-----|---------|----------|-----------------|
| F1 | **Critical** | Unauthenticated stock mutation: `POST /api/webhooks/order-created` and `POST /webhooks/stock-adjustment` have no signature, no shared secret, no guard, and are blanket-PUBLIC via the manifest prefix rules. Anyone on the internet can decrement or set `totalStock` for any SKU and trigger the outbound channel cascade. | `apps/api/src/routes/webhooks.routes.ts:59-63,137-147`; PUBLIC by `apps/api/src/lib/auth/permissions-manifest.ts:61-62`; registered `apps/api/src/index.ts:642` | Require an API key (`lib/api-key-hook.ts`) or an HMAC shared secret on both routes; move them out of the `/webhooks/` PUBLIC prefix (give the manifest an explicit entry). |
| F2 | **Critical** | Etsy receivers (6 routes) perform **no** signature verification; `WebhookValidator.validateEtsySignature` exists but has zero call sites. Any caller can create/cancel orders and update listings once `ETSY_*` env is configured (returns 400 "Not configured" otherwise). | `apps/api/src/routes/etsy-webhooks.ts:312-330` (route body, no validator), all six handlers at lines 321,380,431,482,533,584; validator defined `apps/api/src/utils/webhook.ts:69` and never imported (grep `validateEtsySignature` → only `utils/webhook.ts`); PUBLIC by `permissions-manifest.ts:61` | Verify `x-etsy-signature` (or the scheme Etsy actually uses) over the raw body with `ETSY_WEBHOOK_SECRET`, `timingSafeEqual`, before any DB read. |
| F3 | **Critical** | Live Neon `DATABASE_URL` with password committed in tracked docs (password begins `npg_`, 16 chars). Known from prior sessions as "rotation open". | `docs/PHASE33-CLOUD-DEPLOYMENT-PREP.md:14`, `:135`, `:248` (3 occurrences) | Rotate the Neon role password now; scrub the doc (and history if the repo is shared). |
| F4 | **High** | Amazon Ads OAuth: `GET /api/amazon-ads/auth/connect` **and** `/callback` are PUBLIC (manifest line 82 precedes the `adsConnect` rule at 138; first-match wins). The callback performs **no state validation** — a missing/unknown `state` merely skips PKCE — then exchanges the code and **upserts active `AmazonAdsConnection` rows** with the resulting refresh token. An unauthenticated attacker can consent with their own Amazon account and inject active ads connections that the crons and bid engine then operate on. PKCE also silently downgrades when `state` is absent. | `apps/api/src/routes/amazon-ads-auth.routes.ts:271-299` (connect), `:302-347` (callback; `pkce` optional at 315-316, verifier only "if this flow used it" at 330-332), upsert `:399-425` with `isActive: true` (408,417); PUBLIC: `apps/api/src/lib/auth/permissions-manifest.ts:82`, ordering `:412-419` | Make only `/callback` PUBLIC; keep `/connect` behind `adsConnect`. In the callback: reject when `state` is missing or not in `PKCE_STORE`, require the verifier, and bind the state to the initiating session (HMAC with session id, or persist state→userId). Consider marking new connections `isActive:false` pending operator approval. |
| F5 | **High** | `GET /api/admin/amazon-auth-probe` is PUBLIC and self-gated by `?k=` equal to the **last 6 characters of the Amazon Seller ID** — a value printed in every Amazon storefront URL. With `?write=1` it performs a **live SP-API `patchListingsItem`** on a canary SKU. It also returns the full LWA client id(s), seller id, region and marketplace, and logs all of it at `warn`. Non-constant-time compare. | `apps/api/src/routes/amazon-auth-probe.routes.ts:50-60` (gate), `:61` (write flag), `:137-155` (PATCH), `:65-82` (env echo), `:166` (log); PUBLIC `permissions-manifest.ts:56` | Delete the route (the manifest comment already says "remove with the probe route") or put it behind `adminRepair` + a random 32-byte token compared with `timingSafeEqual`. |
| F6 | **High** | eBay push webhook: signature check is **skipped when `EBAY_NOTIFICATION_VERIFICATION_TOKEN` is unset** (comment says "dev only" but nothing pins it to dev), and when set it computes HMAC-SHA256(body, token) — which is not eBay's Notification-API scheme (eBay signs with an ECDSA key published via its Public Key API; the `x-ebay-signature` header is a base64 JSON envelope). Either way the endpoint is unauthenticated in practice and processes `marketplace.order.created`/`cancelled` and `ItemRevised` into the DB. `config: { rawBody: true }` has no effect — no raw-body plugin is registered — so the fallback re-serialises `req.body`. | `apps/api/src/routes/ebay-notification.routes.ts:345-358` (skip when token empty; 204 on reject), `:86-100` (HMAC scheme), `:346,349` (rawBody never set — no `fastify-raw-body` in `apps/api/package.json`, no `addContentTypeParser` in `apps/api/src/index.ts`) | Implement eBay's documented verification (fetch public key by `kid`, verify ECDSA over the raw body, cache keys), fail closed when the token/keys are missing, and capture the raw body (see F9). |
| F7 | **High** | WooCommerce receivers verify the signature **only if** `ConfigManager.getConfig("WOOCOMMERCE")?.webhookSecret` is truthy; when the Woo env block is incomplete (config → null) all six handlers process the payload unverified (orders create/update/delete, products). PUBLIC prefix. | `apps/api/src/routes/woocommerce-webhooks.ts:293-308` (pattern repeated at 361-376, 429-444, 497-512, 565-580, 633-648); config null when any of 4 env vars missing `apps/api/src/utils/config.ts:70-83` | Return 400/503 when the config or secret is absent (as the Shopify handlers do at `shopify-webhooks.ts:933-938`). |
| F8 | **High** | `POST /webhooks/shopify/refunds/create-test` runs the real refund handler with **no signature and no idempotency**, gated only by `NEXUS_ENV === 'production'`. If `NEXUS_ENV` is unset on the Railway service (env value **unverified**), the route is live and PUBLIC. | `apps/api/src/routes/shopify-webhooks.ts:1402-1407`; PUBLIC `permissions-manifest.ts:61`; only other `NEXUS_ENV` consumers are `returns.routes.ts:2383-2558` and a seed script | Invert the gate (enable only when `NEXUS_ENV` is explicitly `development`/`test`), or drop the route from the production bundle. |
| F9 | **Medium** | Every HMAC receiver except Cloudinary/Sendcloud-string signs over `JSON.stringify(request.body)`, not the raw bytes. Fastify has already parsed the body (no raw-body plugin, no custom parser), so any whitespace, key order, number formatting (`1.0`→`1`) or unicode-escape difference makes a legitimate signature fail — which is the classic path to "temporarily" disabling verification. Shopify + Woo comparisons are also non-constant-time (`===`). | Shopify: `apps/api/src/routes/shopify-webhooks.ts:929,996,1063,1130,1197,1264,1338`; Woo: `woocommerce-webhooks.ts:298`; eBay: `ebay-notification.routes.ts:349`; Sendcloud: `sendcloud-webhooks.routes.ts:129-136`; compare `apps/api/src/utils/webhook.ts:25,52,79` | Register `fastify-raw-body` (or `addContentTypeParser('application/json', {parseAs:'buffer'})` scoped to webhook routes) and HMAC the raw buffer; use `timingSafeEqual` with a length pre-check. |
| F10 | **Medium** | eBay OAuth tokens are stored **plaintext** in `ChannelConnection.accessToken/refreshToken/ebayAccessToken/ebayRefreshToken`. `crypto.ts` exists and is used for Amazon Ads and carriers but not here. | Schema `packages/database/prisma/schema.prisma:6002-6003,6011-6012`; writes `apps/api/src/services/ebay-auth.service.ts:282-286` (refresh), `:343-355` (save); no `encryptSecret` import in that file (importers list: `fulfillment.routes.ts, advertising.routes.ts, sendcloud-webhooks.routes.ts, amazon-ads-auth.routes.ts, services/sendcloud/index.ts, ads-debug-probe.service.ts, ads-api-client.ts`) | Wrap writes with `encryptSecret` and reads with `isEncrypted ? decryptSecret : legacy` (same encrypt-on-read migration pattern the crypto header documents for Sendcloud). |
| F11 | **Medium** | Operator "disconnect" deactivates but **keeps the refresh token** in the row and never calls eBay revoke; tokens for a disconnected account remain live and plaintext. | `apps/api/src/routes/accounts.routes.ts:384-387` (only `isActive:false`); contrast the revoke path that nulls them `apps/api/src/services/ebay-auth.service.ts:417-427` | Call `revokeTokens` (or null the token columns) on disconnect. |
| F12 | **Medium** | AMS ingest (`POST /api/advertising/marketing-stream/ingest`) is PUBLIC and **fails open when `NEXUS_AMS_INGEST_SECRET` is unset**; when set, the compare is `!==` (not constant-time). | `apps/api/src/routes/advertising.routes.ts:8402-8411`; PUBLIC `permissions-manifest.ts:79` | Refuse with 503 when the secret is unset; compare with `timingSafeEqual`. |
| F13 | **Medium** | Outbound-webhook signing secret is stored **plaintext** in a column named `secretHash`, and the test-fire endpoint performs a server-side `fetch` to any operator-supplied URL (localhost/127.0.0.1/`.local`/private ranges accepted; `http:` allowed for those) and persists the response body into `lastError` → SSRF with partial read-back for anyone holding `settingsWebhooksManage`. | Plaintext: `apps/api/src/routes/settings-webhooks.routes.ts:137-150`; URL check `:110-127`; fetch `:349-365`; response stored `:373-378` | Encrypt with `encryptSecret`; block private/loopback/link-local targets (resolve DNS then check), strip the response body from `lastError`. |
| F14 | **Medium** | eBay OAuth `state` is HMAC-signed but not bound to the session/user and not single-use (no nonce ledger); the API callback is PUBLIC and accepts `connectionId` from the body. Replay inside the 10-min window is only "bounded by eBay itself" (comment). Signing key falls back to `EBAY_CLIENT_SECRET` (key reuse). | `apps/api/src/lib/auth/oauth-state.ts:33-36,41,60,76-85`; callback `apps/api/src/routes/ebay-auth.ts:149-230`; PUBLIC `permissions-manifest.ts:83` | Include a session-derived claim in the payload and check it in `/callback`; record consumed nonces (Redis/DB) for the TTL; use a dedicated `OAUTH_STATE_SECRET`. |
| F15 | **Medium** | No CSRF check on state-changing connection routes. JSON-bodied routes are protected incidentally (CORS preflight + JSON content-type), but body-less POSTs (`/api/accounts/:id/disconnect`, `/api/admin/refresh-ebay-tokens`, `/api/admin/setup-*`) are reachable by a cross-site `<form>` if Fastify accepts an empty `text/plain` body — **unverified** (Fastify 5 behaviour with empty body not tested here). | `apps/api/src/routes/accounts.routes.ts:358`; `apps/api/src/routes/ebay-notification.routes.ts:154,199`; `apps/api/src/routes/shopify-setup.routes.ts:82`; CSRF applied only in `auth.routes.ts`, `mfa.routes.ts:28`, `team.routes.ts:37` | Apply `requireCsrf` (or the `verifyCsrf` pattern from `team.routes.ts:37`) globally to non-GET routes that are not PUBLIC. |
| F16 | **Medium** | `GET /api/amazon-ads/debug/test-auth` decrypts the stored Ads credentials, echoes the stored client id, refresh-token **15-char prefix**, access-token prefixes, and fires **live** report-creation requests at Amazon on every GET. Gated only by `adsView` (read permission). | `apps/api/src/routes/amazon-ads-auth.routes.ts:82-269` (prefixes at 143-146,165,259; live POSTs at 176,205-225); permission via `permissions-manifest.ts:234` | Remove ("Remove once auth is stable" per its own comment) or gate behind `adminRepair` and stop returning token material. |
| F17 | **Low** | `POST /api/ebay/auth/refresh` returns the first 20 characters of the live access token. | `apps/api/src/routes/ebay-auth.ts:555` | Return a boolean/expiry only. |
| F18 | **Low** | Hard-coded production hosts in the OAuth flow: Railway API callback fallback and Railway web URL in the success page; CORS allow-list carries `localhost:3000` and two Vercel hosts in code. | `apps/api/src/routes/amazon-ads-auth.routes.ts:35-37,455`; `apps/api/src/lib/cors-origins.ts:14-19` | Require `AMAZON_ADS_REDIRECT_URI`/`NEXUS_WEB_URL` env; fail at startup if absent. |
| F19 | **Low** | Amazon SP-API notifications: SQS bodies are trusted without SNS signature verification; authenticity rests entirely on the queue's IAM/resource policy (**unverified**). | `apps/api/src/services/amazon-sqs.service.ts:216-222` (no `SigningCertURL`/signature check anywhere in `apps/api/src`) | Confirm the SQS policy restricts `SendMessage` to the SP-API principal; optionally validate the SNS envelope. |
| F20 | **Low** | Whole `error` objects logged in eBay auth paths (`{ error }`); fetch/undici errors do not carry request headers, so no header leak was found, but `errorBody` from eBay token endpoints is logged verbatim. `amazon-auth-probe` logs its full result at `warn`. No pino `redact` config. | `apps/api/src/services/ebay-auth.service.ts:151,166,200,215,412,494,548`; `apps/api/src/routes/amazon-auth-probe.routes.ts:166`; `apps/api/src/utils/logger.ts` has no `redact` | Add pino `redact` for `authorization`, `*.refresh_token`, `*.access_token`, `*.client_secret`; log `err.message` only. |
| F21 | **Low** | `.env.example` documents `ENCRYPTION_KEY` (a 64-hex placeholder) but the code reads `NEXUS_CREDENTIAL_ENC_KEY`; the real key name is undocumented in the example. No key-id/rotation support in the envelope (v1 only). | `apps/api/.env.example:5`; `apps/api/src/lib/crypto.ts:57`; envelope `:11-13` | Document `NEXUS_CREDENTIAL_ENC_KEY`; add a key-id to the envelope (`v1:<kid>:…`) to allow rotation without re-encrypting under downtime. |

No `.env` (non-example) file is tracked or was ever added in history (`git ls-files` and `git log --all --diff-filter=A` both show only `*.env.example`). No live Shopify/Woo/AWS/eBay/LWA token patterns were found in tracked files; all `shpat_`/`AKIA`/`ck_`/`cs_`/`Atzr|` hits are documented placeholders (`apps/api/.env.example:9,31,40`, `plans/*.md`, `apps/api/PHASE1-FOUNDATION.md:343`).

---

## 2. Area detail

### 2.1 Credentials at rest (item 1)

**Helper — `apps/api/src/lib/crypto.ts`**
- Algorithm AES-256-GCM (`:42`), 12-byte random IV per call (`:43,90`), 16-byte auth tag (`:44,93`), envelope `v1:<iv>.<tag>.<ct>` base64url (`:94`).
- Key: `NEXUS_CREDENTIAL_ENC_KEY`, base64 of exactly 32 bytes, validated on first use and cached (`:55-76`). Missing/wrong-length throws (`:58-72`).
- Decrypt verifies tag via `setAuthTag` + `final()` (`:122-124`); refuses non-`v1:` input (`:107-109`).
- Rotation: a version prefix exists (`:11-13`) but **no key id** — rotating the key requires re-encrypting every row under downtime; no dual-key decrypt path.
- Tests `apps/api/src/lib/crypto.test.ts` cover round-trip, random IV, tamper (ct + tag), cross-key failure, missing/short key (`:56-100+`). It is a `tsx`-run script, not a vitest file (`:2-5`), so it is **unverified** that CI executes it.

**Where it is used** (grep `encryptSecret|decryptSecret|isEncrypted`): `routes/fulfillment.routes.ts`, `routes/advertising.routes.ts`, `routes/sendcloud-webhooks.routes.ts`, `routes/amazon-ads-auth.routes.ts`, `services/sendcloud/index.ts`, `services/advertising/ads-debug-probe.service.ts`, `services/advertising/ads-api-client.ts`.

**Column-by-column**

| Model.column | Written at | Encrypted? |
|---|---|---|
| `ChannelConnection.accessToken/refreshToken/ebayAccessToken/ebayRefreshToken` (`schema.prisma:6002-6003,6011-6012`) | `services/ebay-auth.service.ts:282-286` (refresh), `:343-355` (save), `:417-427` (null on revoke); `routes/ebay-notification.routes.ts:122-123` reads them | **No** (F10) |
| `AmazonAdsConnection.credentialsEncrypted` (`schema.prisma:3025`) — `{clientId, clientSecret, refreshToken}` | `routes/amazon-ads-auth.routes.ts:376-382,406,416` | Yes (`encryptSecret`) |
| `Carrier.credentialsEncrypted`, `Carrier.webhookSecret`, `CarrierAccount.credentialsEncrypted` (`schema.prisma:8586,8615,8778`) | `services/sendcloud/index.ts`, `routes/fulfillment.routes.ts` | Yes; webhook secret read with `isEncrypted ? decrypt : raw` fallback (`routes/sendcloud-webhooks.routes.ts:114-118`) |
| `NotificationWebhook.secretHash` (`schema.prisma:4214`) | `routes/settings-webhooks.routes.ts:149` | **No** — raw secret stored (F13) |
| Shopify / WooCommerce / Etsy credentials | env only: `apps/api/src/utils/config.ts:35-46,70-83,107-121`; `services/sync/unified-sync-orchestrator.ts:53,107-108` | N/A (not persisted) |
| Amazon SP-API refresh token | env only: `AMAZON_REFRESH_TOKEN` (`lib/amazon-sp-client.ts`, `clients/amazon-sp-api.client.ts`, `index.ts:336`); DB row is `managedBy:"env"` with no token columns (`index.ts:331-343`) | N/A |
| `ApiKey.keyHash`, `NotificationWebhook.secretPrefix`, `UserProfile.passwordHash/twoFactorSecret`, session/invite/reset hashes | out of channel scope; hashed by design (`schema.prisma:4236,4276,4297,4462,4581,4602`) | — |

Note `UserProfile.twoFactorSecret` (`schema.prisma:4297`) is a TOTP secret that must be plaintext-recoverable; it is not passed through `crypto.ts` (**unverified** whether it is encrypted elsewhere — outside this audit's scope).

### 2.2 Webhook receivers (item 2)

Raw body: **not captured anywhere**. `apps/api/src/index.ts` registers no `addContentTypeParser` and no raw-body plugin (grep `rawBody|addContentTypeParser|fastify-raw-body` across `apps/api/src` → only the receivers' own `JSON.stringify` fallbacks); `apps/api/package.json` has no `fastify-raw-body`. `ebay-notification.routes.ts:346` sets `config: { rawBody: true }`, which is inert.

| Receiver | Verification | Body used | Compare | Secret source | Fails open? |
|---|---|---|---|---|---|
| Shopify ×7 (`shopify-webhooks.ts:926,993,1060,1127,1194,1261,1335`) | HMAC-SHA256 base64 via `utils/webhook.ts:17-38` | `JSON.stringify(request.body)` (`:929` etc.) | `===` (`utils/webhook.ts:25`) | `SHOPIFY_WEBHOOK_SECRET` (`utils/config.ts:37`) | No — 400 if unconfigured (`:933-938`) |
| Shopify `refunds/create-test` (`:1402`) | none | — | — | — | Yes unless `NEXUS_ENV=production` (F8) |
| WooCommerce ×6 (`woocommerce-webhooks.ts:286-…`) | HMAC-SHA256 base64 (`utils/webhook.ts:44-65`) | `JSON.stringify(payload)` (`:298`) | `===` (`:52`) | `WOOCOMMERCE_WEBHOOK_SECRET` (`config.ts:73`) | **Yes** when config null (F7) |
| Etsy ×6 (`etsy-webhooks.ts:317-…`) | **none** | — | — | — | **Yes** (F2) |
| eBay challenge `GET /api/webhooks/ebay-notification` (`ebay-notification.routes.ts:326-342`) | SHA256(challenge+token+endpoint) — matches eBay's documented challenge | — | — | `EBAY_NOTIFICATION_VERIFICATION_TOKEN`, `EBAY_NOTIFICATION_ENDPOINT_URL` (`:332-333`) | Works with empty token (returns a hash of the challenge alone) |
| eBay push `POST` (`:345-358`) | HMAC-SHA256(body, token) — **not eBay's scheme** | `rawBody ?? JSON.stringify(req.body)` (`:349`) | `timingSafeEqual` in try/catch (`:97`) | verification token | **Yes** when token unset (F6) |
| Amazon SP-API notifications (`amazon-sqs.service.ts:189-222`) | none at message level; SQS pulled with IAM creds (`:173-182`) | — | — | `AWS_*` | Relies on queue policy (F19) |
| AMS ingest (`advertising.routes.ts:8402-8411`) | shared header secret | — | `!==` | `NEXUS_AMS_INGEST_SECRET` | **Yes** when unset (F12) |
| Sendcloud (`sendcloud-webhooks.routes.ts:103-140`) | HMAC-SHA256 hex | re-stringified body (`:136`) | `timingSafeEqual` w/ length check (`:86-95`) | per-carrier encrypted secret, env fallback (`:108-118`) | No — 503 when no secret (`:123-126`) |
| Cloudinary (`cloudinary-webhook.routes.ts:67-97`) | SHA-1(body+ts+secret) per Cloudinary | re-stringified (`:88-90`) | `timingSafeEqual` (`:46-62`) | `CLOUDINARY_API_SECRET` | No — 503 when unset (`:69-73`) |
| Generic `order-created` / `stock-adjustment` (`webhooks.routes.ts:59,137`) | **none** | — | — | — | **Yes** (F1) |

All of the above are PUBLIC through `permissions-manifest.ts:61-64,79`, so RBAC provides no backstop.

### 2.3 OAuth flows (item 3)

**eBay** (`apps/api/src/routes/ebay-auth.ts`, `lib/auth/oauth-state.ts`, `services/ebay-auth.service.ts`)
- State: `<b64url(payload)>.<b64url(HMAC-SHA256)>`, payload `{channel, n:16 random bytes, iat, adoptConnectionId?}` (`oauth-state.ts:76-85`). Key = HMAC-derived from `NEXUS_CREDENTIAL_ENC_KEY || EBAY_CLIENT_SECRET` (`:59-68`) — fails closed when both absent. TTL 10 min (`:41,123`). Constant-time compare with length check (`:110-113`). Channel bound (`:122`). **No** session/user binding, **no** one-time use (F14).
- `prompt=login` default on (`ebay-auth.ts:120`, `ebay-auth.service.ts:107`). No PKCE (eBay's flow does not offer it). `redirect_uri` is the env RuName (`ebay-auth.service.ts:41,89`); the `redirectUri` body param is ignored (`ebay-auth.ts:104-108`) — no open redirect.
- Callback is a browser `POST` from the web page, PUBLIC (`permissions-manifest.ts:83`); `connectionId` comes from the body (`ebay-auth.ts:158,213-230`) but the adopt intent correctly comes only from the signed state (`:206-211`). Placeholder rows are cleaned up (`:276,310,336,358`).
- Web side: `EbayCallbackContent.tsx:95-97` posts to `window.location.origin` (never `*`); `ChannelsClient.tsx:126-127` rejects messages whose `e.origin !== window.location.origin`. Correct.
- Initiate/revoke/refresh/test/connections gated by `channelsConnect` (`permissions-manifest.ts:137`).

**Amazon Ads** (`apps/api/src/routes/amazon-ads-auth.routes.ts`)
- `/connect`: random 16-byte state, PKCE S256, in-memory `PKCE_STORE` 15-min (`:19-21,281-284`). Process-local — a multi-instance deploy would lose the verifier (Railway single instance **unverified**).
- `/callback`: no state validation; PKCE optional (`:315-332`); tokens encrypted (`:376-382`); connections upserted `isActive:true` (`:399-425`). Both routes PUBLIC (`permissions-manifest.ts:82`) — F4.
- `REDIRECT_URI` env with hard-coded Railway fallback (`:35-37`); success HTML links a hard-coded Railway web host (`:455`) — F18.

**Shopify / WooCommerce / Etsy**: no OAuth code paths exist; credentials are static env values (`utils/config.ts`). Nothing to audit for state/PKCE.

### 2.4 Secrets in logs (item 4)

Grepped every `logger.*`/`console.*` call in the in-scope services/routes/jobs/clients for token/secret/authorization/config arguments. Findings:
- `services/ebay-auth.service.ts:151,200` — logs eBay's error **response body** verbatim (`errorBody`) on token exchange/refresh failure; eBay error bodies do not echo the submitted credentials, so no direct leak, but it is unbounded text.
- `services/ebay-auth.service.ts:166,215,412,494,548` — logs the whole `error` object. These are `fetch` (undici) errors; undici errors carry no request headers. No axios in `services/marketplaces`, `clients`, or `ebay-*` (grep `from 'axios'` → none), so the `error.config.headers.Authorization` pattern does not occur in scope.
- `services/marketplaces/shopify.service.ts:166,187,283,305,328`, `services/marketplaces/ebay.service.ts:103` — `console.error(..., error)` whole object; same undici caveat.
- `routes/amazon-auth-probe.routes.ts:166` — logs full LWA client id, seller id, region, and SHA-256 8-char fingerprints of secrets at `warn`.
- `routes/amazon-ads-auth.routes.ts:297` — logs the OAuth `state` (random, non-secret).
- `routes/ebay-auth.ts:124` — logs the state truncated to 8 chars.
- `clients/amazon-sp-api.client.ts:143-147,160-163,193-196,200-202`, `services/advertising/ads-api-client.ts:221`, `jobs/ebay-token-refresh.job.ts:99-103` — booleans/ids/messages only. Clean.
- `apps/api/src/utils/logger.ts` — no `redact` configuration (grep `redact|censor|mask` → none). Fastify's default request logger (`index.ts:450`) does not log headers or bodies.

### 2.5 Tokens/secrets in URLs or responses (item 5)

- `routes/ebay-auth.ts:555` — 20-char access-token prefix returned (F17).
- `routes/amazon-ads-auth.routes.ts:143-146,165,259` — 15–20-char refresh/access-token prefixes and stored client id returned to `adsView` holders (F16); `:431,445` — 10-char access-token prefix in the callback HTML.
- `routes/ebay-notification.routes.ts:115-150` — selects `refreshToken`/`ebayRefreshToken` into memory but returns only `hasRefreshToken` (`:135,145`). OK.
- `routes/amazon-notifications.routes.ts:73-86` — env echo masked to last-4 (`AWS_SECRET_ACCESS_KEY` last 4 chars) under `adminView`. Low.
- `routes/amazon-auth-probe.routes.ts:65-82` — env echo with full `AMAZON_LWA_CLIENT_ID`/`AMAZON_CLIENT_ID`, PUBLIC (F5).
- `routes/connections.routes.ts:58-77,216` — `toConnectionRow` omits all token columns; `meta: row.connectionMetadata` is returned whole but the only writer stores `activeMarketplaces` (`:291-294`). OK.
- `routes/accounts.routes.ts` — `toAccountRow` (no token fields found by grep). OK.
- No `select: { accessToken: true }` / `...connection` spreads that reach a response in `apps/api/src/routes` (grep at 2.5 above; the `...row` at `advertising.routes.ts:2289` is a launch-run row with an explicit non-secret `select` at `:2280-2284`).
- Query strings: `GET /api/ebay/auth/test?connectionId=` carries only an id (`ebay-auth.ts:572-576`); `GET /api/admin/amazon-auth-probe?k=` carries the gate value (F5). No route puts a token in a URL.

### 2.6 Authorisation on connection routes (item 6)

Manifest (`apps/api/src/lib/auth/permissions-manifest.ts`), first-match-wins (`:412-419`):

| Route(s) | Permission |
|---|---|
| `GET /api/connections`, `GET /api/settings/channels/:type/detail`, `PATCH …/marketplaces` (`connections.routes.ts:100,147,249`) | `/api/connections` → `settingsIntegrationsManage` (`:133`); `/api/settings/channels/*` → `settingsView` read / `settingsWorkspaceEdit` write (`:119`) |
| `GET /api/accounts`, `GET /api/accounts/diagnostics`, `POST /api/accounts/:id/disconnect`, primary/label writes (`accounts.routes.ts:186,233,358`) | read `pages.dashboard`, write `settingsIntegrationsManage` (`:125,132`) — **disconnect = any settingsIntegrationsManage holder** |
| `POST /api/ebay/auth/{create-connection,initiate,revoke,refresh}`, `GET …/connections`, `…/connection/:id`, `…/test` | `channelsConnect` (`:137`) — **revoke/refresh = channelsConnect** |
| `POST /api/ebay/auth/callback` | PUBLIC (`:83`) |
| `GET /api/amazon-ads/auth/connect`, `/callback` | PUBLIC (`:82`) — F4 |
| `GET /api/amazon-ads/debug/test-auth`, `POST /api/amazon-ads/backfill` | `adsView` / `adsCampaignsManage` (`:234`) |
| `POST /api/admin/setup-shopify-webhooks`, `GET /api/admin/shopify-webhook-status` (`shopify-setup.routes.ts:82,152`) | the `/api/shopify…/setup` rule at `:134` does **not** match (path starts `/api/admin`); falls to `/api/admin` → `adminView` read / `adminRepair` write (`:404`) |
| `GET /api/admin/ebay-token-status`, `POST /api/admin/refresh-ebay-tokens`, `POST /api/admin/setup-ebay-notifications`, `GET /api/admin/ebay-notification-status`, `GET /api/admin/sqs-diagnostic`, `POST /api/admin/setup-amazon-notifications` | `adminView` / `adminRepair` (`:404`) — **token refresh sweep = adminRepair** |
| `GET /api/admin/amazon-auth-probe` | PUBLIC (`:56`) — F5 |
| `/api/stock/sync-control/*` (`sync-control.routes.ts`) | `inventoryView` / `inventoryAdjust` (`:276`); no `connectionId` input (grep → none) |
| `/webhooks/*`, `/api/webhooks/*`, `/api/assets/_webhooks/*` | PUBLIC (`:61-64`) |

No route-level `preHandler` guards exist on any of these files; all rely on the global hook, which is inert unless `NEXUS_RBAC_MODE=enforce` (**unverified** on prod).

### 2.7 Hard-coded hosts (item 7)

- `apps/api/src/routes/amazon-ads-auth.routes.ts:37` — `https://nexusapi-production-b7bb.up.railway.app/...` fallback for `AMAZON_ADS_REDIRECT_URI`.
- `apps/api/src/routes/amazon-ads-auth.routes.ts:455` — `https://nexus-commerce-web.up.railway.app/settings/advertising` in the success page.
- `apps/api/src/lib/cors-origins.ts:15-17` — `http://localhost:3000`, two `*.vercel.app` origins in the CORS allow-list (env-extensible via `NEXUS_WEB_ORIGINS`).
- eBay callback destination is held at eBay under the RuName; nothing hard-coded in code (`ebay-auth.service.ts:36-43`).
- Shopify webhook registration address derives from `NEXUS_PUBLIC_API_URL`/`PUBLIC_API_URL`/`RAILWAY_PUBLIC_DOMAIN` (`shopify-setup.routes.ts:50-58`), no literal.

### 2.8 CSRF (item 8)

`requireCsrf`/`verifyCsrf` are applied only in `auth.routes.ts:123,254,263,306,362`, `mfa.routes.ts:28`, `team.routes.ts:37`. Not applied to `/api/connections/*`, `/api/accounts/*`, `/api/ebay/auth/*`, `/api/admin/*`. See F15 for exploitability caveats (JSON routes protected by CORS preflight; body-less POSTs are the concern).

### 2.9 Tenant boundary (item 9)

Single-tenant (no org model). Routes that accept a `connectionId` (`ebay-auth.ts:158,454,501,538,576`; `accounts.routes.ts:359`) check only existence + channel type, which is the correct bar for a single-tenant app. No cross-tenant issue exists to report.

### 2.10 Env / docs hygiene (item 10)

- Tracked env files: only `apps/api/.env.example`, `apps/factory/.env.example`, `apps/web/.env.example`, `services/bidding-engine/.env.example`; `.gitignore:25-27` excludes `.env`, `.env.local`, `.env.*.local`. No real `.env` was ever added in history.
- Secret-pattern sweep over tracked files (masked): only placeholders (`apps/api/.env.example:9,31,40`; `apps/api/PHASE1-FOUNDATION.md:343`; `plans/MARKETPLACE-INTEGRATION-PLAN.md:156`; `plans/SHOPIFY-INTEGRATION-PLAN.md:138`) **except** the Neon connection string in `docs/PHASE33-CLOUD-DEPLOYMENT-PREP.md:14,135,248` (F3).
- Test fixtures: `apps/api/src/lib/crypto.test.ts:63` uses `PK_x`/`SK_y` dummies; `oauth-state.vitest.test.ts:15` uses a literal test key. No live tokens found.
- `.env.example` names `ENCRYPTION_KEY` while the code reads `NEXUS_CREDENTIAL_ENC_KEY` (F21).

---

## 3. Suggested remediation order

1. F1, F2, F5 — remove/guard the three unauthenticated write surfaces (same-day).
2. F3 — rotate the Neon password.
3. F4 — restore auth on `/amazon-ads/auth/connect`, enforce state + PKCE in the callback.
4. F6, F7, F8, F9 — one change: register a raw-body parser for `/webhooks/*`, make every receiver fail closed, use `timingSafeEqual`, implement eBay's real signature scheme.
5. F10, F11, F13 — encrypt eBay tokens and outbound-webhook secrets; revoke on disconnect.
6. F12, F14, F15, F16 — harden the remaining medium items.
