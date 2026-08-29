# R4 — Etsy Open API v3: connection + API-surface map for a self-owned PIM connector (EU seller)

Researched 2026-08-29 against official sources only: `developers.etsy.com` docs, the published OpenAPI spec (`https://www.etsy.com/openapi/generated/oas/3.0.0.json`, 76 paths / 27 tags, `info.version 3.0.0`, downloaded and parsed), the Etsy Developer Portal (`https://www.etsy.com/developers`), and Etsy's own announcement channels (the `etsy/open-api` GitHub repo — Releases + "Announcements" discussions posted by `openapi-support[bot]` — which the webhooks page itself names as the announcement channel). Pages that refused a non-browser fetch (HTTP 403) are marked; facts from them come from search-index snippets and are labelled *(snippet)*. Anything not confirmable is marked **unverified**.

Abbreviations for URLs used many times:

| Key | URL |
|---|---|
| AUTH | https://developers.etsy.com/documentation/essentials/authentication/ |
| RATE | https://developers.etsy.com/documentation/essentials/rate-limits/ |
| REQ | https://developers.etsy.com/documentation/essentials/requests/ |
| URLSYN | https://developers.etsy.com/documentation/essentials/urlsyntax/ |
| DEF | https://developers.etsy.com/documentation/essentials/definitions/ |
| WEBHOOKS | https://developers.etsy.com/documentation/essentials/webhooks/ |
| OAS | https://www.etsy.com/openapi/generated/oas/3.0.0.json (same content rendered at https://developers.etsy.com/documentation/reference/) |
| QUICK | https://developers.etsy.com/documentation/tutorials/quickstart/ |
| LISTINGS | https://developers.etsy.com/documentation/tutorials/listings/ |
| FULFIL | https://developers.etsy.com/documentation/tutorials/fulfillment/ |
| PAY | https://developers.etsy.com/documentation/tutorials/payments/ |
| SHOPMGMT | https://developers.etsy.com/documentation/tutorials/shopmanagement/ |
| INVSHIP | https://developers.etsy.com/documentation/tutorials/inventory-shipping-migration/ |
| PROCPROF | https://developers.etsy.com/documentation/tutorials/migration/ |
| PERS | https://developers.etsy.com/documentation/tutorials/personalization-migration/ |
| PERSADDON | https://developers.etsy.com/documentation/tutorials/personalization-addon-pricing/ |
| THIRDVAR | https://developers.etsy.com/documentation/tutorials/third-variation/ |
| PORTAL | https://www.etsy.com/developers |
| YOURAPPS | https://www.etsy.com/developers/your-apps (login-gated) |
| RELEASES | https://github.com/etsy/open-api/releases |
| ANNOUNCE | https://github.com/etsy/open-api/discussions/categories/announcements |

---

## A. Auth, tokens, limits, approval

### A.1 OAuth 2.0 authorization-code + PKCE

| Fact | Value | Source |
|---|---|---|
| Grant type | Authorization Code Grant; three steps: request code at `https://www.etsy.com/oauth/connect` → user grants → exchange at `https://api.etsy.com/v3/public/oauth/token` | AUTH |
| PKCE | **Mandatory**: "The Etsy Open API requires a PKCE on every authorization flow request." RFC 7636. `code_challenge_method` "Must be `S256`". Verifier: 43–128 chars from `[A-Za-z0-9._~-]`; challenge = URL-safe base64 of SHA-256(verifier). | AUTH |
| Authorize URL params | `response_type=code` (always), `client_id` (API keystring), `redirect_uri` (HTTPS, must be registered), `scope` (space-separated), `state` (recommended single-use CSRF token; echoed back), `code_challenge`, `code_challenge_method=S256` | AUTH |
| Callback error contract | On the redirect: `state` (if sent), `error` (RFC 6749 code), `error_description` (English) | AUTH |
| Token endpoint | `POST https://api.etsy.com/v3/public/oauth/token`, body `application/x-www-form-urlencoded`. The OAS lists the same endpoint on the alias host `https://openapi.etsy.com/v3/public/oauth/token`; REQ says `api.etsy.com/v3/` and `openapi.etsy.com/v3/` are equivalent. | AUTH, OAS `securitySchemes.oauth2`, REQ |
| Code exchange body | `grant_type=authorization_code`, `client_id`, `redirect_uri` (optional; must match if sent), `code`, `code_verifier` | AUTH |
| Refresh body | `grant_type=refresh_token`, `client_id`, `refresh_token` | AUTH |
| Response | `{access_token, token_type:"Bearer", expires_in:3600, refresh_token, scope}` | AUTH |
| Access-token lifetime | "functional life of 1 hour"; `expires_in … 3600 seconds is 1 hour` | AUTH |
| Refresh-token lifetime | "has a longer functional lifetime (90 days)" | AUTH |
| Rotation on refresh | A refresh-token grant response includes a **new `refresh_token`** — the doc's refresh-grant response example carries `refresh_token`, described as "the refresh code sent from Etsy.com after granting a prior authorization grant token **or refresh grant token**". Store the newest one every time. Whether the previous refresh token is immediately invalidated is **unverified** (not stated). | AUTH |
| Token format | `access_token` = "OAuth grant token with a user id numeric prefix (12345678 in the example above)" — i.e. `{user_id}.{token}`; refresh token carries the same prefix. "This numeric OAuth user_id is only available from the authorization code grant flow" — it is the seller's Etsy `user_id`, which "is also a valid shop ID for the user's shop" (OAS `User.user_id`). | AUTH, OAS |
| Headers on every call | `x-api-key: <keystring>` — REQ/OAS phrase it as `keystring:shared_secret`, the AUTH page example shows `x-api-key: 1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5`; plus `Authorization: Bearer {user_id}.{token}` for OAuth-scoped endpoints. UTF-8 everywhere; send `charset=utf-8` on POST. | REQ, AUTH, OAS `securitySchemes.api_key` |
| Scope change | Changing requested scopes requires the user to re-authorize | AUTH |
| Token introspection | `POST /v3/application/scopes` (`tokenScopes`, body `token`) returns the scopes of a token — useful to detect a partial "Allow" | OAS |
| Connectivity check | `GET /v3/application/openapi-ping` needs only `x-api-key`, returns the application id | QUICK, OAS |
| OAuth 1.0 legacy exchange | `grant_type=token_exchange` + `legacy_token` (irrelevant for a new connector) | AUTH |

