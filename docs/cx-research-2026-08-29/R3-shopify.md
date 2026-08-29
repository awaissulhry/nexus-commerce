# R3 — Shopify connection + API-surface map for a self-owned PIM (EU merchant, own stores)

Researched 2026-08-29 against shopify.dev only. Every fact carries its URL. "unverified" = not confirmable from an official page fetched today. Where the brief's assumption differs from what the docs say today, the doc wins and the difference is flagged with **⚠**.

Headline facts that shape everything below:

- The **Dev Dashboard** (`dev.shopify.com/dashboard/<org-id>`) is now where apps are created; the Partner Dashboard still appears in some pages but app creation, versions, scopes, credentials and "Install app" live in the Dev Dashboard. https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard
- **⚠ Admin-created custom apps (Settings → Apps → Develop apps) can no longer be created**: "You can no longer create new admin-created custom apps. Existing apps are unaffected and continue to work." https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin
- There are now **three grants**: token exchange (embedded), authorization code (standalone/API-only), and **client credentials** ("server-side app that acts on stores in your own Shopify organization"). https://shopify.dev/docs/apps/build/authentication-authorization
- **⚠ Webhook retries are 8 over 4 hours** (not 19 over 48 h): "Webhooks will now be retried a total of 8 times over 4 hours using an exponential backoff schedule" (2024-09-10). https://shopify.dev/changelog/updates-to-webhook-retry-mechanism
- **⚠ Bulk operations: up to five concurrent per type per shop** from API 2026-01 (was one). https://shopify.dev/docs/api/usage/bulk-operations/queries

---

## A. Auth options — which gives "click Connect → sign in → Allow"

### A.1 The three grants (decision matrix)

| App shape | Grant | Merchant sees a consent screen? | Token | Source |
|---|---|---|---|---|
| Embedded in Shopify admin | Token exchange (ID token → access token, no redirect) | Scopes approved at install via Shopify managed installation | offline or online | https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange |
| Standalone / API-only (a non-embedded external PIM) | **Authorization code grant** | **Yes** — "redirect the merchant to Shopify, get their approval, and exchange a code for an access token" | offline (default) or online with `grant_options[]=per-user` | https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps |
| Server-side app acting only on stores in **your own** Dev Dashboard organization | **Client credentials grant** | **No** — "You request tokens programmatically when you need them"; no visible token in the admin | 24 h access token, `expires_in` "Always 86399" | https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant |

Overview page statements: embedded apps → "Token exchange"; "Standalone/API-only apps: Authorization code grant"; "Client credentials grant … for server-side integrations acting exclusively on your own stores"; "Shopify installs your app and updates its access scopes without calling your app" (managed installation, for CLI-built apps). https://shopify.dev/docs/apps/build/authentication-authorization

Token exchange "explicitly does not apply to non-embedded apps": "Standalone apps, running outside the Shopify admin, use" the authorization code grant. https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange

Shopify managed installation: "Standalone and API-only apps do **not** use Shopify managed installation. Instead, the merchant visits an install URL you create that redirects them through OAuth." https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps · "This guide is only relevant to standalone apps and legacy apps that aren't using Shopify managed installation." https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant

### A.2 Authorization code grant — exact contract (the "click → sign in → Allow" path for a non-embedded PIM)

Source for everything in this subsection unless noted: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant

- Applies to "standalone and API-only apps that run outside the Shopify admin and cannot use ID tokens." Note on the same page: "If your app only acts on stores in your own Shopify organization, use the client credentials grant instead."
- Authorize URL: `https://{shop}/admin/oauth/authorize` with `client_id`, `scope` (comma-separated), `redirect_uri` ("Must exactly match configured redirect URI"), `state` ("Randomly generated nonce unique to each request"), optional `grant_options[]=per-user` (online token).
- **Shop validation regex** (anchored): `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$` — "must be anchored at both ends to prevent attacks like `exampleshop.myshopify.com.attacker.example`".
- Callback: `https://your-app.example.com/callback?code={code}&hmac={hmac}&shop={shop}&state={nonce}&timestamp={timestamp}`.
- Nonce/state: compare received `state` against stored nonce; "If they don't match, reject the request."
- **HMAC verification**: remove `hmac`, sort remaining params alphabetically, HMAC-SHA256 with the client secret, "Use a constant-time comparison, such as crypto.timingSafeEqual in Node.js".
- Token endpoint: `POST https://{shop}/admin/oauth/access_token` with `client_id`, `client_secret`, `code`, and `expiring: '1'` ("required for new public apps").
- Offline response (expiring form): `access_token`, `scope`, `expires_in: 3600`, `refresh_token: "shprt_…"`, `refresh_token_expires_in: 7776000` (90 days). Online response adds `associated_user` and `associated_user_scope`.
- Scope check after exchange: "A write_* grant includes its matching read_* scope, so Shopify may return only the write scope."
- Use: header `X-Shopify-Access-Token: {access_token}` on GraphQL Admin requests.
- Redirect URIs configured in the Dev Dashboard app settings or the `[auth]` section of `shopify.app.toml` (`redirect_urls`; "minimum one required before public release"). https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
- Libraries with the checks built in: `@shopify/shopify-api` (Node), `shopify-api-ruby`. https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps

### A.3 Offline vs online tokens — lifetimes

| | Offline (non-expiring) | Offline (expiring) | Online |
|---|---|---|---|
| Lifetime | "grant permanent access until the app is uninstalled or the secret is revoked" | `expires_in` 3600 (1 h) + refresh token 90 days | "expires after 24 hours or when the user logs out of the Shopify admin, whichever comes first" |
| Who | "Public apps can't use them for Admin API requests after January 1, 2027. **This doesn't apply to custom apps or apps created by merchants.**" | "Public apps must use expiring offline access tokens for Admin API requests by January 1, 2027." "Shopify keeps one current expiring offline token per app and store" | per staff user; `associated_user.id`, `account_owner`, `collaborator`, `email_verified`; `associated_user_scope` = intersection of app scopes and user permissions; "No refresh token mechanism" |
| Source | https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/offline-access-tokens | same | https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/online-access-tokens |

