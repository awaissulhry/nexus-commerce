# R8 — How Nango is built (design-pattern study, not a dependency)

Studied 2026-08-29 against `NangoHQ/nango` **branch `master`** (tree fetched via the GitHub API; migrations in the tree run up to 2026-08-18, so this is the current code, not the 2024 layout the brief assumed). Every path below is relative to the repo root and resolves as `https://github.com/NangoHQ/nango/blob/master/<path>`. Anything I could not open is marked **unverified**.

**Licence of every file quoted here: Elastic License 2.0 (ELv2)** — the repo has exactly one `LICENSE` (root) and every `packages/*/package.json` says `"license": "SEE LICENSE IN LICENSE FILE IN GIT REPOSITORY"` or omits the field (private packages). Excerpts are ≤10 lines each and are quoted for study only. **The intent is re-implementation of the patterns in our own code, not copying Nango code.**

Local copies of the files I read are in `scratchpad/nango/src/…` (same relative paths) and `scratchpad/nango/providers.yaml`.

---

## 1. Licence

| Where | What | Source |
|---|---|---|
| `LICENSE` (root) | **Elastic License 2.0**. Grants copy/modify/derivative works; forbids providing the software as a hosted/managed service and circumventing licence keys. | `LICENSE` lines 1–12 |
| `LICENSE_SHORT` | `Copyright (c) 2023 Nango Inc, all rights reserved.` | `LICENSE_SHORT` |
| `README.md` §License | "Nango is available under the Elastic License … You can also self-host for free with a limited feature set." | `README.md` line 131 |
| `packages/*/package.json` (all 41) | `license` = `SEE LICENSE IN LICENSE FILE IN GIT REPOSITORY` (cli, frontend, node-client, shared, types, providers-adjacent, egress, server, runner, persist, authz, utils, usage, internal-auth, data-ingestion) or **absent** (all other private packages). **No package declares MIT/Apache.** | verified by reading each package.json |
| `packages/**/LICENSE` | **None exist** — searched the full 9,478-blob tree; only root `LICENSE` and `LICENSE_SHORT`. | tree scan |
| `NangoHQ/integration-templates` (separate repo, the sync/action scripts) | Also **ELv2** (`LICENSE` line 1 "Elastic License 2.0 (ELv2)"; GitHub reports `NOASSERTION`). | `https://raw.githubusercontent.com/NangoHQ/integration-templates/main/LICENSE` |
| `docs/guides/platform/self-hosting.mdx` | Self-hosting is positioned as **Enterprise plan only** ("An Enterprise plan subscription is required"); the "free self-host, limited feature set" of the README is not enumerated anywhere I could read — **unverified** which features are gated. | `docs/guides/platform/self-hosting.mdx` |

**So the premise "which directories are MIT vs ELv2" has an empty answer: the whole monorepo, including the published npm packages `@nangohq/node`, `@nangohq/frontend`, `nango` (CLI), `@nangohq/types`, `@nangohq/providers`, `@nangohq/runner-sdk`, `@nangohq/nango-yaml`, is ELv2.** ELv2 does not forbid reading or re-implementing; it forbids reselling Nango as a service. We are re-implementing.

---

## 2. The providers catalogue — `packages/providers/providers.yaml`

27,434 lines, 982 entries (`display_name` count). Schema lives in **`packages/types/lib/providers/provider.ts`** (`BaseProvider` + per-auth-mode interfaces); auth-mode enum in `packages/types/lib/auth/api.ts`.

### auth_mode values (counted in the YAML)
`API_KEY` 323 · `OAUTH2` 294 · `OAUTH2_CC` 101 · `BASIC` 97 · `TWO_STEP` 62 · `MCP_OAUTH2` 24 · `OAUTH1` 4 · `JWT` 4 · `NONE` 2 · `MCP_OAUTH2_GENERIC` 2 · `BILL` 2 · `TBA` 1 · `SIGNATURE` 1 · `INSTALL_PLUGIN` 1 · `CUSTOM` 1 · `AWS_SIGV4` 1 · `APP` 1. (`TABLEAU` and `APP_STORE` from the brief no longer exist as modes.)

### Field vocabulary (from `provider.ts`, with YAML usage counts)
- Identity/docs: `display_name`, `categories`, `docs`, `docs_connect`, `setup_guide_url`, `alias` (67 — entry inherits another).
- OAuth2: `authorization_url`, `token_url` (string or per-mode object `{OAUTH2, APP}`), `authorization_params` (244), `token_params` (374), `refresh_params` (211), `refresh_url` (16), `scope_separator` (104), `default_scopes` (55), `disable_pkce` (72), `authorization_method: header|body` (16; simple-oauth2 `authorizationMethod`), `body_format: form|json|query` (87), `token_request_auth_method: basic|custom|private_key_jwt` (76), `token_expiration_buffer` (**2 uses**, seconds), `expires_in_unit: milliseconds`, `alternate_access_token_response_path`, `authorization_code_param_in_callback` (3 — e.g. SP-API `spapi_oauth_code`), `authorization_url_replacements` (7 — rename `client_id=`→`clientId=`), `authorization_url_skip_encode`, `authorization_url_skip_empty`, `authorization_url_fragment`, `token_url_skip_encode`.
- Metadata capture: `redirect_uri_metadata` (12 — copy named callback query params into `connection_config`), `token_response_metadata` (25 — copy fields of the token JSON into `connection_config`), `webhook_response_metadata`, `refresh_token_response_metadata`.
- End-user inputs: `connection_config: Record<string, SimplifiedJSONSchema>` (408) and `credentials` (527) — each field `{type:'string', title, description, example, pattern, format, order, default_value, hidden, prefix, suffix, doc_section, secret, automated, enum, warnings, visible_when}`; `integration_config` (per integration, not per connection).
- Proxy: `proxy.base_url` (with `${…}` interpolation and a `A || B` fallback), `proxy.headers`, `proxy.query`, `proxy.body`, `proxy.retry: {at, after, remaining, error_code[], in_body{path,value,strategy}}` (161 retry blocks: 102 `after`, 56 `at`, 5 `error_code`, 4 `remaining`, 1 `in_body`), `proxy.paginate` (cursor/link/offset), `proxy.decompress`, `proxy.forward_headers_on_redirect`, `proxy.verification: {method, endpoints[], base_url_override, headers, data}`.
- Hooks: `webhook_routing_script` (54), `webhook_user_defined_secret` (20), `webhook_allowed_query_params`, `post_connection_script` (41), `pre_connection_deletion_script` (4), `credentials_verification_script` (12).
- TWO_STEP/JWT/SIGNATURE: `token_response: {token, token_expiration, token_expiration_strategy: expireAt|expireIn, refresh_token}`, `token_headers`, `token_request_method`, `additional_steps[]`, `assertion`, `signature: {protocol}`, `token: {signing_key, expires_in_ms, header, payload}`.

Interpolation tokens seen: `${connectionConfig.x}`, `${credentials.x}`, `${accessToken}`, `${clientId}`, `${clientSecret}`, `${random}` (Walmart nonce), `${base64(${credentials.username}:${credentials.password})}`.

Retry-header examples (short excerpts):
```yaml
# exact-online (providers.yaml ~7943)
retry:
    at: ['x-ratelimit-minutely-reset', 'x-ratelimit-reset']
    error_code: ['429', '503']
# github (~9351): at: ['x-ratelimit-reset'], remaining: 'x-ratelimit-remaining', error_code: ['403','5xx','401','429']
# google (~9826): in_body: { path: error.message, value: /User-rate limit exceeded\. +Retry after (.+)/, strategy: at }
```

### Commerce entries, verbatim-ish (all ELv2, `packages/providers/providers.yaml`, line numbers given)

**shopify** (21544–21572)
```yaml
shopify:
    display_name: Shopify (OAuth)
    auth_mode: OAUTH2
    authorization_url: https://${connectionConfig.subdomain}.myshopify.com/admin/oauth/authorize
    token_url: https://${connectionConfig.subdomain}.myshopify.com/admin/oauth/access_token
    proxy: { base_url: https://${connectionConfig.subdomain}.myshopify.com, headers: { x-shopify-access-token: ${accessToken} } }
    webhook_routing_script: shopifyWebhookRouting
    token_params: { expiring: 1 }
    connection_config: { subdomain: { type: string, pattern: '^[a-z0-9_-]+$', prefix: https://, suffix: .myshopify.com } }
```
Notes: `expiring: 1` asks Shopify for expiring tokens (refresh flow). No `retry` block. No scopes in the entry (scopes live on the integration record `oauth_scopes`).

