# R1 — Amazon SP-API + Amazon Ads API: connection and API-surface map (EU seller)

Researched 2026-08-29 against official docs only: `developer-docs.amazon(.com)/sp-api` (the `.com` host 301-redirects to `developer-docs.amazon`), `advertising.amazon.com/API/docs`, `developer-docs.shipping.amazon.com`. Every fact carries its source URL. "unverified" = not confirmable from an official page I could read. Third-party tooling/licensing is out of scope and not discussed.

Doc-access notes (matter for anyone re-checking): the SP-API docs expose a machine index at https://developer-docs.amazon/sp-api/llms.txt; the Ads docs are a client-rendered SPA (a plain fetch returns only the page title — a browser is needed).

---

## A. SP-API authorisation

### A1. Seller authorisation flow (OAuth via Login with Amazon)

**Website workflow** — https://developer-docs.amazon/sp-api/docs/website-authorization-workflow
- Consent URL: `https://<Seller Central host for the seller's region>/apps/authorize/consent` with query params:
  - `application_id` (required) — e.g. `amzn1.sellerapps.app.2eca283f-…`
  - `state` (required) — your CSRF token; echoed back
  - `version=beta` (only while the app is in **Draft** state; remove after publishing — omitting it on a draft app yields error **MD1000**, see A1 errors)
  - `redirect_uri` (optional) — "must match a URI you specified when you registered your application"
  - Example: `https://sellercentral.amazon.com/apps/authorize/consent?application_id=…&state=ourStateToken&version=beta`
  - "Use the Amazon store URL that matches your selling partner's region" (e.g. sellercentral.amazon.co.uk / .de / .it … for EU; the docs do not enumerate the hosts on this page).
- Callback to your redirect URI: `state`, `selling_partner_id`, `spapi_oauth_code`. Example: `https://client-example.com?state=state-example&selling_partner_id=…&spapi_oauth_code=…`
- "The LWA authorization code (`spapi_oauth_code`) expires after five minutes." The whole authorisation must complete within 10 minutes. Set `Referrer-Policy: no-referrer` on your pages.
- Token exchange: `POST https://api.amazon.com/auth/o2/token`
  - `grant_type=authorization_code&code=<spapi_oauth_code>&redirect_uri=…&client_id=…&client_secret=…` → `access_token`, `refresh_token`, `expires_in` (3600), `token_type=bearer`
  - `grant_type=refresh_token&refresh_token=…&client_id=…&client_secret=…` → new `access_token` (3600 s)

**Selling Partner Appstore workflow** (seller starts from the Appstore) — https://developer-docs.amazon/sp-api/docs/selling-partner-appstore-authorization-workflow
- Amazon sends the seller to your registered *OAuth Login URI* with `amazon_callback_uri`, `amazon_state`, `selling_partner_id`, and `version=beta` for draft apps.
- Your site redirects to `amazon_callback_uri` with `amazon_state` (unchanged), your own `state`, and optional `redirect_uri`.
- Amazon then calls your redirect URI with `state`, `selling_partner_id`, `spapi_oauth_code` — exchange within 5 minutes.

**Connecting / tokens** — https://developer-docs.amazon/sp-api/docs/connecting-to-the-selling-partner-api
- Access token goes in header `x-amz-access-token` (max 2048 bytes); it is valid `"expires_in":3600` (one hour).
- Grantless calls use `grant_type=client_credentials` + `scope` (see A2).
- The page gives **no refresh-token TTL**. Related official statements:
  - Public apps: "the selling partner must reauthorize your public application every 365 days, or anytime you add a role" — https://developer-docs.amazon/sp-api/docs/renew-authorizations (seller uses Manage Your Apps → Re-Authorize; your app must run the OAuth flow again and replace the stored refresh token).
  - The authorization-errors page describes the 403 "Expired or revoked API tokens" case as: access tokens 1 h, "refresh tokens valid 365 days", client secrets 180 days — https://developer-docs.amazon/sp-api/docs/authorization-errors
  - Private/self-authorised apps: no expiry stated on https://developer-docs.amazon/sp-api/docs/self-authorization ("generating a new refresh token doesn't invalidate previous refresh tokens"). Whether a self-auth refresh token ever expires by age: **unverified**.
  - Refresh tokens are NOT rotated on use (the refresh grant returns only a new access token per the website-workflow page); they survive a client-secret rotation ("Refresh tokens are linked to the LWA client identifier … You do not need to regenerate refresh tokens") — https://developer-docs.amazon/sp-api/docs/lwa-credentials-faq