Refresh flow (expiring offline): `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`; "every refresh returns a new access token and a new refresh token"; the previous refresh token stays usable until the earliest of: the new one is used, another grant issues a token, 30 days after first use, or the original 90-day expiry. https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/offline-access-tokens

Invalidation: "App uninstallation ends all token access"; "Client secret revocation terminates tokens"; older tokens retire when new ones are acquired through token exchange or authorization code grant (they "stay valid until their `expires_in` duration ends"). Same URL.

### A.4 Client credentials grant — the zero-UX path for the merchant's OWN stores

Source: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant (also at https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant)

- "Use the client credentials grant to get access tokens for a server-side app that acts on stores in your own Shopify organization."
- Only "when the app and the store belong to the same Shopify organization" — "Both appear under the same org in the Dev Dashboard" (`dev.shopify.com/dashboard/<org-id>`). Common failures: dev stores created outside the Dev Dashboard, or app and store in different orgs. Error otherwise: `Oauth error shop_not_permitted: Client credentials cannot be performed on this shop.`
- Requirements: a Dev Dashboard app; "You've selected the access scopes your app needs on your app's version in the Dev Dashboard"; "You've installed your app on your store".
- Request: `POST https://{SHOP}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials`, `client_id`, `client_secret`. Response: `{ "access_token", "scope", "expires_in": 86399 }` — "Always 86399 (24 hours)". Cache and refresh before expiry.
- Scopes: "The token request doesn't ask for scopes, so this is a readback of what you selected on your app's version in the Dev Dashboard." If a scope is missing: "release a new version with it and approve the change on the store."
- Installing the app on an org store in the Dev Dashboard: **Home → Install app → select or create the store → Install**. https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard
- unverified: whether the custom-distribution "single store unless Plus org" rule limits how many organization stores a client-credentials app may be installed on (the grant page mentions no store-count limit); whether the token is classed "offline"; whether webhooks are affected (nothing on the page says they are).

### A.5 "Custom app" created inside the store admin (manual-paste token)

- **Closed for new apps**: "You can no longer create new admin-created custom apps. Existing apps are unaffected and continue to work." Existing: token shown once at Apps → Develop apps → [app] → API credentials; rotation = "uninstall and reinstall the app from the Shopify admin"; "Don't delete the app itself." https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin
- The "Shopify admin" distribution type is "no longer available for new apps" and cannot use App Bridge or app extensions. https://shopify.dev/docs/apps/launch/distribution
- Its protected-data posture (existing apps): Level 1 "Always available"; Level 2 "Varies by plan". https://shopify.dev/docs/apps/launch/protected-customer-data
- Only public or custom apps receive access scopes; "legacy app types excluded" from the scope model. https://shopify.dev/docs/api/usage/access-scopes
- So for a new connector the manual-paste path does not exist; the nearest equivalent with no consent screen is the client credentials grant (A.4).

### A.6 Dev Dashboard app creation, credentials, distribution, review gates

- Create: Dev Dashboard → Create app → Start from Dev Dashboard → name → Create. Versions tab: app URL, Webhooks API version, scopes → Release. Client ID / secret: the app's **Settings**. Prerequisite: "a user with app development permissions", current Chrome/Firefox. https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard
- Distribution (permanent — "You can't change the distribution method after you select it"):

| | Public | Custom |
|---|---|---|
| Stores | "Can be installed on multiple Shopify stores" | "a single Shopify store, on multiple stores that belong to the same Plus organization", or "transfer-disabled development stores" |
| App review | "Yes" | "No" |
| Auth | Token exchange or auth code grant | Token exchange or auth code grant |
| Billing API | Supported | "can't charge merchants through Shopify's app billing system" |
| Source | https://shopify.dev/docs/apps/launch/distribution | same |

- Custom install link: enter the store's `myshopify.com` or `admin.shopify.com` domain; optionally uncheck "Allow multi-store installs for one Plus organization"; Generate link; copy and "send it to your users so that they can install your app". https://shopify.dev/docs/apps/launch/distribution/select-distribution-method · Link expiry "7 days" appears only on a legacy tutorial page (https://shopify.dev/tutorials/authenticate-a-custom-app-with-oauth) — unverified on the current page.
- Public app "unlisted": the official term is **visibility** — "Fully visible" vs "Limit visibility" (hidden from search/category pages but still installable "from an app listing page that uses a Shopify App Store URL"). "Only public apps qualify for App Store listing." https://shopify.dev/docs/apps/launch/distribution/visibility — Public distribution requires review regardless (table above), so "unlisted public" still means App Store review. unverified: any review-free public path.
- Review-gated capabilities:
  - **Protected customer data** — Public apps: Level 1 and Level 2 "Requires review"; **Custom apps: "Always available"** for both levels; dev-store-only installs exempt. Unapproved fields come back `null` with HTTP 200 and an `errors` entry "This app is not approved to access…". https://shopify.dev/docs/apps/launch/protected-customer-data
  - `read_all_orders` — "All relevant orders rather than the default window of orders created within the last 60 days"; approval via Partner Dashboard (Orders permissions). https://shopify.dev/docs/api/usage/access-scopes (unverified whether custom apps are exempt from this request)
  - Subscription APIs (`read_customer_payment_methods`, `*_own_subscription_contracts`) — Partner Dashboard approval. Payments dispute evidence/file-upload scopes — Shopify Support, public distribution only. `read_users` — Shopify Plus only. Same URL.
  - Payments Apps API — "available only to approved Payments Partners" (Payments Extension Review). https://shopify.dev/docs/api/payments-apps
  - Shopify Markets — no approval gate found on the Markets or scope pages (`read_markets`/`write_markets` listed without approval). unverified beyond that.

### A.7 Multi-store model