**ebay** (7479–7496) and **ebay-sandbox** (7497–7514)
```yaml
ebay:
    auth_mode: OAUTH2
    authorization_url: https://auth.ebay.com/oauth2/authorize
    token_url: https://api.ebay.com/identity/v1/oauth2/token
    authorization_params: { response_type: code }
    token_params: { grant_type: authorization_code }
    refresh_params: { grant_type: refresh_token }
    token_request_auth_method: basic
    proxy: { base_url: https://api.ebay.com/ }
```
Missing: no `retry`, no `scope_separator` (eBay wants space — default is space), no modelling of eBay's **refresh-token expiry (18 months)** — Nango has no `refresh_token_expires_at` at all; no RuName/`redirect_uri` metadata; no marketplace/site id in `connection_config`.

**amazon** (1254–1279) — plain Login-with-Amazon: `authorization_url: https://www.amazon.com/ap/oa`, `token_url: https://api.amazon.${connectionConfig.extension}/auth/o2/token`, `proxy.base_url: https://api.amazon.com`, `connection_config.extension` (`com`, `co.uk`…).

**amazon-selling-partner** (1280–1343) — the SP-API entry:
```yaml
amazon-selling-partner:
    auth_mode: OAUTH2
    authorization_url: https://${connectionConfig.domain}/apps/authorize/consent
    token_url: https://api.amazon.com/auth/o2/token
    authorization_code_param_in_callback: spapi_oauth_code
    disable_pkce: true
    authorization_params: { application_id: ${connectionConfig.applicationId} }
    refresh_params: { grant_type: refresh_token }
    redirect_uri_metadata: [selling_partner_id]
    proxy:
        base_url: https://${connectionConfig.subdomain}-${connectionConfig.region}.amazon.com || https://sellingpartnerapi-${connectionConfig.region}.amazon.com
        headers: { x-amz-access-token: ${accessToken} }
```
`connection_config`: `applicationId` (pattern `^[a-zA-Z0-9.-]+$`), `domain` (pattern `^[a-z0-9.-]+\.amazon\.[a-z.]+$`, e.g. `sellercentral.amazon.com`), `subdomain` enum `sellingpartnerapi|sandbox.sellingpartnerapi`, `region` enum `na|eu|fe`. **amazon-selling-partner-beta** (1344–1399) is the same with `version: beta` in `authorization_params` and a sandbox base_url. Missing: `state`-based `version=beta` toggling on one entry; no Restricted-Data-Token (RDT) support; no `retry` block (SP-API returns `x-amzn-RateLimit-Limit`, not a reset header, so Nango would fall back to exponential backoff); marketplace IDs are not modelled.

