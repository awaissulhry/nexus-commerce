# R5 — EU marketplace connectors for a PIM (seller based in IT, selling IT/DE/FR/ES/UK)

Researched 2026-08-29 against official developer/partner documentation only. Every fact carries its URL. "unverified" = could not be confirmed from an official page in this session (third-party help centres may say otherwise; they are named but not relied on). No licensing/pricing discussion.

Key question answered per marketplace: **can an operator connect with "sign in + Allow" (true OAuth consent), or must they copy a key?**

---

## 1. OTTO Market (otto.de)

**1. Public API / access model.** Yes, public. Portal: https://api.otto.market/docs/ . Two consumer groups: "Service Partners: develop integrations and consume APIs on behalf of Sellers" and "Sellers: consume APIs on their own behalf" (https://api.otto.market/docs/). Sellers are fully self-serve: log in to OTTO Partner Connect https://portal.otto.market/ , assign yourself the user right "API-Zugriff", open the API access section, "Neue App erstellen", pick scopes → client ID + client secret; "The client secret for the app is displayed only once" (https://api.otto.market/docs/sellers-integration/). Service partners (a PIM vendor serving many sellers) register via servicepartner.otto.market → developer access to OPC; 30 days sandbox access, then a self-disclosure form for unlimited sandbox (https://api.otto.market/docs/sp-integration/).