- Identity: `shop { id myshopifyDomain primaryDomain { host } name email currencyCode enabledPresentmentCurrencies plan { displayName } ianaTimezone shipsToCountries weightUnit }` — query needs no scope, reads "the access token used in the request". https://shopify.dev/docs/api/admin-graphql/latest/queries/shop → key each account on `shop.id` + `myshopifyDomain`, keep a token per shop.
- Install is per shop: each authorization code exchange returns a token for `{shop}`; "Shopify keeps one current expiring offline token per app and store". https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/offline-access-tokens
- N stores under custom distribution = one store per app unless the stores are in one Plus organization (A.6). For a merchant's own non-Plus stores in one Dev Dashboard org the client credentials grant works per store (A.4; store-count limit unverified).
- Lifecycle webhooks: `app/uninstalled`, `app/scopes_update`, `shop/update` (topic list, D). "App uninstallation ends all token access" (A.3). `shop/redact` arrives "48 hours after a store owner uninstalls your app". https://shopify.dev/docs/apps/build/privacy-law-compliance
- Re-install = run the grant again (new token); old tokens retire when a new one is acquired (A.3). No official page describes re-install semantics beyond that — unverified.

---

## B. Access scopes (Admin API)

Source for the whole table: https://shopify.dev/docs/api/usage/access-scopes. "Any permission to write a resource includes permission to read it"; "Apps should request only the minimum amount of data that's necessary". Granted scopes: `currentAppInstallation { accessScopes { handle description } }`. https://shopify.dev/docs/api/admin-graphql/latest/queries/currentAppInstallation

