# R6 — Non-EU-native channels: connector feasibility for an EU-based PIM

Researched 2026-08-29 against official developer documentation only. Every fact carries its source URL. Where the official page could not be read (several portals are JavaScript-rendered SPAs that return only navigation to a fetcher) the item is marked **unverified**. No licensing/pricing of third-party tools is discussed.

Legend for the "sign in + Allow" question: **YES** = an operator can connect purely by signing into the channel and clicking Allow/Connect (OAuth-style redirect, tokens land server-side). **KEY-COPY** = operator must copy/paste a key or token. **MIXED** = both exist.

---

## 1. TikTok Shop (Partner Center / Open Platform)

### 1.1 Public API, self-serve or partner-only, portal
- Portal: **TikTok Shop Partner Center** — https://partner.tiktokshop.com (docs at `/docv2/page/...`).
- Developer types: "Seller Developer" (direct 1:1 authorization for the bound seller account), "System Integrator", "App Developer". "Seller developers are required to have an activated TikTok Shop account before they can register as a developer at Partner Center." "A Seller Account must have an Account Manager (AM) assigned before onboarding." — https://partner.tiktokshop.com/docv2/page/developer
- App types: **"public"** apps (distributable via the TikTok Shop App Store, "require approval") and **"custom"** apps (access only linked accounts, "without requiring review"; recommended for testing). — https://partner.tiktokshop.com/docv2/page/create-tts-app-oauth-client
- Review: public apps require "registration review, language listing review per market, app review, and compliance checks"; custom apps need review only if they are Connector apps or reach "25 or more seller authorizations". — https://partner.tiktokshop.com/docv2/page/app-development-overview
- Developer guide: "US/UK and some markets also require a compliance & legal review — budget 3+ weeks." — https://partner.tiktokshop.com/docv2/page/tts-developer-guide
- Verdict: **self-serve registration + app creation; public (multi-seller) apps are review-gated per market.**