**Regions / endpoints** — https://developer-docs.amazon/sp-api/docs/sp-api-endpoints
| Region | Endpoint | AWS region | Marketplaces served |
|---|---|---|---|
| NA | https://sellingpartnerapi-na.amazon.com | us-east-1 | US, CA, MX, BR |
| EU | https://sellingpartnerapi-eu.amazon.com | eu-west-1 | "Ireland, Spain, UK, France, Belgium, Netherlands, Germany, Italy, Sweden, South Africa, Poland, Saudi Arabia, Egypt, Turkey, United Arab Emirates" + India |
| FE | https://sellingpartnerapi-fe.amazon.com | us-west-2 | JP, AU, SG |
- Sandbox: `https://sandbox.sellingpartnerapi-{na,eu,fe}.amazon.com` — https://developer-docs.amazon/sp-api/docs/the-selling-partner-api-sandbox
- EU marketplace IDs — https://developer-docs.amazon/sp-api/docs/marketplace-ids: UK `A1F83G8C2ARO7P`, DE `A1PA6795UKMFR9`, FR `A13V1IB3VIYZZH`, IT `APJ6JRA9NG5V4`, ES `A1RKKUPIHCS9HS`, NL `A1805IZSGTT6HS`, PL `A1C3SOZRARQ6R3`, SE `A2NODRKZP88ZB9`, BE `AMEN7PMS3EDWL`, IE `A28R8C7NBKEWEA`, TR `A33AVAJ2PDY3EV`, AE `A2VIGQ35RCS4UG`, SA `A17E79C6D8DWNP`, EG `ARBP9OOSHTCHU`, IN `A21TJRUUN4KGV`.
- One authorisation = one region: the official docs state "Authorizations are regional, so when the authorization is complete your application will have access to the seller's account in any marketplace in the … region" (quoted from a search snippet of https://developer-docs.amazon/sp-api/docs/authorizing-selling-partner-api-applications; the exact section was not re-read — treat wording as **partially unverified**, the behaviour is consistent with the endpoint table). Multi-marketplace Listings PATCH is "only … within the same region (North America, Europe, or Far East)" — https://developer-docs.amazon/sp-api/docs/update-price-for-multiple-marketplace. A seller on both EU and NA needs two authorisations (one per region) — follows from the above; **unverified as an explicit sentence**.
- Discover which marketplaces an authorised seller actually sells in with Sellers API `getMarketplaceParticipations` — https://developer-docs.amazon/sp-api/docs/sellers-api

**Revocation** — https://developer-docs.amazon/sp-api/docs/revoke-self-authorizations-from-your-application
- Seller side (public app): Seller Central → Apps and Services → Manage Your Apps → find app → "Disable authorization" → OK. "When a selling partner revokes OAuth authorization for an app, the app is disabled, but remains viewable on the 'Manage Your Apps' page."
- Developer side (self-authorisation): app → dropdown beside Edit → Authorize → "Revoke Authorization" → Self-Authorizations → Revoke.
- **No push notification to the app is documented** for revocation (unverified that none exists; none is listed among notification types). What you see: HTTP 403 "Expired or revoked API tokens" — https://developer-docs.amazon/sp-api/docs/authorization-errors; the LWA token endpoint error for a revoked grant is not spelled out in SP-API docs (the Ads docs show LWA returning HTTP 400 `{"error":"invalid_grant","error_description":"The request has an invalid grant parameter : refresh_token. User may have revoked or didn't grant the permission."}` — https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/refresh-tokens; same LWA service, so expect the same for SP-API — **unverified for SP-API**).

**Authorisation error codes** — https://developer-docs.amazon/sp-api/docs/resolve-common-http-and-authorization-error-codes and https://developer-docs.amazon/sp-api/docs/authorization-errors
- `MD1000` draft app authorised without `version=beta`; `MD5101` redirect URI mismatch; `MD5110` redirect URI contains `#`; `MD9100` missing login/redirect URI; `SPDC8143` non-primary user; `SPSA0404` unsupported business entity; `SPSA2043` vendor group missing `SPDS-VC-MYA` role; `CONSENT_LIMIT_REACHED` authorisation cap hit.
- 403 causes listed: expired/revoked tokens; missing roles; seller-vs-vendor credential mix; region mismatch; wrong path/version; deprecated endpoint; unsupported marketplace; seller account deactivated/suspended.
- Post-rotation: LWA `{"error":"invalid_client","error_description":"Client authentication failed"}`; expired secret → `"code":"Unauthorized"`, `"Access to requested resource is denied."`, `"The LWA secret token you provided has expired."` — https://developer-docs.amazon/sp-api/docs/lwa-credentials-faq

### A2. App registration prerequisites, roles, RDT, grantless

**Developer registration** — https://developer-docs.amazon/sp-api/docs/registering-as-a-developer
- Done in the **Solution Provider Portal** (SPP; the newer unified console — https://developer-docs.amazon.com/sp-api/changelog/new-announcing-solution-provider-portal-spp-to-streamline-third-party-solution-provider-experience-1). Must be the primary account user. Developer profile ≤ 500 words of original text; security-controls questionnaire; Data Protection Policy; you request **roles** in the profile; Amazon reviews. Private-seller registration requires a Professional selling account. Public developers must also meet website guidelines and the SPP Agreement.
- App registration — https://developer-docs.amazon/sp-api/docs/registering-your-application: SPP → Develop Apps → add app client; choose Sellers and/or Vendors; assign approved roles; register redirect URIs; get LWA `client_id`/`client_secret`.

**Roles** — https://developer-docs.amazon/sp-api/docs/roles-in-the-selling-partner-api (restricted = PII, needs extra verification and the RDT flow at call time)
| Role | Restricted | What it covers |
|---|---|---|
| Account Information Service Provider | no | account info incl. payment methods / financial events (EU) |
| Amazon Fulfillment | no | FBA, MCF, inbound/outbound |
| Amazon Warehousing and Distribution | no | AWD API |
| Brand Analytics | no | analytics reports, Data Kiosk |
| Buyer Communication | no | Messaging API |
| Buyer Solicitation | no | Solicitations API |
| Direct-to-Consumer Shipping | **yes** | ops that need buyer PII to ship (Merchant Fulfillment, Easy Ship, External Fulfillment, order address) |
| Finance and Accounting | no | Finances, settlement, invoices |
| Inventory and Order Tracking | no | orders/inventory without shipping PII |
| Notifications in Seller Central | no | App Integrations API |
| Payment Initiation Service Provider | no | Transfers API |
| Pricing | no | pricing / repricing |
| Product Listing | no | listings, catalog, product types |
| Professional Services | **yes** | Services API |
| Selling Partner Insights | no | account/performance info |
| Tax Invoicing | **yes** | VAT/tax invoice generation (Shipment Invoicing, Invoices BR, Delivery by Amazon) |
| Tax Remittance | **yes** | sales-tax calculation |
Role→operation map: https://developer-docs.amazon.com/sp-api/docs/role-mappings; role→type (incl. notifications): https://developer-docs.amazon/sp-api/docs/role-mappings-for-types. Adding a role to a published app forces sellers to re-authorise — https://developer-docs.amazon/sp-api/docs/renew-authorizations

**Restricted Data Token (Tokens API v2021-03-01)** — https://developer-docs.amazon/sp-api/docs/tokens-api-use-case-guide, https://developer-docs.amazon/sp-api/reference/createrestricteddatatoken
- `POST /tokens/2021-03-01/restrictedDataToken` body: `restrictedResources[] {method (GET/PUT/POST/DELETE), path (e.g. /orders/v0/orders/{orderId}/address), dataElements[] (buyerInfo | shippingAddress | buyerTaxInformation)}`, optional `targetApplication` (delegate the RDT to another app). Response `restrictedDataToken`, `expiresIn` (seconds; value not stated on the reference page — unverified). Rate 1 rps, burst 10. Pass the RDT in `x-amz-access-token` instead of the LWA token.
- Restricted operations (from the Tokens guide + operation references): Orders `getOrders`, `getOrder`, `getOrderItems`, `getOrderAddress`, `getOrderBuyerInfo`, `getOrderItemsBuyerInfo`, `getOrderRegulatedInfo`; Reports `getReportDocument` for restricted report types; Shipment Invoicing `getShipmentDetails`; Shipping `getShipment`; Merchant Fulfillment / Easy Ship / External Fulfillment ops carry the D2C-Shipping restricted role. `buyerInfo` "indicates that the RDT should provide authorization to access PII for use cases such as tax and gift wrapping" — https://developer-docs.amazon/sp-api/docs/get-authorization-to-access-pii-for-order-items

**Grantless operations** (client_credentials; no seller refresh token) — https://developer-docs.amazon/sp-api/docs/grantless-operations
| Scope | Operations |
|---|---|
| `sellingpartnerapi::notifications` | `createDestination`, `deleteDestination`, `getDestination(s)`, `getSubscriptionById`, `deleteSubscriptionById` (NOT `createSubscription`/`getSubscription`, which need the seller's token) |
| `sellingpartnerapi::client_credential:rotation` | `rotateApplicationClientSecret` (`POST /applications/2023-11-30/clientSecret`) |
| `sellingpartnerapi::shipments:track` | `getShipmentTracking` (`GET /tracking/2026-01-30/shipments/track`) |
| `sellingpartnerapi::authorization` | `getAuthorizationCode` — Authorization API v1 **removed March 27, 2024** (https://developer-docs.amazon/sp-api/docs/sp-api-deprecations) |
| `sellingpartnerapi::migration` | not present on the current grantless page — belonged to the retired MWS-migration flow; treat as **retired/unverified** |
Request: `POST https://api.amazon.com/auth/o2/token` with `grant_type=client_credentials&scope=<scope>&client_id=…&client_secret=…` — https://developer-docs.amazon/sp-api/docs/connecting-to-the-selling-partner-api

**Authorisation limits** — https://developer-docs.amazon/sp-api/docs/application-authorization-limits
- Private app: "Self-authorization only", "Maximum of 10 self-authorizations".
- Public app, sellers, not listed on the Appstore: "Maximum of 25 OAuth authorizations"; listed on the Appstore: unlimited; vendors: unlimited; every public app also gets 10 self-authorisations for testing. Over the cap → `CONSENT_LIMIT_REACHED`. Private app wanting more: "update the application to be public or remove existing self-authorizations".

### A3. Public vs private; self-authorisation; multi-account

- Definitions — https://developer-docs.amazon/sp-api/docs/authorizing-selling-partner-api-applications: private apps are "for exclusive use by a single organization" and use self-authorisation; public apps serve "multiple selling partners through the selling partner's website or through the Selling Partner Appstore" via OAuth. Three workflows: Website, Appstore, Self-authorisation.
- Self-authorisation UX — https://developer-docs.amazon/sp-api/docs/self-authorization: SPP "Manage Authorizations" / Seller Central → Apps and Services → Develop Apps / Vendor Central → Integration → API Integration → "Authorize app" → refresh token displayed once. App may be in Draft. "For Seller Central: you must be the Primary User of that account." One refresh token per authorised account; new tokens don't invalidate old ones.
- Multi-account with one private app: officially documented for Vendor Central — "you can create authorization grants and generate refresh tokens to a single application for each of your Vendor Central accounts" (any VC account the logged-in user can access) — https://developer-docs.amazon/sp-api/docs/tutorial-use-a-single-sp-api-application-to-authorize-multiple-vendor-central-accounts. For Seller Central the same page family says only that the authoriser must be the *primary user* of the seller account; so a second **seller** account can self-authorise the same private app only if your developer login is that account's primary user, within the 10-self-auth cap. Any other seller (client accounts, accounts where you are a secondary user) requires the **public** app + OAuth (25 authorisations unlisted, unlimited if listed). Explicit statement for multi-seller private use: **unverified** beyond these rules.

---

## B. SP-API surface map

Index: https://developer-docs.amazon/sp-api/llms.txt (also lists per-API .md pages). Status column: "current" unless a deprecation is scheduled (dates from https://developer-docs.amazon/sp-api/docs/sp-api-deprecations).

| API section | Version(s) | What it does | Role(s) | Source |
|---|---|---|---|---|
| Orders | v0 (deprecated 2026-01-28, **removal 2027-03-27** for 6 ops) · **v2026-01-01** | v0: getOrders/getOrder/BuyerInfo/Address/Items/ItemsBuyerInfo, updateShipmentStatus, getOrderRegulatedInfo, updateVerificationStatus, confirmShipment. v2026-01-01 consolidates ten ops into `getOrder` + `searchOrders` (includedData e.g. PROCEEDS, TAX, PAYMENT). PII ops need RDT. | Inventory & Order Tracking / Amazon Fulfillment (+ D2C Shipping restricted for regulated ops) | https://developer-docs.amazon/sp-api/docs/orders-api ; release notes 2026-01-28 https://developer-docs.amazon/sp-api/page/release-notes |
| Listings Items | **v2021-08-01** (v2020-09-01 legacy) | putListingsItem, patchListingsItem, deleteListingsItem, getListingsItem, searchListingsItems — JSON listing create/replace/patch incl. price & MFN quantity; multi-marketplace PATCH in one region | Product Listing or Inventory & Order Tracking | https://developer-docs.amazon/sp-api/docs/listings-items-api |
| Listings Restrictions | v2021-08-01 | getListingsRestrictions → gating/approval links per ASIN/condition | Product Listing | https://developer-docs.amazon/sp-api/docs/listings-restrictions-api |
| Catalog Items | **v2022-04-01** (v0 listCatalogItems/getCatalogItem removed 2025-04-24; v0 listCatalogCategories removal 2026-08-26) | searchCatalogItems, getCatalogItem; includedData: attributes, dimensions, identifiers, images, productTypes, relationships, salesRanks, summaries, vendorDetails, classifications | Product Listing | https://developer-docs.amazon/sp-api/docs/catalog-items-api |
| Product Type Definitions | v2020-09-01 | searchDefinitionsProductTypes, getDefinitionsProductType → JSON Schema (2019-09 + Amazon meta-schema) per product type/marketplace, used to validate JSON_LISTINGS_FEED / Listings Items payloads | Product Listing or Inv&Order Tracking | https://developer-docs.amazon/sp-api/docs/product-type-definitions-api |
| Feeds | v2021-06-30 (v2020-09-04 removed 2024-06-27) | createFeedDocument → upload → createFeed → getFeed → getFeedDocument; cancelFeed; FEED_PROCESSING_FINISHED. Feed types below. | Product Listing, Pricing, Inv&Order Tracking, … | https://developer-docs.amazon/sp-api/docs/feeds-api |
| Reports | v2021-06-30 (v2020-09-04 removed 2024-06-27) | createReport/getReport(s)/cancelReport/getReportDocument (GZIP documents), report schedules; REPORT_PROCESSING_FINISHED; restricted reports need RDT | many (per report type) | https://developer-docs.amazon/sp-api/docs/reports-api |
| Notifications | v1 | destinations (SQS/EventBridge) + subscriptions per notification type; see D | per notification type | https://developer-docs.amazon/sp-api/docs/notifications-api-v1-use-case-guide |
| Tokens (RDT) | v2021-03-01 | createRestrictedDataToken | any of the roles that own restricted ops | https://developer-docs.amazon/sp-api/docs/tokens-api-use-case-guide |
| Sellers | v1 | getMarketplaceParticipations (marketplaces, default language/currency), getAccount (business info, sellerId) | Product Listing / SP Insights; getAccount: AISP or Finance (EU) | https://developer-docs.amazon/sp-api/docs/sellers-api |
| Product Pricing | v0 · **v2022-05-01** (`CompetitivePriceThreshold` ref price removed 2025-09-30) | getPricing, getCompetitivePricing, getListingOffers, getItemOffers, *Batch variants, getFeaturedOfferExpectedPriceBatch, getCompetitiveSummary (+ `similarItems` 2026-04) | Pricing | https://developer-docs.amazon/sp-api/docs/product-pricing-api |
| Product Fees | v0 | getMyFeesEstimateForSKU / ForASIN / getMyFeesEstimates | Pricing / Product Listing / Finance | https://developer-docs.amazon/sp-api/docs/product-fees-api |
| FBA Inventory | v1 | getInventorySummaries (fulfillable/inbound/reserved/unfulfillable/researching, per marketplace); createInventoryItem/deleteInventoryItem/addInventory are sandbox-only | Amazon Fulfillment / Product Listing | https://developer-docs.amazon/sp-api/docs/fba-inventory-api |
| Fulfillment Inbound | v0 (10 ops removed 2025-01-21; getLabels, getBillOfLading, getShipments, getShipmentItems, getPrepInstructions remain) · **v2024-03-20** | inbound plans → packing/placement options → transportation → labels | Amazon Fulfillment | https://developer-docs.amazon/sp-api/docs/fulfillment-inbound-api |
| FBA Inbound Eligibility | v1 | getItemEligibilityPreview (ASIN inbound/commingling eligibility) — from model listing; details **unverified** | Amazon Fulfillment (unverified) | https://developer-docs.amazon.com/sp-api/lang-fr_FR/docs/fbainboundeligibility-api-v1-model |
| Fulfillment Outbound (MCF) | v2020-07-01 · **v2026-07-04** (multi-tenant) | getFulfillmentPreview, createFulfillmentOrder, getFulfillmentOrder, cancelFulfillmentOrder, getPackageTrackingDetails, listReturnReasonCodes, createFulfillmentReturn, getFeatureInventory, submitFulfillmentOrderStatusUpdate; attended-delivery options 2026-02 | Amazon Fulfillment | https://developer-docs.amazon/sp-api/docs/fulfillment-outbound-api |
| Merchant Fulfillment | v0 (*Old ops removed 2024-03-27) | getEligibleShipmentServices, createShipment, getShipment, cancelShipment, getAdditionalSellerInputs — Buy Shipping labels for MFN orders | **D2C Shipping (restricted)** | https://developer-docs.amazon/sp-api/docs/merchant-fulfillment-api |
| Shipping (Amazon Shipping) | v1 (reference https://developer-docs.amazon/sp-api/docs/shipping-api-v1-reference) · **v2** (separate docs host) | v2: getRates, purchaseShipment, oneClickShipment, getTracking, getShipmentDocuments, cancelShipment, getAccessPoints (UK only), submitNdrFeedback/createClaim (IN), getAdditionalInputs; on- and off-Amazon shipments; purchase within 10 min of rate | D2C Shipping (restricted), "Amazon Logistics" role | https://developer-docs.shipping.amazon.com/apis/docs/shipping-api-v2-reference |
| Tracking | **v2026-01-30** | getShipmentTracking (grantless `sellingpartnerapi::shipments:track`), milestones/ETA for Amazon supply-chain shipments (US) ; SHIPMENT_TRACKING_MILESTONE_CHANGED | none (grantless) | https://developer-docs.amazon/sp-api/docs/tracking-api |
| External Fulfillment | Shipping **v2024-09-11**, Inventory v2024-09-11, Returns | seller-warehouse fulfilment of Amazon orders (Seller Flex, Easy Ship, Self Ship); publish inventory; returns | D2C Shipping (restricted) | https://developer-docs.amazon/sp-api/docs/external-fulfillment-shipping , https://developer-docs.amazon/sp-api/docs/external-fulfillment-inventory |
| Easy Ship | v2022-03-23 | listHandoverSlots, createScheduledPackage, labels/invoices; NL & PL support bulk package ops; IN/MX/TR/AU/SG/JP core | D2C Shipping (restricted) | https://developer-docs.amazon/sp-api/docs/easy-ship-api |
| Supply Sources | v2020-07-01 | create/update/archive supply sources (multi-location inventory, ship-from-store) | Selling Partner Insights | https://developer-docs.amazon/sp-api/docs/supply-sources-api |
| Finances | v0 (listFinancialEvents* deprecated 2025-07-21, **removal 2027-08-27**) · **v2024-06-19** | v2024-06-19: listTransactions, listSummary, listBalances | Finance & Accounting (some v0 EU ops accept AISP/Amazon Fulfillment) | https://developer-docs.amazon/sp-api/docs/finances-api |
| Transfers | v2024-06-01 | initiatePayout (EU only), listPayouts, listExpectedPayouts, payment instruments | Finance & Accounting or Payment Initiation SP | https://developer-docs.amazon/sp-api/docs/transfers-api |
| Seller Wallet | v2024-03-01 | wallet accounts, balances, transactions, transfer schedules, fee preview | AISP (+ PISP for transactions) | https://developer-docs.amazon/sp-api/docs/seller-wallet-api |
| Invoices | **v2024-06-19** (Brazil only) · **v2026-06-25** (vendor invoice headers/detail, all regions) | BR: getInvoices/getInvoice/Attributes/Document/Exports; vendor: getInvoiceHeaders, getInvoice | Tax Invoicing (restricted) / Finance & Accounting | https://developer-docs.amazon/sp-api/docs/invoices-api , https://developer-docs.amazon/sp-api/docs/invoice-api |
| Shipment Invoicing | v0 | BR FBA-Onsite invoicing: getShipmentDetails, submitInvoice, getInvoiceStatus | Tax Invoicing (restricted) | https://developer-docs.amazon/sp-api/docs/shipment-invoicing-api |
| Delivery by Amazon | v2021-12-28 | BR shipment-invoice data | Tax Invoicing (restricted) | https://developer-docs.amazon/sp-api/docs/delivery-by-amazon-api |
| Messaging | v1 | getMessagingActionsForOrder + createConfirm*/createLegalDisclosure/createWarranty/createUnexpectedProblem/sendInvoice/… (attachments via Uploads API) | Buyer Communication | https://developer-docs.amazon/sp-api/docs/messaging-api |
| Solicitations | v1 | getSolicitationActionsForOrder, createProductReviewAndSellerFeedbackSolicitation | Buyer Solicitation | https://developer-docs.amazon/sp-api/docs/solicitations-api |
| Uploads | v2020-11-01 | createUploadDestinationForResource (pre-signed upload for Messaging/A+ assets) | Product Listing | https://developer-docs.amazon/sp-api/docs/uploads-api |
| A+ Content | v2020-11-01 | "rich marketing content to Amazon product detail pages" — content documents, ASIN relations, approval submissions (operation list on the reference page; role **unverified**) | (unverified) | https://developer-docs.amazon/sp-api/reference/a-content-management-v2020-11-01 |
| Sales | v1 | getOrderMetrics (aggregated order metrics by interval/granularity/buyer type) | Inv&Order Tracking / Product Listing / … | https://developer-docs.amazon/sp-api/docs/sales-api |
| Replenishment | v2022-11-07 | Subscribe & Save: getSellingPartnerMetrics, listOfferMetrics, listOffers | Brand Analytics or Inv&Order Tracking | https://developer-docs.amazon/sp-api/docs/replenishment-api |
| Customer Feedback | v2024-06-01 | review topics/trends per ASIN & browse node, return insights | Brand Analytics or SP Insights | https://developer-docs.amazon/sp-api/docs/customer-feedback-api |
| Data Kiosk | v2023-11-15 | GraphQL: createQuery/getQuery/getQueries/cancelQuery/getDocument (JSONL); DATA_KIOSK_QUERY_PROCESSING_FINISHED; dataset `analytics_salesAndTraffic_2023_11_15` removed 2026-03-27 (successor name not readable — unverified); schema explorer https://sellercentral.amazon.com/datakiosk-schema-explorer ; B2B metrics added 2026-02 | Brand Analytics | https://developer-docs.amazon/sp-api/docs/data-kiosk-api-v2023-11-15-use-case-guide |
| Promotions | **v2025-12-01** | searchPromotions, getPromotion, getSelection (deals, coupons, price discounts) | Pricing or Product Listing | https://developer-docs.amazon/sp-api/docs/promotions-api |
| Application Management | v2023-11-30 | rotateApplicationClientSecret (grantless) → new secret to your SQS queue | none | https://developer-docs.amazon/sp-api/docs/application-management-api-v2023-11-30-use-case-guide |
| Application Integrations | v2024-04-01 | createNotification, deleteNotifications, recordActionFeedback — push notifications INTO the seller's Seller Central banner | Notifications in Seller Central | https://developer-docs.amazon/sp-api/docs/app-integrations |
| Services | v1 | service jobs, appointments, technicians, fulfilment documents | Professional Services (restricted) | https://developer-docs.amazon/sp-api/docs/services-api |
| Vehicles | v2024-11-01 | vehicle identifiers for fitment/compatibility (EU sellers only) | Product Listing | https://developer-docs.amazon/sp-api/docs/vehicles-api |
| Amazon Warehousing & Distribution | v2024-05-09 | createInbound, confirmInbound, listInboundShipments, getInboundShipment, listInventory, labels (US only) | AWD | https://developer-docs.amazon/sp-api/docs/awd_2024-05-09-reference |
| Vendor Retail Procurement | Orders v1, Shipments v1, Invoices v1, Transaction Status v1 | POs (getPurchaseOrders, submitAcknowledgement), ASNs/labels, submitInvoices, transaction status | Amazon Fulfillment / Inv&Order Tracking | https://developer-docs.amazon/sp-api/docs/vendor-retail-procurement-orders-api , …-shipments-api , …-invoices-api , …-transaction-status-api |
| Vendor Direct Fulfillment | Orders v1 & **2021-12-28**, Shipping v1 & **2021-12-28**, Inventory v1, Payments v1, Transaction Status 2021-12-28 | drop-ship POs, labels/packing slips/customer invoices, inventory updates, invoices | D2C Shipping (restricted) / Amazon Fulfillment | https://developer-docs.amazon/sp-api/docs/vendor-direct-fulfillment-orders-api , …-shipping-api , …-inventory-api , …-payments-api , …-transaction-status-api |
| Authorization API | v1 | **removed 2024-03-27** | — | https://developer-docs.amazon/sp-api/docs/sp-api-deprecations |
| FBA Small and Light | v1 | **removed** (NA/EU 2023-09-26, JP 2024-03-27) | — | same |

**Feed types** — https://developer-docs.amazon/sp-api/docs/feed-type-values (page lists Easy Ship, FBA, Invoicing, Listings, Order families)
- Listings: `JSON_LISTINGS_FEED` (the only supported listings feed; interoperable with Listings Items + Product Type Definitions).
- Order: `POST_ORDER_ACKNOWLEDGEMENT_DATA`, `POST_ORDER_FULFILLMENT_DATA`, `POST_PAYMENT_ADJUSTMENT_DATA`, `POST_INVOICE_CONFIRMATION_DATA`, `POST_EXPECTED_SHIP_DATE_SOD`, `POST_FLAT_FILE_ORDER_ACKNOWLEDGEMENT_DATA`, `POST_FLAT_FILE_FULFILLMENT_DATA`, `POST_FLAT_FILE_PAYMENT_ADJUSTMENT_DATA`, `POST_FLAT_FILE_IL_SNAPSHOT_FEED`, `POST_FLAT_FILE_IL_ALLOCATION_REQUESTS_CONFIRMATION_FEED`, `POST_EXPECTED_SHIP_DATE_SOD_FLAT_FILE`.
- FBA: `POST_FULFILLMENT_ORDER_REQUEST_DATA`, `POST_FULFILLMENT_ORDER_CANCELLATION_REQUEST_DATA`, `POST_FBA_INBOUND_CARTON_CONTENTS`, `POST_FLAT_FILE_FBA_CREATE_REMOVAL`, `POST_FLAT_FILE_FULFILLMENT_ORDER_REQUEST_DATA`, `POST_FLAT_FILE_FULFILLMENT_ORDER_CANCELLATION_REQUEST_DATA`.
- Invoicing: `UPLOAD_VAT_INVOICE` (EU VAT invoice upload). Easy Ship: `POST_EASYSHIP_DOCUMENTS`.
- **Removed legacy listing feeds** (deprecated 2024-03-18; schedule says removed **2025-12-03**; the changelog had earlier removal dates 2025-03-31 → 06-30 → 07-31): `POST_PRODUCT_DATA`, `POST_INVENTORY_AVAILABILITY_DATA`, `POST_PRODUCT_OVERRIDES_DATA`, `POST_PRODUCT_PRICING_DATA`, `POST_PRODUCT_IMAGE_DATA`, `POST_PRODUCT_RELATIONSHIP_DATA`, `POST_FLAT_FILE_INVLOADER_DATA`, `POST_FLAT_FILE_LISTINGS_DATA`, `POST_FLAT_FILE_BOOKLOADER_DATA`, `POST_FLAT_FILE_CONVERGENCE_LISTINGS_DATA`, `POST_FLAT_FILE_PRICEANDQUANTITYONLY_UPDATE_DATA`, `POST_UIEE_BOOKLOADER_DATA` — https://developer-docs.amazon/sp-api/changelog/deprecation-of-feeds-api-support-for-xml-and-flat-file-listings-feeds and https://developer-docs.amazon/sp-api/docs/sp-api-deprecations. Also removed: `POST_FLAT_FILE_FBA_CREATE_INBOUND_PLAN`/`UPDATE_INBOUND_PLAN` (2024-03-27), `RFQ_UPLOAD_FEED` (2025-12-17).

**Report type families** — https://developer-docs.amazon/sp-api/docs/report-type-values
| Family | Page | Representative types |
|---|---|---|
| Inventory | …/report-type-values-inventory | GET_MERCHANT_LISTINGS_ALL_DATA, GET_FLAT_FILE_OPEN_LISTINGS_DATA, GET_MERCHANT_LISTINGS_INACTIVE_DATA, GET_PAN_EU_OFFER_STATUS, GET_REFERRAL_FEE_PREVIEW_REPORT |
| Order | …-order | GET_FLAT_FILE_ACTIONABLE_ORDER_DATA_SHIPPING, GET_ORDER_REPORT_DATA_INVOICING, GET_PENDING_ORDERS_DATA, GET_FLAT_FILE_ARCHIVED_ORDERS_DATA_BY_ORDER_DATE |
| FBA | …-fba | GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL, GET_AFN_INVENTORY_DATA, GET_FBA_MYI_ALL_INVENTORY_DATA, GET_FBA_STORAGE_FEE_CHARGES_DATA, GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA |
| Returns | …-returns | GET_XML_RETURNS_DATA_BY_RETURN_DATE, GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE, GET_CSV_MFN_PRIME_RETURNS_REPORT |
| Analytics (Brand Analytics / vendor) | …-analytics | GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT, GET_SALES_AND_TRAFFIC_REPORT, GET_VENDOR_REAL_TIME_SALES_REPORT, GET_VENDOR_FORECASTING_REPORT |
| Performance | …-performance | GET_SELLER_FEEDBACK_DATA, GET_V2_SELLER_PERFORMANCE_REPORT, GET_PROMOTION_PERFORMANCE_REPORT, GET_COUPON_PERFORMANCE_REPORT |
| Tax | …-tax | GET_VAT_TRANSACTION_DATA, SC_VAT_TAX_REPORT, GET_FLAT_FILE_SALES_TAX_DATA, GST_MTR_STOCK_TRANSFER_REPORT |
| Settlement | …-settlement | GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE, _V2, _XML (two settlement types removal 2026-11-11) |
| Payment | …-payment | GET_DATE_RANGE_FINANCIAL_HOLDS_DATA |
| Browse tree | …-browse-tree | GET_XML_BROWSE_TREE_DATA |
| Easy Ship | …-easy-ship | GET_EASYSHIP_DOCUMENTS, GET_EASYSHIP_PICKEDUP, GET_EASYSHIP_WAITING_FOR_PICKUP |
| Invoice data | …-invoice-data | GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT, GET_XML_VAT_INVOICE_DATA_REPORT |
| B2B opportunities | …-b2b-product-opportunities | GET_B2B_PRODUCT_OPPORTUNITIES_RECOMMENDED_FOR_YOU, …_NOT_YET_ON_AMAZON |
| Regulatory compliance | …-regulatory-compliance | END_USER_DATA_REPORT, GET_EPR_MONTHLY_REPORTS, GET_EPR_QUARTERLY_REPORTS, MARKETPLACE_ASIN_PAGE_VIEW_METRICS |
| Amazon Business | …-amazon-business | FEE_DISCOUNTS_REPORT |
(Prefix each page with https://developer-docs.amazon/sp-api/docs/ .)

**Deprecation cadence** — https://developer-docs.amazon/sp-api/docs/sp-api-deprecations and https://developer-docs.amazon/sp-api/page/release-notes
- Two-phase: "Deprecated indicates that the resource is no longer in active development as of the deprecation date. Removed indicates that calls to the resources fail as of the removal date."
- Observed notice windows on the schedule: ~6 months (Authorization v1) to 2+ years (Orders v0: deprecated 2026-01-28 → removed 2027-03-27; Finances v0: 2025-07-21 → 2027-08-27; Catalog v0: 2022-09-30 → 2025-04-24).
- Announcements: dated release notes (chronological) + changelog posts ("Deprecation Reminders – …" e.g. https://developer-docs.amazon/sp-api/changelog/deprecation-reminders-february-26-2025). Email notification to developers: **unverified**.
- Recent (2026) release-note entries: Promotions v2025-12-01 (Aug 26), Tracking v2026-01-30 + SHIPMENT_TRACKING_MILESTONE_CHANGED (Aug 5), Invoices v2026-06-25 + Finances listSummary/listBalances + Fulfillment Outbound v2026-07-04 (Jul 29), Notifications `filterExpression` (CEL) + `DeliveryTipChange` (May 27), Orders v2026-01-01 (Jan 28).

---

## C. SP-API rate limits — https://developer-docs.amazon/sp-api/docs/usage-plans-and-rate-limits

- Token bucket per **(operation × selling partner × application × region/store)**: "rate" = tokens added per second, "burst" = bucket capacity; each request consumes one token; empty bucket → throttled.
- Response header `x-amzn-RateLimit-Limit` carries the rate for that operation/account-app pair — but "you must not depend on this header being present": omitted when limits can't be fetched, only on 20x/400/404 (not on auth failures), and it doesn't include every plan dimension.
- 429 = `QuotaExceeded`, message "You exceeded your quota for the requested resource." (from https://developer-docs.amazon/sp-api/docs/troubleshoot-sp-api-errors via search snippet); "A 429 is a retry-able status code" — implement back-off; "wait a few minutes, then retry".
- Dynamic usage plans adjust to the selling partner's business metrics; "Rates do not dynamically increase because an application makes API requests more frequently."
- Guidance: read the header when present, code against events (notifications) rather than polling loops, batch — https://developer-docs.amazon.com/sp-api/docs/strategies-to-optimize-rate-limits-for-your-application-workloads. Per-op defaults are in each operation's reference page (e.g. createRestrictedDataToken 1 rps/burst 10; createSubscription 1 rps/burst 5; getOrder/getOrderAddress/getOrderBuyerInfo 0.5 rps/burst 30 per changelog snippet).
- Sandbox is limited to 5 rps / burst 15.

---

## D. Notifications — https://developer-docs.amazon/sp-api/docs/notifications-api-v1-use-case-guide

**Model**
1. `createDestination` (grantless, `sellingpartnerapi::notifications`) with `resourceSpecification` = `{sqs: {arn}}` or `{eventBridge: {region, accountId}}` and a `name`. SQS: **standard queues only** ("Selling Partner API does not support delivery to FIFO queues"). EventBridge: "you can only create one EventBridge destination per AWS account"; Amazon creates a partner event source `aws.partner/sellingpartnerapi.amazon.com/{AWS Account Id}/{Application Id}` that you associate with an event bus in the console — https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-eventbridge
2. `createSubscription` (**seller-authorised** — uses that seller's refresh token; role depends on notification type) with `payloadVersion`, `destinationId`, optional `processingDirective` {`eventFilter` (marketplace, aggregation period, OrderChangeType), `filterExpression` (CEL, since 2026-05)} — https://developer-docs.amazon/sp-api/reference/createsubscription. Subscriptions "apply to the selling partners for whom you are making calls", i.e. **one createSubscription per notification type per seller per app** (a destination can be shared); multiple subscriptions with different payload versions per (app, type, party) are allowed — https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-sqs
3. Grantless management: getDestination(s), deleteDestination, getSubscriptionById, deleteSubscriptionById — https://developer-docs.amazon/sp-api/docs/grantless-operations

**SQS policy** (principal = SP-API's AWS account `437568002678`) — https://developer-docs.amazon/sp-api/docs/tutorial-grant-permission-to-sqs-queue
```json
{"Version":"2012-10-17","Statement":[{"Sid":"AllowSPAPIAccess","Effect":"Allow",
 "Principal":{"AWS":"arn:aws:iam::437568002678:root"},
 "Action":["sqs:GetQueueAttributes","sqs:SendMessage"],"Resource":"*"}]}
```
For SSE-KMS queues also grant `kms:GenerateDataKey` + `kms:Decrypt` to the same principal.

**Message format** — raw JSON body in SQS (no SNS envelope, no documented signature — verify integrity by the fact only that principal can write, and dedupe on `NotificationId`):
`{NotificationVersion:"1.0", NotificationType, PayloadVersion, EventTime, Payload{…}, NotificationMetadata{ApplicationId, SubscriptionId, PublishTime, NotificationId}}` — https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-sqs. EventBridge events use `source: aws.partner/sellingpartnerapi.amazon.com`, `detail-type` = notification type.

**Guarantees** — standard queues give "best-effort ordering" and may deliver duplicates/out of order; dedupe via `NotificationId`. Amazon's own advice: "we recommend that you have a means to retrieve needed information in the event of an unexpected outage or delay" (i.e. keep a reconciliation poll). Explicit at-least-once/retry SLA: **unverified**.

**Notification types** (names from https://developer-docs.amazon/sp-api/docs/notification-type-values and https://developer-docs.amazon/sp-api/docs/role-mappings-for-types; EB = also deliverable via EventBridge per https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-eventbridge)
| Type | Payload ver. | Party | Role | What it carries |
|---|---|---|---|---|
| ACCOUNT_STATUS_CHANGED | 2021-01-01 | seller | SP Insights | NORMAL / AT_RISK / DEACTIVATED |
| ANY_OFFER_CHANGED | 1.0 | seller | Pricing | top-20 offers / Buy Box changes for an ASIN you sell |
| B2B_ANY_OFFER_CHANGED | 1.0 | seller | Pricing | B2B offer tiers |
| BOPIS_CHECKIN_DETAILS | (unverified) | seller | Inv&Order Tracking | buy-online-pick-up-in-store check-in |
| BRANDED_ITEM_CONTENT_CHANGE (EB) | 1.0 | seller | Product Listing | title/bullets/description/images change on brand-owned ASIN |
| DATA_KIOSK_QUERY_PROCESSING_FINISHED | (unverified) | seller/vendor | Brand Analytics, AWD | GraphQL query done |
| DETAIL_PAGE_TRAFFIC_EVENT | 1.0 | seller & vendor | Brand Analytics | hourly ASIN traffic |
| EXTERNAL_FULFILLMENT_SHIPMENT_STATUS_CHANGE | 1.0 | seller | (unverified) | external-warehouse order status |
| FBA_INVENTORY_AVAILABILITY_CHANGES | 1.0 | seller | Amazon Fulfillment | FBA quantity changes |
| FBA_OUTBOUND_SHIPMENT_STATUS | 1.0 | seller | Amazon Fulfillment | FBA Onsite shipments created/cancelled |
| FEE_PROMOTION | 1.0 | seller | Finance / Product Listing | fee promotions |
| FEED_PROCESSING_FINISHED | 1.0 | seller & vendor | several | feed DONE/CANCELLED/FATAL |
| FULFILLMENT_ORDER_STATUS | (unverified) | seller | Amazon Fulfillment | MCF order status |
| ITEM_INVENTORY_EVENT_CHANGE | (unverified) | seller/vendor | Brand Analytics | inventory analytics events |
| ITEM_PRODUCT_TYPE_CHANGE (EB) | (unverified) | seller | Product Listing (Pricing NA) | ASIN's product type changed |
| ITEM_SALES_EVENT_CHANGE | (unverified) | seller/vendor | Brand Analytics | sales analytics events |
| LISTINGS_ITEM_ISSUES_CHANGE (EB) | 1.0 (deprecated 2024-02-28, removal 2026-08-26) — newer version exists (unverified) | seller | Product Listing | listing issues appear/clear |
| LISTINGS_ITEM_MFN_QUANTITY_CHANGE (EB) | (unverified) | seller | Product Listing | "whenever the available quantity for the seller-fulfilled (MFN) listings item changes" |
| LISTINGS_ITEM_STATUS_CHANGE (EB) | (unverified) | seller | Product Listing | BUYABLE/DISCOVERABLE status change |
| ORDER_CHANGE | (unverified) | seller | Amazon Fulfillment / D2C Shipping / Inv&Order | order-level payload; `OrderChangeType` ∈ OrderStatusChange, BuyerRequestedChange, DeliveryTipChange — https://developer-docs.amazon/sp-api/docs/tutorial-subscribe-to-order-change-notification |
| ORDER_STATUS_CHANGE | — | seller | same | deprecated 2023-06-21, **removal 2026-07-29** → migrate to ORDER_CHANGE |
| MFN_ORDER_STATUS_CHANGE | — | seller | — | **removed 2024-03-27** |
| PRICING_HEALTH | (unverified) | seller | Pricing | offer ineligible for Featured Offer due to price |
| PRODUCT_TYPE_DEFINITIONS_CHANGE (EB) | (unverified) | seller | Product Listing | new product type / version |
| REPORT_PROCESSING_FINISHED | (unverified) | seller & vendor | several | report done |
| SHIPMENT_TRACKING_MILESTONE_CHANGED (EB) | (unverified) | seller/vendor | none (grantless) | Tracking API milestones |
| SHIPPING_CHARGE_NOTIFICATION | (unverified) | seller | D2C Shipping (restricted) | shipping charge events |
| TRANSACTION_UPDATE | (unverified) | seller | (unverified) | referenced in role mappings search snippet only |
| APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY | — | application-level | none | payload `clientId`, `clientSecretExpiryTime`, `clientSecretExpiryReason: PERIODIC_ROTATION`; subscribed in the Developer Console → Notification Preferences (SQS ARN) — https://developer-docs.amazon/sp-api/docs/set-up-credential-rotation-notifications |
| APPLICATION_OAUTH_CLIENT_NEW_SECRET | — | application-level | none | new secret + old-secret expiry delivered to the preregistered SQS queue after `rotateApplicationClientSecret` — https://developer-docs.amazon/sp-api/docs/application-management-api-v2023-11-30-use-case-guide |
Payload versions marked unverified were not readable because the fetcher truncates the long page; the type names and roles are from the role-mappings page.

---

## E. Sandbox — https://developer-docs.amazon/sp-api/docs/the-selling-partner-api-sandbox

- **Static sandbox**: pattern-matches the request against the `x-amzn-api-sandbox` examples in each API model and returns canned responses; parameters must match exactly; "don't necessarily contain all parameters required for a successful response".
- **Dynamic sandbox**: "routes requests to a sandbox backend that returns realistic responses based on the request parameters", stateful. Dynamic-only: Fulfillment Outbound, Uploads, Vendor Transaction Status; dynamic + AI: External Fulfillment (Inventory/Returns/Shipping), FBA Inventory (with sandbox-only createInventoryItem/addInventory); Vendor DF Orders/Shipping/Transaction Status v2021-12-28. An "AI sandbox" runs locally at `http://localhost:9001`.
- Same auth as production (LWA tokens; RDTs must be minted in production and passed to the sandbox). Limits 5 rps / burst 15; "test functionality, not scalability"; cannot trigger real-world events (e.g. notifications from real orders).

---

## F. Amazon Ads API

**Authorisation** — https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/authorization-grants
- Consent URL per region: NA `https://www.amazon.com/ap/oa`, **EU `https://eu.account.amazon.com/ap/oa`**, FE `https://apac.account.amazon.com/ap/oa`; params `client_id`, `scope`, `response_type=code`, `redirect_uri` (HTTPS, listed in the LwA app's "Allowed Return URLs"), optional `state`, `code_challenge`, `code_challenge_method` (PKCE recommended). Redirect returns `?code=…&scope=advertising%3A%3Acampaign_management`. Codes expire in 5 min, single-use.
- Token exchange: `POST` to `https://api.amazon.com/auth/o2/token` (NA) / `https://api.amazon.co.uk/auth/o2/token` (EU) / `https://api.amazon.co.jp/auth/o2/token` (FE) with `grant_type=authorization_code|refresh_token`; "The resulting tokens are valid globally across all regions." Access token `Atza|…` valid **60 min** (`expires_in: 3600`); refresh token `Atzr|…`.
- **Refresh-token lifetime** — https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/refresh-tokens: "Effective July 30, 2026, refresh tokens issued for Amazon Ads API advertising scopes expire 365 days from the date of advertiser consent"; tokens issued before that date have no fixed expiry. Refresh returns the same refresh token (no rotation). Invalid when: expired, advertiser revokes/removes the app, LwA client credentials changed/deleted, suspicious activity → HTTP 400 `invalid_grant` "User may have revoked or didn't grant the permission." Bound to one client application.
- Scopes — https://advertising.amazon.com/API/docs/en-us/guides/onboarding/assign-api-access: `advertising::campaign_management` (nearly everything), `advertising::test:create_account` (test-account creation — https://advertising.amazon.com/API/docs/en-us/guides/account-management/test-accounts/overview), `advertising::audiences` (Data Provider API, needs separate approval). Other scopes (e.g. DSP-specific): **unverified**.
- Headers on every call — https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/overview: `Amazon-Advertising-API-ClientId`, `Authorization: Bearer <access token>`, and for nearly all resources `Amazon-Advertising-API-Scope: <profileId>` (missing/wrong → 401 or 400).
- **Profiles** — https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/profiles: a profile = one advertiser account in one marketplace; `GET /v2/profiles` (no Scope header; max 5000 items; filters `apiProgram`, `accessLevel`, `profileTypeFilter`) returns only profiles in the region of the host called; `accountInfo.type` ∈ `seller | vendor | agency`; `marketplaceStringId` = SP-API marketplace ID; seller SB/SD need Brand Registry. One refresh token → all profiles the Amazon login can manage, per regional host; a profileId from another region is rejected (4XX). Manager accounts can be linked to many advertiser accounts.
- Endpoints — https://advertising.amazon.com/API/docs/en-us/reference/api-overview: NA `https://advertising-api.amazon.com` (US, CA, MX, BR); **EU `https://advertising-api-eu.amazon.com`** (UK, FR, IT, ES, DE, NL, AE, PL, TR, EG, SA, SE, BE, IN, ZA); FE `https://advertising-api-fe.amazon.com` (JP, AU, SG).

**Rate limits** — https://advertising.amazon.com/API/docs/en-us/reference/concepts/rate-limiting: dynamic, "based on the overall system load"; 429 carries a `Retry-After` header (seconds); exponential backoff with max delay/retries; report-request limits are tiered per region by report-queue depth (spread backfills across the day, use longer backoffs); "list extended data" calls weigh 5× standard; prefer Exports over listing everything. Limits are not published per operation.

**API surface families** (confirmed from official pages read; ones not readable are flagged)
| Family | Notes | Source |
|---|---|---|
| Amazon Ads API **v1** (common model) | single model across SP, SB, SD, Sponsored TV, DSP; will "eventually fully replace the ad product-specific APIs"; betas listed separately | https://advertising.amazon.com/API/docs/en-us/reference/amazon-ads/overview |
| Sponsored Products (v3), Sponsored Brands, Sponsored Display | product-specific campaign APIs (e.g. `POST /sp/campaigns/list`, content type `application/vnd.spCampaign.v3+json`); SD variants for sellers/vendors vs non-Amazon sellers | https://advertising.amazon.com/API/docs/en-us/guides/overview , profiles page |
| Reporting v3 | async report requests broken down by campaign/ad group/…; rate-tiered | https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/overview |
| Exports | async structure export of campaigns/ad groups/ads/targets (metadata, not performance) | https://advertising.amazon.com/API/docs/en-us/guides/exports/overview |
| Amazon Marketing Stream | push datasets to SQS/Firehose; see below | https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/overview |
| Amazon DSP | agency/advertiser DSP APIs; `GET /dsp/advertisers`; AMS `adsp-*` datasets via `POST /dsp/streams/subscriptions` with `Amazon-Advertising-API-Account-ID` | profiles page; AMS onboarding |
| Data Provider API (Audiences) | scope `advertising::audiences`, separate approval | assign-api-access page |
| Test accounts | scope `advertising::test:create_account`; no serving/performance data | test-accounts page |
| Profiles / Manager accounts / User permissions | `/v2/profiles`; manager accounts; "Advertising User Permissions Management APIs" (`/user-permissions`) | profiles page; https://advertising.amazon.com/API/docs/en-us/user-permissions |
| Brand Metrics, Insights API, Stores, Posts, Lock Screen Ads, Billing/Invoices | named on the test-accounts page as (un)supported features — they exist as API areas | https://advertising.amazon.com/API/docs/en-us/guides/account-management/test-accounts/overview |
| Recommendations | AMS dataset `sponsored-ads-campaign-diagnostics-recommendations`, `sp-budget-recommendations`; v1 roadmap lists "recommendations, rules, media planning" | AMS data guide; v1 overview |
| Attribution, Portfolios, Change history, Creatives/Creative asset library, Locations, Persona Builder, Product eligibility, Common Marketplace | **unverified** in this pass (the docs URLs I tried 404'd or weren't reachable); presumed present in the "API Specifications" nav | — |

**Amazon Marketing Stream** — https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/overview , onboarding https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/onboarding , data guide https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/data-guide
- Hourly traffic/conversion **deltas** (restatements arrive as more deltas; dedupe by `idempotency_id`; early negative values are corrections) plus near-real-time messaging (entity changes, `budget-usage` when budget consumption moves ≥5%).
- Datasets: `sp-traffic`, `sp-conversion`, `sb-traffic`, `sb-conversion`, `sb-clickstream`, `sb-rich-media`, `sd-traffic`, `sd-conversion`, `budget-usage`, `sponsored-ads-campaign-diagnostics-recommendations`, `sp-budget-recommendations`, `ads-campaign-management-{campaigns,adgroups,ads,targets}` (all NA/EU/FE, `POST /streams/subscriptions`); DSP: `adsp-traffic`, `adsp-conversion`, `adsp-clickstream`, `adsp-rich-media` (`POST /dsp/streams/subscriptions`).
- Destinations: SQS **standard** queue (FIFO unsupported) or Amazon Data Firehose (S3/Redshift/Snowflake/…; needs stream ARN + subscription-role ARN + subscriber-role ARN). AWS region must match the advertiser: EU → `eu-west-1` (NA us-east-1, FE us-west-2). Each dataset×region has its own resource-based IAM policy (CloudFormation template recommended).
- Subscription: one `POST /streams/subscriptions` per **profile × dataset** (`dataSetId`, `destinationArn`, `clientRequestToken`); Amazon then drops an SNS `SubscriptionConfirmation` message in the queue that you must confirm (GET `SubscribeURL` or `sns:ConfirmSubscription`) within 3 days, else `FAILED_CONFIRMATION`. No delete — set status `ARCHIVED` via `PUT /streams/subscriptions/{id}`. No backfill. Timestamps `time_window_start` are in the advertiser profile's timezone.
- Prerequisites: Ads API access + access token + profile ID + AWS account; the overview says it "is available for integrated partners and other advertisers". A separate AMS approval step is **not** documented on the pages read — unverified whether one exists.

**App approval** — https://advertising.amazon.com/API/docs/en-us/guides/onboarding/overview , https://advertising.amazon.com/API/docs/en-us/guides/onboarding/apply-for-access , https://advertising.amazon.com/API/docs/en-us/guides/onboarding/assign-api-access
1. Create an LwA security profile/client (free, no approval).
2. Apply: **Partner** (tool provider/agency) → register in the Amazon Ads Partner Network, Console → API Applications → Request API Access, form + link LwA apps; **Direct Advertiser** → application form, signed in with the same email as the Developer account. Form covers intended use, the Amazon Ads API License Agreement and Data Protection Policy. "Application approval may take up to 1 business day."
3. Assign access: email link (log out of every other Amazon account first; link invalidates otherwise) → pick the LwA app → scopes granted; "This association cannot be changed once it is set."

---

## G. Things a serious integrator also wires up

- **LWA client-secret rotation every 180 days** — https://developer-docs.amazon/sp-api/docs/rotating-your-apps-lwa-credentials: 90-day advance notice; old secret dies 7 days after a new one is generated; unrotated secret → SP-API errors (`Unauthorized`, "The LWA secret token you provided has expired"). Rotate in the console or programmatically via Application Management `rotateApplicationClientSecret` (grantless `sellingpartnerapi::client_credential:rotation`); the new secret is delivered **only** to your preregistered SQS queue as `APPLICATION_OAUTH_CLIENT_NEW_SECRET`; `APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY` warns ahead (Developer Console → Notification Preferences). Refresh tokens survive rotation. Changelog: https://developer-docs.amazon.com/sp-api/changelog/important-you-must-rotate-your-login-with-amazon-lwa-credentials-client-secrets-for-all-applications-every-180-days
- **Annual re-authorisation for public apps** (365 days, or on any role addition) with a "Re-Authorize" button in Manage Your Apps; your OAuth handler must accept re-auth for an existing seller and overwrite the stored refresh token — https://developer-docs.amazon/sp-api/docs/renew-authorizations
- **Listing-level notifications a PIM should subscribe to**: `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE`, `ITEM_PRODUCT_TYPE_CHANGE`, `PRODUCT_TYPE_DEFINITIONS_CHANGE`, `BRANDED_ITEM_CONTENT_CHANGE` (all EventBridge-capable), plus `ORDER_CHANGE` (with `eventFilter` OrderChangeType), `FEED_PROCESSING_FINISHED`, `REPORT_PROCESSING_FINISHED`, `ANY_OFFER_CHANGED`, `PRICING_HEALTH`, `FBA_INVENTORY_AVAILABILITY_CHANGES`, `ACCOUNT_STATUS_CHANGED` (SQS). Recommended MFN set per https://developer-docs.amazon/sp-api/docs/subscribe-to-mfn-notifications: `ORDER_CHANGE` (MFN_ORDER_STATUS_CHANGE and ORDER_STATUS_CHANGE are gone).
- **Data Kiosk (GraphQL)** for sales & traffic analytics under the Brand Analytics role, with `DATA_KIOSK_QUERY_PROCESSING_FINISHED`; concurrency-limited, no scheduling — https://developer-docs.amazon/sp-api/docs/data-kiosk-api-v2023-11-15-use-case-guide
- **Solution Provider Portal** is now the single console for developer profile, apps, authorisations, notification preferences and secret rotation; registration requires the primary user; public developers must pass the security questionnaire and PII assessment for restricted roles — https://developer-docs.amazon/sp-api/docs/registering-as-a-developer
- **Application Integrations API** lets the app post notifications into the seller's Seller Central banner (role "Notifications in Seller Central") — https://developer-docs.amazon/sp-api/docs/app-integrations
- **Amazon Shipping API v2** lives on its own docs host and has its own roles ("Amazon Logistics"); off-Amazon rates expire in 10 minutes — https://developer-docs.shipping.amazon.com/apis/docs/shipping-api-v2-reference
- **Vehicles API** (EU-only fitment data) and **Listings Restrictions** (gating/approval links) matter for EU catalogue onboarding — https://developer-docs.amazon/sp-api/docs/vehicles-api , https://developer-docs.amazon/sp-api/docs/listings-restrictions-api
- **Transfers / Seller Wallet / Finances v2024-06-19** cover payouts and balances (Transfers `initiatePayout` is EU-only) — https://developer-docs.amazon/sp-api/docs/transfers-api
- **`sellingpartnerapi::migration`** and the Authorization API are gone; do not design around MWS auth tokens (`mws_auth_token` is no longer a callback parameter on the current workflow page).
- **Region mismatch is a 403** ("Region mismatch") — route each seller's calls by the region of its authorisation — https://developer-docs.amazon/sp-api/docs/resolve-common-http-and-authorization-error-codes