| Scope(s) | Grants | Approval |
|---|---|---|
| `read_all_orders` | orders beyond the default 60-day window | Partner Dashboard request |
| `read_analytics_annotations`, `write_analytics_annotations` | `AnalyticsAnnotation` (2026-10+) | — |
| `write_app_proxy` | app proxy | — |
| `read_assigned_fulfillment_orders`, `write_assigned_fulfillment_orders`, `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`, `read_third_party_fulfillment_orders`, `write_third_party_fulfillment_orders`, `read_marketplace_fulfillment_orders` | `FulfillmentOrder` | — |
| `read_cart_transforms`, `write_cart_transforms` | `CartTransform` | — |
| `read_checkout_branding_settings`, `write_checkout_branding_settings` | `CheckoutBranding` | — |
| `read_checkout_and_accounts_configurations`, `write_…` | `CheckoutAndAccountsConfiguration` | — |
| `read_content`, `write_content`, `read_online_store_pages` | `Article`, `Blog`, `Comment`, `Page` | — |
| `read_customer_events`, `write_pixels` | Web Pixels | — |
| `read_customer_merge`, `write_customer_merge` | customer merge | — |
| `read_customer_payment_methods` | `CustomerPaymentMethod` | Partner Dashboard (Subscription APIs) |
| `read_customers`, `write_customers` | `Customer`, `Segment`, `Company`, `CompanyLocation` | — (protected customer data rules apply) |
| `read_delivery_customizations`, `write_delivery_customizations` | `DeliveryCustomization` | — |
| `read_discounts`, `write_discounts` | discounts | — |
| `read_draft_orders`, `write_draft_orders` | `DraftOrder` | — |
| `read_files`, `write_files` | `GenericFile` (Files) | — |
| `read_fulfillments`, `write_fulfillments` | `FulfillmentService` | — |
| `read_gift_cards`, `write_gift_cards` | `GiftCard` | — |
| `read_inventory`, `write_inventory` | `InventoryLevel`, `InventoryItem` | — |
| `read_inventory_shipments`, `write_inventory_shipments`; `read/write_inventory_shipments_received_items`; `read_inventory_transfers`, `write_inventory_transfers` | inventory shipments / transfers | — |
| `read_legal_policies` | `ShopPolicy` | — |
| `read_locales`, `write_locales` | `ShopLocale` | — |
| `read_locations`, `write_locations` | `Location` | — |
| `read_markets`, `write_markets` | `Market` | — |
| `read_marketing_events`, `write_marketing_events` | `MarketingEvent`, `MarketingActivity` | — |
| `read_merchant_approval_signals` | `MerchantApprovalSignals` | — |
| `read_metaobject_definitions`, `write_metaobject_definitions` | `MetaobjectDefinition` | — |
| `read_metaobjects`, `write_metaobjects` | `Metaobject` | — |
| `read_online_store_navigation`, `write_online_store_navigation` | `UrlRedirect` | — |
| `read_order_edits`, `write_order_edits` | `CalculatedOrder` | — |
| `read_orders`, `write_orders` | `Order`, `Fulfillment` and related | — (protected customer data) |
| `read_own_subscription_contracts`, `write_own_subscription_contracts` | subscription contracts | Partner Dashboard (Subscription APIs) |
| `read_payment_customizations`, `write_payment_customizations` | `PaymentCustomization` | — |
| `read_payment_gateways`, `write_payment_gateways`; `write_payment_sessions` | Payments Apps API | Payments partner status (A.6) |
| `read_payment_mandate`, `write_payment_mandate` | `PaymentMandate` | — |
| `read_payment_terms`, `write_payment_terms` | `PaymentSchedule`, `PaymentTerms` | — |
| `read_price_rules`, `write_price_rules` | `PriceRule` (legacy discounts) | — |
| `read_privacy_settings`, `write_privacy_settings` | `CookieBanner`, `PrivacySettings` | — |
| `read_products`, `write_products` | `Product`, `ProductVariant`, `Collection` (also catalogs/price lists — see G) | — |
| `read_reports`, `write_reports` | `shopifyqlQuery`, `AnalyticsTarget` | — |
| `read_returns`, `write_returns` | `Return` | — |
| `read_script_tags`, `write_script_tags` | `ScriptTag` | — |
| `read_shipping`, `write_shipping` | `DeliveryCarrierService` | — |
| `read_shopify_payments_disputes` | `ShopifyPaymentsDispute` | — |
| `read/write_shopify_payments_dispute_evidences`, `read/write_shopify_payments_dispute_file_uploads` | dispute evidence | Shopify Support; public distribution |
| `read_shopify_payments_payouts` | `ShopifyPaymentsPayout` | — |
| `read_store_credit_accounts`; `read/write_store_credit_account_transactions` | store credit | — |
| `read_themes`, `write_themes` | `OnlineStoreTheme` | — |
| `read_translations`, `write_translations` | `TranslatableResource`, `Translation` | — |
| `read_users` | `StaffMember` | Shopify Plus only |
| `read_validations`, `write_validations` | `Validation` | — |
| `read_publications`, `write_publications` | publications / sales-channel publishing | — (from https://shopify.dev/docs/apps/build/sales-channels/product-publishing; not in the scope table fetch) |

Storefront (`unauthenticated_*`) and Customer Account (`customer_*`) scopes exist but are not Admin-API scopes (same page).

**Scope changes**: in TOML, `scopes` (required, granted at install) vs `optional_scopes` (requested later, merchant can decline or revoke). Changing `scopes`: embedded apps — "Merchants are prompted to approve the updated access scopes when they open your app"; **standalone apps — merchants must be "sent through the authorization URL again with the updated scope list"**. Optional scopes for standalone apps: `https://admin.shopify.com/store/{STORE_NAME}/oauth/install?client_id={CLIENT_ID}&optional_scopes={REQUESTED_SCOPES}`. `app/scopes_update` fires when the merchant approves added required scopes, opens the app after a scope reduction, or approves optional scopes. https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes · `app/scopes_update` available from Webhook API 2024-10. https://shopify.dev/changelog/new-webhook-topic-app-scopes_update · TOML `use_legacy_install_flow=true` = legacy OAuth flow ("not recommended as installations may have inconsistent scope sets"). https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration

---

## C. API surface

### C.1 GraphQL Admin API (primary)

Endpoint `https://{store_name}.myshopify.com/admin/api/2026-07/graphql.json`, header `X-Shopify-Access-Token`; latest 2026-07; "the GraphQL API can return a `200 OK` response code in cases that would typically produce 4xx or 5xx errors in REST". https://shopify.dev/docs/api/admin-graphql

QueryRoot fields confirmed (the index page truncates): `products, productVariants, inventoryItems, inventoryLevel, locations, collections, metafieldDefinitions, metaobjects, orders, draftOrders, fulfillmentOrders, returns, refund, customers, companies, discountNodes, giftCards, markets, catalogs, priceLists, publications, deliveryProfiles, shopifyPaymentsAccount, files, translatableResources, sellingPlanGroups, checkoutBranding, shop, webhookSubscriptions, bulkOperation, currentAppInstallation, segments, urlRedirects, themes`. https://shopify.dev/docs/api/admin-graphql/latest/objects/QueryRoot

| Family | Representative queries / mutations | Scope | Source |
|---|---|---|---|
| Products, variants, options, media | `products`, `productSet`, `productCreate/Update`, `productVariantsBulkCreate/Update/Delete`, `productOptionsCreate`, `productUpdateMedia` | `write_products` | https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet |
| Inventory | `inventoryItems`, `inventoryLevel`, `inventorySetQuantities`, `inventoryAdjustQuantities`, `inventoryMoveQuantities`, `inventoryActivate` | `write_inventory` | https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps |
| Locations | `locations`, `locationAdd`, `locationActivate/Deactivate` | `write_locations` | scope page |
| Collections | `collectionCreate`, `collectionAddProducts` | `write_products` | https://shopify.dev/docs/apps/build/graphql/basics/mutations |
| Metafields / metaobjects | `metafieldDefinitionCreate`, `metafieldsSet`, `metaobjectDefinitionCreate`, `metaobjectCreate`, `metaobjectUpsert` | `write_metaobject_definitions`, `write_metaobjects` | https://shopify.dev/docs/apps/build/custom-data |
| Orders / order edits | `orders`, `orderCreate`, `orderUpdate`, `orderEditBegin` | `write_orders`, `write_order_edits` | Mutation object |
| Draft orders | `draftOrders`, `draftOrderCreate` | `write_draft_orders` | Mutation object |
| Fulfillment / fulfillment orders | `fulfillmentOrders`, `fulfillmentCreate`, `fulfillmentOrderMove` | `*_fulfillment_orders`, `write_fulfillments` | Mutation object |
| Returns / refunds | `returns`, `returnCreate`, `refund`, `refundCreate` | `write_returns`, `write_orders` | Mutation object |
| Customers, B2B companies | `customers`, `customerCreate`, `companies`, `companyCreate`, `CompanyLocation`, `CompanyContact` | `write_customers` | https://shopify.dev/docs/apps/build/b2b |
| Discounts / price rules | `discountNodes`, `discountCodeBasicCreate`, `discountAutomaticBasicCreate` | `write_discounts` | Mutation object |
| Gift cards | `giftCards`, `giftCardCreate` — "Requires `write_gift_cards`" (no plan note on the page) | `write_gift_cards` | https://shopify.dev/docs/api/admin-graphql/latest/mutations/giftCardCreate |
| Markets, catalogs, price lists | `markets`, `marketCreate`, `catalogs`, `catalogCreate`, `priceLists`, `priceListCreate`, `priceListFixedPricesAdd`, `catalogContextUpdate` | `write_markets`; catalogs/price lists need `write_products` | https://shopify.dev/docs/api/admin-graphql/latest/mutations/catalogCreate · https://shopify.dev/docs/api/admin-graphql/latest/mutations/priceListCreate |
| Publications / channels | `publications`, `publishablePublish`, `publishableUnpublish`, `publicationUpdate` | `write_publications` | https://shopify.dev/docs/apps/build/sales-channels/product-publishing |
| Shipping | `deliveryProfiles`, `deliveryProfileCreate` | `write_shipping` | Mutation object |
| Shopify Payments | `shopifyPaymentsAccount` (payouts, balance, disputes) | `read_shopify_payments_payouts`, `read_shopify_payments_disputes` | scope page |
| Files / media | `files`, `fileCreate`, `stagedUploadsCreate` | `write_files` | https://shopify.dev/docs/api/admin-graphql/latest/mutations/stagedUploadsCreate |
| Translations / locales | `translatableResources`, `translationsRegister`, `shopLocaleEnable` | `write_translations`, `write_locales` | https://shopify.dev/docs/apps/build/markets/manage-translated-content |
| Selling plans / subscriptions | `sellingPlanGroups`, `sellingPlanGroupCreate` | `write_products` + `*_own_subscription_contracts` (approval) | https://shopify.dev/docs/apps/build/purchase-options |
| Checkout branding | `checkoutBranding`, `checkoutBrandingUpsert` | `write_checkout_branding_settings` | scope page |
| Store properties | `shop` | none | https://shopify.dev/docs/api/admin-graphql/latest/queries/shop |
| Webhooks | `webhookSubscriptions`, `webhookSubscriptionCreate`, `pubSubWebhookSubscriptionCreate`, `eventBridgeWebhookSubscriptionCreate` | — | https://shopify.dev/docs/apps/build/webhooks/subscribe/subscribe-using-api |
| Bulk | `bulkOperation`, `bulkOperationRunQuery`, `bulkOperationRunMutation` | — | C.3 |
| Flow | `flowTriggerReceive` | — | https://shopify.dev/docs/apps/build/flow/triggers/reference |

Mutation object entry point: "The schema's entry point for all mutation operations." https://shopify.dev/docs/api/admin-graphql/latest/objects/mutation

### C.2 REST Admin API — legacy

"The REST Admin API is a legacy API as of October 1, 2024." "Starting April 1, 2025, all new public apps must be built exclusively with the GraphQL Admin API." "Some newer platform features may only be available in GraphQL." https://shopify.dev/docs/api/admin-rest

### C.3 Bulk operations

- Query: `bulkOperationRunQuery` → JSONL download URL; results carry `__parentId` ("not in the API schema"); statuses CREATED / RUNNING / COMPLETED / FAILED / CANCELED; error codes ACCESS_DENIED / INTERNAL_SERVER_ERROR / TIMEOUT; "each app can run up to five bulk query operations per shop simultaneously" (2026-01+; earlier: one per type); max five connections, two levels deep; URLs "expire after one week"; must "complete within 10 days"; completion via `bulk_operations/finish` webhook or polling. https://shopify.dev/docs/api/usage/bulk-operations/queries
- Mutation: `stagedUploadsCreate` with `resource: BULK_MUTATION_VARIABLES`, `mimeType: "text/jsonl"`, `httpMethod: POST` → multipart upload (file param last) → `bulkOperationRunMutation`; "up to five bulk mutation operations per shop simultaneously" (2026-01+); file ≤ 100 MB; must complete within 24 h; one connection field per mutation; line-level errors in the output JSONL; not subject to standard rate limits. Supported mutations named: `productCreate`, `collectionCreate`, `productUpdate`, `productUpdateMedia` (and `productSet`, which "when run within bulk operations, synchronous mode is enforced" — https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet). https://shopify.dev/docs/api/usage/bulk-operations/imports
- "Bulk operations … don't have the max cost limits or rate limits that single queries have." https://shopify.dev/docs/api/usage/limits

### C.4 Other APIs

| API | Purpose | Why a PIM does / doesn't need it | Source |
|---|---|---|---|
| Storefront API | buyer-facing; "custom, scalable, and performant shopping experiences"; tokenless or public/private tokens; `unauthenticated_*` scopes; "cannot perform administrative writes"; "You can't use Storefront API to duplicate existing Shopify functionality" | Not needed: no admin writes, no PIM data model; only if the PIM renders a headless storefront | https://shopify.dev/docs/api/storefront |
| Partner API | Partner Dashboard data (transactions, app events); token from Settings → Partner API clients, `X-Shopify-Access-Token`; 4 req/s; "for analytics purposes only" | Not needed | https://shopify.dev/docs/api/partner |
| Payments Apps API | payment session resolve/pend/reject, captures, refunds; "available only to approved Payments Partners" | Not applicable | https://shopify.dev/docs/api/payments-apps |
| Customer Account API | buyer's own account data; OAuth with customer login, PKCE; 7500 cost points per store+customer | Not needed | https://shopify.dev/docs/api/customer |
| Events (developer preview) | "next-generation subscription mechanism, with field-level triggers, conditional filters, and custom GraphQL payloads"; unstable only; "Webhooks remain fully supported"; can coexist in TOML | Watch; not production | https://shopify.dev/docs/apps/build/events-webhooks |

### C.5 Versioning

- "Shopify releases a new API version every three months at the beginning of the quarter, at 5pm UTC. Version names are date-based (for example, `2026-04`)." "Each stable version is supported for a minimum of 12 months, with at least nine months of overlap." Version goes in the URL; the response carries `X-Shopify-API-Version`. "If your app targets an inaccessible version, Shopify falls forward and responds using the oldest accessible stable version." Types: stable, release candidate, unstable. Current stable list on the page: 2025-07, 2025-10, 2026-01, 2026-04, 2026-07, 2026-10, 2027-01. https://shopify.dev/docs/api/usage/versioning
- `X-Shopify-API-Deprecated-Reason`: "As of the 2025-04 API version … returns the list of detected deprecations instead of a generic URL" (e.g. `Shop.products, Shop.productVariants`). https://shopify.dev/changelog/graphql-return-actual-deprecation-reasons · Deprecation channels: API health report, GraphiQL warnings, changelog, reference docs, emergency-contact emails. https://shopify.dev/docs/api/usage/versioning
- **Idempotency**: from 2026-04 the `@idempotent(key:)` directive is mandatory for `refundCreate`, `inventoryShipmentReceive`, `inventoryAdjustQuantities`, `inventoryMoveQuantities`, `inventorySetQuantities`, `inventorySetOnHandQuantities`, `inventoryShipmentCreateInTransit`, `inventoryShipmentCreate`, `inventoryTransferCreate`, `inventoryTransferCreateAsReadyToShip`, `inventoryTransferDuplicate`, `inventoryTransferSetItems`, `inventorySetScheduledChanges`, `inventoryActivate`, `inventoryShipmentAddItems`, `locationActivate`, `locationDeactivate` (2025-12-12). https://shopify.dev/changelog/making-idempotency-mandatory-for-inventory-adjustments-and-refund-mutations · Syntax `@idempotent(key: "<uuid>")`. https://shopify.dev/docs/api/usage/idempotent-requests · Keys tracked 24 h; `IDEMPOTENCY_CONCURRENT_REQUEST` on concurrent duplicates. https://shopify.dev/docs/api/usage/implementing-idempotency

---

## D. Webhooks

### D.1 Topic list (from https://shopify.dev/docs/api/webhooks)

| Family | Topics |
|---|---|
| App | `app/scopes_update`, `app/uninstalled`, `app_purchases_one_time/update`, `app_subscriptions/approaching_capped_amount`, `app_subscriptions/update` |
| Audit | `audit_events/admin_api_activity` |
| Bulk | `bulk_operations/finish` |
| Carts / checkouts | `carts/create`, `carts/update`, `checkouts/create`, `checkouts/delete`, `checkouts/update` |
| Channels | `channels/delete` |
| Collections | `collections/create`, `collections/delete`, `collections/update`, `collection_listings/add|remove|update`, `collection_publications/create|delete|update` |
| Companies (B2B) | `companies/create|delete|update`, `company_contact_roles/assign|revoke`, `company_contacts/create|delete|update`, `company_locations/create|delete|update` |
| Customers | `customers/create|delete|disable|enable|merge|purchasing_summary|update`, `customers/data_request`, `customers/redact`, `customer_groups/create|delete|update`, `customer_payment_methods/create|revoke|update`, `customer_account_settings/update`, `customer.joined_segment`, `customer.left_segment`, `customer.tags_added`, `customer.tags_removed`, `customers_email_marketing_consent/update`, `customers_marketing_consent/update`, `customers_whats_app_marketing_consent/update` |
| Delivery | `delivery_promise_settings/update` |
| Discounts | `discounts/create|delete|update`, `discounts/redeemcode_added`, `discounts/redeemcode_removed` |
| Disputes | `disputes/create|update` |
| Domains | `domains/create|destroy|update` |
| Draft orders | `draft_orders/create|delete|update` |
| Fulfillment | `fulfillment_events/create|delete`, `fulfillment_holds/added|released`, `fulfillments/create|update`, `fulfillment_orders/cancellation_request_accepted|cancellation_request_rejected|cancellation_request_submitted|cancelled|fulfillment_request_accepted|fulfillment_request_rejected|fulfillment_request_submitted|fulfillment_service_failed_to_complete|hold_released|line_items_prepared_for_local_delivery|line_items_prepared_for_pickup|manually_reported_progress_stopped|merged|moved|order_routing_complete|placed_on_hold|progress_reported|rescheduled|scheduled_fulfillment_order_ready|split` |
| Gift cards | `gift_cards/create|delete|update` |
| Inventory | `inventory_items/create|delete|update`, `inventory_levels/connect|disconnect|update` |
| Locales / locations | `locales/create|delete|update`, `locations/create|delete|update` |
| Markets | `markets/create|delete|update` |
| Metafields / metaobjects | `metafield_definitions/create|delete|update`, `metaobjects/create|delete|update` |
| Orders | `orders/cancelled|create|deleted|fulfilled|paid|partially_fulfilled|updated`, `order_transactions/create` |
| Payment terms | `payment_schedules/create|delete|update`, `payment_terms/create|delete|update` |
| Products | `products/create|delete|update`, `variants/create|delete|update`, `product_listings/add|remove|update`, `product_publications/create|delete|update`, `product_feeds/create|delete|update` (+ `product_feeds/full_sync`, `full_sync_finish`, `incremental_sync` — shop-specific subscriptions only, per https://shopify.dev/docs/apps/build/webhooks/subscribe), `scheduled_product_listings/add|remove|update` |
| Profiles / publications | `profiles/create|delete|update`, `publications/create|delete|update` |
| Refunds / returns | `refunds/create`, `returns/cancel|create|update`, `reverse_deliveries/create|update`, `reverse_fulfillment_orders/break|create|dispose|open|update` |
| Segments | `segments/create|delete|update` |
| Selling plans / subscriptions | `selling_plan_groups/create|delete|update`, `subscription_billing_attempts/challenged|failure|skipped|success`, `subscription_billing_cycles/activated|expired|skipped|upcoming`, `subscription_contracts/created|updated` |
| Shipping / shop | `shipping_addresses/create|update`, `shop/update`, `shop/redact` |
| Tender / themes | `tender_transactions/create`, `themes/create|delete|publish|update` |

"Each topic you subscribe to requires a corresponding access scope" (e.g. `products/update` needs `read_products`). https://shopify.dev/docs/apps/build/webhooks/subscribe/subscribe-using-api

### D.2 Subscription methods

- **App-specific** (recommended): "Defined in `shopify.app.toml` and applied uniformly across every shop that installs your app." **Shop-specific**: "Created using GraphQL Admin API; configuration can differ per shop." Migrating: "remove existing subscriptions to the same topics first to avoid conflicts and duplicate notifications." Both support HTTPS, Google Pub/Sub, Amazon EventBridge. https://shopify.dev/docs/apps/build/webhooks/subscribe
- TOML: `[webhooks] api_version` (required), `[[webhooks.subscriptions]]` with `topics`, `uri` (HTTPS URL, relative path, `pubsub://{project-id}:{topic-id}`, or EventBridge ARN), `compliance_topics`, `filter`, `include_fields`. https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
- API: `webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { uri, format, includeFields, metafieldNamespaces, filter })`; `pubSubWebhookSubscriptionCreate`, `eventBridgeWebhookSubscriptionCreate`. https://shopify.dev/docs/apps/build/webhooks/subscribe/subscribe-using-api
- Filters: Shopify API search syntax, e.g. `"status:active AND (product_type:Music OR product_type:Movies)"`, nested `variants.price:>=10.00`; since 2024-07; metaobject topics require `type:{type}`. https://shopify.dev/docs/apps/build/webhooks/customize/filters

### D.3 Delivery, verification, guarantees

- Headers: `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256` ("Base64-encoded HMAC signature… HTTPS only"), `X-Shopify-Shop-Domain`, `X-Shopify-API-Version`, `X-Shopify-Webhook-Id` ("unique composite key per delivery… deduplicate"), `X-Shopify-Triggered-At`, `X-Shopify-Event-Id` ("shared across all deliveries produced by the same merchant action"), optional `X-Shopify-Name`. "Treat header names as case-insensitive… HTTP/2 often lowercases them." https://shopify.dev/docs/apps/build/webhooks/delivery-structure
- HMAC: "compute HMAC-SHA256 of the raw request body using your app's client secret as the key, then compare it to the decoded header value" with a timing-safe compare; raw body before any JSON middleware; invalid → `401` "HMAC validation failed." https://shopify.dev/docs/apps/build/webhooks/verify-deliveries · https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- Timeouts/retries: "one-second connection timeout and a five-second timeout for the entire request"; "If Shopify receives no response or an error, it retries 8 times over the next 4 hours"; "After 8 consecutive failures, the subscription is automatically deleted if it was configured using the Admin API" (warning emails to the emergency developer email). https://shopify.dev/docs/apps/build/webhooks/verify-deliveries · exponential backoff, original payload preserved: https://shopify.dev/changelog/updates-to-webhook-retry-mechanism · "Any response outside the 200 range, including 3XX codes, is treated as an error." https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- Ordering / duplicates: "Shopify doesn't guarantee ordering within a topic, or across different topics for the same resource" — use `X-Shopify-Triggered-At`; ignore duplicates via `X-Shopify-Webhook-Id`; "Webhook delivery isn't always guaranteed" — reconcile by fetching data for the outage period. https://shopify.dev/docs/apps/build/webhooks · https://shopify.dev/docs/apps/build/webhooks/troubleshooting-webhooks
- **⚠** "19 retries over 48 hours" is not on any current page fetched; treat as outdated.

### D.4 Mandatory compliance webhooks

`customers/data_request`, `customers/redact`, `shop/redact` ("48 hours after a store owner uninstalls your app"); configured via `compliance_topics` in `shopify.app.toml`; respond 200; invalid HMAC → 401; "Complete the action within 30 days"; "Any app that you distribute through the Shopify App Store must respond to data subject requests, regardless of whether the app collects personal data." https://shopify.dev/docs/apps/build/privacy-law-compliance — unverified whether custom-distribution apps are required to implement them (the page scopes the requirement to App Store apps); implement them anyway.

---

## E. Rate limits

- GraphQL Admin: cost points — scalars/enums 0, objects 1, mutations 10, connections sized by `first`/`last`; leaky bucket refunded "the difference between the requested cost and the actual cost". Restore rates: Standard "100 points/second", Advanced "200 points/second", Plus "1000 points/second", Enterprise (Commerce Components) "2000 points/second". "A single query may not exceed a cost of 1,000 points." Arrays max 250; pagination capped at 25,000 objects. `extensions.cost = { requestedQueryCost, actualQueryCost, throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate } }`. "recommended backoff time is one second"; use caching and bulk operations. https://shopify.dev/docs/api/usage/limits — **Bucket sizes per plan are not stated on the page** (the example shows `maximumAvailable: 1000`, `restoreRate: 50`); unverified.
- REST: "Bucket size: `40 requests/app/store`", "Leak rate: `2/second`", Plus ×10 (400 / 20 per s); header `X-Shopify-Shop-Api-Call-Limit: 32/40`; `429 Too Many Requests` + `Retry-After` seconds. https://shopify.dev/docs/api/admin-rest/usage/rate-limits
- Bulk: five concurrent per type per shop (2026-01+), exempt from cost limits (C.3).
- Variant throughput: "After this threshold is reached, no more than 10,000 new variants can be created per day" (at 500,000+ variants). https://shopify.dev/docs/api/usage/limits
- Storefront: no fixed limit for buyer traffic; bots rate-limited; `430 Shopify Security Rejection`. https://shopify.dev/docs/api/storefront · Customer Account API 100/200/200/400 points/s by plan. https://shopify.dev/docs/api/usage/limits

---

## F. Sandbox — development stores

- "Dev stores are testing environments that you own and control." Create in Dev Dashboard → Stores → Create store → type Dev → plan (Basic, Grow, Advanced, Plus) → optional feature previews. Can: test apps via Shopify CLI, log in as owner, "test orders via … the Bogus test gateway or by enabling test mode with your payment processor", preview the password-protected storefront. Cannot: "process real transactions or generate actual revenue"; "Dev stores can't be converted to production stores"; cannot remove the password page; not transferable to clients (use client transfer stores). https://shopify.dev/docs/api/development-stores
- Custom apps may be installed on "transfer-disabled development stores". https://shopify.dev/docs/apps/launch/distribution
- Protected customer data: "You don't need to submit a request for review for apps that are installed only on development stores." https://shopify.dev/docs/apps/launch/protected-customer-data
- Test-order limits on dev stores: changelog exists (https://shopify.dev/changelog/changes-to-order-and-payment-testing-on-all-development-stores) — page returned 404 today; number of Bogus test orders per dev store: unverified. No real payouts by construction ("cannot process real transactions").

---

## G. What a serious integrator does that a PIM might miss

1. **Markets / catalogs / price lists (EU multi-currency)** — a Market is "a group of buyers that a merchant targets with a specific buying experience", matched by geography, retail location or B2B company; catalogs control availability per market ("excluded … hidden from storefronts, omitted from search results, and blocked from being added to cart"); pricing by "Percentage adjustments" or "Fixed pricing" in local currency; presentment vs shop vs settlement currency. https://shopify.dev/docs/apps/build/markets · `catalogCreate { title, status: ACTIVE|DRAFT, context { marketIds | companyLocationIds }, priceListId, publicationId }` — `write_products`. https://shopify.dev/docs/api/admin-graphql/latest/mutations/catalogCreate · `priceListCreate { name, currency, parent { adjustment { type: PERCENTAGE_INCREASE|PERCENTAGE_DECREASE, value } } }` + `priceListFixedPricesAdd`, `priceListFixedPricesByProductUpdate`, `catalogContextUpdate`, `marketCreate`. https://shopify.dev/docs/api/admin-graphql/latest/mutations/priceListCreate
2. **Publication to sales channels** — catalogs of three kinds (`AppCatalog` = channels such as Online Store/POS, `MarketCatalog`, `CompanyLocationCatalog`); `publications(first:20){ nodes { id autoPublish supportsFuturePublishing catalog { id title } } }`; `publishablePublish` / `publishableUnpublish`; `publicationUpdate` with `publishablesToAdd`/`publishablesToRemove` (max 50 each); scopes `read_publications`, `write_publications`, `read_products`; **variant-level publishing from 2026-07** ("Variants remain visible only when the product is published AND the variant is published to that channel"); `publishablePublishToCurrentChannel` deprecated. https://shopify.dev/docs/apps/build/sales-channels/product-publishing
3. **Metafield definitions & app-owned data** — definitions give "type validation, Shopify admin integration, query filtering, access control"; app-owned definitions via TOML, merchant-owned via `metafieldDefinitionCreate`; standard definitions exist (ISBN, ingredients, care). https://shopify.dev/docs/apps/build/custom-data · Ownership: `$app` (GraphQL) / `app` (TOML) namespace = app-owned, "view-only in Shopify admin by default" (`merchant_read` or `merchant_read_write`); non-reserved (`custom`) = merchant-owned; `shopify--` = Shopify-controlled; storefront access `none|public_read`; customer-account `none|read|read_write`. https://shopify.dev/docs/apps/build/custom-data/ownership · Metaobjects = "structured data with multiple related field values"; `metaobjectDefinitionCreate`, `metaobjectCreate`; `$app:author`-style types. https://shopify.dev/docs/apps/build/custom-data/metaobjects (limits per shop: unverified)
4. **Inventory CAS writes** — `inventorySetQuantities(input: { name: "available"|"on_hand", reason, referenceDocumentUri, ignoreCompareQuantity, quantities: [{ inventoryItemId, locationId, quantity, compareQuantity }] })` — "supports compare-and-set functionality to handle concurrent requests properly"; mismatch → error; `@idempotent` required from 2026-04; `write_inventory`. https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities · States: `incoming, on_hand, available, committed, reserved, damaged, safety_stock, quality_control`; "You can't use the Admin API to adjust or move inventory quantities in the `committed` state"; `inventoryAdjustQuantities` (delta), `inventoryMoveQuantities` (between states); all take `referenceDocumentUri`. https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps
5. **`productSet` upsert** — create-or-update by `identifier` (id or handle); `synchronous: true` (default) returns the product, `synchronous: false` returns `ProductSetOperation` (poll `productOperation`); list fields (variants, collections, metafields) are replaced ("deletes any not included"), other fields patch; max 2048 variants per product; `write_products`; in bulk operations synchronous is enforced. https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet
6. **Staged uploads for images/files** — `stagedUploadsCreate([{ filename, mimeType, resource: PRODUCT_IMAGE|VIDEO|MODEL_3D|COLLECTION_IMAGE|SHOP_IMAGE|URL_REDIRECT_IMPORT|FILE|BULK_MUTATION_VARIABLES, fileSize (required for VIDEO/MODEL_3D), httpMethod: POST|PUT }])` → `stagedTargets { url resourceUrl parameters }` → upload → use `resourceUrl` as `originalSource` in `fileCreate` / product media mutations. https://shopify.dev/docs/api/admin-graphql/latest/mutations/stagedUploadsCreate
7. **Translations for EU locales** — scopes `read_products`, `write_translations`, `write_locales`; `shopLocaleEnable` (`en`, `en-UK`), `shopLocaleUpdate` to publish; `translatableResources(resourceType:)` returns `digest`; `translationsRegister({ key, value, locale, translatableContentDigest, marketId? })` (market-scoped translations optional); max 20 enabled and 20 published locales; `tags` not translatable; only publicly accessible metafields are translatable; primary locale not changeable via API. https://shopify.dev/docs/apps/build/markets/manage-translated-content · Resource types include `PRODUCT, PRODUCT_OPTION, PRODUCT_OPTION_VALUE, COLLECTION, METAFIELD, METAOBJECT, SELLING_PLAN, SELLING_PLAN_GROUP, SHOP, SHOP_POLICY, PAGE, ARTICLE, BLOG, MENU, LINK, FILTER, DELIVERY_METHOD_DEFINITION, EMAIL_TEMPLATE, PACKING_SLIP_TEMPLATE, PAYMENT_GATEWAY, MEDIA_IMAGE, ONLINE_STORE_THEME*` (30 values). https://shopify.dev/docs/api/admin-graphql/latest/enums/translatableresourcetype
8. **Shopify Flow triggers** — extension `type = "flow_trigger"` with `[settings.fields]`; app sends `flowTriggerReceive(handle:, payload:)`; payload "must be under 50000 bytes"; "Same rate limits as the Shopify API"; API ≥ 2023-10. https://shopify.dev/docs/apps/build/flow/triggers/reference · "Flow is an optional app that's available to Shopify merchants on any paid plan" but for custom apps "your Flow app extensions are available only to a Shopify Plus store that has your app installed." https://shopify.dev/docs/apps/build/flow (action HMAC details: unverified)
9. **Scope drift detection** — `app/scopes_update` webhook + `currentAppInstallation.accessScopes` (B).
10. **GDPR / data retention** — protected-data Level 1 obligations include "Apply retention periods to make sure that personal data isn't kept for longer than needed", "Encrypt data at rest and in transit", "Make privacy and data protection agreements with your merchants"; Level 2 adds encrypted backups, test/prod separation, DLP, limited staff access, strong passwords, access log, incident response policy. https://shopify.dev/docs/apps/launch/protected-customer-data · Privacy policy must state retention duration and processing locations. https://shopify.dev/docs/apps/launch/privacy-requirements · `shop/redact` at +48 h after uninstall; 30-day completion. https://shopify.dev/docs/apps/build/privacy-law-compliance
11. **B2B** — `Company`, `CompanyLocation`, `CompanyContact`, catalogs and payment terms; B2B resources available to "Only dev stores, Shopify Plus Partners, and Shopify affiliates" during development; merchant needs "a plan that supports B2B capabilities". https://shopify.dev/docs/apps/build/b2b
12. **Selling plans** — `write_products` + `read/write_own_subscription_contracts`; "Most subscriptions, pre-order and try before you buy apps need to request API access through the Partner Dashboard." https://shopify.dev/docs/apps/build/purchase-options
13. **App subscriptions / billing** — not needed: custom distribution "can't charge merchants through Shopify's app billing system". https://shopify.dev/docs/apps/launch/distribution
14. **Webhook filters + `include_fields`** to cut payload volume (D.2); **Events API** as the future replacement to watch (C.4).
15. **Idempotency keys** on every inventory/refund write from 2026-04 (C.5).