### A.2 Redirect / callback URL registration

- "Authorization code or token requests with unregistered or non-matching" redirect URIs fail; "URL matching is case-sensitive and is specifically the URL established when you registered." No protocol, trailing-slash, query-mark, subdomain or case variations. Register the callback at `etsy.com/developers/your-apps`. — AUTH
- The Quick Start registers `http://localhost:3003/oauth/redirect` for local testing; production callbacks must be HTTPS. — QUICK, AUTH

### A.3 Revocation

| Fact | Value | Source |
|---|---|---|
| Revocation endpoint | **None.** The OAS contains no revoke/introspect path (0 hits for "revok"); the AUTH page has no revocation section. | OAS, AUTH |
| Seller-side revoke | Sellers remove an app under their Etsy account's installed-integrations page (`https://www.etsy.com/your/shops/me/integrations/installed` — **unverified**, reported by developers in https://github.com/etsy/open-api/discussions/1171, no staff reply). | GH #1171 |
| Error after revoke | Not documented. Community reports in GH #1171: HTTP **403** with `"access token has been revoked"` / `"refresh_token is revoked"` → re-run the OAuth flow. Treat any 401 (`"The request lacks valid authentication credentials"`) or 403 (`"…not allowed to"`) on a refresh as "grant lost → prompt reconnect". | OAS response descriptions; GH #1171 (**unverified**) |

### A.4 Multi-shop

- One Etsy user owns at most one shop: `GET /v3/application/users/{user_id}/shops` (`getShopByOwnerUserId`) "Retrieves **the** shop identified by the shop owner's user ID" and returns a single `Shop`; `User.user_id` "is also a valid shop ID for the user's shop". — OAS
- Therefore one grant = one shop; a merchant with several shops (several Etsy accounts) must run "Connect" once per account. Personal-access keys are capped at "up to 5 shops via OAuth token scopes" *(snippet of YOURAPPS)*; a **Seller App** may only be authenticated with the developer's own shop *(snippet of https://help.etsy.com/hc/en-us/articles/41918478450967-How-to-Register-a-Seller-App-with-Etsy-s-API — page returns 403 to fetchers)*.
- After `Allow`, resolve the shop with `GET /v3/application/users/me` (`getMe`, scope `shops_r`) or `getShopByOwnerUserId(user_id from the token prefix)`. — OAS

### A.5 Sandbox / testing

- **No sandbox.** Neither the docs nor the OAS mention one (0 hits for "sandbox"); the docs link an "API Testing Policy" (`https://www.etsy.com/legal/policy/api-testing-policy/169130941112`, 403 to fetchers) which *(snippet)* requires testing on real accounts: put "test" in the title/description of test listings, avoid stock images, and cancel any accidental purchase of a test listing (unfulfilled orders lead to suspension). Etsy's own GitHub thread https://github.com/etsy/open-api/discussions/1619 (2026) confirms developers still lack a test environment.
- The Webhook Portal does include a "Testing Webhooks" tool that sends test events to your endpoint. — WEBHOOKS

### A.6 Rate limits

| Fact | Value | Source |
|---|---|---|
| Model | Application-based: QPS + QPD. "Rate limits are applied at the API key level for both public auth and private auth." "You can see your application's current rate limits in the Developer Portal." | RATE |
| Default numbers | **Not stated on the current page.** The page's *example* headers show `x-limit-per-second: 150`, `x-limit-per-day: 100000`. The widely quoted default "10 QPS / 10,000 per day" appeared on an earlier version of this page and in third-party copies — **unverified today**; read your real quota from the headers / Developer Portal. | RATE |
| QPD window | Sliding 24-hour window of buckets, not midnight-to-midnight; quota from an exiting bucket is freed immediately | RATE |
| Headers (every 2xx) | `x-limit-per-second`, `x-remaining-this-second`, `x-limit-per-day`, `x-remaining-today` (page shows lowercase names) | RATE |
| Exceeded | QPS checked first, then QPD; HTTP **429** + `retry-after` (seconds). Release notes 2025-10-02 and 2025-10-24 fixed inaccurate `retry-after` values on QPD violations. | RATE, RELEASES |
| Increase | Email developer@etsy.com with an app description + QPD/QPS estimate | RATE |
| Pagination caps | `limit` default 25, max 100; `offset` default 0, **max 12,000**; responses carry `count` | URLSYN, OAS |

### A.7 App types and approval