### 1.2 Auth mechanism
- Authorization URLs (seller): ROW `https://services.tiktokshop.com/open/authorize?service_id={service_id}`; US `https://services.us.tiktokshop.com/open/authorize?service_id={service_id}`. Partner (TAP): `https://partner.tiktokshop.com/open/authorize?service_id=…` / `https://partner.us.tiktokshop.com/open/authorize?service_id=…`. — https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
- Code exchange: `GET https://auth.tiktok-shops.com/api/v2/token/get` with `grant_type=authorized_code` (sic — TikTok's own value, not `authorization_code`); refresh: `GET https://auth.tiktok-shops.com/api/v2/token/refresh` with `app_key, app_secret, refresh_token, grant_type=refresh_token`. — https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
- Lifetimes: `auth_code` valid **30 minutes, single use**; access token "default validity: **7 days**"; refresh-token expiry "based on the authorization duration the user granted" (returned as `refresh_token_expire_in`). Response fields: `access_token, access_token_expire_in, refresh_token, refresh_token_expire_in, open_id, seller_name, seller_base_region, user_type, granted_scopes`. — https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
- Refresh returns a **new access token and a new refresh token** (rotation). — https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
- Credentials: App Key = "public identifier"; App Secret = "private key used to sign your API requests and to exchange the authorization code for an access token". Redirect URL configured at app creation; callback appends `?code={authorization_code}`. — https://partner.tiktokshop.com/docv2/page/create-tts-app-oauth-client
- Request signing: every call carries query params `app_key`, `timestamp`, `sign` (+ `shop_cipher` for shop-scoped APIs) and header `x-tts-access-token` (visible in the official Get Order Detail sample URL — https://partner.tiktokshop.com/us/doc/page/63fd742f715d622a338c4c10). The signature is documented at https://partner.tiktokshop.com/docv2/page/sign-your-api-request — **exact recipe (sorted-params concatenation + path + body wrapped in app_secret, HMAC-SHA256 hex) is unverified**: the page is JS-rendered and returned only navigation to every fetcher tried. Treat the widely-cited algorithm as unconfirmed until read in a browser.
- Seller App Store authorization flow exists ("Authorization via App Store", https://partner.tiktokshop.com/docv2/page/authorization-via-app-store) — content unverified (JS-rendered).
- **Sign in + Allow? YES.** Seller is redirected to the TikTok `open/authorize` page, consents, and a code lands on the redirect URL; no key copying by the operator. (The app's own app_key/app_secret are yours, not the seller's.)

### 1.3 Multi-account / multi-region
- One authorization can cover several shops; call `GET /authorization/202309/shops` to "obtain the corresponding shop cipher for use as an input parameter in shop related APIs". — https://partner.tiktokshop.com/docv2/page/6507ead7b99d5302be949ba9
- Region split at the auth layer: US vs ROW authorize hosts; token response carries `seller_base_region`. — https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
- App creation asks you to "select your local region for market and select local sellers for seller type". — https://partner.tiktokshop.com/docv2/page/create-tts-app-oauth-client
- EU footprint (official newsroom): live in France, Germany, Ireland, Italy, Spain, UK; Austria, Belgium, Netherlands, Poland from 15 June 2026; "Sell Across Europe" lets sellers localise and ship to other EU markets. — https://newsroom.tiktok.com/tiktok-shop-expands-across-europe?lang=en-150

### 1.4 API surface
- Developer guide lists six primary domains: Seller, Products, Orders, Fulfillment, Logistics, Finance. SDKs: Java, GoLang, Node.js. — https://partner.tiktokshop.com/docv2/page/tts-developer-guide
- Additional families evidenced by official doc pages: Promotions ("Promotion API overview" https://partner.tiktokshop.com/docv2/page/650da1ab55bc3202b76f8d21), Products (https://partner.tiktokshop.com/docv2/page/650b23eef1fd3102b93d2326), Seller API (https://partner.tiktokshop.com/docv2/page/650b1f2ff1fd3102b93c6d3d), Creator/Affiliate management (https://partner.tiktokshop.com/docv2/page/650934be0fcef602bf0e5784), Category rules (https://partner.tiktokshop.com/docv2/page/6509c0febace3e02b74594a9), Global Product (https://partner.tiktokshop.com/doc/page/262904), Webhook events for Returns/Cancellations/Messaging (see 1.5). Finance APIs are moving from 202309 to a 202605 version (Get Payments) — https://partner.tiktokshop.com/docv2/page/supplementary-notice-on-api-deprecation-finance-apis
- Advertising: not part of TikTok Shop Partner Center docs; TikTok Ads is a separate platform (not researched here).

### 1.5 Real-time events (webhooks)
- 16 topics: `ORDER_STATUS_CHANGE, RECIPIENT_ADDRESS_UPDATE, PACKAGE_UPDATE, PRODUCT_STATUS_CHANGE, SELLER_DEAUTHORIZATION, UPCOMING_AUTHORIZATION_EXPIRATION, CANCELLATION_STATUS_CHANGE, RETURN_STATUS_CHANGE, NEW_CONVERSATION, NEW_MESSAGE, PRODUCT_INFORMATION_CHANGE, PRODUCT_CREATION, PRODUCT_CATEGORY_CHANGE, NEW_MESSAGE_LISTENER, INVOICE_STATUS_CHANGE, PRODUCT_AUDIT_STATUS_CHANGE, REVERSE_STATUS_UPDATE`. — https://partner.tiktokshop.com/docv2/page/tts-webhooks-overview
- Signature: `Authorization` header = "signature = HMAC-SHA256(signature_base_string, app_secret)" where base string is "app_key + raw_request_body"; value is "the lowercase hexadecimal HMAC-SHA256 digest" (no Bearer prefix). Constant-time compare; reject missing. — same URL
- Payload: `type` (numeric), `tts_notification_id` (idempotency key), `shop_id`, `timestamp` (Unix s), `data`. — same URL
- Retry policy: **not documented**; the page warns "Do not rely on webhooks as the only source of truth". — same URL

### 1.6 Rate limits and bulk
- "does not expose fixed QPS quotas" — dynamic per App ID × authorized shop. Suggested baselines: heavy write/analytics 0.2–1 rps; standard write 1–3 rps; standard read/sync 3–10 rps; lightweight read/batch 5–20 rps. Throttle signals: HTTP **429** and business code **36009002**; honour `Retry-After`. More capacity: "expand your shop authorization scale" or contact AM. — https://partner.tiktokshop.com/docv2/page/rate-limits
- Bulk/feeds: no feed-file mechanism found in official docs; batch is per-API (e.g., Global Product / batch product endpoints) — **unverified**.

### 1.7 Sandbox
- "Development Shop (sandbox)" to "simulate seller workflows without affecting real shop data"; only sandbox test accounts can validate unpublished apps. — https://partner.tiktokshop.com/docv2/page/app-development-overview
- Test access token generation page exists (https://partner.tiktokshop.com/docv2/page/generate-test-access-token) and a US Sandbox Guide (https://partner.tiktokshop.com/us/doc/page/275159) — contents unverified (JS-rendered).

### 1.8 Versioning
- Version is a **path segment**: "Specify the version name (e.g. 202309) in the path instead of as a query parameter", e.g. `https://open-api.tiktokglobalshop.com/fulfillment/202309/orders/{order_id}/packages`. — https://partner.tiktokshop.com/docv2/page/introducing-api-version-202309
- Legacy (pre-Sept-2023) versions: unsupported from 30 June 2024; "All requests to legacy API versions will fail" from 31 Dec 2024. — same URL
- Newer versions coexist (202407 auth overview; 202605 finance) — per-endpoint version drift is normal. — https://partner.tiktokshop.com/docv2/page/authorization-overview-202407 ; https://partner.tiktokshop.com/docv2/page/supplementary-notice-on-api-deprecation-finance-apis
- US API base host: **unverified** (only the global host is quoted in official text read).

---

## 2. Walmart Marketplace (US + walmart.ca / walmart.com.mx)

### 2.1 Public API, self-serve or partner-only, portal
- Portal: **Walmart Developer Portal** — https://developer.walmart.com (US Marketplace docs: https://developer.walmart.com/us-marketplace).
- Sellers: "Generate a Client ID and Client Secret in the Walmart Developer Portal" and call Token API. — https://developer.walmart.com/doc/us/mp/us-mp-onboarding/
- Solution providers (multi-seller apps): submit https://gecrm.my.site.com/channelpartnerprospectform/ ; "approval and application publication process may take between three to five weeks"; then Solution Provider Center + sandbox, implement OAuth 2.0, list on Seller Center App Store, demo for verification. "The Delegated Access method is no longer supported. Moving forward, all approved Solution Providers are expected to use OAuth 2.0." — https://developer.walmart.com/us-marketplace/docs/get-started-as-a-solution-provider
- **EU seller eligibility**: W-8BEN-E pathway supported for sellers incorporated in "China, Hong Kong, the United Kingdom …, Japan, Canada, Mexico, India, Singapore, South Korea, Taiwan, Germany, Vietnam, Thailand, Chile and Turkey"; "For certain COIs, we don't accept COI tax ID and you may have to provide a U.S. tax ID". — https://marketplacelearn.walmart.com/guides/Taxes%20&%20payments/Tax%20information/Tax-classifications-and-documentation . Other requirements: "Business Tax ID(s) or Business License Number (SSN is not accepted)"; "A B2C U.S. warehouse with returns capability" or WFS; disallowed: non-profits, sole proprietorships (except India), HUF. — https://marketplacelearn.walmart.com/guides/Getting%20started/Onboarding/Before-you-start-selling-on-Walmart-Marketplace . **So: UK and Germany explicitly listed; FR/IT/ES/IE not in the published W-8BEN-E list (unverified whether accepted via US tax ID).**
- Verdict: **self-serve for a seller's own keys; partner programme (3–5 weeks) for a multi-seller app.**

### 2.2 Auth mechanism
- Token API: `POST https://marketplace.walmartapis.com/v3/token`; grant types `authorization_code`, `refresh_token`, `client_credentials`; `Authorization: Basic base64(ClientID:ClientSecret)`; `Content-Type: application/x-www-form-urlencoded`; required headers `WM_QOS.CORRELATION_ID`, `WM_SVC.NAME`; `WM_PARTNER.ID` required for authorization_code/refresh_token grants; optional `WM_CONSUMER.CHANNEL.TYPE`. Access token **900 s (15 min)**; refresh token **365 days**. — https://developer.walmart.com/api/us/mp/auth
- OAuth 2.0 seller authorization (solution providers): seller goes to Seller Center → Apps → **Connect**; provider's App Log-in URL receives `walmartCallbackUri` and `clientType` (`seller` US, `seller-ca`, `seller-mx`); provider redirects to `https://login.account.wal-mart.com/authorize` with `responseType=code, clientId, redirectUri, clientType, nonce, state`; callback returns `code, sellerId, clientId, type=auth, state`; exchange at `/v3/token` with `WM_PARTNER.ID = sellerId`, optional `WM_MARKET` (`us` default, `mx`, `ca`). — https://developer.walmart.com/doc/us/mp/us-mp-auth2/ ; https://developer.walmart.com/us-marketplace/docs/oauth-20-authorization
- Delegated Access (seller-generated key for a provider) — creation retired 30 July 2026; existing keys stop end of September 2026; replaced by OAuth 2.0 via App Store Connect. — https://developer.walmart.com/us-marketplace/docs/delegated-access-authorization ; https://developer.walmart.com/doc/us/mp/us-mp-auth/
- Every API call: `WM_SEC.ACCESS_TOKEN`, `WM_QOS.CORRELATION_ID`, `WM_SVC.NAME` (MX docs also show `WM_MARKET: mx`). — https://developer.walmart.com/mx-marketplace/docs/authentication
- No scopes documented. — https://developer.walmart.com/doc/us/mp/us-mp-auth2/
- **Sign in + Allow? YES for approved solution providers** (App Store Connect → login.account.wal-mart.com → code). **KEY-COPY for a seller using its own client credentials** (client_credentials grant).

### 2.3 Multi-account / multi-region
- Markets `us`, `ca`, `mx` via `WM_MARKET` header on the same token endpoint; `clientType` distinguishes at authorization. — https://developer.walmart.com/doc/us/mp/us-mp-auth2/
- "Global Marketplace APIs provide a unified integration framework for sellers and approved Solution Providers operating in Canada, Mexico, and Chile"; "Canada legacy APIs use certificate-based authentication, which is being replaced by OAuth based authentication"; legacy CA/MX/CL users "must migrate". — https://developer.walmart.com/doc/ca/ca-mp/ca-mp-items/ . A Canada announcement titled "Switch to Unified APIs Before July 31,2026" exists but its body now returns "No Data found" — **date unverified**. — https://marketplacelearn.walmart.com/ca/guides/Other%20Topics/Announcements/switch-to-global-apis-now-and-unlock-new-possibilities-
- Additional markets are added from one Seller Center account (flag icon → Set up → AML questionnaire); "You must be invited to view additional markets." — https://marketplacelearn.walmart.com/guides/Getting%20started/Onboarding/global-onboarding-set-up-an-additional-market
- One `sellerId` per authorization; the token is per seller (WM_PARTNER.ID).

### 2.4 API surface (US reference navigation)
Authorization/Token; Advertising (Search Engine Marketing: campaign management, catalog, item diagnostics, reporting); Assortment Recommendations; Claims (Shipment Protection); Disputes; Feeds; Fulfillment (multichannel, Preferred Carriers); Insights (Seller Performance, Listing Quality); Inventory; Items; Lag Time; Notifications; On-Request Reports (+ Report Scheduler); Orders; Payments (+ Tax Form); Payment Reports; Prices; Promotions; Returns/Refunds; Recommendations; Reviews Acceleration; Settings; Ship With Walmart; Simplified Shipping Settings; Utilities; Walmart+ Seller Fulfilled; Simulations. — https://developer.walmart.com/us-marketplace/reference
- Feeds: `POST /v3/feeds?feedType=MP_INVENTORY` (bulk inventory), `feedType=PRICE_AND_PROMOTION` (bulk price), item feeds `MP_ITEM_INTL`, `MP_ITEM_MATCH`, `MP_MAINTENANCE`; 10,000 items/feed, keep <10 MB; feed ID tracks status. — https://developer.walmart.com/us-marketplace/docs/bulk-inventory ; https://developer.walmart.com/us-marketplace/docs/update-bulk-prices ; https://developer.walmart.com/doc/us/mp/items/us-mp-items

### 2.5 Real-time events
- Subscription: `POST /v3/webhooks/subscriptions` with `eventType, eventVersion, resourceName, eventUrl, authDetails{authMethod,…}, headers, status(ACTIVE|INACTIVE)`; destination auth `BASIC_AUTH`, `HMAC` ("HMACSHA256 hashing with clientSecret as the key"), `OAUTH` (Walmart POSTs `grant_type=client_credentials` to your `authUrl`). — https://developer.walmart.com/us-marketplace/reference/createsubscription
- Event types: INVENTORY `INVENTORY_OOS`; ITEM `OFFER_PUBLISHED`, `OFFER_UNPUBLISHED`; ITEMS `SELLER_PERFORMANCE_ALARMS`, `SELLER_PERFORMANCE_REPORT`; ORDER `DRIVER_STATUS`, `INTENT_TO_CANCEL`, `PO_CREATED`, `PO_LINE_AUTOCANCELLED`; PRICE `BUY_BOX_CHANGED`; REPORTS `REPORT_STATUS`; ReturnsAndRefunds `RETURN_CREATED`, `RETURN_DELIVERED`, `RETURN_INVOICED`. — https://developer.walmart.com/us-marketplace/reference/geteventtypes
- Retries: "First retry: 5 minutes later / Second retry: 15 minutes after the first / Third retry: 45 minutes after the second". — https://developer.walmart.com/us-marketplace/docs/subscribe-to-an-event-notification
- Delivery signature (performance webhooks / security guide): headers `WM_SEC.TIMESTAMP`, `WM_SEC.SIGNATURE` (base64 HMAC-SHA256), optional `WM_SEC.KEY_ID`; string-to-sign `<METHOD>\n<PATH_AND_QUERY>\n<WM_SEC.TIMESTAMP>\n<SHA256_HEX_OF_BODY>`; replay window "five minutes with two minutes of allowed skew". — https://developer.walmart.com/us-marketplace/docs/security-and-authenticity

### 2.6 Rate limits
- Token-bucket; headers `x-current-token-count`, `X-Next-Replenishment-Time`; `429` when exhausted; `413` on oversize feeds. Examples: All orders 5000/min; Update inventory 200/min; Item Search 200/min; Create campaign 5/min. — https://developer.walmart.com/us-marketplace/docs/rate-limiting

### 2.7 Sandbox
- Base `https://sandbox.walmartapis.com`; header `WM_SANDBOX: v2` selects the **Dynamic sandbox** (else static); covers Inventory, Items, Orders, Returns/Refunds, Settings; Simulations API `/v1/simulations` to simulate customer orders/returns; "Walmart deletes all Dynamic sandbox data every two days". — https://developer.walmart.com/us-marketplace/docs/dynamic-sandbox
- Sandbox keys are shown on the Developer Portal "API Keys for Production and Sandbox" page. — https://developer.walmart.com/global-marketplace/docs/marketplace-api-sandbox

### 2.8 Versioning / deprecation
- Path-versioned `/v3/...`; webhook subscriptions carry `eventVersion`. — https://developer.walmart.com/us-marketplace/reference/createsubscription
- Delegated Access sunset: creation retired 30 Jul 2026, keys dead end-Sept 2026. — https://developer.walmart.com/us-marketplace/docs/delegated-access-authorization
- CA/MX/CL legacy APIs → Global APIs (date unverified, see 2.3).

---

## 3. Temu (Partner Platform)

### 3.1 Public API, self-serve or partner-only, portal
- Portals: global https://partner.temu.com/ ; US https://partner-us.temu.com/ ; EU https://partner-eu.temu.com/ . Seller-centre logins: US `https://seller.temu.com/login.html`, EU `https://seller-eu.temu.com/login.html`. — https://partner.temu.com/
- Who: "Independent Software Vendors (ISVs)" who "Build apps using Temu's open APIs to provide sellers with solutions", and "Sellers Developing Apps"; also "Researchers". — https://partner.temu.com/ ; https://partner-eu.temu.com/register
- Flow: "Registration → Create an app → Compliance and security assessment → Publish an app", "Each stage may take as little as 1 business day". App categories highlighted: ERP, WMS. — https://partner.temu.com/ ; https://partner-eu.temu.com/documentation?menu_code=85762c6ccc5a4dbc8c023ea5e10c6dc0&sub_menu_code=07f6e09011434c9f80511f8a9e09c8ce
- Verdict: **a real open platform exists for third-party integrators, self-serve registration with a compliance/security assessment gate.**

### 3.2 Auth mechanism
- Three seller-authorization modes: **Manual** ("The user manually authorizes the app in the Seller Center and selects the permissions to be granted … the system directly displays the access_token to the user" → operator copies it); **Callback** ("a code is sent to the app's pre-configured redirect_url … the back end … uses the code to generate an access_token"); **In-app** via `https://seller.temu.com/open-platform/client-manage/authorization?appKey=XXX&redirect_uri=XXX&state=XXX`. Callback returns `app_key, callback_host, code, state`. US local sellers manage at `https://seller.temu.com/open-platform/client-manage`. — https://partner-us.temu.com/documentation?menu_code=38e79b35d2cb463d85619c1c786dd303 ; https://partner.temu.com/documentation?menu_code=38e79b35d2cb463d85619c1c786dd303
- Authorization returns an `apiScopeList` of granted API names. — https://partner.temu.com/documentation?menu_code=fb16b05f7a904765aac4af3a24b87d4a
- Token lifetime, request signature (sign/MD5 vs HMAC), gateway URLs per region: **unverified** (Developer Guide pages beyond the auth section are JS-rendered).
- **Sign in + Allow? MIXED — YES via callback/in-app authorization; KEY-COPY via manual mode.**

### 3.3 Multi-account / multi-region
- Three regional partner portals and seller centres (US / EU / global); EU portal "serves sellers registered in applicable countries or regions" with access points for 25+ European nations. — https://partner.temu.com/ ; https://partner-eu.temu.com/register
- One access token per seller-app authorization; cross-region model beyond that **unverified**.

### 3.4 API surface (from `apiScopeList` names)
Goods `bg.local.goods.add / .list.query / .update`; Order `bg.order.list.get / .detail.get / .amount.query`; Logistics `bg.logistics.shipment.create / .get`, `bg.logistics.companies.get`; After-sales `bg.aftersales.aftersales.list.get`, `bg.aftersales.parentreturnorder.get`; Inventory `bg.local.goods.stock.edit`; Price `bg.local.goods.sku.list.price.query`, `bg.local.goods.priceorder.query`; Category/attributes `bg.local.goods.category.recommend`, `bg.local.goods.property.get`; Messaging `bg.tmc.message.update`. "Add Products API V3.0 is now Live!" — https://partner.temu.com/documentation?menu_code=fb16b05f7a904765aac4af3a24b87d4a ; https://partner-us.temu.com/documentation
- Promotions, advertising, finance/settlements, reports: **unverified**.

### 3.5 Real-time events — `bg.tmc.message.*` suggests a message-centre push model; details **unverified**.
### 3.6 Rate limits / bulk — **unverified**.
### 3.7 Sandbox — **unverified**.
### 3.8 Versioning — API names carry versions (e.g. "Add Products API V3.0"); policy **unverified**.

---

## 4. SHEIN (Open Platform)

### 4.1 Public API, self-serve or partner-only, portal
- Portal: **SHEIN Open Platform / Developer Platform** — https://open.sheincorp.com/ (login https://open.sheincorp.com/login ; docs https://open.sheincorp.com/documents/apidoc/1000001 ; contact openapi@shein.com).
- Five-step workflow: "Open Platform Account Application → Create Application → Applicaiton Review → Authorization Integration → Solution Integration" — review-gated. Serves "sellers who fulfill orders via SHEIN integrated logistics" and "merchants who fulfill stock preparation orders". — https://open.sheincorp.com/
- SHEIN publishes a CLI (`shein-open`) for Open Platform apps: needs "a SHEIN Open Platform developer account and access to an app"; auth modes `open-key` / `app-key`; test stores via `shein-open test-store list/use`. — https://github.com/sheinsight/Shein-Open-CLI
- Verdict: **exists; application + review gate (not open self-serve).**

### 4.2 Auth mechanism
- Merchant authorizes in Seller Hub "App Store → My Authorizations", yielding a `tempToken`; app calls `POST /open-api/auth/get-by-token` (domain `https://openapi.sheincorp.com` or `https://openapi.sheincorp.cn`) with headers `x-lt-appid`, `x-lt-timestamp` (ms, valid 5 min), `x-lt-signature`; response `openKeyId`, `secretKey` ("needs to be decrypted with developer appSecretKey"), `appid`, `supplierId`, `supplierBusinessMode` (POP-US, POP-GLOBAL, SFS…). — https://open.sheincorp.com/documents/apidoc/detail/3001520
- Request signature: VALUE = `OpenKeyId&Timestamp&Path`; KEY = `SecretKey + RandomKey(5 chars)`; `HMAC-SHA256(VALUE, KEY)` → hex → Base64; signature = `RandomKey + Base64`. — same URL
- Token lifetime/rotation: **unverified**.
- **Sign in + Allow? Partially** — merchant grants in Seller Hub App Store and a tempToken is exchanged server-side; whether that is a redirect flow or a copy-token step is **unverified**.

### 4.3 Multi-account / multi-region — `openKeyId` is "Unique identifier for store-application relationship"; business modes POP-US / POP-GLOBAL / SFS; `.com` vs `.cn` domains. — https://open.sheincorp.com/documents/apidoc/detail/3001520
### 4.4 API surface — Product (publish/edit/query/category/attributes), Pricing, Orders (customer & purchase orders, fulfilment), Returns/Refunds, Inventory & Stock, Compliance (certificates, eco-labels), Finance (billing, invoices, statements), Logistics (carriers, tracking callbacks, waybills), Manufacturing (MES). — https://open.sheincorp.com/documents/apidoc/1000001
### 4.5 Events — "tracking callbacks" mentioned; general webhook mechanism **unverified**.
### 4.6 Rate limits — "QPS (single developer): 40 requests per second". — https://open.sheincorp.com/documents/apidoc/detail/3001520
### 4.7 Sandbox — test stores exist (CLI `test-store`). — https://github.com/sheinsight/Shein-Open-CLI
### 4.8 Versioning — **unverified**.

---

## 5. Google Merchant Center (Merchant API)

### 5.1 Public API, self-serve, portal
- Docs: https://developers.google.com/merchant/api . Registration is **mandatory**: "a mandatory, one-time setup process that links your Google Cloud project to your Merchant Center account"; `POST https://merchantapi.googleapis.com/accounts/v1/accounts/{ACCOUNT_ID}/developerRegistration:registerGcp`; unregistered projects get `401`; removing all `API developer` users blocks calls after a 30-day grace. Prereqs: production MC account, verified website, Admin access, Cloud project, Google-account email. — https://developers.google.com/merchant/api/guides/quickstart/registration
- "Using API keys for authentication is not supported". — https://developers.google.com/merchant/api/guides/authorization/overview
- Verdict: **fully self-serve; no partner programme.**

### 5.2 Auth mechanism
- OAuth 2.0 scope `https://www.googleapis.com/auth/content` ("Read/write access"); consent screen shown to the merchant; incremental auth recommended. — https://developers.google.com/merchant/api/guides/authorization/access-client-accounts
- Service accounts: create in API Console, add the service-account email as a user in Merchant Center (Settings → Access and services → Add person), needs **Admin** for settings; "Access tokens expire one hour after they're issued". — https://developers.google.com/merchant/api/guides/authorization/access-your-account
- **Sign in + Allow? YES** (standard Google OAuth consent; refresh token thereafter). Service account is the key-based alternative.

### 5.3 Multi-account
- **Advanced account** (ex-MCA) with client/sub-accounts linked via `accountAggregation`; `accounts.createAndConfigure` creates client accounts; 3P agencies/developers "should create a new, primary Merchant Center Account and request converting it to an advanced account". — https://developers.google.com/merchant/api/guides/accounts/create-accounts ; https://developers.google.com/merchant/api/guides/accounts/relationships
- Notification subscriptions can target one account or `allManagedAccounts: true`. — https://developers.google.com/merchant/api/guides/accounts/notifications

### 5.4 API surface (sub-APIs)
accounts (settings, regions, users, relationships), products / productInputs, inventories (local & regional), data-sources, reports, promotions, reviews, autofeedSettings, notifications, conversion-sources, programs; plus order tracking and issue resolution sub-APIs (May 2025). — https://developers.google.com/merchant/api/overview ; https://developers.google.com/merchant/api/latest-updates
- Products: insert `ProductInput` into a primary **API** data source ("Products can only be inserted, updated or deleted if they belong to data sources of type API"); refresh "at least every 30 days"; few-minutes propagation. — https://developers.google.com/merchant/api/guides/products/add-manage
- Data sources: primary, supplemental (must be linked to primary), local/regional inventory, promotion, product/merchant review; file-based sources support "trigger an immediate fetch". — https://developers.google.com/merchant/api/guides/data-sources/overview
- No orders/fulfilment/returns/settlements/messaging (Google is not a marketplace of record for the merchant here).

### 5.5 Real-time events
- `POST https://merchantapi.googleapis.com/notifications/v1/accounts/{ACCOUNT_ID}/notificationsubscriptions/` with `registeredEvent: "PRODUCT_STATUS_CHANGE"`, `callBackUri`, and `targetAccount` or `allManagedAccounts`. Callback must be public HTTPS with CA-signed cert, accept JSON POST, return 102/200/201/202/204. Payload `{"message":{"data":"<base64>"}}` decoding to `account, managingAccount, resourceType (PRODUCT), attribute (STATUS), changes[{oldValue,newValue,regionCode,reportingContext}], resourceId, resource, eventTime, expirationTime`; reportingContext values include `SHOPPING_ADS, LOCAL_INVENTORY_ADS, YOUTUBE_SHOPPING, YOUTUBE_CHECKOUT, YOUTUBE_AFFILIATE, FREE_LISTINGS_UCP_CHECKOUT`. — https://developers.google.com/merchant/api/guides/accounts/notifications
- Other `NotificationEventType` values, push signature, retry policy: **unverified** (reference page did not render; guide is silent).

### 5.6 Rate limits and bulk
- Quota groups with `quotaLimit` (daily) and `quotaMinuteLimit`; daily quotas reset "12:00 PM midday UTC"; product daily quota "generally set to 2 times the number of offer quota"; check via `POST https://merchantapi.googleapis.com/quota/v1/accounts/{ACCOUNT_ID}/quotas`; HTTP 429 with `quota/request_rate_too_high` or `quota/daily_limit_exceeded`; increases via support form, not guaranteed. — https://developers.google.com/merchant/api/guides/quotas-limits/quotas ; https://developers.google.com/merchant/api/guides/quotas-limits
- **No customBatch**: "use asynchronous calls" / parallel requests / channel pools. — https://developers.google.com/merchant/api/guides/compatibility/overview
- Bulk alternative: file/scheduled-fetch data sources and supplemental sources. — https://developers.google.com/merchant/api/guides/data-sources/overview

### 5.7 Sandbox
- Test accounts: `POST https://merchantapi.googleapis.com/accounts/v1/accounts/{ACCOUNT_ID}:createTestAccount` (`time_zone`, `language_code`); "Data submitted to a test account will never be published"; max 5 per Google Account; same quotas as production; cannot be advanced accounts or link to Ads. — https://developers.google.com/merchant/api/guides/accounts/test-accounts

### 5.8 Versioning / deprecation
- Merchant API v1 GA July 2025; v1beta discontinued 28 Feb 2026; **Content API for Shopping sunset 18 August 2026** (extended access available by application). URL form `https://merchantapi.googleapis.com/{SUB_API}/{VERSION}/{RESOURCE}`. — https://developers.google.com/merchant/api/latest-updates ; https://developers.google.com/merchant/api/guides/compatibility/overview

---

## 6. Meta Commerce (Facebook/Instagram Shops, Commerce Manager, Marketing API catalogs)

### 6.1 Public API, self-serve or partner-only, portal
- Docs index: https://developers.facebook.com/docs/commerce-platform/ (new tree at https://developers.facebook.com/documentation/ads-commerce/commerce-platform/...). Sections: Get Started, API Integration Setup, **Commerce Integration (Platform Partners Only)** (onboarding, catalog, offers, order integration), Catalog & Inventory (Feed API, Batch API), Order Management (Order, Fulfillment, Cancellation/Refund, Returns APIs), Finance Reporting (Payouts, Transactions), Customer Communication. Note in index: "Shops ads now use offsite checkout: buyers discover products on Facebook and Instagram and complete checkout on your website." — https://developers.facebook.com/docs/commerce-platform/
- Order-management (Commerce API) status: "The Commerce API is in a closed, invite-only Beta program. Please work with your Facebook representative to get access"; and "This document will be deprecated on September 4, 2025. On that date, Shops checkout will no longer be available on Facebook and Instagram." — https://developers.facebook.com/docs/commerce-platform/project-guide
- Order API still documents `GET /{cms_id}/commerce_orders`, `GET /{order_id}`, `GET /{order_id}/items`; polling "every 5–15 minutes"; "Facebook does not make API calls to your systems". — https://developers.facebook.com/documentation/ads-commerce/commerce-platform/order-management/order-api ; https://developers.facebook.com/docs/commerce-platform/order-management/integration
- Shops supported countries: full = United States; open beta = Canada, Mexico, **France, Germany, Italy, Spain, United Kingdom**, Australia, Japan, Korea, Taiwan, Thailand; limited = Brazil, Denmark, Netherlands, Norway, Sweden, Switzerland, Ukraine, Indonesia; **Ireland not listed**; "Some features related to Shops and checkout on Facebook and Instagram are no longer supported". — https://www.facebook.com/business/help/549256849084694
- Catalog side is fully self-serve via Marketing API after App Review; `catalog_management` requires App Review, depends on `business_management`, screencast of login + catalog CRUD. — https://developers.facebook.com/docs/permissions
- Verdict: **catalog/Shops (offsite checkout) = self-serve after App Review + Business Verification; on-platform order management = invite-only and effectively sunset outside legacy US checkout.**

### 6.2 Auth mechanism
- **Facebook Login for Business** — "the preferred authentication and authorization solution for tech providers"; two configurations: **Business Integration System User access token** ("defaults to never expire", optional `set_token_expires_in_60_days`) and **User access token** (short-lived). Users "grant your app access to their business assets" (Pages, catalogs, ad accounts, Instagram accounts). — https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
- Token lifetimes: default user/page tokens "short-lived, expiring in hours"; long-lived user token "about 60 days" via `GET oauth/access_token?grant_type=fb_exchange_token`; "Long-lived Page access token do not have an expiration date". — https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- Permissions: `catalog_management` (App Review; dep. `business_management`), `commerce_account_manage_orders`, `commerce_account_read_orders`, `commerce_account_read_reports`, `commerce_account_read_settings`, `business_management` (App Review; dep. `pages_read_engagement`, `pages_show_list`), `instagram_shopping_tag_products`; none marked deprecated. — https://developers.facebook.com/docs/permissions
- App Review: required "If your app will be used by anyone without a Role on the app or a role in a Business that has claimed the app". — https://developers.facebook.com/docs/app-review . Business Verification: required for "Advanced level access to permissions" (since 1 Feb 2023) and for "apps that allow other Businesses to access their own data". — https://developers.facebook.com/docs/development/release/business-verification
- **Sign in + Allow? YES** — Login for Business dialog; with the system-user configuration the resulting token does not expire.

### 6.3 Multi-account model
- Business → assets (Pages, catalogs, ad accounts, IG accounts) selected in the Login-for-Business config; commerce accounts (`cms_id`) own orders; catalogs (`catalog_id`) own items. — https://developers.facebook.com/docs/facebook-login/facebook-login-for-business ; https://developers.facebook.com/documentation/ads-commerce/commerce-platform/order-management/order-api
- Partner onboarding uses business login with `catalog_management`, `commerce_account_manage_orders`, `business_management`; partner track is "Onboarding Integration" (not self-service). — https://developers.facebook.com/documentation/ads-commerce/commerce-platform/partners/onboarding-integration

### 6.4 API surface
- Catalog: `POST /{catalog_id}/items_batch` (`item_type`, `requests` JSON array "no more than 5000 records", `allow_upsert`), `localized_items_batch`, `GET /{catalog_id}/check_batch_request_status`; `/batch` deprecated. — https://developers.facebook.com/docs/marketing-api/catalog-batch ; https://developers.facebook.com/docs/marketing-api/reference/product-catalog/items_batch/
- Feeds: `POST /v25.0/{product-catalog-id}/product_feeds` with `schedule` `{"interval":"DAILY","url":"…","hour":"22"}` (HOURLY/DAILY/WEEKLY), formats .tsv/.xml/zip/gzip/bz2. — https://developers.facebook.com/docs/marketing-api/reference/product-catalog/product_feeds/
- Orders/fulfilment/cancellation/refund/returns, Finance (payouts, transactions), Customer communication — documented but gated (6.1). — https://developers.facebook.com/docs/commerce-platform/
- Advertising: Marketing API (same app/tokens) — out of scope here.

### 6.5 Real-time events
- Webhooks generic: verification `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; signature `X-Hub-Signature-256: sha256=…` over payload with App Secret; retries "immediately, then try a few more times with decreasing frequency over the next 36 hours"; dedupe expected. — https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- `commerce_account` / `commerce_orders` webhook topic: reference page returned HTTP 500 — **unverified**; order docs explicitly recommend polling.

### 6.6 Rate limits
- Marketing/Pages calls with system/page tokens fall under Business Use Case (BUC) limits; catalog management: "Calls within one hour = 20,000 + 20,000 * log2(DA impressions + PDP visits)"; header `X-Business-Use-Case-Usage` (`call_count, total_cputime, total_time, estimated_time_to_regain_access`); app-level "200 * Number of Users". — https://developers.facebook.com/docs/graph-api/overview/rate-limiting
- Batch: per-catalog per-minute limit per "Catalog Batch business use case"; error 80014; ≤5000 items (recommend <3000), ≤28 MB. — https://developers.facebook.com/docs/marketing-api/reference/product-catalog/items_batch/

### 6.7 Sandbox
- "Commerce Test Account Access Form" / sandbox commerce account for order flows; test commerce account onboarding step. — https://developers.facebook.com/docs/commerce-platform/project-guide ; https://developers.facebook.com/docs/commerce-platform/order-management/integration
- Catalog side: no separate sandbox (use a test catalog in a real Business) — **unverified**.

### 6.8 Versioning
- Graph API versions live "at least 2 years"; expire 2 years after the next version's release; expired calls route to the oldest usable version. Current v26.0 released 29 Jul 2026; v25.0 18 Feb 2026 (until 29 Jul 2028); v24.0 8 Oct 2025 (until 18 Feb 2028). — https://developers.facebook.com/docs/graph-api/guides/versioning ; https://developers.facebook.com/docs/graph-api/changelog

---

## Comparison table

| Channel | Self-serve API? | Auth style | True OAuth "sign in + Allow"? | Region model | Events model | Sandbox | EU seller eligible? |
|---|---|---|---|---|---|---|---|
| **TikTok Shop** | Yes (register + create app); public apps review-gated per market, "3+ weeks" for US/UK compliance ([dev guide](https://partner.tiktokshop.com/docv2/page/tts-developer-guide)) | Redirect → `auth_code` (30 min) → `token/get` (`grant_type=authorized_code`); access 7 d, refresh rotates ([auth](https://partner.tiktokshop.com/docv2/page/authorization-overview-202407)); every call signed with app_secret (`sign`, `timestamp`, `app_key`, `x-tts-access-token`) — exact recipe unverified | **YES** | US vs ROW auth hosts; one auth → many shops via `shop_cipher` ([shops](https://partner.tiktokshop.com/docv2/page/6507ead7b99d5302be949ba9)) | 16 webhook topics; `Authorization` = HMAC-SHA256(app_key+body, app_secret) hex; retries undocumented ([webhooks](https://partner.tiktokshop.com/docv2/page/tts-webhooks-overview)) | Development Shop sandbox ([overview](https://partner.tiktokshop.com/docv2/page/app-development-overview)) | **Yes** — DE/FR/IT/ES/IE/UK + AT/BE/NL/PL ([newsroom](https://newsroom.tiktok.com/tiktok-shop-expands-across-europe?lang=en-150)) |
| **Walmart Marketplace** | Seller keys self-serve; multi-seller app = approved Solution Provider (3–5 weeks) ([SP](https://developer.walmart.com/us-marketplace/docs/get-started-as-a-solution-provider)) | OAuth 2.0 at `/v3/token` (client_credentials / authorization_code / refresh_token); access 15 min, refresh 1 yr; `WM_SEC.ACCESS_TOKEN`, `WM_QOS.CORRELATION_ID`, `WM_SVC.NAME`, `WM_PARTNER.ID`, `WM_MARKET` ([token](https://developer.walmart.com/api/us/mp/auth)) | **YES** for Solution Providers via App Store Connect ([oauth](https://developer.walmart.com/doc/us/mp/us-mp-auth2/)); key-copy otherwise; delegated keys die Sept 2026 | US/CA/MX via `WM_MARKET`/`clientType`; CA/MX/CL on Global APIs ([CA](https://developer.walmart.com/doc/ca/ca-mp/ca-mp-items/)) | `/v3/webhooks/subscriptions`, 15 event types, retries 5/15/45 min, HMAC-SHA256 `WM_SEC.SIGNATURE` ([events](https://developer.walmart.com/us-marketplace/reference/geteventtypes)) | `sandbox.walmartapis.com` + `WM_SANDBOX: v2`, Simulations API, purge every 2 days ([sandbox](https://developer.walmart.com/us-marketplace/docs/dynamic-sandbox)) | **UK + Germany listed** for W-8BEN-E; FR/IT/ES/IE not listed; US return warehouse mandatory ([tax](https://marketplacelearn.walmart.com/guides/Taxes%20&%20payments/Tax%20information/Tax-classifications-and-documentation)) |
| **Temu** | Yes — Partner Platform for ISVs, with compliance & security assessment ([portal](https://partner.temu.com/)) | Seller authorizes in Seller Center; manual (token shown to copy), callback (`code` → access_token) or in-app URL ([guide](https://partner-us.temu.com/documentation?menu_code=38e79b35d2cb463d85619c1c786dd303)); signature/lifetime unverified | **MIXED** (callback/in-app yes; manual = key-copy) | Separate US / EU / global portals and seller centres ([EU](https://partner-eu.temu.com/register)) | `bg.tmc.message.*` message centre — details unverified | unverified | **Yes** — EU portal for sellers in 25+ EU countries ([EU](https://partner-eu.temu.com/register)) |
| **SHEIN** | Exists, but "Applicaiton Review" gate ([portal](https://open.sheincorp.com/)) | Seller Hub App Store grant → `tempToken` → `/open-api/auth/get-by-token` → `openKeyId` + encrypted `secretKey`; per-call `x-lt-signature` = RandomKey + Base64(hex(HMAC-SHA256)) ([auth](https://open.sheincorp.com/documents/apidoc/detail/3001520)) | Partial / unverified (grant happens in Seller Hub; redirect vs token copy unconfirmed) | `openKeyId` per store-app; POP-US / POP-GLOBAL / SFS modes; `.com`/`.cn` domains | unverified (tracking callbacks only) | Test stores via official CLI ([CLI](https://github.com/sheinsight/Shein-Open-CLI)) | unverified |
| **Google Merchant Center** | Yes, fully self-serve; mandatory developer registration ([reg](https://developers.google.com/merchant/api/guides/quickstart/registration)) | OAuth 2.0 scope `https://www.googleapis.com/auth/content`; or service account added as MC user ([scope](https://developers.google.com/merchant/api/guides/authorization/access-client-accounts)) | **YES** | Advanced account + sub-accounts (`accountAggregation`, `createAndConfigure`) ([accounts](https://developers.google.com/merchant/api/guides/accounts/create-accounts)) | Notifications API push to HTTPS callback (`PRODUCT_STATUS_CHANGE`), per account or all managed ([notif](https://developers.google.com/merchant/api/guides/accounts/notifications)) | Test accounts via `createTestAccount` (max 5) ([test](https://developers.google.com/merchant/api/guides/accounts/test-accounts)) | **Yes** (global product) |
| **Meta Commerce** | Catalog/Shops: self-serve after App Review + Business Verification; on-platform orders: invite-only, checkout sunset 4 Sep 2025 ([guide](https://developers.facebook.com/docs/commerce-platform/project-guide)) | Facebook Login for Business; system-user tokens never expire, user tokens 60 d long-lived ([FLB](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)) | **YES** | Business → Pages/catalogs/IG assets → commerce accounts ([FLB](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)) | Graph webhooks `X-Hub-Signature-256`, 36 h retries ([webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)); commerce_orders topic unverified; orders = polling | Test commerce account by form ([guide](https://developers.facebook.com/docs/commerce-platform/project-guide)) | **Yes (open beta)** for DE/FR/IT/ES/UK; IE not listed ([countries](https://www.facebook.com/business/help/549256849084694)) |

### Unverified items (could not be read from official pages)
- TikTok: exact `sign` algorithm steps; US API base host; sandbox URL; retry policy for webhooks; bulk/feed mechanism.
- Walmart: Canada "July 31, 2026" unified-API deadline (page body deleted); acceptance of FR/IT/ES/IE-incorporated sellers.
- Temu: gateway URLs, request signature, token lifetime, webhooks, sandbox, rate limits, versioning.
- SHEIN: token lifetime, webhooks, versioning, EU eligibility, whether the grant is a redirect.
- Google: full `NotificationEventType` enum, push authentication/retries.
- Meta: `commerce_account`/`commerce_orders` webhook fields (HTTP 500), catalog-side sandbox.