**etsy** (7887–7906): OAUTH2, `authorization_url: https://www.etsy.com/oauth/connect`, `token_url: https://api.etsy.com/v3/public/oauth/token`, `refresh_params grant_type refresh_token`, `proxy.base_url https://api.etsy.com`, `proxy.headers.x-api-key: ${clientId}:${clientSecret}` (Etsy wants the keystring; note the header template needs the integration's client id, which is why `ProxyRequest` fetches integration config when a header mentions `${clientId}`). PKCE on (default) — Etsy requires it.

**bigcommerce** (3410–3444): OAUTH2, `authorization_url https://login.bigcommerce.com/oauth2/authorize`, `token_url https://login.bigcommerce.com/oauth2/token`, `scope_separator ' '`, `authorization_params: {response_type: code, context: stores/${connectionConfig.storeHash}, account_uuid: ${connectionConfig.accountUuid}}`, `token_params.context: stores/${connectionConfig.storeHash}`, `proxy.base_url https://api.bigcommerce.com/stores/${connectionConfig.storeHash}`, header `x-auth-token: ${accessToken}`; `connection_config.storeHash` (pattern alnum), `accountUuid` (`automated: true`). Note: BigCommerce tokens don't expire → no `refresh_params`; Nango will store `expires_at` = now+1 day by default (`DEFAULT_EXPIRES_AT_MS`) and simply never refresh (`expired_oauth2_no_refresh_token`).

**walmart** (25687–25718):
```yaml
walmart:
    auth_mode: OAUTH2
    authorization_url: https://login.account.wal-mart.com/authorize
    authorization_params: { clientType: ${connectionConfig.clientType}, nonce: ${random} }
    disable_pkce: true
    authorization_url_replacements: { 'response_type=': 'responseType=', 'client_id=': 'clientId=', 'redirect_uri=': 'redirectUri=' }
    token_url: https://marketplace.walmartapis.com/v3/token
    redirect_uri_metadata: [sellerId]
    proxy: { base_url: https://marketplace.walmartapis.com, headers: { wm_qos.correlation_id: ${random}, wm_sec.access_token: ${accessToken} } }
```
`connection_config.clientType` hidden with `default_value: seller`. Shows the "string-replace the OAuth param names" escape hatch.

**woocommerce** (25989–26023): `auth_mode: BASIC` (consumer key/secret as username/password), `proxy.base_url https://${connectionConfig.storeURL}`, and a **verification** block: `proxy.verification: {method: GET, headers: {content-type: application/json}, endpoints: [/wp-json/wc/v3/customers]}`.

**shopware** (21803–21838): `OAUTH2_CC`, `body_format: json`, `token_url https://${connectionConfig.shopwareUrl}/api/oauth/token`, `credentials.client_id/client_secret` (`secret: true`), `connection_config.shopwareUrl` (`format: hostname`). **squarespace** (22345): OAUTH2, `token_request_auth_method: basic`, `scope_separator ','`, user-agent header from connection_config. **tiktok-accounts / tiktok-ads** (23633/23654): OAuth2 with `refresh_url` and `authorization_url_replacements: {client_id: client_key}` / `{client_id: app_id}`.

**Absent from the catalogue** (grepped, zero hits): `tiktok-shop`, `zalando`, `bol`/`bol.com`, `allegro`, `google-merchant` / Content API / `merchant-center`, `kaufland`, `otto`, `mirakl`, `cdiscount`. Also absent: any commerce entry with a `retry` block — none of shopify/ebay/amazon/etsy/bigcommerce/walmart declare rate-limit headers, so all of them fall back to generic backoff.

---

## 3. Connections and credentials

**Table** `_nango_connections` (`packages/database/lib/migrations/20221026075018_create_connection.cjs` + later): `provider_config_key`, `connection_id` (unique together), `credentials` JSON, `connection_config` JSON, `metadata` JSON, `credentials_iv`, `credentials_tag` (`20230322233042_add_encryption_to_connection.cjs`), `last_fetched_at` (`20230724110746`), and — the health columns from `20250310134848_connection_add_meta_fields.cjs`:
```sql
ADD COLUMN "credentials_expires_at" timestamptz,
ADD COLUMN "last_refresh_success" timestamptz,
ADD COLUMN "last_refresh_failure" timestamptz,
ADD COLUMN "refresh_attempts" int2,
ADD COLUMN "refresh_exhausted" bool
```
plus `last_execution_at` (`20250626163600`), `end_user_id`, `tags`, `webhook_url_override`, `config_id`. TS type: `packages/types/lib/connection/db.ts` (`DBConnection`; `credentials: { encrypted_credentials?: string }`).

**Encryption** — `packages/utils/lib/encryption.ts` class `Encryption`: **AES-256-GCM**, 12-byte random IV, base64 encoding, 16-byte auth tag, key must be base64 256-bit (`encryptSync` returns `[ciphertext, iv, authTag]`). `packages/shared/lib/utils/encryption.manager.ts` `encryptConnection` stores `credentials: {encrypted_credentials}` + `credentials_iv` + `credentials_tag`; `decryptConnection` reverses; the same manager encrypts `oauth_client_secret` on integrations and env variables. PBKDF2-SHA256 with 310,000 iterations is used to hash the encryption key / session tokens (`PBKDF2_ITERATIONS`, `KEY_HASH_ITERATIONS`). Enterprise adds envelope encryption of the DEK with AWS KMS (`packages/kms/lib/envelope.ts`, `@aws-crypto/client-node`, `REQUIRE_ENCRYPT_REQUIRE_DECRYPT`, DEK 32 bytes, encryption-context assertion). Records can be encrypted per row too (`packages/records/lib/utils/encryption.ts`, not read in detail).

**Credential parsing** — `connection.service.ts` `parseRawCredentials` (line 1462): for OAUTH2, `expires_at` = provided `expires_at` or `now + expires_in*1000`; keeps `refresh_token` and the whole `raw` token response; supports `alternate_access_token_response_path`.

**Refresh — `packages/shared/lib/services/connections/credentials/refresh.ts`** (677 lines). Entry `refreshOrTestCredentials(props)`:
1. `updateLastFetched` — `UPDATE … WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED)` so concurrent readers don't queue on the row (`connection.service.ts` 1447).
2. Short-circuits (unless `instantRefresh`): `refresh_exhausted` → `connection_refresh_exhausted`; `last_refresh_failure` within **30 s** (`REFRESH_FAILURE_COOLDOWN_MS`) → `connection_refresh_backoff`.
3. Dispatch on `credentials.type`: `OAUTH2|APP|OAUTH2_CC|JWT|BILL|TWO_STEP|SIGNATURE|AWS_SIGV4` → `refreshCredentials`; `BASIC|API_KEY|TBA` → `testCredentials` (runs the provider `verification` endpoint / script); `CUSTOM|OAUTH1` → nothing.
4. On error: `setRefreshFailure` (`connection.service.ts` 857):
```ts
// Only increment once per day to avoid burst failed refresh invalidating a connection (e.g: provider being down)
if (lastRefreshFailure && (… lastRefreshFailure.getDate() < now.getDate())) { attempt += 1; }
… refresh_attempts: attempt, refresh_exhausted: attempt >= MAX_CONSECUTIVE_DAYS_FAILED_REFRESH
```
with `MAX_CONSECUTIVE_DAYS_FAILED_REFRESH = 4` (`connections/utils.ts`). `markConnectionAuthFailed` sets exhausted immediately (used when the provider says the grant is revoked). **`refresh_exhausted` semantics: four distinct calendar days of failed refresh → stop trying automatically; only a manual `instantRefresh` (dashboard / API `force_refresh`) bypasses it, and a successful refresh resets `refresh_attempts=null, refresh_exhausted=false`.** `getStaleConnections` (line 986) selects `refresh_exhausted false AND last_fetched_at < now - N days` for a proactive refresh cron (cron itself unverified).

**The refresh lock** — `refreshCredentialsIfNeeded` (line 366):
- process-local **in-flight promise map** keyed `${env}:${providerConfigKey}:${connectionId}` (`FixedSizeMap(5000)`) collapses concurrent callers in one process;
- then a **Redis lock** `lock:refresh:${env}:${providerConfigKey}:${connectionId}`, TTL 10 s, acquisition timeout 12 s, via `packages/kvstore/lib/Locking.ts` (`store.set(key,'1',{canOverride:false, ttlMs})` = SET NX PX, polled every 50 ms). Their own comment: "This is not a distributed lock and will not work in a multi-redis environment. It could also be unsafe in case of a Redis crash."
- **double-checked**: after acquiring, re-read the connection and re-evaluate `shouldRefreshCredentials`; if another worker already refreshed, return the fresh creds without refreshing. If lock acquisition **times out**, re-read once more; if fresh, return it; else fail.
- `shouldRefreshCredentials`: buffer = `provider.token_expiration_buffer || 15 min` (`REFRESH_MARGIN_MS`); `isTokenExpired(expires_at, buffer)`; no `expires_at` → never refresh; expired OAUTH2 without `refresh_token` → `{should:false, reason:'expired_oauth2_no_refresh_token'}` (except providers that re-auth with client credentials); some providers use token introspection instead of `expires_at`; facebook/instagram/threads only refresh on demand.
- success path: `updateConnection({ …, credentials_expires_at: getExpiresAtFromCredentials(newCredentials), last_refresh_success: now, last_refresh_failure: null, refresh_attempts: null, refresh_exhausted: false })`. `getExpiresAtFromCredentials` defaults: 1 day (`DEFAULT_EXPIRES_AT_MS`) when no expiry, 55 min for OAUTH2_CC, 99 years for OAUTH1.

**Refresh-token rotation** — `packages/shared/lib/clients/oauth2.client.ts` `getFreshOAuth2Credentials` (simple-oauth2 `AccessToken.refresh(refresh_params)`; basic auth header if `token_request_auth_method: basic`; per-connection `config_override` client id/secret honoured):
```ts
newCredentials = connectionsManager.parseRawCredentials(rawNewAccessToken.token, 'OAUTH2', provider) as OAuth2Credentials;
if (!newCredentials.refresh_token && credentials.refresh_token != null) {
    newCredentials.refresh_token = credentials.refresh_token;
}
```
i.e. a rotated refresh token replaces the old one; an omitted one is carried forward. There is **no** tracking of refresh-token expiry (eBay/Amazon LWA 18-month/1-year limits are invisible until a refresh fails).

**Refresh failed → connection marked error** — `packages/server/lib/hooks/hooks.ts` `connectionRefreshFailed` (line 316): creates an **active auth error record** (`errorNotificationService.auth.create({type:'auth', action, connection_id, log_id, active:true})`), sends the customer an `auth` webhook `{operation:'refresh', success:false, error}` signed with the env webhook key, posts to Slack. `connectionRefreshSuccess` (253) clears the active error and, *only if one was cleared*, sends a recovery webhook `{operation:'refresh', success:true}`. Proxy/sync callers get `NangoError('connection_refresh_exhausted')` etc. and the dashboard shows the connection as errored.

**Credentials verification on connect** — `hooks.ts` `testConnectionCredentials` (89): if `provider.credentials_verification_script` → run the named handler (`server/lib/hooks/connection/providers/<p>/credentials-verification.ts`, 12 providers); else if `provider.proxy.verification` → `credentialsTest` (387) loops `endpoints`, builds an `ApplicationConstructedProxyConfiguration` and fires a `ProxyRequest`; any 2xx = `Ok({tested:true})`, else `connection_test_failed`. The same function is reused as the periodic "test" for API_KEY/BASIC connections (so `last_refresh_success` is meaningful for non-OAuth too).

---

## 4. OAuth flow — `packages/server/lib/controllers/oauth.controller.ts` (2,737 lines)

**Authorize request** `oauthRequest` (line 101): reads `provider_config_key`, `connection_id` (generated if absent), `ws_client_id`, optional `connect_session_token`, optional `hmac`. If `environment.hmac_enabled` and not a connect session, verifies `hmac` = HMAC-SHA256(`hmac_key`, `${providerConfigKey}:${connectionId}`) (`packages/shared/lib/services/hmac.service.ts`; plain `===` compare, not timing-safe). Builds an `OAuthSession`:
```ts
const session: OAuthSession = {
    providerConfigKey, provider: config.provider, connectionId, callbackUrl,
    authMode: provider.auth_mode,
    codeVerifier: crypto.randomBytes(24).toString('hex'),
    id: uuid.v1(),
    connectSessionId: connectSession ? connectSession.id : null,
    connectionConfig, webhookUrlOverride: …, environmentId, webSocketClientId: wsClientId, activityLogId: logCtx.id, …
```
**State storage**: the session row is inserted into **`_nango_oauth_sessions`** (`packages/server/lib/services/oauth-session.service.ts`; table from `packages/database/lib/migrations/20230326083713_create_oauth_session.cjs` with columns `id uuid, provider_config_key, provider, connection_id, callback_url, auth_mode, account_id, connection_config json, web_socket_client_id, code_verifier, request_token_secret, timestamps`). **`state` = `session.id`** (a v1 UUID). Orphan sessions are swept by `deleteExpiredSessions({olderThan})`.

**PKCE** (line 711): "We always implement PKCE, no matter whether the server requires it or not, unless it has been explicitly turned off for this template" — `code_challenge = base64url(sha256(codeVerifier))`, `code_challenge_method=S256`; the verifier never leaves the server (it's in the session row) and is sent as `code_verifier` in the token exchange (line 1745).

**CSRF double-submit cookie** (line 804): `res.cookie('oauth2-${session.id}', '1', {maxAge: 1h, httpOnly, secure, sameSite: secure ? 'none' : 'lax'})`. In the callback (1291–1345) the cookie's presence is **measured** (metrics with `sec-fetch-*` tags) and only **rejected when the feature flag `isOAuthStateCookieEnforced` is on** — a rollout in progress.

**Authorization URL**: simple-oauth2 `authorizeURL({redirect_uri: callbackUrl, scope, state: session.id, …allAuthParams})` where `allAuthParams` = interpolated `authorization_params` + PKCE + per-request overrides; then the template hacks `authorization_url_skip_encode`, `authorization_url_fragment`, `authorization_url_replacements` (string replace), `authorization_url_skip_empty`. Scopes come from the integration's `oauth_scopes` (comma-joined) re-joined with `scope_separator`. `callback_url` = `environment.callback_url` (per-environment override, default `<server>/oauth/callback`).

**Callback** `oauthCallback` (1222): `state = req.query.state || payload || customField`; `findById(state)`; **session deleted immediately (single use)**; then by `authMode` → `oauth2Callback` (1487): code param = `provider.authorization_code_param_in_callback || 'code'`; `callbackMetadata` = the query params named in `redirect_uri_metadata` (`getConnectionMetadataFromCallbackRequest`, `server/lib/utils/utils.ts` 103); missing code → `WSErrBuilder.InvalidCallbackOAuth2(providerContext)` where the provider's `error`, `error_description`, `error_reason`, `error_uri`, `status_code`, `error_message` query params are folded into the message (`web-socket-error.ts`). `handleTokenExchangeAndConnectionCreation` (1694): interpolates `token_params`, adds `code_verifier`, basic auth header if configured, `assertSafeOAuthUrl` (egress policy), token exchange via simple-oauth2 or a provider-specific client (`provider.client.ts`, for the odd ones), `getConnectionMetadata(raw, provider, 'token_response_metadata')`, `parseRawCredentials`, then `connection_config = {...tokenMetadata, ...callbackMetadata, ...webhookMetadata, ...sessionConfig}`, upsert, `post_connection_script`, `validateConnection` hook, audit.

**Result delivery to the popup/opener** — two channels:
1. **WebSocket + Redis**: `packages/server/lib/clients/publisher.client.ts` — the browser SDK opens a WS first; server replies `{message_type:'connection_ack', ws_client_id}`; the popup URL carries `ws_client_id`; on completion the server sends `{message_type:'success'|'error', …}` to that WS; if this server instance doesn't hold the socket it publishes on Redis channel `publisher:<wsClientId>` and the instance that does forwards it ("multiple instances of the server running in parallel").
2. **postMessage from the callback page** (`packages/server/lib/utils/html.ts`, 138–195): the rendered page posts `{type:'nango_oauth_callback_success'}` or `{type:'nango_oauth_callback_error', payload:{message, errorType}}` to `window.opener` (`'*'`) **and** on a `BroadcastChannel('nango-oauth-callback')` (COOP fallback); it waits for `{type:'nango_oauth_callback_ack'}` from the Connect UI before `window.close()`, else self-closes after 500 ms on success; on error it stays open showing a "Show error details" toggle.

**Browser SDK** `packages/frontend/lib/index.ts` + `authModal.ts`: `Nango.auth(providerConfigKey, connectionId?, options)` → `AuthorizationModal` opens `new WebSocket(webSocketUrl)`, on ack sets `ws_client_id` and `window.open` with a centred popup (`computeLayout`); polls `modal.closed` to raise `AuthError('windowClosed')`; `AuthError` types include `blocked_by_browser`, `windowClosed`, `invalid_credentials`, `resource_capped`. Query string gets `connect_session_token=` or `hmac=`.

**Connect UI** (`packages/connect-ui`, iframe) ↔ host page (`packages/frontend/lib/connectUI.ts`): iframe→parent events `{type:'ready'}`, `{type:'close'}`, `{type:'connect', payload: AuthResult}`, `{type:'error', payload:{errorType, errorMessage}}` (`connect-ui/src/lib/events.ts`); parent→iframe `{type:'session_token', sessionToken}`; the parent **checks `event.origin` against the Connect UI base URL** (connectUI.ts 137). The iframe's `Go.tsx` listens for the popup's `nango_oauth_callback_*` messages and ACKs them.

**Connect session token** (`packages/server/lib/controllers/connect/postSessions.ts`, `services/connectSession.service.ts`, `packages/keystore/lib/models/privatekeys.ts`): `POST /connect/sessions {end_user, organization, allowed_integrations, integrations_config_defaults{user_scopes, authorization_params, connection_config{oauth_scopes_override,…}}, overrides, webhook_url_override, tags}`; the token is `nango_connect_session_<random>`, stored as **PBKDF2 hash** (`hashValue`) + AES-GCM encrypted copy, `expires_at = now + 30 min` (`CONNECT_SESSION_TTL_MS`); lookup `WHERE hash = ? AND (expires_at IS NULL OR expires_at > now)`. `postReconnect` re-issues a session bound to an existing connection.

**OAuth1** (`server/lib/clients/oauth1.client.ts`): request token → store `request_token_secret` in the same session row → callback with `oauth_verifier` → access token (state is carried manually because OAuth1 doesn't echo it).

---

## 5. Syncs, records, orchestration, inbound webhooks

### Sync script shape — `packages/runner-sdk/lib/scripts.ts` (`createSync`), `sync.ts` (`NangoSyncBase`)
```ts
const sync = createSync({
    description, endpoints: [{ method: 'GET', path: '/shopify/products' }],
    frequency: 'every hour',            // min 30s, max 31 days
    models: { Product: z.object({ id: z.string(), … }) },
    syncType: 'incremental' | 'full',   // deprecated
    trackDeletes: boolean,              // deprecated → nango.trackDeletesStart/End
    autoStart: true, scopes: [...], metadata: zod, checkpoint: zod (flat string|number|boolean),
    webhookSubscriptions: ['products/update', '*'],
    exec: async (nango) => { … }, onWebhook: async (nango, payload) => { … }
});
```
(Legacy `nango.yaml` v2: `syncs.<name>: {runs, sync_type, track_deletes, auto_start, endpoint, output, input, scopes, webhook-subscriptions, version}` parsed by `packages/nango-yaml/lib/parser.v2.ts` into `ParsedNangoSync`; `packages/types/lib/nangoYaml/index.ts`.)

SDK surface inside `exec` (abstract in `runner-sdk/lib/sync.ts`, implemented in `packages/runner/lib/sdk/sdk.ts`): `batchSave(records, model)`, `batchDelete`, `batchUpdate` (deep merge on server), `getRecordsByIds`, `listRecords(model,{cursor})`, `trackDeletesStart(model)` / `trackDeletesEnd(model) → {deletedKeys}`, `deleteRecordsFromPreviousExecutions` (deprecated), `setMergingStrategy({strategy:'ignore_if_modified_after'|'override'}, model)`, `paginate(config)` (async generator using `provider.proxy.paginate` cursor/link/offset — `runner-sdk/lib/paginate.service.ts`), `get/post/…/proxy` with `retries`/`retryOn`/`retryHeader`, `getMetadata/setMetadata`, `getCheckpoint/setCheckpoint`, `lastSyncDate` (Date of the previous successful job, or undefined on first/full run), `log`, `getConnection`, plus a cross-execution **lock API** (`runner/lib/sdk/locks.ts` → persist `/runner/locks/*`, TTL + owner). Every SDK call starts with `this.throwIfAbortedOrKilled()` (cooperative cancellation).

`batchSave` (`sdk.ts` 561): strips `_nango_metadata`, chunks by `this.batchSize`, `POST /environment/:env/connection/:id/sync/:syncId/job/:jobId/records` on the **persist** service with the current merging strategy; the server returns `nextMerging`, which the SDK adopts (this is how `ignore_if_modified_after` becomes `ignore_if_modified_after_cursor` once a cursor is known). Validation against the zod-derived JSON schema per record (`validateRecords`).

**Incremental vs full** — `packages/jobs/lib/execution/sync.ts` 69–130: `syncType = sync_type === 'incremental' && lastSyncDate ? 'incremental' : 'full'`; the script itself decides what to fetch using `nango.lastSyncDate`; `emptyCache` (from "run full resync and delete records") hard-deletes all records of the models first (`clearRecordsIfNeeded`). Legacy `track_deletes` post-step (358–380): after `exec`, `records.deleteOutdatedRecords({generation: syncJobId})` per model.

### Records store — `packages/records`
`records` table (`stores/postgres/migrations/20240327151027_create_records_table.ts`):
```sql
CREATE TABLE "records" (
  id uuid NOT NULL, external_id varchar(255) NOT NULL, json jsonb, data_hash varchar(255) NOT NULL,
  connection_id integer NOT NULL, model varchar(255) NOT NULL,
  created_at timestamptz …, updated_at timestamptz …, deleted_at timestamptz, sync_id uuid, sync_job_id integer
) PARTITION BY HASH (connection_id, model)   -- 256 partitions
-- UNIQUE (connection_id, model, external_id); UNIQUE (connection_id, model, id); INDEX (connection_id, model, updated_at, id)
```
Triggers: `records_updated_at` bumps `updated_at` **only when `data_hash` changes**; `records_undelete` resets `created_at/updated_at` when a soft-deleted row comes back. Later: `pruned_at`, `size_bytes`; `records_data` (2026-03, `20260327160200_create_data_table.ts`) moves the JSON blob to a side table so a row is rewritten only when the hash changes ("only write data when hash has changed"); `records_seen` (`20260512000100`, range-partitioned per day) holds `record_ids uuid[]` per `(connection_id, model, generation)`; `records_routing` maps `(connection, model)` → store key (multi-store).

`FormattedRecord` (`lib/types.ts`): `{id, external_id, json, data_hash, connection_id, model, sync_id, sync_job_id, created_at, updated_at, deleted_at}`; returned records carry
```ts
_nango_metadata: { first_seen_at, last_modified_at, last_action: 'ADDED'|'UPDATED'|'DELETED', deleted_at, pruned_at, cursor }
```
`helpers/format.ts`: `id = uuid.v5(connectionId+model+external_id, uuid.v5(connectionId+model, NIL))` (stable across runs), `data_hash = md5(JSON.stringify(record))`, `external_id = String(record.id)` with NUL bytes stripped; `softDelete` mode sets `deleted_at` (from `record.deletedAt` or now). `helpers/uniqueKey.ts` dedupes by `external_id` and reports `nonUniqueKeys`. `helpers/merge.ts` deep-merges for `batchUpdate` (arrays replaced, not concatenated). `cursor.ts`: cursor = `base64("${last_modified_at}||${id}")`, validated with zod on decode.

**Upsert = one SQL statement with a change classification** (`stores/postgres/postgres.ts` `upsert`, line 536): per (connection, model) `pg_advisory_xact_lock` (`acquireAdvisoryLock`), chunks of `BATCH_SIZE`, `WITH incoming AS (VALUES …), classified AS MATERIALIZED (SELECT … LEFT JOIN records r ON external_id …)` computing
```sql
CASE WHEN r.external_id IS NULL THEN 'inserted'
     WHEN r.deleted_at IS NOT NULL AND incoming.deleted_at IS NULL THEN 'undeleted'
     WHEN r.deleted_at IS NULL AND incoming.deleted_at IS NOT NULL THEN 'deleted'
     WHEN incoming.data_hash IS DISTINCT FROM r.data_hash THEN 'changed'
     ELSE 'unchanged' END as status
```
and `should_upsert` (hash differs, deleted flag differs, or the optional `(r.updated_at, r.id) <= (cursor)` guard for `ignore_if_modified_after_cursor`) → `INSERT … ON CONFLICT (connection_id, model, external_id) DO UPDATE` only for those rows → `UpsertSummary {addedKeys, updatedKeys, deletedKeys, unchangedKeys, nonUniqueKeys, activatedKeys (monthly-active accounting), nextMerging}`. Wrapped in `retry()` for deadlocks.

**Delete detection by generation** — `deleteOutdatedRecords({connectionId, model, generation, batchSize=10_000})` (postgres.ts 1373): pages live rows by `id > lastId`, anti-joins against `SELECT unnest(record_ids) FROM records_seen WHERE … AND generation >= :generation` and soft-deletes the rest; each batch is its own transaction under the advisory lock ("deletion is intentionally not atomic … the next sync run will call deleteOutdatedRecords again and clean up whatever was missed"). `trackDeletesStart` saves `{syncJobId}` in a checkpoint keyed by model; `trackDeletesEnd` calls persist `DELETE …/job/:jobId/outdated` with that job id, so everything not seen since the start marker is tombstoned (`deleted_at`, `last_action: DELETED`). Old `sync_job_id` on `records` is deprecated ("records_seen owns the generation").

Delete modes: `deleteRecords({mode: 'hard'|'soft'|'prune'})`; daemons `autopruning` (drop JSON of stale records, keep tombstone) and `autodeleting`.

### Orchestrator / scheduler / jobs / runner
- **`packages/scheduler`** — two Postgres tables (`20240506105059_initial_scheduler_models.ts`): `tasks(id, name, payload, group_key, group_max_concurrency, retry_max, retry_count, retry_key, owner_key, starts_after, created_to_started_timeout_secs, started_to_completed_timeout_secs, heartbeat_timeout_secs, state ENUM(CREATED,STARTED,SUCCEEDED,FAILED,EXPIRED,CANCELLED), last_state_transition_at, last_heartbeat_at, output, terminated, schedule_id)` and `schedules(name unique, state PAUSED|STARTED|DELETED, starts_at, frequency_ms, payload, group_key, retry_max, timeouts, last_scheduled_task_id/state, next_execution_at)`. **Partial unique index** `tasks_one_active_per_schedule ON tasks(schedule_id) WHERE state IN ('CREATED','STARTED')` (`20260728085028`).
- **Dequeue** (`models/tasks.ts` 392): `pg_try_advisory_xact_lock(hash(groupKeyPattern))` (skip if another worker is dequeuing the same pattern), then one CTE: candidates `WHERE state='CREATED' AND group_key LIKE ? AND starts_after <= now() FOR UPDATE SKIP LOCKED` → running count per group → `ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY created_at)` → `WHERE group_max_concurrency = 0 OR rank + current_running <= group_max_concurrency` → `UPDATE … SET state='STARTED', last_heartbeat_at=now()` → return.
- **Expiry daemon** (`daemons/expiring/expiring.daemon.ts` + `tasks.expiresIfTimeout`): under an advisory lock, CREATED past `starts_after + created_to_started_timeout` or STARTED past `last_heartbeat_at + heartbeat_timeout` → EXPIRED with `{reason}`; schedules' `next_execution_at` advanced. **Scheduling daemon** (`daemons/scheduling/scheduling.ts`): due = `state='STARTED' AND starts_at<=now AND next_execution_at<=now AND last_scheduled_task_state NOT IN (CREATED,STARTED)` `FOR UPDATE SKIP LOCKED`.
- **Retry** (`scheduler.ts` `fail`, 456–510): if `retryMax > retryCount` insert a new task `${name}:${retryCount+1}` with the same `retryKey` (clients poll `/retries/:retryKey/output`).
- **Group keys & concurrency** (`packages/shared/lib/clients/orchestrator.ts`): syncs are recurring schedules named `environment:<envId>:sync:<syncId>`, group `sync:environment:<envId>` with `maxConcurrency: 0` (unbounded; an env `SYNC_ENVIRONMENT_MAX_CONCURRENCY` → `recurringGroupMaxConcurrency` exists in `orchestrator/lib/scheduler-config.ts`), `retry: {max: 0}`, timeouts `createdToStarted 1h, startedToCompleted 24h, heartbeat 5min`; actions `action:environment:<env>` (async actions `maxConcurrency: 1` "runs sequentially per environment"); webhooks `webhook:environment:<env>`; functions `function:environment:<env>:connection:<id>:function:<name>` (per-connection group). `ORCHESTRATOR_TASK_CREATED_PER_GROUP_COUNT_MAX` caps queued tasks per group (`task_dropped` events); `BackpressureMonitor` gauges queued-per-group.
- **`packages/jobs`** — `OrchestratorProcessor` (`orchestrator/lib/clients/processor.ts`): a `PQueue({concurrency})` per `groupKeyPattern`, long-polling `dequeue` for `available + concurrency` tasks, handler failure → `client.failed(taskId)`. `jobs/lib/execution/sync.ts` builds `NangoProps` (connection, syncId, syncJobId, lastSyncDate, track_deletes, secretKey for persist, heartbeatTimeoutSecs, runner flags, usage capping status) and calls the runner; on completion writes the sync job result, fires the `sync` webhook per model `{added, updated, deleted}` and, if any records changed, `modifiedAfter`.
- **`packages/runner`** — `exec.ts`: the compiled script is wrapped in `(function(){ var module={exports:{}}; … })()` and run with **`node:vm` `Script` in a sandbox** whose `console` is a no-op Proxy and whose `require` is a whitelist (`url`, `crypto`, `zod`, `soap`, `botbuilder`, `unzipper`, …); the SDK object is injected; an `AbortController` propagates cancel/kill; output capped at 2 MB. `RunnerMonitor` (`monitor.ts`) holds a **sync-conflict key** `function:${env}:${scriptType}:${syncId}` (locally or via persist `PUT /runner/syncConflict`) so the same sync never runs twice concurrently even if the scheduler misfires; heartbeats go to `jobs /tasks/:id/heartbeat`. Runners are per-team processes (`jobs/lib/runner/runner.ts`: `${env}-runner-account-${teamId}` on Fleet/Kubernetes, Render, Lambda or a single "remote" runner) — customer isolation is by process, not by `vm`.
- **`packages/persist`** — the only service that touches the records DB from scripts; authenticated by the environment secret key; routes for records (`POST/PUT/DELETE …/job/:jobId/records`, `/outdated`, `/hard`), cursor, checkpoints, runner locks, sync-conflict, abort, logs.

### Inbound webhooks — `packages/server/lib/webhook/*`
- Route `/webhook/:environmentUuid/:providerConfigKey` → `webhook.manager.ts routeWebhook`: 204 if no body+headers, 204 if the provider has no `webhook_routing_script` or no handler; handler contract (`types.ts`):
```ts
export type WebhookHandler<T = any> = (internalNango: InternalNango, headers, body: T, rawBody: string, query?)
    => Promise<Result<WebhookResponse>>;
// WebhookResponse = { content, statusCode } | + { connectionIds: string[] } | + { toForward: unknown } | { content: null, statusCode: 204 }
```
37 handlers exist (`index.ts` re-exports; e.g. shopify, hubspot, salesforce, slack, github-app, jira, linear, xero, airtable, google-*, gmail, notion, pagerduty, shipstation). **There is no `stripe-webhook-routing.ts`** on master (404) — Stripe forwarding without routing is **unverified**.
- **Shopify** (`shopify-webhook-routing.ts`, quoted ≤10 lines):
```ts
function validateShopifySignature(secret: string, headerSignature: string, rawBody: string): boolean {
    const calculatedHmac = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    return crypto.timingSafeEqual(Buffer.from(calculatedHmac, 'base64'), Buffer.from(headerSignature, 'base64'));
}
…
const webhookSecret = nango.integration.oauth_client_secret || nango.integration.custom?.['webhookSecret'];
…
const response = await nango.executeScriptForWebhooks({ body, webhookTypeValue: topic ?? '', connectionIdentifierValue: subdomain, propName: 'subdomain' });
return Ok({ content: { status: 'success' }, statusCode: 200, connectionIds, toForward: body });
```
Headers read case-insensitively: `x-shopify-hmac-sha256`, `x-shopify-topic`, `x-shopify-shop-domain` (→ subdomain). `InternalNango.executeScriptForWebhooks` (`internal-nango.ts` 117) resolves connections by `connection_config.<propName>` (or `metadata.<x>`, or `connectionId`), then for each sync config whose `webhook_subscriptions` contains the topic (or `*`) dispatches an `onWebhook` execution through the orchestrator (`webhook:environment:<env>` group) or a queue.
- **Forwarding to the customer** (`webhook.manager.ts` 100–190 + `packages/webhooks/lib/forward.ts`): only when the handler returned 200 and the integration has `forward_webhooks`; **fire-and-forget** ("Forward the webhook to the customer asynchronously to avoid provider timeouts"); per matched connection: body `{from: provider, providerConfigKey, type:'forward', payload, connectionId}` to `primary_url` and `secondary_url` (per-connection `webhook_url_override` honoured). `deliver` (`webhooks/lib/utils.ts` 212): stable-stringified body, headers `X-Nango-Signature` (= sha256(secret+payload), flagged "vulnerable to length-extension attacks") **and** `X-Nango-Hmac-Sha256` (HMAC), original provider headers minus `NON_FORWARDABLE_HEADERS`; `retryFlexible` up to `NANGO_WEBHOOK_RETRY_ATTEMPTS` with backoff `min(3000·2^n, 10 min)`; `shouldRetry`: network errors and non-2xx except `4xx` → retry; timeouts `NANGO_WEBHOOK_TIMEOUT_MS`; egress URL policy (`isOutboundUrlAllowed`). **Circuit breaker per destination URL** (`circuitBreaker.ts`, Redis `rate-limiter-flexible` failure counter: `failureThreshold` in `windowSecs` → OPEN for `cooldownDurationSecs` → HALF_OPEN single probe).
- Sync-completion webhook (`webhooks/lib/sync.ts` `sendSync`): `{type:'sync', connectionId, providerConfigKey, syncName, syncVariant, model, responseResults:{added,updated,deleted}, syncType, modifiedAfter, success, error?}`; auth webhooks (`auth.ts`) for creation/refresh/override with success/error.

---

## 6. Proxy — `packages/server/lib/controllers/proxy/allProxy.ts` + `services/proxy.service.ts` + `packages/shared/lib/services/proxy/*`

Request headers (`allProxy.ts` 105–125): `Connection-Id`, `Provider-Config-Key`, `Retries` (number, default 0), `Retry-On` (comma-separated status codes → `retryOn: number[]`), `Base-Url-Override`, `Decompress`, `Forward-Headers-On-Redirect`, `Nango-Activity-Log-Id`, `Nango-Is-Sync`, `Nango-Is-Dry-Run`, and any `Nango-Proxy-<Header>` is forwarded as `<Header>`. Endpoint = everything after `/proxy/` including the query string.

`proxy.service.ts request` (216–345): load connection → `refreshOrTestCredentials({instantRefresh:false})` **before the first attempt**; build `ApplicationConstructedProxyConfiguration` via `getProxyConfiguration` (`proxy/utils.ts` 210: strips the base_url if the caller passed an absolute URL, `retries || 0`, `retryOn`, `decompress`, files); then `new ProxyRequest({ proxyConfig, getConnection, getIntegrationConfig, outboundPolicy, logger })`. **`getConnection` is invoked on every attempt** (memoised for `MEMOIZED_CONNECTION_TTL`) and re-runs `refreshOrTestCredentials`, which is why a `401` is in the default retryable set ("Maybe: token was refreshed").

`ProxyRequest.request` (`proxy/request.ts` 100–200): `retryFlexible(fn, { max: retries, onError })` — `fn` rebuilds the axios config each attempt (`getAxiosConfiguration`: URL, headers, agents with SSRF policy, byte-metering transport, redirect validation). `retryFlexible` (`packages/utils/lib/retry.ts`): attempt loop, `nextWait = min(3000·2^attempt, 600000)`, `onError` may return `{retry, reason, wait}` and the custom `wait` wins.

**Retry decision** (`proxy/retry.ts` `getProxyRetryFromErr`): network error codes (`ECONNRESET, ETIMEDOUT, ECONNABORTED, ECONNREFUSED, EHOSTUNREACH, EAI_AGAIN, UND_ERR_SOCKET` + env extras) → retry; if the provider declares `proxy.retry.error_code` (exact `429`, class `5xx`, range `500-502`) only those; else default `status >= 500 || 429 || 401`; then caller `retryOn`; then `remaining` header `=== '0'`. Wait time precedence: caller `retryHeader {at|after}` → provider `proxy.retry.at|after` (list; **longest** wait across headers wins) → `in_body {path, value regex, strategy}` → exponential backoff. `parseRetryValue`: `at` accepts epoch seconds, epoch ms (year > 1971 heuristic) or a date string, wait = `reset - now`; `after` = seconds (their TODO: "handle non-seconds header (e.g: linear)").

**URL building** (`proxy/utils.ts buildProxyURL` 419): `apiBase = baseUrlOverride || provider.proxy.base_url`; the `A || B` fallback is resolved by finding the first `connectionConfig.<key>` in the template and picking `A` if that key is set, else `B`; the endpoint is stripped of the base only at a real path boundary (anti `api.example.com.evil.com`); then `interpolateIfNeeded` with `{...connection (connection_config, metadata), ...credentials}`; `provider.proxy.query` interpolated with `{accessToken, connectionConfig, credentials, ...credentials}`. Headers: `provider.proxy.headers` interpolated the same way (`${accessToken}` = OAuth2 `access_token` or `.token`; `${clientId}/${clientSecret}` need the integration config). `Base-Url-Override` is subject to `enforceProxyOutboundUrlPolicy` + a denylist (`packages/egress`, `runner-sdk/lib/baseUrlOverrideDenylist.ts`) — private/metadata IPs are blocked.

Per-provider pagination in the SDK (`nango.paginate`) is driven by `provider.proxy.paginate` (cursor: `cursor_path_in_response`/`cursor_name_in_request`; link: `link_rel_in_response_header`/`link_path_in_response_body`; offset: `offset_name_in_request`, `offset_calculation_method`).

---

## 7. Rate limiting and concurrency

- **Public API** (`packages/server/lib/middleware/ratelimit.middleware.ts`): `rate-limiter-flexible` (Redis, memory fallback), fixed 60-s window, key `account-secret-<id>` / `account-global-<id>` (+`-script` bucket when `Nango-Is-Script: true`), `user-<id>`, or `ip-<ip>`; plan size `s…12xl` = multiples of `DEFAULT_RATE_LIMIT_PER_MIN`; sensitive paths cost `max/6` points, unauthenticated calls cost 10; responds `X-RateLimit-Limit/Remaining/Reset`, `429 {error:{code:'too_many_request'}}` + `Retry-After`; **fails open** if Redis is down (docs: `docs/reference/backend/http-api/rate-limits.mdx`).
- **Webhook ingress** (`webhook-ingress-ratelimit.middleware.ts`): key `${environmentUuid}:${providerConfigKey}`, `enforce` flag, same headers.
- **Orchestrator immediate-task throttle** (`orchestrator/lib/rateLimiter.ts` + `kvstore/lib/SlidingWindowRateLimiter.ts`): Lua sliding window (previous window weighted by remaining fraction), `ORCHESTRATOR_THROTTLED_IMMEDIATE_PER_MIN`, returns `retryAfterMs`.
- **Outbound to providers**: **no per-connection or per-provider outbound rate limiter.** Only reactive handling: `retries` + header-driven waits (§6). Docs (`docs/guides/functions/rate-limits.mdx`) explicitly say "Strategy 1: retry with exponential backoff … sync functions can run for up to 24 hours".
- **Concurrency control per connection**: (a) Redis refresh lock per connection (§3); (b) `records` advisory lock per (connection, model) for upsert/delete; (c) one active task per schedule (partial unique index) + runner sync-conflict key per `(env, scriptType, syncId)`; (d) task group `group_max_concurrency` — `action` async 1 per environment, functions grouped per connection, syncs unbounded per environment by default; (e) `updateLastFetched` uses `SKIP LOCKED` to avoid lock convoys. A sync of one connection and an action on the same connection **can** run concurrently.

---

## 8. What Nango gets wrong / what is over-engineered for a single-tenant PIM

**Over-engineered for us (multi-tenant SaaS control plane):**
- Accounts → environments → plans → usage/metering/capping (`packages/billing`, `metering`, `usage`; `capping.getStatus(...)` is called on the hot path of sync, webhook and proxy), connect sessions / end users / keystore, Slack notifications, audit trails, ClickHouse/ElasticSearch logs, `dd-trace` on every function.
- Five services talking HTTP (server, orchestrator, jobs, persist, runner) plus Redis pub/sub just so a popup can be notified by whichever instance holds the socket; fleet/Kubernetes/Render/Lambda runner provisioning per customer; `node:vm` sandbox + compiled-script upload to S3 + the whole `nango.yaml`/zod → JSON-schema compile & deploy pipeline (`packages/nango-yaml`, `shared/lib/services/deploy`). For one tenant, a sync is a function in our own process.
- Records: 256 hash partitions + `records_data` side table + daily-partitioned `records_seen` + auto-pruning/deleting daemons + MAR accounting (`activatedKeys`) — sized for hundreds of millions of rows across tenants.
- 982-provider catalogue with 17 auth modes (MCP OAuth, TBA, BILL, TWO_STEP with SAML assertions…) — we need ≈10 commerce providers and 3 modes.
- Per-record encryption option and KMS envelope keys.

**Actually wrong or weak (worth avoiding, not copying):**
- Refresh lock is admittedly "not a distributed lock" (single Redis, unsafe on crash); combined with the in-process promise map it is good enough only because refreshes are idempotent-ish. No fencing token.
- `refresh_attempts` is incremented **per calendar day**, so a connection broken on Friday night is only `refresh_exhausted` on the 4th day; meanwhile every sync retries. Fine for them (they bill), noisy for us.
- No `refresh_token_expires_at`: eBay (18 months), Amazon LWA and Etsy refresh-token lifetimes are invisible until failure. `credentials_expires_at` defaults to `now+1 day` for tokens without expiry, which makes the column meaningless for BigCommerce/Shopify offline tokens.
- OAuth `state` cookie is measured but not enforced (feature flag); HMAC verification uses `===`; the popup posts to `window.opener` with `'*'` origin.
- `X-Nango-Signature` (sha256(secret+payload)) is kept for backward compatibility despite their own "vulnerable to length-extension" comment.
- `at:` retry headers assume seconds ("TODO: handle non-seconds header"); `after:` assumes seconds; `in_body` regex config in YAML is fragile.
- `A || B` base-url fallback is parsed with a regex on the first `connectionConfig.<key>` — an implicit, undocumented rule.
- `data_hash = md5(JSON.stringify(record))` is key-order sensitive (a script that emits the same object with different key order will "update" every record). They do stable-stringify webhook bodies but not records.
- The commerce entries carry **no** rate-limit metadata (Shopify leaky bucket / `X-Shopify-Shop-Api-Call-Limit`, SP-API token bucket, eBay daily quotas), so the proxy's clever header logic is unused for exactly the APIs we care about.
- `sync:environment:<env>` groups run unbounded; per-connection fairness is not modelled (one big connection can starve the rest).
- Webhook forwarding is fire-and-forget after the provider gets its 200 — a crash between the two loses the event (no outbox).

---

## Patterns worth re-implementing in our own code

| # | Pattern | Why | Nango file that demonstrates it | Size |
|---|---|---|---|---|
| 1 | **Declarative provider catalogue** (YAML/TS object per provider: auth mode, URLs, `authorization_params`, `token_params`, `refresh_params`, `scope_separator`, `token_request_auth_method`, `authorization_code_param_in_callback`, `redirect_uri_metadata`, `token_response_metadata`, typed `connection_config` fields with pattern/prefix/suffix/enum, `proxy.base_url/headers` with `${…}` interpolation) | One place per marketplace; new provider = data, not code | `packages/providers/providers.yaml` (shopify, amazon-selling-partner, walmart entries), `packages/types/lib/providers/provider.ts` | M |
| 2 | **Connection health columns**: `credentials_expires_at`, `last_refresh_success/failure`, `refresh_attempts`, `refresh_exhausted`, `last_fetched_at`, `last_execution_at` — plus our own `refresh_token_expires_at` | Lets the UI/cron reason about "needs re-auth" without decrypting tokens | `packages/database/lib/migrations/20250310134848_connection_add_meta_fields.cjs`, `connection.service.ts` `setRefreshFailure` | S |
| 3 | **Refresh-if-needed with buffer, in-flight dedupe, lock, double-check** (`token_expiration_buffer` default 15 min; process map + `SET NX PX` lock; re-read after lock; re-read on lock timeout; keep old refresh_token when rotation omits one) | Prevents the classic "two workers refresh, second invalidates first" with Amazon/eBay | `packages/shared/lib/services/connections/credentials/refresh.ts` 366–582, `oauth2.client.ts` 216–222, `kvstore/lib/Locking.ts` | M |
| 4 | **Failure cooldown + exhaustion** (30-s cooldown, N failed *days* → exhausted; success resets; manual force bypasses) and the **active-error record cleared on recovery with a recovery event** | Stops retry storms; gives "connection broken since …" and "recovered" signals | `refresh.ts` 98–109, `hooks.ts` `connectionRefreshFailed/Success` | S |
| 5 | **OAuth session row keyed by `state`** (single-use, holds `code_verifier`, `connection_config`, callback URL, who started it), **PKCE always on unless disabled**, **state cookie double-submit**, provider error params folded into the user-visible error | Correct, restartable OAuth across server instances | `oauth.controller.ts` 225–245, 711–722, 804–809, 1222–1260; `migrations/20230326083713_create_oauth_session.cjs`; `web-socket-error.ts getProviderErrorContextFromQuery` | M |
| 6 | **Metadata capture into `connection_config`** from callback query (`redirect_uri_metadata`, e.g. `selling_partner_id`, `sellerId`) and token response (`token_response_metadata`) | SP-API/Walmart identity arrives that way; no extra API call | `oauth.controller.ts` 1503, 1798–1815; `server/lib/utils/utils.ts` 103 | S |
| 7 | **Popup → opener protocol**: `window.opener.postMessage` + `BroadcastChannel` fallback + ACK before close + 500 ms self-close, error page stays open with details | Works under COOP/Safari; no WebSocket needed for one tenant | `packages/server/lib/utils/html.ts` 138–195, `connect-ui/src/lib/events.ts` | S |
| 8 | **Credentials verification on connect** = declarative `verification.endpoints` (2xx = ok) or a small per-provider function; same function reused as periodic test for API-key connections | Catches bad keys at save time; gives API-key connections a health signal | `hooks.ts` `credentialsTest` 387–518, providers.yaml `woocommerce.proxy.verification` | S |
| 9 | **Proxy retry decision table + header-driven wait** (`error_code` list with `5xx`/ranges, `retryOn`, `remaining==0`, `at`/`after` headers (longest wins), body regex, exponential fallback capped 10 min) and **`getConnection()` per attempt** so a 401 retry uses refreshed credentials | Exactly what SP-API / Shopify throttling needs; add Shopify `X-Shopify-Shop-Api-Call-Limit` and SP-API `x-amzn-RateLimit-Limit` ourselves | `packages/shared/lib/services/proxy/retry.ts`, `request.ts` 100–200, `utils/lib/retry.ts retryFlexible` | M |
| 10 | **Base-URL/header interpolation with `${connectionConfig.x}` / `${accessToken}` and prefix-boundary-safe absolute-URL stripping** | Region/sandbox switching per connection without code | `proxy/utils.ts buildProxyURL` 419–505 | S |
| 11 | **Records table: `external_id` unique per (connection, model), `data_hash`, `deleted_at` tombstone, `updated_at` bumped only on hash change, undelete trigger, single-CTE upsert that classifies inserted/undeleted/deleted/changed/unchanged and writes only changed rows, advisory lock per (connection, model)** | Cheap change detection → "what changed since" for downstream PIM sync; idempotent re-runs | `records/lib/stores/postgres/migrations/20240327151027_create_records_table.ts`, `postgres.ts upsert` 536–700, `helpers/format.ts` | M |
| 12 | **Generation-based delete detection** (`trackDeletesStart/End`: remember seen ids per job, tombstone what wasn't seen since the start marker; batched, non-atomic, self-healing on next run) | Correct deletes for full listings (Shopify products, eBay offers) without diffing in memory | `runner/lib/sdk/sdk.ts` 705–735, `postgres.ts deleteOutdatedRecords` 1373–1460, `records_seen` migration | M |
| 13 | **Keyset cursor `base64(updated_at||id)` + `_nango_metadata {first_seen_at, last_modified_at, last_action, deleted_at, cursor}` on every returned record** | Stable pagination and per-record provenance for the UI | `records/lib/cursor.ts`, `records/lib/types.ts` | S |
| 14 | **Task table with explicit states, heartbeat, `starts_after`, three timeouts, `retry_max/retry_count/retry_key`, group key + `group_max_concurrency`, `FOR UPDATE SKIP LOCKED` dequeue CTE, expiry daemon under an advisory lock, one-active-task-per-schedule partial unique index** | Postgres-only job queue with per-connection concurrency and stuck-task recovery; no Redis/BullMQ needed | `scheduler/lib/models/tasks.ts dequeue` 392–470, `expiresIfTimeout` 472–520, `migrations/20260728085028_tasks_one_active_per_schedule.ts`, `scheduler.ts fail` 456–510 | L |
| 15 | **Sync-conflict guard** keyed `(env, scriptType, syncId)` in the executor, independent of the queue | Belt-and-braces against double execution | `runner/lib/monitor.ts` 60–140 | S |
| 16 | **Inbound webhook handler contract** `(ctx, headers, body, rawBody, query) → {statusCode, content, connectionIds, toForward}`; verify HMAC on the **raw body** with `timingSafeEqual`; resolve connection by a `connection_config` field (Shopify `subdomain`); topic → subscribed handlers; respond fast, process async | Shopify/eBay/Amazon notifications all fit this shape | `server/lib/webhook/types.ts`, `shopify-webhook-routing.ts`, `webhook.manager.ts` | M |
| 17 | **Outbound delivery**: stable-stringify body, HMAC-SHA256 signature header, bounded retries with backoff, 4xx not retried, **per-destination circuit breaker** in Redis/Postgres | If we ever call back external systems (our own webhooks to ops tools) | `webhooks/lib/utils.ts deliver` 212–350, `circuitBreaker.ts` | M |
| 18 | **Egress URL policy** for any user-supplied base URL (deny private/metadata ranges, validate redirects) | Any "custom store URL" field (WooCommerce, Shopware) is an SSRF vector | `packages/egress` (not read; referenced from `proxy/outbound-policy.ts`, `runner-sdk/lib/baseUrlOverrideDenylist.ts`) — **partially unverified** | M |
| 19 | **Encrypt credentials at rest with AES-256-GCM, iv+tag columns beside the ciphertext**, key from env, re-encrypt-on-key-change routine | Minimal, auditable; no KMS needed for one tenant | `packages/utils/lib/encryption.ts`, `encryption.manager.ts encryptConnection/encryptDatabase` | S |

## Not worth cloning

- Multi-tenant accounts/environments/plans/billing/metering/capping; Connect UI + connect sessions + end-user model; Slack/notification services; agent/MCP sessions.
- WebSocket + Redis pub/sub result delivery (the `postMessage` path alone is enough for one origin).
- The five-service topology, per-customer runners (Fleet/Kubernetes/Lambda/Render), `node:vm` sandboxing, script compilation and S3 deploy, `nango.yaml`/zod → JSON-schema pipeline and per-record schema validation flags.
- 256-way hash partitioning, `records_data` blob side table, daily `records_seen` partitions, `records_routing` multi-store, auto-prune/auto-delete daemons, MAR accounting, per-record encryption, KMS envelope encryption.
- ElasticSearch/ClickHouse operation logs and `dd-trace` spans everywhere.
- The 982-provider catalogue as a whole (we hand-write ≈10 entries) and the 17 auth modes (we need OAUTH2, OAUTH2_CC, API_KEY/BASIC).
- The legacy `X-Nango-Signature` scheme, `track_deletes` config flag (use start/end markers), `deleteRecordsFromPreviousExecutions`, `batchSend`.
- Their commerce YAML entries verbatim: shopify/ebay/amazon-selling-partner/etsy/bigcommerce/walmart are correct skeletons but lack rate-limit headers, refresh-token expiry, marketplace ids, RDT — we should write ours with those fields added.