| Tier | What it is | Approval | Reach | Source |
|---|---|---|---|---|
| **Seller App** (`/developers/register-seller-app`) | "Use Etsy's API to build an app for your own shop … programmatic access to your shop data" | "The approval process is light and straightforward"; *(snippet)* "eligible sellers are approved within minutes, with no manual review queue" | Own shop only — *(snippet)* "you will only be allowed to authenticate your app with your shop"; cannot serve other sellers | PORTAL; help article 41918478450967 *(snippet)* |
| **Personal App** (`/developers/register`) | "build on Etsy's API for uses beyond your own shop, including tools other buyers and sellers can use at limited scale" | "deeper review process" | *(snippet of YOURAPPS)* "API key with personal access and ratelimits, allowing you to read and write data for up to 5 shops via OAuth token scopes" | PORTAL; YOURAPPS *(snippet)* |
| **Commercial Access** | Upgrade of an *approved* Personal App: "To grow past that, you can request an upgrade to commercial access… commercial taking longer depending on your proposed use case" | Manual review; two-step (Personal first, then request Commercial) | Unlimited sellers (subject to quota) | PORTAL; help article 360025870013 *(snippet)* |
| Provisional / pending | "Your API key is not active until it has been approved" — check "Manage Your Apps" first. No documented "provisional key" capability set today (the old v2 notion is gone). | — | — | QUICK |
| Process status | Etsy pinned "App Key Application Process" (2026-05-12): "We are currently revisiting our App Key application process"; posting application details publicly gets the application denied. Developer reports there describe multi-month waits and silent denials. | — | — | https://github.com/etsy/open-api/discussions/1607 |
| Terms | *(snippet of https://www.etsy.com/legal/api/, 403 to fetchers)* Do not display listing content more than **6 hours** older than Etsy, other content more than **24 hours** older; do not cache/store Etsy content longer than reasonably necessary to serve your users. | — | — | API Terms of Use |

**Implication for "Connect → sign in → Allow" for our own EU shop:** a *Seller App* is the fastest key (minutes, no queue) and is exactly what a self-owned PIM needs; a *Personal App* is required only if other sellers must connect (≤5 shops), and *Commercial* beyond that.

### A.8 Regional fulfilment restrictions that bite an EU seller

Etsy has been fencing off address data and `createReceiptShipment` for **new** keys/sellers per country:

| Date | Region | Rule | Source |
|---|---|---|---|
| 2024-10-21 | US | "New personal keys for shops in the United States will no longer be able to access `createReceiptShipment`" or `formatted_address`/address fields on `getShopReceipt(s)`/`updateShopReceipt`; new commercial-key sellers likewise "unless … an Etsy Preferred Partner or … in an approved category"; existing keys/users keep access | https://github.com/etsy/open-api/releases/tag/3.0.0-general-release-2024-10-21 |
| 2024-11-20 | Canada | Same rule for Canada | RELEASES |
| 2025-07-17 | **France & Germany** | "New personal keys for shops in France and Germany will no longer be able to access `createReceiptShipment`" or `formatted_address, first_line, second_line, city, state, zip, country_iso`; new FR/DE sellers on commercial apps likewise unless Preferred Partner/approved category; existing keys and existing sellers keep access | https://github.com/etsy/open-api/discussions/1439 |
| ongoing | all | OAS on `getShopReceipts`/`getShopReceipt`/`updateShopReceipt`: "Access to ShopReceipt's first_line, second_line, city, state, zip, country_iso and formatted_address is contingent in some regions to a preferred partnership status with Etsy"; since 2024-08-01 these fields are **nullable** (null when unauthorized, not empty strings). `buyer_email` and `User.primary_email` are also "case-by-case" grants. | OAS, RELEASES |

Whether a *Seller App* key for a FR/DE shop is treated as a "new personal key" is **unverified** — the connector must probe one receipt after `Allow` and surface "address hidden by Etsy" honestly instead of rendering blanks.

---

## B. Scopes (complete v3 list — exactly 12)

Source: AUTH scope table and OAS `securitySchemes.oauth2.flows.authorizationCode.scopes` (identical set).

| Scope | Grants | Endpoints that require it (OAS) |
|---|---|---|
| `address_r` | Read a member's shipping addresses | `getUserAddresses`, `getUserAddress`, `deleteUserAddress` (the OAS lists `address_r` on delete; no endpoint currently demands `address_w`) |
| `address_w` | Update and delete a member's shipping addresses | none in the current OAS |
| `email_r` | Read a user profile | `getUser` |
| `listings_d` | Delete a member's listings | `deleteListing` |
| `listings_r` | Read a member's inactive and expired (non-public) listings | `getListingsByShop`, `getListingInventory`, `getListingsInventoryByListingIds`, `getListingProduct`, listing files, `getListingsByShopReturnPolicy` |
| `listings_w` | Create/edit listings | `createDraftListing`, `updateListing`, images/videos/files/inventory/properties/translations/variation-images/personalization writes |
| `profile_r` | See all profile data | none in the current OAS |
| `profile_w` | Update user profile, avatar, etc. | none in the current OAS |
| `shops_r` | See private shop info ("even if not (yet) public") | `getMe`, shipping profiles/destinations/upgrades reads, readiness-state reads, production partners, holiday prefs read, `getListingsShippingByListingIds`, `updateShop` (with `shops_w`) |
| `shops_w` | Update shop | `updateShop`, sections, shipping profiles, readiness states, return policies, holiday prefs writes |
| `transactions_r` | See all checkout/payment data | receipts, transactions, payments, ledger entries, `getListingsByShopReceipt` |
| `transactions_w` | Update receipts | `updateShopReceipt`, `createReceiptShipment` |

**Not v3 scopes** (they were v2): `billing_r`, `cart_r/w`, `favorites_r/w`, `feedback_r`, `recommend_r/w`, `treasury_*`. They do not appear in AUTH or the OAS and requesting them is not documented to work. For an "everything" PIM grant, request: `listings_r listings_w listings_d shops_r shops_w transactions_r transactions_w email_r address_r` (add `profile_r profile_w address_w` only if you accept asking for permissions no endpoint uses).

---

## C. Complete API surface (OAS 3.0.0, 76 paths, grouped by tag; scope column = OAuth scope in the OAS `security` block, `–` = API key only)

### C.1 Listing Management

**ShopListing**

| Op | Method + path | Scope |
|---|---|---|
| createDraftListing | `POST /v3/application/shops/{shop_id}/listings` | listings_w |
| updateListing | `PATCH /v3/application/shops/{shop_id}/listings/{listing_id}` | listings_w |
| deleteListing | `DELETE /v3/application/listings/{listing_id}` | listings_d |
| getListing | `GET /v3/application/listings/{listing_id}` | – |
| getListingsByShop | `GET /v3/application/shops/{shop_id}/listings` (`state` filter, `sort_on`, `includes`) | listings_r |
| findAllActiveListingsByShop | `GET /v3/application/shops/{shop_id}/listings/active` | – |
| findAllListingsActive | `GET /v3/application/listings/active` (marketplace search) | – |
| getListingsByListingIds | `GET /v3/application/listings/batch` (≤100 ids; `currency`, `buyer_country`) | – |
| getListingsShippingByListingIds | `GET /v3/application/listings/batch/shipping` (≤100 ids) | shops_r |
| getFeaturedListingsByShop | `GET /v3/application/shops/{shop_id}/listings/featured` | – |
| getListingsByShopSectionId | `GET /v3/application/shops/{shop_id}/shop-sections/listings` | – |
| getListingsByShopReceipt | `GET /v3/application/shops/{shop_id}/receipts/{receipt_id}/listings` | transactions_r |
| getListingsByShopReturnPolicy | `GET /v3/application/shops/{shop_id}/policies/return/{return_policy_id}/listings` | listings_r |
| getListingProperties / getListingProperty | `GET …/listings/{listing_id}/properties[/{property_id}]` | – |
| updateListingProperty | `PUT /v3/application/shops/{shop_id}/listings/{listing_id}/properties/{property_id}` (`value_ids[]`, `values[]`, `scale_id`) | listings_w |
| deleteListingProperty | `DELETE …/listings/{listing_id}/properties/{property_id}` | listings_w |

**ShopListing Image** — `getListingImages`, `getListingImage` (–); `uploadListingImage` `POST …/images` multipart (`image`, or re-attach `listing_image_id`; `rank`, `overwrite`, `is_watermarked`, `alt_text` ≤500 chars); `deleteListingImage` (listings_w).
**ShopListing Video** — `getListingVideos`, `getListingVideo` (–); `uploadListingVideo` `POST …/videos` multipart (`video`+`name`, or `video_id`); `deleteListingVideo` (listings_w).
**ShopListing File** (digital) — `getAllListingFiles`, `getListingFile` (listings_r); `uploadListingFile` (`file`+`name` or `listing_file_id`, `rank`) — "Associating an existing file to a physical listing converts the physical listing" to digital; `deleteListingFile` (listings_w).
**ShopListing Inventory** — `getListingInventory` `GET /v3/application/listings/{listing_id}/inventory` (`show_deleted`, `includes=Listing`; listings_r); `getListingsInventoryByListingIds` `GET /v3/application/listings/batch/inventory` (≤100, listings_r); `updateListingInventory` `PUT /v3/application/listings/{listing_id}/inventory` JSON `{products[], price_on_property[], quantity_on_property[], sku_on_property[], readiness_state_on_property[]}` + `?max_variations_supported=2|3` (listings_w).
**ShopListing Product / Offering** — `getListingProduct` `GET /v3/application/listings/{listing_id}/inventory/products/{product_id}` (listings_r); `getListingOffering` `GET …/products/{product_id}/offerings/{product_offering_id}` (–). Both read-only; all writes go through `updateListingInventory`.
**ShopListing VariationImage** — `getListingVariationImages` (–); `updateVariationImages` `POST …/variation-images` JSON `variation_images[{property_id,value_id,image_id}]` (listings_w).
**ShopListing Translation** — `getListingTranslation`, `createListingTranslation` (`title`, `description`, `tags[]`), `updateListingTranslation` at `…/translations/{language}` (`de, en, es, fr, it, ja, nl, pl, pt`).
**ShopListing Personalization** (new, 2026) — `getListingPersonalization` `GET /v3/application/listings/{listing_id}/personalization` (–); `updateListingPersonalization` `POST /v3/application/shops/{shop_id}/listings/{listing_id}/personalization` JSON `personalization_questions[]` + `?supports_multiple_personalization_questions=true` — "fully replace"; `deleteListingPersonalization` (listings_w).
**SellerTaxonomy** — `getSellerTaxonomyNodes` (full tree), `getPropertiesByTaxonomyId` (properties + scales + values per node). **BuyerTaxonomy** — `getBuyerTaxonomyNodes`, `getPropertiesByBuyerTaxonomyId`. All API-key only.

### C.2 Receipt Management (orders)

| Op | Method + path | Scope | Notes |
|---|---|---|---|
| getShopReceipts | `GET /v3/application/shops/{shop_id}/receipts` | transactions_r | filters `min_created`, `max_created`, `min_last_modified`, `max_last_modified`, `was_paid`, `was_shipped`, `was_delivered`, `was_canceled`; `sort_on` = `created|updated|receipt_id`; `sort_order`; `limit`≤100; `offset`; `legacy` (processing-profile fields) |
| getShopReceipt | `GET …/receipts/{receipt_id}` | transactions_r | |
| updateShopReceipt | `PUT …/receipts/{receipt_id}` | transactions_w | body `was_shipped`, `was_paid` only |
| createReceiptShipment | `POST …/receipts/{receipt_id}/tracking` | transactions_w | JSON `tracking_code`, `carrier_name`, `send_bcc`, `note_to_buyer`, plus optional label data (`mail_class`, `weight[_units]`, `length/width/height`, `dimension_units`, `shipping_label_cost/_currency`, `ship_from_country`, `ship_to_country`, `incoterm`, `customs_data[]`, `duty_amount/_currency`, `ship_date`); each success emails the buyer; with no tracking it still marks shipped |
| getShippingCarriers | `GET /v3/application/shipping-carriers` | – | carrier ids + mail classes (FULFIL lists 250+ `carrier_name` values) |
| getShopReceiptTransactionsByShop / ByReceipt / ByListing / getShopReceiptTransaction | `GET …/transactions…` | transactions_r | line items: `listing_id`, `product_id`, `sku`, `quantity`, `price`, `shipping_cost`, `variations[]` (incl. personalization, `property_id: 54`), `expected_ship_date`, `buyer_coupon`, `shop_coupon` |

`ShopReceipt.status` enum: `paid, completed, open, payment processing, canceled, fully refunded, partially refunded`. Receipt carries `shipments[]` (`ShopReceiptShipment`: `receipt_shipping_id`, `carrier_name`, `tracking_code`, `shipment_notification_timestamp`) and `refunds[]` (`ShopRefund`: `amount`, `created_timestamp`, `reason`, `note_from_issuer`, `status`). **There is no endpoint to create a refund or cancel an order** — refunds/cancellations are read-only in v3. — OAS, DEF

### C.3 Payment Management

| Op | Path | Scope |
|---|---|---|
| getShopPaymentAccountLedgerEntries | `GET /v3/application/shops/{shop_id}/payment-account/ledger-entries` — **`min_created` and `max_created` are required**; `limit`≤100, `offset` | transactions_r |
| getShopPaymentAccountLedgerEntry | `GET …/ledger-entries/{ledger_entry_id}` | transactions_r |
| getPaymentAccountLedgerEntryPayments | `GET …/ledger-entries/payments?ledger_entry_ids=` | transactions_r |
| getPayments | `GET /v3/application/shops/{shop_id}/payments` | transactions_r |
| getShopPaymentByReceiptId | `GET …/receipts/{receipt_id}/payments` | transactions_r |

Ledger entries: `entry_id`, `sequence_number` ("The higher the sequence, the more recent the entry"), `amount`, `balance`, `currency`, `description` (payment, refund, reversal of failed refund, disbursement, returned disbursement, recoupment, misc credit…), `ledger_type`, `reference_type/_id`, `parent_entry_id` ("e.g., vat_seller_services to originating seller fees"), `payment_adjustments[]`. Payments: `amount_gross/fees/net`, `posted_*` (once shipped), `adjusted_*` (after refunds), `status` ("settled"/"authed"). "Payment records don't appear until after purchase shipment." — OAS, PAY

### C.4 Shop / Shipping / Policy Management

- **Shop** — `getShop`, `getShopByOwnerUserId`, `findShops?shop_name=` (–); `updateShop` `PUT` (`title`, `announcement`, `sale_message`, `digital_sale_message`, `policy_additional` — "should only be set for shops located in the EU"; shops_r+shops_w). Shop fields worth syncing: `currency_code`, `is_vacation`, `vacation_message`, `vacation_autoreply`, `languages[]`, `shop_location_country_iso`, `shipping_from_country_iso`, `is_etsy_payments_onboarded`, `policy_has_private_receipt_info` ("EU receipts display private info"), `include_dispute_form_link` (EU ODR), `listing_active_count`, `review_count/average`. **No write for vacation mode** (read-only fields).
- **Shop Section** — `getShopSections`, `getShopSection` (–); `createShopSection`, `updateShopSection`, `deleteShopSection` (shops_w). Listings are assigned via `updateListing.shop_section_id`. — SHOPMGMT
- **Shop ShippingProfile** — full CRUD: profiles (`title`, `origin_country_iso`, `primary_cost`, `secondary_cost`, `origin_postal_code`, optional `min/max_processing_time` 1–10 + `processing_time_unit`, and either `shipping_carrier_id`+`mail_class` or `min/max_delivery_days` 1–45; `destination_country_iso` **or** `destination_region` ∈ `eu|non_eu|none`), destinations (same cost/carrier fields per destination), upgrades (`type` 0 domestic/1 international, `upgrade_name`, `price`, `secondary_price`). Reads shops_r, writes shops_w.
- **Shop ProcessingProfiles** (readiness states) — `getShopReadinessStateDefinitions`, `getShopReadinessStateDefinition` (shops_r); `createShopReadinessStateDefinition` (`readiness_state` ∈ `ready_to_ship|made_to_order`, `min/max_processing_time` 1–10, `processing_time_unit` ∈ `days|weeks`; 409 Conflict + `Content-Location` if an identical one exists), `updateShopReadinessStateDefinition`, `deleteShopReadinessStateDefinition` (shops_w).
- **Shop Return Policy** — `getShopReturnPolicies`, `getShopReturnPolicy` (–); `createShopReturnPolicy` (`accepts_returns`, `accepts_exchanges`, `return_deadline` ∈ {7,14,21,30,45,60,90}), `updateShopReturnPolicy`, `deleteShopReturnPolicy` (only when no listings attached), `consolidateShopReturnPolicies` (shops_w).
- **Shop HolidayPreferences** — `getHolidayPreferences`, `updateHolidayPreferences/{holiday_id}` (`is_working`) — "Currently only supported in the US and CA".
- **Shop ProductionPartner** — `getShopProductionPartners` (shops_r) **read-only**; partners are created in Shop Manager and referenced by `production_partner_ids[]` on listings.

### C.5 Review / User / Other

- **Review** — `getReviewsByShop` (`min_created`/`max_created`, ≤100), `getReviewsByListing` (–). Read-only; no reply-to-review.
- **User** — `getMe` (shops_r; returns `user_id` + `shop_id`), `getUser` (email_r; `primary_email` "granted on a case by case basis").
- **UserAddress** — `getUserAddresses`, `getUserAddress`, `deleteUserAddress` (address_r).
- **Other** — `ping`, `tokenScopes`.

### C.6 What does NOT exist in v3 (verified against the 76-path OAS)

| Capability | Status | Evidence |
|---|---|---|
| Conversations / messaging | **Absent.** 0 paths; only `Shop.vacation_autoreply` and receipt `message_from_*` strings are readable. Etsy's own discussions record "messages are not supported" (https://github.com/etsy/open-api/discussions/1547, 2026-03-06, no staff reply). | OAS |
| Coupons / promotions / sales | **Absent.** "coupon" appears only as read-only amounts on transactions (`buyer_coupon`, `shop_coupon`) and `ShopReceipt.discount_amt`. | OAS |
| Etsy Ads / Offsite Ads | **Absent** (0 paths). | OAS |
| Bulk / feed / CSV upload | **Absent.** Only batch *reads* exist (`/listings/batch`, `/batch/inventory`, `/batch/shipping`, ≤100 ids). Every write is one listing at a time. | OAS, INVSHIP |
| Refund / cancel order | **Absent** (read-only `refunds[]`, `was_canceled` filter). | OAS |
| Feedback (v2) | Replaced by read-only `Review` endpoints. | OAS |
| Cart, Favorites, Treasury, Teams, Guest, Billing (v2) | **Absent.** | OAS |
| Vacation mode write, shop policies (structured) write, shop about/banner | **Absent** (read-only on `Shop`). | OAS |
| Production partner create | **Absent** (read-only). | OAS |
| Webhook subscription API | **Absent** — webhooks are configured only in the portal (see D). | WEBHOOKS |
| GPSR / product-safety / manufacturer fields | **Absent** from the OAS (0 hits for gpsr/safety/manufactur/producer/economic operator). Developers asked in https://github.com/etsy/open-api/discussions/1307 (2025); no staff reply. | OAS |

---

## D. Real-time events

### D.1 Correction to the brief: Etsy **does** have webhooks now (order lifecycle only)

| Fact | Value | Source |
|---|---|---|
| Existence | "Webhooks provide real-time notifications to approved Etsy applications when defined events occur." Launched for commercial apps 2025-12-11 (`ORDER_PAID`); opened to **personal apps** with `order.canceled` on 2026-02-17. | WEBHOOKS; https://github.com/etsy/open-api/discussions/1509; https://github.com/etsy/open-api/discussions/1537 |
| Eligibility | "Webhook functionality is available for both commercial and personal applications!" Prerequisite: "a valid OAuth 2.0 access token with the appropriate scopes" + a public HTTPS callback accepting POST. Seller-App eligibility is **not stated** (**unverified**). | WEBHOOKS |
| Events (all today) | `order.paid` (on payment), `order.canceled` (seller-initiated cancel), `order.shipped` ("when shipping information is created for a product of a shop's receipt"), `order.delivered`. "Stay tuned to our announcements for more events coming soon!" — **no listing, inventory, shop or review events.** | WEBHOOKS |
| Payload | JSON: `event_type`, `resource_url` (e.g. `https://api.etsy.com/v3/application/shops/{shop_id}/receipts/{receipt_id}`), `shop_id`. Thin — you must call `resource_url` with the shop's bearer token. | WEBHOOKS |
| Signature | Headers `webhook-id`, `webhook-timestamp` (unix s), `webhook-signature`. Verify: `signed = webhook-id + "." + webhook-timestamp + "." + raw_body`; key = base64-decode(secret minus `whsec_` prefix); HMAC-SHA256 → base64; compare; reject if `abs(now - webhook-timestamp) > 300`. (Standard-Webhooks / Svix-style.) | WEBHOOKS |
| Retries | Exponential backoff: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h (8 attempts); stops if the endpoint is disabled/deleted; manual retry and "Recover" (bulk retry from a date) in the portal | WEBHOOKS |
| Management | Portal only: Manage your apps → app dropdown → "Go to Webhook portal" → "+Add Endpoint" (callback URL + event) → Create; enable/disable/delete; delivery stats, message attempts, payload inspection, test-event sender. **No API to create subscriptions**; subscriptions are per *app*, delivered with the `shop_id` of whichever connected shop fired. Acknowledgement status code is not specified (**unverified**; assume any 2xx). | WEBHOOKS |

### D.2 Polling design the docs imply (needed for everything that has no event, and as the safety net for orders)

| Stream | Endpoint + cursor | Interval suggestion | Notes / source |
|---|---|---|---|
| Orders — new & changed | `getShopReceipts?min_last_modified={last_watermark - overlap}&sort_on=updated&sort_order=asc&limit=100&offset=…` (`legacy` param if you read readiness-state fields). Use `update_timestamp` of the newest row as the next watermark; keep a 5–10 min overlap because timestamps are epoch-seconds and `offset` is capped at 12,000. | Every 5–15 min as reconciliation under webhooks; every 1–5 min if webhooks are unavailable to the key | OAS params; URLSYN offset cap |
| Orders — state slices | `was_paid=true&was_shipped=false` (to-ship queue), `was_canceled=true`, `was_delivered=true` — filters are boolean and combinable with the timestamp windows | On demand / hourly | OAS |
| Order line items | `getShopReceiptTransactionsByReceipt` when a receipt changes (or read `transactions[]` embedded on the receipt) | event-driven | OAS |
| Listings — changed | `getListingsByShop?state=active|inactive|sold_out|draft|expired&sort_on=updated&sort_order=desc&includes=Images,Videos,Translations,Personalization` — walk newest-first until `last_modified_timestamp` < watermark; repeat per state (state is a single value, default `active`). OAS caveat: "`sort_on` only works when combined with one of the search options" is inherited text from the search endpoint; verify on the shop endpoint at build time (**unverified**). | Every 15–60 min; plus immediately after our own writes | OAS |
| Listings — inventory (stock/price/SKU) | `getListingsInventoryByListingIds?listing_ids=…` in 100-id batches (`Inventory` is no longer an `includes` value); `getListingsShippingByListingIds` for shipping | With the listing pass | INVSHIP |
| Ledger / payouts | `getShopPaymentAccountLedgerEntries?min_created=&max_created=` (both required) → page by `offset`; order by `sequence_number`; then `getPaymentAccountLedgerEntryPayments?ledger_entry_ids=` to map to payments/receipts | Hourly / daily | OAS, PAY |
| Reviews | `getReviewsByShop?min_created=` | Daily | OAS |
| Shop / profiles / policies / sections / taxonomy | Full re-read (small) | Daily, and on connector open | OAS |
| Push | Register the four `order.*` webhooks; on receipt, GET `resource_url` and run the same upsert as the poller (idempotent on `receipt_id` + `update_timestamp`). De-dupe on `webhook-id`. | — | WEBHOOKS |

Budget: a shop with 2,000 listings costs ~20 listing pages + 20 inventory batches + 20 shipping batches ≈ 60 calls per full pass; receipts by `min_last_modified` are usually 1 call. Read `x-remaining-today` and back off at ~10% remaining; honour `retry-after` on 429.

---

## E. Versioning / deprecation

| Fact | Value | Source |
|---|---|---|
| v2 sunset | Announced 2022-11-10 by the Etsy Open API team: v2 "fully retired and removed from production" on **2023-03-31**; Google Group retired 2022-12-31; community moved to GitHub Discussions. | https://groups.google.com/g/etsy-api-v2/c/HgWQa-CaCKc |
| v3 versioning | Single version `3.0.0` in the OAS; changes are additive with opt-in query flags (`legacy`, `max_variations_supported`, `supports_multiple_personalization_questions`) and dated field removals. The old `developers.etsy.com/documentation/changelog` and `/migration/*` URLs now 404. | OAS; fetch results |
| Where changes are announced | Release notes on GitHub Releases (each titled "3.0.0 General Release YYYY-MM-DD"), and "📣 Announcements" discussions by `openapi-support[bot]`; the WEBHOOKS page links that category as the channel to watch. Support: GitHub Discussions, developers@etsy.com, Stack Overflow tag. | RELEASES; ANNOUNCE; https://developers.etsy.com/documentation/get-help/ |
| Recent releases (newest first) | 2026-03-24 video-upload/image-rank/draft-activation fixes · 2025-10-24 `retry-after` fix (QPD) · 2025-10-14 removed 3 deprecated image endpoints · 2025-10-08 `min/max_processing_time` on `createShippingProfile` optional, "scheduled for removal in Q1 2026"; `min_processing_days`, `max_processing_days`, `processing_days_display_label` removed from `ShopShippingProfile` · 2025-10-02 Etsy Insider shipping-cost fix · 2025-01-06 draft/digital `updateListing` fix · 2024-11-20 Canada fulfilment restriction · 2024-10-21 US fulfilment restriction · 2024-08-01 receipt address fields nullable · 2024-07-24 holiday-preference endpoints | RELEASES |
| Personalization | Legacy fields `is_personalizable`, `personalization_is_required`, `personalization_char_count_max`, `personalization_instructions` "[DEPRECATED] … will be removed on Apr. 9th, 2026"; new structure from 2026-02-06, GA 2026-05-11 *(search snippet of PERS)*; the OAS still lists them on create/update today. | OAS; PERS |
| Processing profiles | Early access 2025-07-16 with a 60-day legacy window; `readiness_state_id` is mandatory for physical listings; the `legacy` query param toggles the new response fields. | PROCPROF |
| Third variation | `max_variations_supported=3` (default 2 → 400 on 3-variation listings); developer preview and reading-support deadline **2026-08-17**; limits 2,500 products (400 when an `*_on_property` lists all three). | THIRDVAR |
| Dev MCP server | `https://mcp.api.etsycloud.com/mcp` — spec/docs only, no live calls (announced 2026-04-15). | https://developers.etsy.com/documentation/mcp_server/devmcpserver/; https://github.com/etsy/open-api/discussions/1582 |

### E.1 Listing content constraints

| Constraint | Value | Source |
|---|---|---|
| Images | "up to **20** images" per listing (`image_ids`); upload one per call; `rank` ≥1, `overwrite`; `alt_text` ≤500 chars; full-size served "up to 3000 pixels in each dimension" | OAS |
| Video | The listing-with-associations schema calls `videos` "The single video associated with a listing" → **1 via API**. Etsy Help *(snippet of https://help.etsy.com/hc/en-us/articles/360053206073-How-to-Add-Listing-Videos)* now says sellers can add **2** videos of 3–15 s (audio stripped) — API parity **unverified**. | OAS; help snippet |
| Title | Allowed chars: letters, numbers, punctuation, math symbols, whitespace, ™©® (regex given); `%`, `:`, `&`, `+` at most once each. Length limit **not in the OAS**; Etsy Help *(snippet of https://help.etsy.com/hc/en-us/articles/115015628707-How-to-Create-a-Listing)* says **140 characters**. | OAS; help snippet |
| Tags | Letters, numbers, whitespace, `-`, `'`, ™©® only. Count/length not in the OAS; Help *(snippet)* says **13 tags, 20 chars each**. | OAS; help snippet |
| Materials | Letters, numbers, whitespace only; count limit **unverified** (commonly 13). | OAS |
| Styles | "up to two styles" | OAS |
| Description | Plain `description` required; `rich_description` (seller-authored HTML) is read-only in the schema | OAS |
| Price | float in shop currency ("minimum possible price"); per-offering exact prices via inventory | OAS |
| Personalization | ≤5 questions; types `text_input`, `dropdown`, `unlabeled_upload`, `labeled_upload`; `instructions` ≤120 chars; `add_on_price` USD 0.20–500 (optional text questions only) | PERS; PERSADDON; OAS |
| Processing / delivery | processing 1–10 days or weeks; delivery days 1–45 | OAS |
| Return deadline | one of 7, 14, 21, 30, 45, 60, 90 days | OAS |
| Products per listing | 2,500 (3 variations), 400 if all three properties drive price/qty/sku/readiness | THIRDVAR |

---

## F. Things a PIM connector must not miss

| Item | Detail | Source |
|---|---|---|
| Required create fields | `quantity`, `title`, `description`, `price`, `who_made`, `when_made`, `taxonomy_id`; `shipping_profile_id` and `readiness_state_id` required for `type=physical`; `image_ids` required to activate | OAS; LISTINGS |
| Legal/attribution enums | `who_made` ∈ `i_did | someone_else | collective`; `when_made` ∈ `made_to_order, 2020_2026, 2010_2019, 2007_2009, before_2007, 2000_2006, 1990s … 1900s, 1800s, 1700s, before_1700`; `is_supply` (Supplies heading) — "Requires 'who_made' and 'when_made'" | OAS |
| Production partners | `production_partner_ids[]` on create/update; partners are **read-only** via `getShopProductionPartners` (create in Shop Manager). `who_made=someone_else` handmade listings need one — enforcement is a marketplace policy, not an API validation (**unverified**). | OAS |
| Return policy | `return_policy_id` — "Required for active physical listings. This requirement does not apply to listings of **EU-based shops**." | OAS `updateListing` |
| `should_auto_renew` | "renews a listing for four months upon expiration" — set true unless the PIM manages expiry; otherwise listings drop to `expired` and need `state=active` | OAS |
| `is_taxable`, `is_customizable` | `is_taxable` applies shop tax rates; `is_customizable` allows custom-order requests (default true if shop accepts) | OAS |
| Listing `type` | `physical` (default) / `download` / `both`; digital files via `uploadListingFile` after creation; attaching a file to a physical listing converts it | OAS; LISTINGS |
| `state` machine | create → `draft`; `updateListing.state=active` publishes (needs image + shipping/readiness); `inactive` hides; `sold_out` and `expired` are system states; filter with `getListingsByShop?state=` | OAS; DEF |
| Inventory model | `products[]` each with `sku`, `property_values[{property_id,value_ids[],values[],scale_id}]`, `offerings[{price,quantity,is_enabled,readiness_state_id}]`; `*_on_property` arrays declare which properties drive price/qty/sku/readiness; "Listings you did not edit using the Etsy.com inventory tools have no inventory records" (batch returns `null`) | OAS; INVSHIP |
| Variation images | `updateVariationImages` maps `(property_id, value_id) → image_id` | OAS |
| Translations | per-language `title/description/tags`; shop `languages[]` lists enrolled languages; `getListing?language=` returns a translation | OAS |
| `includes` param | `getListing`/batch: `Images, Shop, User, Translations, Videos, Personalization, BuyerPrice`; `getListingsByShop` additionally still accepts `Shipping` and `Inventory` in its enum but INVSHIP says those two were removed in favour of the batch endpoints — treat as unreliable; `getListingInventory?includes=Listing` | OAS; INVSHIP |
| Buyer-facing price | `getListingsByListingIds?currency=EUR&buyer_country=DE` returns VAT-inclusive buyer price (`BuyerPrice` include) | OAS |
| Holiday preferences | US/CA only — no-op for an EU shop | OAS |
| Shop-level EU fields | `updateShop.policy_additional` EU-only; `Shop.include_dispute_form_link`, `policy_has_private_receipt_info` | OAS |
| GPSR / economic operator | Not in the API (C.6). Etsy's seller-side fields ("Manufacturers and Product safety info", shop-level Responsible Person) exist only in Shop Manager *(snippets of https://www.etsy.com/seller-handbook/article/1364599291081 and https://help.etsy.com/hc/en-gb/articles/19880002187927-How-to-Add-an-Economic-Operator)*. A PIM must keep these outside the Etsy sync or embed them in the description. | OAS; seller handbook snippets |
| Receipt address gating | Address fields are nullable and region-gated (A.8); `buyer_email` null unless granted | OAS |
| Shipping-notification side effect | Every successful `createReceiptShipment` emails the buyer; "Etsy posts the final transaction total immediately after a seller posts shipping details" | FULFIL |
| Money | `Money{amount, divisor, currency_code}`; receipts in shop currency; `Payment` amounts "in pennies"; ledger `amount`/`balance` integers with `currency` | DEF; OAS |
| Data-freshness terms | Listing content shown ≤6 h stale, other content ≤24 h stale; no caching beyond what is reasonably necessary *(snippet of API Terms)* | https://www.etsy.com/legal/api/ |
| Errors | All error responses are `{ "error": string }` (`ErrorSchema`); 400 request data, 401 "lacks valid authentication credentials", 403 "not allowed to", 404, 409 (duplicate readiness-state), 429 rate limit, 500 | OAS |