**2. Auth.** OAuth 2.0, token endpoint `https://api.otto.market/v1/token` (https://api.otto.market/docs/about-the-api/api-guides/).
- Seller self-app: `grant_type=client_credentials`, `client_id`, `client_secret`, `scope=orders products …`; `expires_in: 1800` (30 min); scopes: products, orders, receipts, returns, price-reduction, shipments, shipping-profiles, availability, returns-warehouse-read, returns-warehouse-write, advertising-services (https://api.otto.market/docs/sellers-integration/).
- Service-partner app: **authorization-code flow** — seller is sent to `https://sandbox.api.otto.market/oauth2/auth?response_type=code&client_id={CLIENT_ID}&redirect_uri={YOUR_REDIRECT_URI}&scope=installation%20partnerId` (live host `api.otto.market`), code is exchanged at the token endpoint, then `GET /v1/apps/{appId}/installation` returns the installation, and the partner obtains an "installation access token" via client credentials with `scope=developer`; access token `expires_in: 1800` (https://api.otto.market/docs/sp-integration/). Refresh-token lifetime for the code flow: unverified.
- **Sign in + Allow? YES for a registered Service Partner app (seller installs/consents in OPC). Key-copy for a seller self-app.** Least-friction key path: https://portal.otto.market/ → API-Zugriff → Neue App erstellen (choose Sandbox or Live) → paste client id/secret; test call = token request then any scoped GET (e.g. Orders).

**3. Multi-account / multi-country.** OTTO Market docs expose no country/marketplace parameter; the platform is otto.de (Germany). One app per seller account; a Service Partner app is installed per seller ("installation") (https://api.otto.market/docs/sp-integration/). Countries beyond DE: unverified (none documented).

**4. API surface (functional interfaces, https://api.otto.market/docs/category/functional-interfaces).** Products (product data incl. categories/attributes; "Products v4 will be supported until 10.12.2025" per changelog), Availability (SKU→shipping profile), Shipping Profiles, Orders V4, Shipments, Returns V3, ReturnShipments, Returns Warehouse, Price-Reductions, Receipts V3 (customer receipts/billing), Sponsored Product Ads, Sponsored Product Ads Reporting V1 (90-day max) (https://api.otto.market/docs/changelog). Not documented: promotions, customer messaging, settlements/payouts beyond Receipts, quality/performance.

**5. Real-time events.** No webhook/push interface is listed anywhere in the functional-interface index or changelog (https://api.otto.market/docs/category/functional-interfaces , https://api.otto.market/docs/changelog). Async writes return `202 Accepted` with a task object (`state: pending`, `pingAfter`, `progress`, `total`, links self/failed/succeeded) to poll (https://api.otto.market/docs/about-the-api/api-guides/).

**6. Rate limits / bulk.** "1200 requests per minute for each partner"; token endpoint "10 per second for each IP" and "100 per second for each service partner"; per-partner-id throttling "20 requests per second"; 429 on excess; limit status exposed in HTTP headers (names not enumerated). Bulk = the 202/async task pattern above (https://api.otto.market/docs/about-the-api/api-guides/).

**7. Sandbox.** `https://sandbox.api.otto.market`; create a Sandbox App under API-Zugriff (sellers) or via the Service Partner Program "Sandbox Apps" permission; fully separate login/keys; reset first Sunday of each month 18–22h; test-order generator endpoint; SPA changes auto-accepted (https://api.otto.market/docs/about-the-api/sandbox/).

**8. Versioning.** Major version in URL path; breaking changes only in new majors; old version offline "6 months from the time of public announcement"; `Sunset` header carries the date (https://api.otto.market/docs/about-the-api/api-guides/). Example: Products v4 supported until 10.12.2025 (https://api.otto.market/docs/changelog).

---

## 2. Zalando — zDirect (Partner Program) and Connected Retail

**1. Public API / access model.** zDirect Platform APIs: https://developers.merchants.zalando.com/ . Access is invitation-based: "Developers are granted access to the zDirect Portal when they are invited by a company or brand to develop on their behalf" (https://developers.merchants.zalando.com/). Roles: "Fashion Partners" (brands selling on Zalando) and "Technical Partners" ("Internal or external developers who integrate on behalf of Fashion Partners"); "A single app may be used by multiple Merchants associated with the same Fashion Partner, but not by multiple Fashion Partners" (https://developers.merchants.zalando.com/docs/partners-and-merchants.html). So a PIM vendor needs one app per Fashion Partner (customer), created after that partner invites the vendor. Connected Retail (store-stock model) is a separate product: docs https://docs.partner-solutions.zalan.do/ ; credentials come from "assigned Onboarding Manager" or partner-care@zalando.de (https://docs.partner-solutions.zalan.do/en/fci/index.html).

**2. Auth.** OAuth 2.0 client credentials. `POST https://api.merchants.zalando.com/auth/token` (sandbox `https://api-sandbox.merchants.zalando.com`), HTTP Basic `client_id:client_secret`, body `grant_type=client_credentials&scope=access_token_only`; response `expires_in: 7200`; no refresh token (https://developers.merchants.zalando.com/docs/requesting-access-token.html , https://developers.merchants.zalando.com/docs/openapi/specs/authentication.json — grant enum also lists `password`). App = OAuth client, created as **developer-admin** at https://zdirect.zalando.com/applications → "Create Application" → select Fashion Partner + Merchants → per-service access (scopes); apps start in sandbox mode, toggle "Production Mode" (https://developers.merchants.zalando.com/docs/dev-portal-app-management.html , https://developers.merchants.zalando.com/docs/auth.html).
**Sign in + Allow? NO — key-copy** (client id/secret pasted). Least-friction path: deep link https://zdirect.zalando.com/applications ; test call = token request then `GET sales-channels?merchant_ids=…`.
Connected Retail: API key (`x-api-key` header or Basic), issued by Zalando; webhooks authenticated with the same key (https://docs.partner-solutions.zalan.do/en/oea/getting-started.html).

**3. Multi-country.** "Sales channels define regions where Zalando products are offered for sale through Zalando Fashion Stores (such as zalando.de, zalando.co.uk)"; "Sales channels usually correspond to countries"; 33 sales-channel IDs; `GET sales-channels?merchant_ids={…}` (https://developers.merchants.zalando.com/docs/sales-channels.html). A Fashion Partner may have several Merchants (e.g. legal entities per country) served by one app (https://developers.merchants.zalando.com/docs/partners-and-merchants.html). One credential per Fashion Partner app, countries selected per request via sales-channel ID.

**4. API surface** (https://developers.merchants.zalando.com/ , https://developers.merchants.zalando.com/docs/): Authentication; Products, Product Attributes, Product Onboarding, Product Submissions, Product Status Report (product-data submission is separate from offers); Prices, Price Reporting; Stocks; Article Availability (offer blocking); Article Requirements; Sales Channels; Logistic Centers; Orders (getting, exporting, shipping, splitting, returns updates); ZFS (fulfilment: shipping notices, item quantities, stock locations/movements, cross-border, intra-community); ZRS/ZSS shipping documents; ZRS customer returned items; Direct Data Sharing credentials. Not documented as APIs: invoices/settlements, promotions, advertising, messaging, quality.

**5. Real-time events.** zDirect: no webhook/notification page exists in the documentation navigation (https://developers.merchants.zalando.com/docs/) — poll Orders. Connected Retail OEA: Zalando POSTs order events (assigned/fulfilled/cancelled) to the partner's HTTPS webhook; must answer HTTP 200 within 10 s or the event is re-queued; API-key header verification (https://docs.partner-solutions.zalan.do/en/oea/getting-started.html).

**6. Rate limits / bulk.** "Each API has its own policy for rate limiting" — e.g. Product Attributes "1000 requests per minute", Product Submissions "25 calls per second"; 429 with `Retry-After` and `X-Rate-Limit` headers (https://developers.merchants.zalando.com/docs/rate-limiting.html). Bulk: Product Submissions API (batch product data), Orders "Exporting Orders" guide; Connected Retail FCI ingests stock/price as a CSV file via REST `PUT` (https://docs.partner-solutions.zalan.do/en/fci/index.html).

**7. Sandbox.** `https://api-sandbox.merchants.zalando.com`; "All apps are set to sandbox mode by default"; "data written to most sandbox APIs is not persisted or propagated"; new tokens required after switching modes (https://developers.merchants.zalando.com/docs/sandbox-testing.html).

**8. Versioning.** Only the Direct Data Sharing policy is published: semver; previous major kept "one month" after a new major; deprecated datasets kept "two months" (https://developers.merchants.zalando.com/docs/direct-data-sharing-versioning-and-deprecation-policy.html). REST API deprecation cadence: unverified.

---

## 3. Kaufland Global Marketplace (kaufland.de/.at/.cz/.sk/.pl/.fr/.it/.es/.nl)

**1. Public API / access model.** Public, self-serve: https://sellerapi.kaufland.com/ ("Marketplace Seller API 2.0", REST + OpenAPI). Keys are generated by the seller "on your API settings page" https://sellerportal.kaufland.de/settings/api (https://sellerapi.kaufland.com/?page=rest-api). Kaufland also lists "more than 130 software and middleware providers" and an "open API" as onboarding options (https://www.kauflandglobalmarketplace.com/en/).

**2. Auth.** HMAC request signing. Headers: `Shop-Client-Key` (the Client Key), `Shop-Timestamp` (Unix seconds; accepted "5 minutes earlier or 5 minutes later than the current server time"), `Shop-Signature` = "SHA-256 HMAC in base64 encoding" over `METHOD\nFULL_URI\nBODY\nTIMESTAMP` using the Secret Key; `User-Agent` must name the software or "Inhouse_development"; `Accept: application/json` (https://sellerapi.kaufland.com/?page=rest-api). "the Secret Key is always a string that just happens to look like a hexadecimal number. Do not interpret it as a hex value" (https://sellerapi.kaufland.com/?page=rest-api#signing-requests); body signed byte-for-byte; empty body = two consecutive `\n` (https://sellerapi.kaufland.com/?page=signature-calculator).
**Sign in + Allow? NO — key-copy** (client key + secret key). Least-friction path: deep link https://sellerportal.kaufland.de/settings/api ; validation: secret is hex-looking string (exact length unverified); test call `GET /v2/info/storefront` (lists allowed storefronts) (https://sellerapi.kaufland.com/?page=rest-api).

**3. Multi-country.** One registration covers nine storefronts: "Austria – Kaufland.at, Czech Republic – Kaufland.cz, France – Kaufland.fr, Germany – Kaufland.de, Italy – Kaufland.it, Poland – Kaufland.pl, Slovakia – Kaufland.sk, Spain – Kaufland.es, The Netherlands – Kaufland.nl" (https://www.kauflandglobalmarketplace.com/en/). One key pair; the `storefront` query parameter selects the country, enum `de, cz, sk, pl, at, fr, it, es, nl` (OpenAPI 2.41.0, https://sellerapi-playground.kaufland.com/swagger.json). Note: Kaufland's own FAQ list is the official real.de successor (see §12).

**4. API surface.** Base `https://sellerapi.kaufland.com/v2/`. Path groups (swagger): `/products`, `/units` (Kaufland's term for offers: "we call inventory data for a single product a unit or sometimes an offer" — https://sellerapi.kaufland.com/?page=overview), `/categories`, `/orders`, `/order-units`, `/returns`, `/return-units`, `/shipping-labels`, `/shipping-groups`, `/shipping-addresses`, `/warehouses`, `/tickets` (customer/buyer communication), `/subscriptions`, `/import-files` (CSV), `/vouchers`, `/commission-rates`, `/vat-rates`, `/assortment-coverage`, `/info` (https://sellerapi-playground.kaufland.com/swagger.json). Guide sections: Managing Product Data, Variant Suggestions, Inventory, Orders, Order Invoices, Tickets, Returns, Reports, Vouchers, Kaufland Shipment Solutions, Assortment Insight, Commission Rates (https://sellerapi.kaufland.com/?page=rest-api#signing-requests nav). No advertising or settlement/payout API documented (unverified).

**5. Real-time events.** Yes — push notifications. `POST /subscriptions/?storefront=…` with `callback_url` (≤255 chars), `fallback_email`, `event_name`. Events: `order_new, order_unit_new, order_unit_status_changed, item_changed, category_changed, return_new, return_status_changed, return_unit_status_changed, item_unit_new, item_unit_changed, item_unit_deleted, item_unit_out_of_stock, item_unit_not_available, item_unit_available, buy_box_changed`. Callback POST carries `Shop-Timestamp` + `Shop-Signature` "generated using your key_secret, with the same function that you use to sign your API requests"; body has `event_name, id_message, resource, storefront` (+ `payload` for item_unit events). Must answer 200/201/202/204 within 5 s; retries "at increasing intervals for about 12 hours" (1 min, then 15/30/60 min); subscription disabled + email after 12 h; URL verification request has 15 s timeout (https://sellerapi.kaufland.com/?page=push-notifications).

**6. Rate limits / bulk.** "The rate limit is 111 requests per seller per second", counted "across all endpoints", HTTP 429; no limit headers documented (https://sellerapi.kaufland.com/?page=rate-limits). Bulk: CSV file interface for product data, inventory and order data, plus `/import-files` endpoint (https://sellerapi.kaufland.com/?page=csv-files ; swagger).

**7. Sandbox.** "Playground": "an isolated environment designed to help the users test and interact with the API without affecting production data"; OpenAPI at https://sellerapi-playground.kaufland.com/swagger.json ; same production Client/Secret key; obfuscated data synced every two weeks; subset of endpoints; `POST /playground/orders` creates test orders (https://sellerapi.kaufland.com/?page=playground). Kaufland warns the "Try it out" buttons in the main docs hit **live** data (https://sellerapi.kaufland.com/?page=endpoints).

**8. Versioning.** v2 in the path; OpenAPI `info.version` "2.41.0" (https://sellerapi-playground.kaufland.com/swagger.json); a Release Notes page exists in the nav; fixed deprecation cadence: unverified.

---

## 4. bol.com — Retailer API (v10, v11 per resource)

**1. Public API / access model.** Public, self-serve: https://api.bol.com/retailer/public/Retailer-API/ . Credentials: Seller Dashboard → Settings → Services → API Settings → fill technical contact → "API Credentials for the Retailer API" → Client ID + Client Secret (https://api.bol.com/retailer/public/Retailer-API/authentication.html).

**2. Auth.** OAuth 2.0 client credentials, JWT bearer. `POST https://login.bol.com/token` with `Authorization: Basic base64(clientId:clientSecret)`, `grant_type=client_credentials`; `expires_in: 299`; "Please do not request a new token for each request" (IP blocking risk) (https://api.bol.com/retailer/public/Retailer-API/authentication.html).
**Sign in + Allow? NO — key-copy.** Least-friction path: Seller Dashboard → Settings → Services → API Settings (no public deep-link documented); test call = token, then e.g. `GET /retailer/orders` against production or the demo base.

**3. Multi-country.** NL + BE in one retailer account: offers carry `countryAvailabilities` with `countryCode` `NL` / `BE` (https://api.bol.com/retailer/public/Retailer-API/v11/functional/offer-api/offer-api-use-case-guide.html); `Accept-Language` `nl` / `fr-BE` (https://api.bol.com/retailer/public/Retailer-API/demo/v10-PRODUCTS.html).

**4. API surface** (https://api.bol.com/retailer/public/Retailer-API/ , https://api.bol.com/retailer/public/Retailer-API/versioning-per-resource.html): Offers v11; Orders & Shipments v10; Returns; Shipping Labels; Inventory & Replenishments (FBB); Invoices; Promotions; Insights & performance indicators; Commissions v10; Subscriptions v11; Process Status (shared); Retailer Information v10 (v11 beta); Product Content API v10 (supplier/content: product data + assets); Advertising API v11 (Sponsored Products campaigns/reporting). Messaging/customer communication: not in the index (unverified).

**5. Real-time events.** Subscriptions API v11: delivery via webhooks, GCP Pub/Sub or AWS SQS; event types: PROCESS_STATUS `SUCCESS/FAILURE/TIMEOUT`, SHIPMENT `UPDATE_TRANSPORT_EVENT`, ORDER `ORDER_CREATED`, `ORDER_ITEM_CANCELLATION_REQUEST`, PRICE_STAR_BOUNDARY `CHANGE`, COMPETING_OFFER `CHANGE`, OFFERS `FOR_SALE` / `NOT_FOR_SALE` (https://api.bol.com/retailer/public/Retailer-API/v11/functional/subscriptions-api/supported-event-types.html). Payload signed `Signature: keyId=0, algorithm="rsa-sha256", signature=<SIG>` with public keys from the signature-keys endpoint; at-least-once; 10 attempts over 10 minutes with exponential backoff, auto-disabled after 10 failures; "send test push notification" endpoint (https://api.bol.com/retailer/public/Retailer-API/v11/functional/subscriptions-api/subscriptions.html). All writes are async: process status `PENDING/SUCCESS/FAILURE/TIMEOUT`, kept 1 day, single/bulk/entity lookups, internal retry every 5 min ×5 (https://api.bol.com/retailer/public/Retailer-API/v10/functional/shared-api/process-status.html).

**6. Rate limits / bulk.** Machine-readable limits at https://api.bol.com/retailer/public/ratelimits (`maxCapacity`/`timeToLive`/`timeUnit`): e.g. Offers POST 50/s, Offers GET 25/s, Orders list 25/min, Shipments list 25/min, Process-status POST 2/s, Subscriptions 10/s, Signature keys 10/h, Inventory GET 20/min. Every response carries budget headers ("varying capitalizations per endpoint"); 429s are monitored (https://api.bol.com/retailer/public/Retailer-API/ratelimits.html). Bulk: `POST /retailer/offers/export` → process status → `GET /retailer/offers/export/{id}` CSV; same file for 15 min; expires after 14 days (https://api.bol.com/retailer/public/Retailer-API/v10/functional/retailer-api/offers.html).

**7. Sandbox.** Demo environment `https://api.bol.com/retailer-demo/`, same credentials as production, "Hard coded examples for every endpoint", mocked process status, one generic rate limit, no end-to-end flows (https://api.bol.com/retailer/public/Retailer-API/demo/demo.html , https://api.bol.com/retailer/public/Retailer-API/demo/v10-PRODUCTS.html).

**8. Versioning.** Version in each endpoint URL, per resource; "the previous version is marked as Deprecated and scheduled for removal in 12 months"; releases are "dynamically adapted" (no fixed cadence); beta program (https://api.bol.com/retailer/public/Retailer-API/api-lifecycle.html , https://api.bol.com/retailer/public/Retailer-API/versioning-per-resource.html).

---

## 5. Allegro (allegro.pl / .cz / .sk / .hu)

**1. Public API / access model.** Public, self-serve: https://developer.allegro.pl/ . Register apps at https://apps.developer.allegro.pl/ (production requires an Allegro account with 2FA; max 5 application keys per account; redirect URIs) → Client_ID + Client_Secret (https://developer.allegro.pl/auth/).

**2. Auth.** OAuth 2.0 with four methods: **Authorization Code** (user redirected to Allegro to log in and consent), **Device flow**, Client Credentials (public data only), Dynamic Client Registration (`https://api.allegro.pl/register`). Endpoints `https://allegro.pl/auth/oauth/authorize`, `https://allegro.pl/auth/oauth/token`, `https://allegro.pl/auth/oauth/device`. Access token 12 h; refresh token 3 months, single-use with a 60-second overlap; auth code valid 10 s; PKCE S256 supported; 27 scopes such as `allegro:api:sale:offers:read/write`, `allegro:api:orders:read/write`, `allegro:api:messaging`, `allegro:api:billing:read` (https://developer.allegro.pl/auth/).
**Sign in + Allow? YES — true OAuth** (authorization code with consent, or device flow for headless setups).

**3. Multi-country.** One account, one token for all markets: each account has a `baseMarketplace.id` (from `GET /me`); `GET /marketplaces` lists markets, delivery countries and currencies; offers are exposed to allegro.cz/.sk/.hu via `marketplaceId` with prices in each marketplace's base currency (CZK for CZ, etc.), after qualification (product-catalog link, shipping to the country, translation) (https://developer.allegro.pl/tutorials/wystawianie-i-zarzadzanie-oferta-w-serwisach-zagranicznych-wwzjP4M8gTZ). Orders carry `marketplace.id` (https://developer.allegro.pl/tutorials/jak-obslugiwac-zamowienia-GRaj0qyvwtR).

**4. API surface** (https://developer.allegro.pl/documentation): Offer (offers, product catalog, categories/parameters, images, translations, batch commands, automatic pricing, tags, tax settings, rebates, bundles, badge campaigns, pricing programs, ratings, classifieds); Orders ("order management, payments, post purchase issues, shipment management, customer returns, and commission refunds"); Sale settings (after-sale services, delivery, size tables, points of service, responsible persons/producers); One Fulfillment; Affiliate; Others ("information about user, information about marketplaces, message center, billing, auctions and bidding, charity"). Advertising (Allegro Ads) API: unverified.

**5. Real-time events.** No webhooks: "No, we do not support webhooks currently." — Allegro collaborator, 2024-08-08 (https://api.github.com/repos/allegro/allegro-api/issues/9624/comments). Poll `GET /order/events` (`from={last_seen_event_id}`, `limit` 1–1000, default 100 oldest; types BOUGHT, FILLED_IN, READY_FOR_PROCESSING, BUYER_CANCELLED, FULFILLMENT_STATUS_CHANGED, AUTO_CANCELLED; last 60 days) and `GET /order/event-stats` (https://developer.allegro.pl/tutorials/jak-obslugiwac-zamowienia-GRaj0qyvwtR). `GET /sale/offer-events` keeps the last 24 h of offer events (OFFER_ACTIVATED, OFFER_CHANGED, OFFER_STOCK_CHANGED, OFFER_PRICE_CHANGED, OFFER_ENDED, OFFER_ARCHIVED, OFFER_BID_PLACED, OFFER_BID_CANCELED, OFFER_TRANSLATION_UPDATED, OFFER_VISIBILITY_CHANGED, OFFER_DELIVERY_COUNTRIES_BLOCKED; `from`, `limit` ≤1000, `type`) (https://developer.allegro.pl/my_offers , https://developer.allegro.pl/news/get-sale-offer-events-dodalismy-nowa-tablice-w-odpowiedzi-dla-typu-zdarzenia-offer_delivery_countries_blocked-k1zjobxlnIV).

**6. Rate limits / bulk.** "9000 queries per minute" per Client ID; 429 + temporary block (https://developer.allegro.pl/about). Bulk: `PUT /sale/offer-price-change-commands/{id}` and `/sale/offer-quantity-change-commands/{id}` (up to 1000 offers per command), `PUT /sale/offer-modification-commands/{id}` (one element type per request), `POST /sale/offer-bulk-modification-commands` (25 modifications per request); status via `GET …-commands/{id}` and `/tasks`. No CSV mechanism (https://developer.allegro.pl/my_offers).

**7. Sandbox.** `https://api.allegro.pl.allegrosandbox.pl`, app registration `https://apps.developer.allegro.pl.allegrosandbox.pl`, UI `https://allegro.pl.allegrosandbox.pl/` (no 2FA needed) (https://developer.allegro.pl/about , https://developer.allegro.pl/auth/).

**8. Versioning.** Media-type versioning `application/vnd.allegro.public.v1+json` (beta: `application/vnd.allegro.beta.v1+json`, may break) (https://developer.allegro.pl/about). Deprecations are announced per resource in the news feed with a removal date (e.g. `/sale/disputes` removed 7 Jan 2026 — https://developer.allegro.pl/news/7-stycznia-2026-usuniemy-zasoby-na-sciezce-sale-disputes-do-zarzadzania-dyskusjami-b27OwYoEdCV ; Allegro Prices endpoints removed 25 May 2026 — https://developer.allegro.pl/news/allegro-ceny-zmiany-w-obsludze-scopeow-zl7RXyGO2sA). A fixed minimum notice period: unverified.

---

## 6. Cdiscount — via Octopia REST API (not Mirakl)

**1. Public API / access model.** Cdiscount sellers integrate through the Octopia REST API (Octopia = Cdiscount subsidiary created 2021, "More than 50 marketplaces, 10,000 sellers and 160 partners" — https://octopia.com/about-us/). Docs: https://developer.octopia-io.net/ . The legacy Cdiscount SOAP API "is permanently decommissioned and no longer accessible… All SOAP methods have been replaced by their REST equivalents" (https://developer.octopia-io.net/migration/1-general-information/). Connection methods: A feed aggregator, B integration partner (`clientId`, `clientSecret`, `sellerId`), C self-development, D integrator/aggregator registration (https://developer.octopia-io.net/getting-started/ , https://developer.octopia-io.net/aggregator-registration/). Credentials are managed on the "API Credentials Management page" where a seller can "Create my clientId and clientSecret" or link an aggregator's clientId (https://developer.octopia-io.net/user-guides/getting-started/ , https://developer.octopia-io.net/user-guides/api-credentials/) — self-serve for the seller; an integrator registers as aggregator. **Mirakl: no official Octopia/Cdiscount page mentions Mirakl** (https://octopia.com/about-us/ , https://marketplace.cdiscount.com/en/service/octopia/); the "Cdiscount runs on Mirakl" claim appears only in third-party blogs → unverified. Integration target is the Octopia API, not the Mirakl seller API.

**2. Auth.** OAuth 2.0 client credentials: `POST https://auth.octopia-io.net/auth/realms/maas/protocol/openid-connect/token` with `client_id`, `client_secret`, `grant_type=client_credentials`; response includes `access_token`, `expires_in`, `refresh_token`, `refresh_expires_in` (https://developer.octopia-io.net/migration/2-managing-authentication/); "Your token is available for 2h" and "You do not need a new token for every api call"; every call needs `Authorization: Bearer` plus a `SellerId` header (https://developer.octopia-io.net/user-guides/getting-started/ , https://developer.octopia-io.net/getting-started/).
**Sign in + Allow? NO — key-copy** (clientId/clientSecret + sellerId). Least-friction: API Credentials Management page in the seller portal (Seller Zone) — exact deep link unverified; test call `GET …/seller/v2/` seller information.

**3. Multi-country.** Cdiscount is a French storefront; the Octopia API "allows you to manage your business across all Octopia sales channels" (aggregator blogs, unverified officially). Seller scoping is via the `SellerId` header, one credential per seller (https://developer.octopia-io.net/getting-started/).

**4. API surface.** Base `https://api.octopia-io.net/seller/v2/`: Seller configuration (information, addresses, indicators, subscriptions, delivery modes, carriers); Products referential (categories, brands, properties); Products management; Offer management (JSON/XML integration); Orders management + order invoices; Discussions (customer messaging); Fulfillment (inbound, outbound, stock, returns); Financial management (https://developer.octopia-io.net/api-reference/technical-documentation/ , https://developer.octopia-io.net/user-guides/getting-started/). Promotions/advertising: not documented (unverified).

**5. Real-time events.** No webhooks/notifications documented (https://developer.octopia-io.net/api-reference/technical-documentation/). A "subscriptions" resource exists under seller configuration — whether it is an event subscription is unverified.

**6. Rate limits / bulk.** Only the token endpoint has a published quota "500 /h" (https://developer.octopia-io.net/api-reference/technical-documentation/). Bulk: offer JSON/XML integration feeds; pagination methods flagged "deprecated due to performance reasons".

**7. Sandbox.** None mentioned in the current docs (https://developer.octopia-io.net/user-guides/getting-started/); the older sandbox host `sandbox-developer.cdscdn.com` no longer resolves (DNS failure on fetch, 2026-08-29) → treat as no sandbox (unverified).

**8. Versioning.** `v2` in the path; individual endpoints carry deprecation warnings (e.g. delivery-modes) (https://developer.octopia-io.net/api-reference/technical-documentation/); notice period unverified.

---

## 7. ManoMano (Toolbox / Partners API)

**1. Public API / access model.** "ManoMano Partners API" docs are public at https://www.manomano.dev/ : "REST-based API that helps you to programmatically access your data on orders, offers, stock". Currently available: "Orders API (REST)", "Offers API", "ManoFulfillment Product Stock API", "Categories API"; "Legacy - Orders API (XML). End Of Life by March 31, 2025. MUST migrate to Orders API (REST)"; Postman collection button (https://www.manomano.dev/). Whether integrators need a partner registration: unverified (nothing on the public page).

**2. Auth.** The official SPA did not render the auth section in this session. Third-party help centres (Channable, DespatchCloud, ShoppingFeed) state an `x-api-key` header, key created by a Toolbox Admin under Settings → "API keys", plus the "seller contract ID" shown top-right in the Toolbox → **unverified against manomano.dev**. Under that model: **Sign in + Allow? NO — key-copy.**

**3. Multi-country.** ManoMano runs FR/ES/IT/DE/GB storefronts; whether one API key spans all contracts or one key per seller contract (contract ID per country): unverified.

**4. API surface.** Orders, Offers (price/stock), ManoFulfillment stock, Categories (https://www.manomano.dev/). Product/catalog creation, messaging, returns, invoices, promotions, advertising: not listed → unverified/absent.

**5. Real-time events.** Not listed on the public page → unverified (assume polling).

**6. Rate limits / bulk.** Unverified.

**7. Sandbox.** Exists with restricted hours: "Sandbox APIs operate Mon 00:00–20:00 and Tue–Fri 07:00–20:00 (CEST). Access is disabled at other times." (https://www.manomano.dev/).

**8. Versioning.** Only the XML→REST order API sunset (31 Mar 2025) is published (https://www.manomano.dev/).

---

## 8. Mirakl-based marketplaces (seller "Marketplace APIs")

**Which big EU marketplaces run on Mirakl (official mirakl.com statements only).** Mirakl's boilerplate: customers "including Airbus, Decathlon, Galeries Lafayette, Kroger, Leroy Merlin, Macy's, Maisons du Monde, MediaMarkt, Sonepar, Toyota Material Handling and Yves Rocher" (2023-06-15, https://www.mirakl.com/news/maisons-du-monde-selects-mirakl-ads-to-power-retail-media-advertising-on-marketplace); "Galeries Lafayette, Conforama, Conrad, Carrefour, Siemens, Best Buy, Go Sport…" and Carrefour France's marketplace built with "son partenaire technologique Mirakl" (2020-11-04, https://www.mirakl.com/fr-FR/news/carrefour-france-ouvre-gratuitement-sa-marketplace-aux-commercants); Conforama services marketplace (https://www.mirakl.com/fr-FR/news/mirakl-accompagne-conforama-developpement-marketplace-services); seller-channel page names Decathlon, Leroy Merlin, B&Q, Home24, El Corte Inglés, MediaMarkt, Carrefour, ASOS, Best Buy, Macy's, Nordstrom, Walmart, Lowe's, Amazon among "450+ channels" (https://www.mirakl.com/sellers/multichannel-selling/); B2C customer stories include Worten, Debenhams, Conrad, Stadium (https://www.mirakl.com/customers/b2c-marketplace-customers). **Douglas: unverified** (no official page fetched). **Fnac/Darty: no longer Mirakl** (see §10). **Cdiscount: not Mirakl-facing for sellers** (see §6).

**1. Public API / access model.** Yes: https://developer.mirakl.com/ → "Rest Seller APIs" https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3 . Each operator hosts its own instance ("URL to be replaced by your Mirakl instance URL: https://your-instance.mirakl.net"); the seller generates the key in that operator's back office → self-serve per marketplace. Mirakl Connect / partner apps use the "Mirakl Authentication System" (OAuth 2 authorization code docs are downloadable from https://developer.mirakl.com/ ; client id/secret "from their Mirakl Partner team contact") → partner-only; whether it yields a seller-consent flow usable by a PIM: unverified.

**2. Auth.** "You can authenticate through API by sending your API key in the Authorization header. Example: Authorization: YOUR_API_KEY"; HTTPS only; `shop_id` parameter "when a user is associated to multiple shops" (https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3). Official location of the key in the seller UI: unverified (third-party: user menu → "API key" tab → Generate; key is environment-specific). The official PHP SDK constructor is `new ShopApiClient('API_URL', 'API_KEY', 'SHOP_ID')` (https://github.com/mirakl/sdk-php-shop).
**Sign in + Allow? NO — key-copy, one key per operator instance (per shop).** Least-friction: ask for instance URL + API key (+ shop_id); test call `GET /api/account`.

**3. Multi-country.** Per operator: separate instance and key per marketplace (Leroy Merlin FR vs Leroy Merlin ES etc. are separate instances; unverified per operator). Within an instance, channels are exposed via `GET /api/channels` and a user may span several shops via `shop_id` (https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3).

**4. API surface** (https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3): Stores/account (`/api/account`, statistics, shop documents); Platform settings (`/api/additional_fields`, `/api/channels`, `/api/currencies`, `/api/documents`, `/api/locales`, `/api/offers/states`, `/api/platform/configuration`, `/api/reasons` …); Invoicing and Accounting (`/api/document-request/…`, `/api/invoices`, `/api/seller-billing-cycles`); Products (`/api/hierarchies`, `/api/products`, `POST /api/products/imports` + error/new-product/transformed reports — the P41/P42/P43 family); Messages (`/api/inbox/threads…`; `/api/messages` and `POST /api/orders/{id}/messages` are "Deprecated ⚠️ No Integration Allowed"); Offers (`POST /api/offers/imports` OF01, `/api/offers`, `POST /api/offers/export/async`); Orders (`/api/orders`, accept, tracking, `POST /api/orders/async-export`); Incidents; Picklists; Promotions; Users; Returns; Multiple shipments. Quality/performance and advertising: not in the seller index (unverified).

**5. Real-time events.** No webhook/subscription resource in the seller API index → polling (https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3). Mirakl's own blog describes webhooks at the operator level ("we process more than 1 million webhooks a minute", 2021-11-04, https://www.mirakl.com/blog/webhooks-or-apis-for-the-worlds-leading-online-marketplaces-the-answer-is-both).

**6. Rate limits / bulk.** "Each API has a dedicated section displaying its rate limit"; 429 with `Retry-After` (seconds); page size max 100 (offset `max`/`offset`, or seek `limit`/`page_token`) (https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3). Bulk: product imports (file), offer imports (file), async offer export, async order export.

**7. Sandbox.** Per-operator test instances; keys are environment-specific — third-party statement, unverified officially.

**8. Versioning.** "Mirakl solutions are updated through continuous delivery"; "New deployed versions are backward compatible" provided integrations tolerate new fields, field order and new enum values; JSON recommended ("our newest APIs are only available in JSON format"); deprecated endpoints are marked in the reference (https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3).

---

## 9. eMAG (RO / HU / BG, + PL)

API exists, self-serve for approved sellers. Official doc index: https://marketplace.emag.ro/infocenter/emag-academy/how-to-add-a-product/product-import-through-api-or-feeds/api-documentation/?lang=en ("v4.5.1 valid from 02.03.2026"; reference https://marketplace-api.emag.ro/api-doc). From the official v4.4.4 PDF (https://s13emagst.akamaized.net/layout/hu/static-upload/emag-marketplace-api-documentation-v4-4-4.pdf): auth = "Basic Authorization request with your username, password and a base64 computed hash" (`base64(username:password)`), user must have API rights; endpoints per country `https://marketplace-api.emag.ro/api-3`, `…emag.bg/api-3`, `…emag.hu/api-3`, `…emag.pl/api-3` (one seller account per country platform); IP whitelisting required; limits "Maximum 1 request every 3 seconds and maximum 20 requests every 1 minute" per resource, `X-RateLimit-Limit-3second` header, 429; bulk saves 50 entities; callback URLs (new order, order cancellation, return/status change, AWB status change) activated in the Marketplace UI. **Auth style: username/password key-copy — no OAuth.**

## 10. Fnac / Darty

Fnac Darty now runs its own platform: API endpoint `https://vendeur.fnac.com/api.php/`, test environment `https://catalog-mp-staging.fnacdarty.com/`, product-import portal `https://catalog-mp.fnacdarty.com` with docs at `https://catalog-mp.fnacdarty.com/docapi` (login required), offers-API doc on request via Marketplace.api@fnacdarty.com (https://marketplace.fnacdarty.com/s/ressources/les-liens-de-connexion-a-nos-outils?language=fr). The Mirakl-based back office was retired (Lengow: "Fnac Mirakl becoming obsolete on June 30, 2025" — third-party, unverified officially). **Auth style: partner/shop id + API key (key-copy); details behind login → unverified.**

## 11. Miravia (ES)

Open platform exists: https://open.miravia.com/ ; onboarding via App Console account, "Quick API Integration", Feed API (async JSON) and Automation Feed (CSV/Excel) (https://open.miravia.com/apps/doc/getting_started , updated Jun 2 2025). Dedicated "Seller authorization" and "Configure seller authorization" docs exist (https://open.miravia.com/apps/doc/doc?nodeId=30655&docId=120904 , …docId=120905) and the Developer Agreement refers to a "Seller Access Token" (https://open.miravia.com/apps/doc/terms) — i.e. an app-key + seller-authorization model (seller grants the app; token issued). Token lifetimes, sign method: pages did not render → unverified. **Auth style: app key/secret + seller authorization grant (OAuth-like); details unverified.**

## 12. Privalia / Veepee

Integration is through "PinkConnect" (login https://www.pink-connect.com/user/login). No public official API documentation found; third-party connectors (Lengow, ChannelEngine, BeezUP) describe a Shop ID + API token copied from the seller space. **API: exists but partner-documented only; auth = token key-copy — unverified officially.**

## 13. Real.de → Kaufland

real.de was rebranded to Kaufland.de on 14 April 2021 (ChannelX — third-party; the official Kaufland e-commerce blog returned 403 in this session → unverified officially). The successor programme is Kaufland Global Marketplace: "sell on all Kaufland marketplaces with just one registration" across 9 countries (https://www.kauflandglobalmarketplace.com/en/). The API is the one in §3.

---

## Comparison table

| Marketplace | Self-serve seller API? | Auth style | True OAuth "sign in + Allow"? | Multi-country model | Events model | Sandbox |
|---|---|---|---|---|---|---|
| OTTO Market | Yes (seller self-app in OPC); Service Partner programme for vendors | OAuth2 client_credentials (self-app) / authorization-code + installation (Service Partner app); 30-min tokens | **Y** via Service Partner app; N for self-app | DE only (no market param) | None — poll; async 202 tasks | Yes, sandbox.api.otto.market, monthly reset |
| Zalando zDirect | Invitation-based (Fashion Partner invites developer); app per Fashion Partner | OAuth2 client_credentials, Basic client id/secret, 2-h tokens | **N** (key-copy) | One partner → many merchants; sales-channel ID per country (33) | None in zDirect (poll orders); Connected Retail OEA = webhooks w/ API key | Yes, api-sandbox.merchants.zalando.com |
| Kaufland Global Marketplace | Yes | Client key + secret, HMAC-SHA256 signed requests | **N** (key-copy, deep link sellerportal.kaufland.de/settings/api) | One account, `storefront` param: de cz sk pl at fr it es nl | Push subscriptions (15 events), HMAC-signed callbacks, ~12 h retries | Playground (isolated, same keys) |
| bol.com Retailer API | Yes | OAuth2 client_credentials (login.bol.com/token), 299-s tokens | **N** (key-copy) | One account NL+BE via `countryCode` | Subscriptions v11: webhooks/PubSub/SQS, RSA-SHA256 signed, 10 retries/10 min; process-status polling | Demo env (hard-coded responses) |
| Allegro | Yes | OAuth2 authorization-code / device / DCR; 12-h access, 3-month refresh | **Y** | One account/token; `marketplaceId` for allegro-pl/cz/sk/hu | No webhooks; poll /order/events (60 d) and /sale/offer-events (24 h) | Yes, full sandbox |
| Cdiscount (Octopia) | Yes (self-created clientId/secret; aggregator registration for vendors) | OAuth2 client_credentials at auth.octopia-io.net, 2-h tokens, `SellerId` header | **N** (key-copy) | FR storefront; per-seller `SellerId`; other Octopia channels unverified | None documented | None documented |
| ManoMano | Public docs; access rules unverified | `x-api-key` from Toolbox (third-party; unverified) | **N** (key-copy, unverified) | unverified | unverified | Yes, limited hours |
| Mirakl-based (Leroy Merlin, Decathlon, Carrefour, MediaMarkt, Conforama, Galeries Lafayette, Worten, Debenhams, Conrad, El Corte Inglés, B&Q, Home24, Maisons du Monde…) | Yes, per operator instance | `Authorization: <API key>` (+ `shop_id`) | **N** (key-copy per instance); Mirakl Connect OAuth is partner-only | One instance + key per operator/marketplace; channels within | None for sellers — polling; async exports | Per-operator test instance (unverified) |
| eMAG | Yes (approved sellers) | HTTP Basic username:password, IP whitelist | N | One account per country platform (RO/BG/HU/PL) | Callback URLs (order, cancel, return, AWB) | unverified |
| Fnac/Darty | Docs behind login / on request | Shop id + API key (unverified) | N | FR/BE via one catalogue (third-party) | unverified | Staging catalogue env |
| Miravia | Yes (App Console) | App key/secret + seller authorization token | Likely Y (seller grants app) — unverified | ES | unverified | unverified |
| Privalia/Veepee | Partner-documented only | PinkConnect shop ID + token (unverified) | N | One PinkConnect token across Veepee/Privalia ES/IT (third-party) | unverified | unverified |
