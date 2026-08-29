# R2 — eBay: connection + API-surface map for a PIM (EU seller: IT/DE/FR/ES/UK)

Researched 2026-08-29 against developer.ebay.com only (pages read in-browser; the site now redirects the old `api-docs/static/*.html` URLs to consolidated guides — both URLs are given where relevant). Facts I could not confirm on an official page are marked **unverified**.

Method note: WebFetch/curl are bot-blocked on developer.ebay.com (403), so every page was read through Chrome. Versions and scope lists come from eBay's own OpenAPI specs at `https://developer.ebay.com/api-docs/master/<ctx>/<api>/openapi/3/<api>_oas3.json`.

---

## A. Auth

Source (all of A unless noted): Authorization guide — https://developer.ebay.com/develop/guides/sell/authorization (old URLs `oauth-authorization-code-grant.html`, `oauth-consent-request.html`, `oauth-refresh-token-request.html`, `oauth-tokens.html`, `oauth-client-credentials-grant.html`, `oauth-runame.html`, `oauth-scopes.html`, `oauth-trad-apis.html` all 301 here).

| Item | Fact |
|---|---|
| Consent (authorize) endpoint | `GET https://auth.ebay.com/oauth2/authorize` (prod) / `GET https://auth.sandbox.ebay.com/oauth2/authorize` (sandbox) |
| Query params | `client_id` (required), `redirect_uri` = **the RuName value** (required), `response_type=code` (required), `scope` = URL-encoded space-separated list (required), `state` (optional, "opaque value… returned… to the client's accept URL… recommend… to prevent cross-site request forgery"), `prompt=login` (optional: "force a user to log in… even if they already have an existing user session"), `locale` (optional, e.g. `locale=de-DE`, localizes the consent page) |
| Consent result | Redirect to the RuName's Accept URL with `state`, `code` (max 1024 chars, single use) and `expires_in` (seconds the code is valid; sample shows `expires_in=299`). Decline → RuName's Auth Declined URL. |
| Token endpoint | `POST https://api.ebay.com/identity/v1/oauth2/token` (prod) / `https://api.sandbox.ebay.com/identity/v1/oauth2/token`; headers `Content-Type: application/x-www-form-urlencoded`, `Authorization: Basic base64(client_id:client_secret)`; body `grant_type=authorization_code&code=<url-encoded code>&redirect_uri=<RuName>` |
| Access-token lifetime | `"expires_in": 7200` — "the token remains valid for 7,200 seconds (2 hours)" (both user and application tokens) |
| Refresh-token lifetime | `"refresh_token_expires_in": 47304000` (= 547.5 days ≈ 18 months). The guide only says "long-lived"; the 18-month figure is the numeric value in the official sample response. |
| Refresh rotation | **Not rotated.** The refresh-token grant response contains only `access_token`, `expires_in`, `token_type` — no new refresh token. "You can continue to use the refresh token… as long as the refresh token associated with their account is valid." |
| Refresh request | `grant_type=refresh_token&refresh_token=…&scope=…`; `scope` is optional; "If you do specify a scope parameter, the included scope values must be equal to or a subset of the scope values included in the consent request." |
| Client-credentials grant | Same token endpoint, `grant_type=client_credentials&scope=…`; returns `"token_type": "Application Access Token"`, `expires_in: 7200`. Used for methods on non-user data (metadata, taxonomy, Notification getTopics/getPublicKey, Browse…). |
| Scope consent semantics | "Adding a new scope to an existing User access token requires a new permission grant from each of your users" and "if you update the scopes needed by your app, you must update both the access token and the refresh token, starting with Getting the third-party consent." → **adding a scope later = full re-consent.** Consent page lists exactly the scopes requested; "no need to specify a read-only scope if the corresponding view and manage scope is also being specified". |
| Revocation by seller / eBay | "if a seller changes their eBay member log-in name or the password… any active refresh tokens… will be automatically revoked… sellers can choose to revoke a token themselves via their eBay account pages… you must redo the consent-request flow". eBay can also revoke "for various reasons". The exact error returned on a refresh with a revoked token is **unverified** (guide only says handle it "gracefully"). Signals available: Notification topic `AUTHORIZATION_REVOCATION` (reasons `REVOKED_BY_APP`, `REVOKED_BY_USER`, `REVOKED_BY_EBAY`, `PASSWORD_CHANGE`) — https://developer.ebay.com/develop/api/buy/notification_events ; Trading platform event `TokenRevocation`. |
| Revoke / introspect endpoints (app-initiated) | `POST https://api.ebay.com/identity/v1/oauth2/token/revoke` (`token`, optional `token_type_hint=access_token|refresh_token`; 200 + empty body; revoking a refresh token "MAY also revoke associated access tokens / related authorization grants / active user sessions") and `POST …/oauth2/token/introspect` (returns `active`, `scope`, `client_id`, `username`, `exp`, `iat`, `sub`, `aud`, `iss`; invalid/revoked → only `"active": false`). Client auth: `client_secret_basic`, `client_secret_post` (private_key_jwt / mTLS "optional"). |
| Token-minting rate limits | per app per 24 h: client_credentials **1,000/day**, authorization_code **10,000/day**, refresh_token **50,000/day** |
| One grant, all marketplaces | **Unverified — no explicit sentence found.** Evidence: tokens are minted per *environment* (sandbox/production) and per user, never per marketplace; the marketplace is chosen per request via `X-EBAY-C-MARKETPLACE-ID` / `marketplaceId` fields (RESTful guide: https://developer.ebay.com/develop/guides/sell/using-ebay-restful-apis ; Marketplace ID table lists EBAY_IT, EBAY_DE, EBAY_FR, EBAY_ES, EBAY_GB) and Fulfillment `getOrders` "returns all orders created within the last 90 days" with no marketplace parameter (https://developer.ebay.com/develop/api/sell/fulfillment_api/order/getorders). `locale` on the consent URL only localizes the page. |
| Sandbox vs production keysets | Separate keysets; "Your application has two unique RuName values, each supports either the Sandbox or Production"; "it's possible the Sandbox and Production environments support different sets of scopes for your application"; tokens "work only in the environment for which the token was minted". |
| RuName | "Instead of a URL, the OAuth flow requires a custom RuName value that eBay generates"; configured with Display Title, Privacy Policy URL, Auth Accepted URL, Auth Declined URL (Developer portal → Application Keys → User Tokens). |
| Trading API with OAuth | Trading call reference "Making a Call": header `X-EBAY-API-IAF-TOKEN` — "Required if you do not supply an eBay Authentication token using the RequesterCredentials field. This header supports the use of OAuth tokens… supply a valid User access token"; `X-EBAY-API-COMPATIBILITY-LEVEL` is "Always" required — https://developer.ebay.com/devzone/xml/docs/Concepts/MakingACall.html. Current Trading API version: **1477** (page header of https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/NotificationEventTypeCodeType.html). Which scopes a given Trading call needs under OAuth: **unverified** (the "Using OAuth with the eBay traditional APIs" section of the guide renders empty). Auth'n'Auth is "still available for older applications" but eBay "recommend[s] that you use OAuth". |

Best-practice line worth copying into the connector: "refresh each access token after it expires (and you receive an 'Invalid access token' error), rather than trying to renew each token before it expires." Invalid-token shape (Feed page sample): HTTP 401, `errorId 1001, domain OAuth, "Invalid access token"` — https://developer.ebay.com/api-docs/sell/static/feed/lms-feeds-quick-reference.html.

---

## B. Scope list

There is **no single official scope reference page any more** (`oauth-scopes.html` redirects to the guide, which says to read each method's "OAuth Scope" section, and to copy the full string from Your Account → Application Keys → User Tokens → "See all"). The table below is assembled from the `securitySchemes` of eBay's own OpenAPI specs (cited per row) plus method pages and the Notification Topics page. Every scope is `https://api.ebay.com/oauth/api_scope/<name>` unless noted.

| Scope | Grant | Unlocks (official description) | Special approval? | Source |
|---|---|---|---|---|
| `https://api.ebay.com/oauth/api_scope` (base) | client-cred | "View public data from eBay" — Metadata, Taxonomy, Charity, Translation, Browse, Notification getTopics/getPublicKey, Key Management, Client Registration, Developer Analytics | no | specs (see D) |
| `sell.inventory` / `sell.inventory.readonly` | auth-code | "View and manage your inventory and offers" / "View your inventory and offers"; also Feed (LMS inventory feeds), Negotiation, Recommendation, Media, Catalog, Metadata (user-level) | no | sell_inventory_v1_oas3.json, sell_feed, sell_negotiation, sell_recommendation, commerce_media, commerce_catalog, sell_metadata |
| `sell.account` / `sell.account.readonly` | auth-code | "View and manage your account settings" (business policies, programs, rate tables…) | no | sell_account_v1_oas3.json |
| `sell.marketing` / `sell.marketing.readonly` | auth-code | "View and manage your eBay marketing activities, such as ad campaigns and listing promotions"; Feed (promotion reports); topic `PLA_CAMPAIGN_BUDGET_STATUS` | no | sell_marketing_v1_oas3.json; notification_events |
| `sell.fulfillment` / `sell.fulfillment.readonly` | auth-code | "View and manage your order fulfillments"; Feed LMS_ORDER_REPORT / order feeds; topic `ORDER_CONFIRMATION` | no | sell_fulfillment_v1_oas3.json; lms quick ref |
| `sell.finances` | auth-code | "View and manage your payment and order information… and allow you to initiate refunds using the third party application" (Finances API; also listed on Fulfillment spec for issueRefund) | No scope-level approval documented; but **every Finances call and issueRefund for EU/UK sellers must carry a digital signature** (H) | sell_finances_v1_oas3.json; digital-signatures guide |
| `sell.payment.dispute` | auth-code | "View and manage disputes and related details (including payment and order information)" (Fulfillment payment_dispute) | no | sell_fulfillment_v1_oas3.json |
| `sell.analytics.readonly` | auth-code | "View your selling analytics data, such as performance reports"; topics `SELLER_STANDARDS_PROFILE_METRICS`, `SELLER_CUSTOMER_SERVICE_METRIC_RATING`, `LISTING` | no | sell_analytics_v1_oas3.json; notification_events |
| `sell.logistics` | auth-code | "allow signed in user to access Logistics information" (shipping quotes/labels) | no | sell_logistics_v1_oas3.json |
| `sell.stores` | auth-code | Stores API (getStore, store categories) | no | https://developer.ebay.com/develop/api/sell/stores_api/store/getstore |
| `sell.stores.readonly` | — | **unverified** (not seen in spec/method pages read) | — | — |
| `sell.reputation` / `sell.reputation.readonly` | — | **unverified** (not seen on any page read) | — | — |
| `https://api.ebay.com/oauth/scope/sell.edelivery` (note: path is `oauth/scope`, as printed) | auth-code | eDelivery International Shipping API | API "only available for Greater-China based sellers with an active eDIS account" | https://developer.ebay.com/develop/api/sell/edelivery_international_shipping_api/bundle/createbundle |
| `sell.leads` | auth-code | Leads API (classified-ad leads) | "(Limited Release) API available only to select developers approved by business units" | https://developer.ebay.com/develop/api/sell/leads_api |
| `sell.inventory.mapping` | auth-code | Inventory Mapping (GraphQL, AI listing previews; US only); topic `LISTING_PREVIEW_CREATION_TASK_STATUS` | no (growth check to scale) | notification_events; https://developer.ebay.com/develop/api/sell/inventory_mapping |
| `sell.listing.read` | auth-code | topic `LISTING` (CREATED/UPDATED/ENDED) | no | notification_events |
| `sell.cancellation` / `sell.cancellation.read` | auth-code | topics `ORDER_CANCELLATION_ACTIVITY`, `ITEM_COMMITMENT_CANCELLATION_ACTIVITY`, `PURCHASE_QUOTE_CANCELLATION_ACTIVITY` (Post-Order cancellations) | no | notification_events |
| `sell.return` / `sell.return.read` | auth-code | topic `ORDER_RETURN_ACTIVITY` (Post-Order returns) | no | notification_events |
| `sell.inquiry` / `sell.inquiry.read` | auth-code | topic `ORDER_INQUIRY_ACTIVITY` | no | notification_events |
| `sell.marketplace.insights.readonly` | auth-code | "read only access to marketplace insights" (Marketplace Insights API — Limited Release per RESTful guide) | Limited Release | developer_analytics spec |
| `metadata.insights` | client-cred | "View metadata insights such as aspect relevance" (Taxonomy) | no | commerce_taxonomy_v1_oas3.json |
| `commerce.identity.readonly` | auth-code | "View a user's basic information, such as username or business account details" (getUser) | "Additional user restrictions apply" (call-limits footnote †) | commerce_identity_v1_oas3.json |
| `commerce.identity.email.readonly` / `.phone.readonly` / `.address.readonly` / `.name.readonly` | auth-code | personal e-mail / telephone / address / first+last name from the member account | † | commerce_identity_v1_oas3.json |
| `commerce.identity.status.readonly` | — | **unverified** (not in the v2.0.0 spec) | — | — |
| `commerce.notification.subscription` / `.readonly` | auth-code | "View and manage your event notification subscriptions" (user-scoped subscriptions) | no | commerce_notification_v1_oas3.json |
| `commerce.catalog.readonly` | auth-code | "allow signed in user to read catalog data" (Catalog API; Feed catalog reports) | † | commerce_catalog_v1_beta_oas3.json |
| `commerce.vero` | auth-code | VeRO API v2 reportVeroViolations | "only available to members of the Verified Rights Owner (VeRO) Program" | https://developer.ebay.com/develop/api/sell/vero_api_v2/report_vero_violations/reportveroviolations |
| `commerce.message` | auth-code | Message API sendMessage/conversations; topics `NEW_MESSAGE`, `BUYER_QUESTION` | no | https://developer.ebay.com/develop/api/sell/message_api/conversation/sendmessage |
| `commerce.feedback` (auth-code) / `commerce.feedback.readonly` (client-cred) | both | Feedback API getFeedback etc. | no | https://developer.ebay.com/develop/api/sell/feedback_api/feedback/getfeedback |
| `commerce.shipping` | auth-code | topic `ITEM_MARKED_SHIPPED` | no | notification_events |
| `sell.item.draft`, `sell.item` | — | **unverified** (Listing API (beta) is no longer in the portal API list and its spec URL 404s) | — | — |
| `buy.item.bulk` | client-cred | Browse getItems bulk | "Buy APIs require an additional license" | buy_browse_v1_oas3.json; call-limits page |
| `buy.marketing` | client-cred | Buy Marketing API (merchandised items) | Buy licence | buy_marketing_v1_beta_oas3.json |
| `buy.offer.auction` | auth-code | Buy Offer API bidding | Buy licence | buy_offer_v1_beta_oas3.json |
| `buy.guest.order` | client-cred | Buy Order v2 guest checkout | Buy licence | buy_order_v2_oas3.json |
| `buy.deal` | client-cred | Deal API | Buy licence | buy_deal_v1_oas3.json |
| `buy.watchlist.read` | auth-code | topic `WATCHLIST_REVISION` | Buy licence (unverified) | notification_events |
| `buy.item.feed`, `buy.shopping.cart`, `buy.order` (v1) | — | **unverified** (Buy Feed v1 spec URL 404; Order v1 not fetched) | — | — |

Count for a seller-side PIM: **~35 distinct non-Buy scopes are documented**; a full-capability EU seller connector realistically requests ~20 (inventory, inventory.readonly, account, account.readonly, marketing, marketing.readonly, fulfillment, fulfillment.readonly, finances, payment.dispute, analytics.readonly, logistics, stores, listing.read, cancellation(+.read), return(+.read), inquiry(+.read), commerce.identity.readonly, commerce.notification.subscription(+.readonly), commerce.catalog.readonly, commerce.message, commerce.feedback, commerce.shipping).

---

## C. App prerequisites

| Requirement | Fact | Source |
|---|---|---|
| Developer account + keysets | "You must have an active eBay Developer Program account"; keysets for Sandbox and Production are generated in the portal (Your Account → Application Keys); each keyset gets its own scope set and its own RuName. | Authorization guide |
| Marketplace Account Deletion endpoint is **mandatory before the first production call** | "New third-party developers coming to the platform must subscribe to or opt out of eBay marketplace account deletion/closure notifications before they make their first production API call. Once… subscribed… or… successfully opted out, the keyset/App ID is activated." "Failure to comply… will result in termination of your access to the Developer Tools, and/or reduced access to all or some APIs." Opt-out ("Not persisting eBay data" toggle + exemption reason) only for apps storing no eBay data. | https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion |
| Challenge validation | eBay sends `GET https://<callback_URL>?challenge_code=123`; endpoint must reply `200 OK`, `content-type: application/json`, body `{"challengeResponse":"<hex>"}` where hex = SHA-256 over `challengeCode + verificationToken + endpoint` **in that order**; endpoint must be https, no internal IP/localhost; verification token 32–80 chars `[A-Za-z0-9_-]`; use a JSON library (a BOM breaks it); endpoint must support GET and POST. | same |
| Deletion payload / ack / retry | POST JSON `{metadata:{topic:"MARKETPLACE_ACCOUNT_DELETION",schemaVersion,deprecated}, notification:{notificationId,eventDate,publishDate,publishAttemptCount,data:{username,userId,eiasToken}}}`; ack with 200/201/202/204; unacknowledged → resent "until it is acknowledged"; after 24 h of unacknowledged notifications the URL is "marked down" + alert e-mail; 30 days to fix or "marked as non-compliant"; be ready for up to ~1500/day bursts; from 2025-09-26 "select developers" get an immutable userId instead of username for US users; verify with `x-ebay-signature` → `getPublicKey`; SDKs return 412 on bad signature. | same |
| Application Growth Check | "required if you want to: Increase the API call limits for your application; Use restricted APIs in production"; free; reviews compliance with the API License Agreement, OWASP, UTF-8, latest API versions, retries "for a maximum of two times for infrastructure errors", no scraping of eBay credentials, no iFrames of eBay pages. | https://developer.ebay.com/grow/application-growth-check ; https://developer.ebay.com/api-docs/static/gs_request-an-application-growth.html |
| Business policies opt-in | "To use the Inventory API… the user's seller account must be opted in to business policies"; "you must opt-in to the SELLING_POLICY_MANAGEMENT seller program using the optInToProgram call in the Account API"; every offer "must also reference a payment, a fulfillment, and a return business policy"; policies are per marketplace ("the number of business policies compounds when a seller targets multiple marketplaces"); category types ALL_EXCLUDING_MOTORS_VEHICLES / MOTORS_VEHICLES. Opt-in can take "up to 24-hours" (optInToProgram page, seen via search snippet — https://developer.ebay.com/api-docs/sell/account/resources/program/methods/optInToProgram). | https://developer.ebay.com/api-docs/sell/inventory/static/overview.html ; https://developer.ebay.com/api-docs/sell/static/seller-accounts/business-policies.html |
| Out-of-Stock control | "very good idea"; keeps a 0-quantity listing alive up to 90 days (hidden from search); set via My eBay or Trading `SetUserPreferences`. | Inventory overview |
| Inventory-API listings are locked to the API | "listings created through the Inventory API cannot be edited through Seller Hub or any other listing platform." Trading-created listings must be converted with `bulkMigrateListing` (1–5 item IDs per call). | Inventory overview; https://developer.ebay.com/develop/api/sell/inventory_api/listing/bulkmigratelisting |

---

## D. Complete API surface (current versions from the OpenAPI specs; portal lists at https://developer.ebay.com/develop/api/sell and https://developer.ebay.com/develop/api/buy)

### Sell APIs
| API | Version / base path | One line | Source |
|---|---|---|---|
| Account v1 | v1.9.3 `/sell/account/v1` | business policies (fulfillment/payment/return), programs (optInToProgram), rate tables, sales tax, KYC, subscriptions, custom policies | sell_account_v1_oas3.json |
| Account v2 | version **unverified** (spec URL 404); resources rate_table, payout_settings (China), combined_shipping_rules (replaces Trading Get/SetShippingDiscountProfiles), user_preferences | https://developer.ebay.com/develop/api/sell/account_api_v2 |
| Analytics | 1.3.2 `/sell/analytics/v1` | customer_service_metric, seller_standards_profile, traffic_report | sell_analytics_v1_oas3.json |
| Compliance | **DECOMMISSIONED 2026-03-30** ("This API and its associated methods have been decommissioned") | — | https://developer.ebay.com/develop/get-started/api-deprecation-status |
| Feed | v1.3.1 `/sell/feed/v1` | LMS upload/download tasks, order/inventory/customer-service-metric reports | sell_feed_v1_oas3.json |
| Finances | v1.19.0 `https://apiz.ebay.com/sell/finances/v1` (also api.ebay.com) | payouts, transactions, transfers, seller funds summary — signature-required for EU/UK | sell_finances_v1_oas3.json |
| Fulfillment | v1.20.7 `/sell/fulfillment/v1` (api + apiz) | order, shipping_fulfillment, payment_dispute, issueRefund | sell_fulfillment_v1_oas3.json |
| Inventory | 1.18.5 `/sell/inventory/v1` | location, inventory_item, inventory_item_group, offer, listing (migrate), product_compatibility, sku location mapping | sell_inventory_v1_oas3.json |
| Inventory Mapping | GraphQL; US marketplace only; "Apply for an Application Growth Check to scale" | AI listing previews from product data | https://developer.ebay.com/develop/api/sell/inventory_mapping |
| Listing (beta) | **not in the portal API list; spec 404 — status unverified (treat as withdrawn)** | — | — |
| Logistics | v1_beta.0.0 `/sell/logistics/v1_beta` | shipping quotes + labels | sell_logistics_v1_oas3.json |
| Marketing | v1.23.2 `/sell/marketing/v1` | Promoted Listings campaigns/ads/reports, promotions (item price markdown, item promotion). `setupQuickCampaign` + `launchCampaign` decommissioned 2026-03-31 | sell_marketing_v1_oas3.json; deprecation page |
| Metadata | v1.12.1 `/sell/metadata/v1` | marketplace/category policies (item conditions, return policies, listing structure, compatibilities — replaces Trading GetCategoryFeatures) | sell_metadata_v1_oas3.json |
| Negotiation | v1.1.0 `/sell/negotiation/v1` | findEligibleItems, sendOfferToInterestedBuyers | sell_negotiation_v1_oas3.json |
| Recommendation | v1.1.0 `/sell/recommendation/v1` | findListingRecommendations (ads) | sell_recommendation_v1_oas3.json |
| Stores | "1" `/sell/stores/v1` | getStore, getStoreCategories, add/rename/move/delete category, tasks | sell_stores_v1_oas3.json; stores_api page |
| Leads | Limited Release | classified-ad leads | leads_api page |
| eDelivery International Shipping | Greater-China sellers only | eDIS bundles/packages/labels | edelivery page |
| Feedback (REST) | version unverified | getItemsAwaitingFeedback, getFeedback, leaveFeedback, respondToFeedback, getFeedbackRatingSummary | feedback_api page |
| Message | "1.0.0" `/commerce/message/v1` | sendMessage, getConversation(s), update/bulkUpdateConversation | commerce_message_v1_oas3.json |
| Post-Order | `/post-order/v2/…` (REST, traditional family) | cancellation (create/search/get/approve/reject), casemanagement (get/appeal/search), inquiry (get/escalate/issue_refund/search/send_message), return (search/get/add_shipping_label/decide/escalate/file upload/files/preference/issue_refund/mark_as_received/send_message/tracking/create). **Sixteen return methods decommissioned 2026-01-20, five case methods 2026-03-02, four inquiry methods 2026-03-16, four more 2026-02-02** (see deprecation page). | https://developer.ebay.com/develop/api/sell/post_order_api ; deprecation page |

### Commerce APIs
| API | Version / base | One line | Source |
|---|---|---|---|
| Catalog | v1_beta.5.3 `/commerce/catalog/v1_beta` | product search/getProduct (ePID) — replaced the decommissioned Product API | commerce_catalog_v1_beta_oas3.json |
| Charity | v1.2.1 | charity orgs | commerce_charity_v1_oas3.json |
| Identity | v2.0.0 `https://apiz.ebay.com/commerce/identity/v1` | getUser | commerce_identity_v1_oas3.json |
| Media | v1_beta.5.0 `/commerce/media/v1_beta` (apim/api/apiz hosts) | image (createImageFromFile/Url — replaces UploadSiteHostedPictures), video, document | commerce_media_v1_beta_oas3.json; deprecation page |
| Notification | v1.6.7 `/commerce/notification/v1` | config, destination, subscription (+filter, test), topic, public_key | commerce_notification_v1_oas3.json |
| Taxonomy | v1.1.1 `/commerce/taxonomy/v1` | category tree, aspects, getCategoryMappings (replaced Trading GetCategoryMappings/GetCategories) | commerce_taxonomy_v1_oas3.json |
| Translation | v1_beta.1.6 | translate title/description | commerce_translation_v1_beta_oas3.json |
| VeRO v1 / v2 | v1 "1.0.0" `/commerce/vero/v1`; v2 (vero_reason_code, report_vero_violations, vero_report, vero_report_items) — replaces Trading VeRO calls decommissioned 2026-02-02 | rights-owner reports | commerce_vero_v1_oas3.json; vero_api_v2 page |

### Buy APIs ("Buy APIs require an additional license" — call-limits page)
Browse v1.20.4; Feed v1 (version unverified) + Feed Beta; Marketing v1_beta.2.0; Offer v1_beta.0.1; Order v1 (`updatePaymentInfo` decommissioned 2026-06-02) and Order v2.1.4 (`apix.ebay.com`); Deal v1.3.0. (specs cited in B)

### Developer APIs
Developer Analytics v1_beta.0.1 (`rate_limit` → getRateLimits, `user_rate_limit` → getUserRateLimits; "call quota, number of calls used, number of remaining calls, reset time, and the time window for each resource"; covers "eBay RESTful APIs and the legacy Trading API") — https://developer.ebay.com/develop/api/sell/developer_analytics_api ; Key Management v1.0.0 (`apiz.ebay.com/developer/key_management/v1`, signing_key: create/get/getAll) — https://developer.ebay.com/develop/api/sell/key_management_api ; Client Registration ("Developer Registration API" v1.0.0, `tppz.ebay.com/developer/registration/v1`, for regulated Third Party Providers) — spec.

### Traditional APIs — status
| API | Status | Replacement | Source |
|---|---|---|---|
| Trading | live, version 1477; XML/SOAP; OAuth via `X-EBAY-API-IAF-TOKEN` | — | MakingACall.html |
| Shopping | **decommissioned 2025-02-04** | Browse API | deprecation page |
| Finding | **decommissioned 2025-02-04** | Browse API | deprecation page |
| Merchandising | deprecated 2024-07-29, decommission TBD | Buy Marketing API | deprecation page |
| Product API / Product Metadata API | decommissioned 2026-08-15 / 2026-07-15 | Catalog API (search, getProduct) / Metadata API compatibilities | deprecation page |
| Business Policies Management | deprecated 2021-03-23, TBD | Account API policies | deprecation page |
| Return Management | deprecated 2023-02-03, TBD | Post-Order API | deprecation page |
| Post-Order | live (v2) but heavily pruned (see above) | — | deprecation page |
| Feedback (Trading calls) | live: GetFeedback, GetItemsAwaitingFeedback, LeaveFeedback, RespondToFeedback | Feedback API (REST) | traditional_sell_communication_apis page |
| Client Alerts | **unverified** — guide URL 404s and the API is absent from both portal API lists; no deprecation entry found | poll Fulfillment/Trading instead | — |
| Trading calls already gone | GetCategories (2026-04-15 → Taxonomy/Metadata), GetCategoryFeatures (2026-06-04 → Metadata), GetCategoryMappings (2025-06-02 → Taxonomy), ExtendSiteHostedPictures (2025-07-28), VeRO calls (2026-02-02 → VeRO API), eBayPlus fields (2026-02-16), GeteBayOfficialTime (2025-01-27, per Q4-2024 newsletter snippet) | | deprecation page |
| Trading calls scheduled | GetAdFormatLeads → 2026-09-21 (Leads API); GetSellerDiscountProfiles/SetShippingDiscountProfiles → 2027-01-19 (Account v2 combined shipping rules); UploadSiteHostedPictures → 2026-09-30 (Media API); `ItemMarkedPaid` notification event → 2026-06-22 | | deprecation page |

**Trading API's remaining exclusive / still-needed capabilities** (portal call lists): listing — AddItem, AddItems, AddFixedPriceItem, AddSecondChanceItem, ReviseItem, **ReviseFixedPriceItem**, **ReviseInventoryStatus**, AddToItemDescription, RelistItem, RelistFixedPriceItem, VerifyAdd*/VerifyRelistItem, EndItem(s), EndFixedPriceItem, GetItem, GetSellerList, GetSellerEvents (https://developer.ebay.com/develop/api/sell/traditional_listing_apis); orders — GetOrders, **GetItemTransactions**, GetSellerTransactions, CompleteSale, AddOrder, SendInvoice (…/traditional_sell_order_management_apis); Best Offer — GetBestOffers, RespondToBestOffer, GetAllBidders (…/traditional_offers_and_leads_apis); account — GetUser, GetUserContactDetails, GetBidderList, GetAccount, Get/SetUserPreferences, Get/SetTaxTable, **GetMyeBaySelling**, SetUserNotes, ConfirmIdentity, token calls (…/traditional_sell_user_account_apis); metadata — GeteBayDetails, GetItemShipping, GetDescriptionTemplates; store — GetStore, SetStoreCategories, GetStoreCategoryUpdateStatus; messaging/notifications — see E. Variations and item specifics on legacy (non-Inventory-API) listings are handled through these Add/Revise*Item calls (the LMS feed page confirms "FIXED_PRICE feed types… support fixed-price items with single and multiple variations").

**Versioning / deprecation cadence** (https://developer.ebay.com/develop/guides/sell/using-ebay-restful-apis, "Versioning and the API lifecycle"): three-part `major.minor.maintenance`; only a major bump changes the URI (`/v1` → `/v2`); launch stages Alpha (NDA) / Beta ("Limited production use but not for business critical use") / GA; "Limited Release" APIs restricted to approved apps; the deprecation policy text itself was not readable (page truncated) — **unverified**. Per-API release notes are linked from every API page; the consolidated deprecation table is https://developer.ebay.com/develop/get-started/api-deprecation-status.

---

## E. Real-time events

### Commerce Notification API (REST)
Model (https://developer.ebay.com/develop/guides/sell/sell-communications-guide): `createDestination` (https endpoint + verification token; challenge-code validation identical to C) → `getTopics` (read `authorizationScopes`; "if you lack the necessary scope… you cannot subscribe") → `createSubscription` (topicId + destinationId + `status: ENABLED`) → for each POST extract Base64 `X-EBAY-SIGNATURE`, decode, call `getPublicKey/{public_key_id}` (client-credentials `api_scope`; cache ~1 h; "supported in Sandbox") and verify the "ECC message signature" over the payload. Supporting methods: get/update/delete destination, get/enable/disable/test/update/delete subscription, subscription filters, get/updateConfig (alert e-mail). Verification SDKs (Java/.NET/Node/PHP/Go) return 412 on failure. Topic IDs and the header/payload shape (`metadata`, `notification`, `publishAttemptCount`) — https://developer.ebay.com/develop/api/buy/notification_events ; getTopics — https://developer.ebay.com/develop/api/sell/notification_api/topic/gettopics ; getPublicKey — https://developer.ebay.com/develop/api/sell/notification_api/public_key/getpublickey.

Topics (29 on the official Notification Topics page, grouped as eBay groups them):

| Topic | Group | Sub-events | Extra scope beyond `api_scope` | Restriction |
|---|---|---|---|---|
| ITEM_AVAILABILITY | Listing Mgmt | AVAILABLE / UNAVAILABLE / TEMPORARILY_UNAVAILABLE | — | ePN partners only |
| LISTING_PREVIEW_CREATION_TASK_STATUS | Listing Mgmt | COMPLETED / FAILED / COMPLETED_WITH_ERROR | sell.inventory.mapping | — |
| LISTING | Listing Mgmt | CREATED / UPDATED / ENDED | sell.analytics.readonly or sell.listing.read | — |
| SELLER_STANDARDS_PROFILE_METRICS | Account | CURRENT/PROJECTED; PROGRAM_US/UK/DE/GLOBAL | sell.analytics.readonly | — |
| AUTHORIZATION_REVOCATION | Account | REVOKED_BY_APP/USER/EBAY, PASSWORD_CHANGE | — | — |
| FEEDBACK_STAR_RATING | Account | star colours | — | — |
| MARKETPLACE_ACCOUNT_DELETION | Account | — | — (configured in portal) | mandatory |
| SELLER_CUSTOMER_SERVICE_METRIC_RATING | Account | CURRENT/PROJECTED; ITEM_NOT_AS_DESCRIBED / ITEM_NOT_RECEIVED | sell.analytics.readonly | — |
| AUCTION_ACTIVITY | Account | BID_PLACED, BID_RECEIVED (seller), OUTBID, AUCTION_WON | — | — |
| AUCTION_ENDED | Account | — | — | — |
| WATCHLIST_REVISION | Account | ITEM_WATCHED / ITEM_UNWATCHED | buy.watchlist.read | — |
| BULK_DATA_TRANSFER_THRESHOLD | Account | WARNING / REACHED / NORMAL | — | — |
| ITEM_MARKED_SHIPPED | Order | — | commerce.shipping | — |
| BUYER_REQUESTED_PURCHASE_QUOTE | Order | — | — | — |
| ORDER_CONFIRMATION | Order | "sent to a seller when the buyer completes the checkout process and payment clears" | sell.fulfillment or sell.fulfillment.readonly | — |
| PURCHASE_QUOTE_CANCELLATION_ACTIVITY | Order | REQUESTED/DECLINED/COMPLETED, SELLER_RESPONSE_REMINDER | sell.cancellation(.read) | — |
| ORDER_CANCELLATION_ACTIVITY | Order | CANCELLATION_REQUESTED/DECLINED/COMPLETED, SELLER_RESPONSE_REMINDER | sell.cancellation(.read) | — |
| ITEM_COMMITMENT_CANCELLATION_ACTIVITY | Order | same set | sell.cancellation(.read) | — |
| ORDER_RETURN_ACTIVITY | Order | RETURN_REQUESTED, RETURN_FULFILLMENT_INITIATED/COMPLETED, RETURN_CLOSED, RETURN_REFERRAL_CREATED/DECIDED/ON_HOLD, SELLER_RESPONSE_DUE_REMINDER | sell.return(.read) | — |
| ORDER_INQUIRY_ACTIVITY | Order | INQUIRY_CREATED, INQUIRY_REFERRAL_*, INQUIRY_CLOSED, SELLER_RESPONSE_REMINDER | sell.inquiry(.read) / sell.return.read | — |
| OFFER_ACTIVITY | Offers | BUYER_OFFER, BUYER_COUNTER_OFFER, SELLER_OFFER, SELLER_COUNTER_OFFER; PENDING/DECLINED/ACCEPTED/EXPIRED | — | — |
| BUYER_QUESTION | Communication | — | commerce.message | — |
| FEEDBACK_LEFT / FEEDBACK_RECEIVED | Communication | POSITIVE/NEUTRAL/NEGATIVE; ENTERED, DESCORED, MUTUAL_WITHDRAWAL_INITIATED, FEEDBACK_REVISION_OPEN/CLOSED | — | — |
| NEW_MESSAGE | Communication | FROM_MEMBERS / FROM_EBAY | commerce.message | — |
| REGULATORY_GUIDELINE | Communication | — | — | "may only be available to approved partners" |
| PLA_CAMPAIGN_BUDGET_STATUS | Marketing | OUT_OF_BUDGET (Promoted Listings priority strategy) | sell.marketing(.readonly) | — |
| ITEM_PRICE_REVISION | Inventory Discovery | — | — | ePN partners only |
| PRIORITY_LISTING_REVISION | Inventory Discovery | — | — | ePN partners only |

**There is no `ITEM_SOLD` topic in the Notification API** — the order event is `ORDER_CONFIRMATION`; `ItemSold`/`FixedPriceTransaction` exist only as Trading platform events. No `ORDER_STATUS`/shipping-status-change topic either (only ITEM_MARKED_SHIPPED).

Delivery/retry: payload field `publishAttemptCount` "indicates whether this is the first, second, or third attempt to send the notification" (topics page) → 3 attempts per notification; for MARKETPLACE_ACCOUNT_DELETION eBay resends "until it is acknowledged" and marks the URL down after 24 h (C). A general "destination disabled after N failures" rule for other topics: **unverified**.

### Legacy Platform Notifications (Trading, SOAP push)
Subscribe with `SetNotificationPreferences` (per application: up to **25 delivery URLs** in `ApplicationDeliveryPreferences`; per user token: enable event types); review with `GetNotificationPreferences`; usage with `GetNotificationsUsage`. Notifications are SOAP messages POSTed to your URL; respond `200 OK`; "after a significant number of unacknowledged notifications, eBay may stop sending"; "Notifications do not count as API calls"; eBay explicitly says to keep polling: "if you have subscribed to the AuctionCheckoutComplete notification, verify that you have also configured the periodic polling of GetOrders." — https://developer.ebay.com/api-docs/static/platform-notifications-landing.html ; https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/platform-notifications.html.
Event types (NotificationEventTypeCodeType, v1477): AskSellerQuestion, AuctionCheckoutComplete, BestOffer, BestOfferDeclined, BestOfferPlaced, BidItemEndingSoon, BidPlaced, BidReceived, BuyerCancelRequested, CheckoutBuyerRequestsTotal, CounterOfferReceived, EBP* (buyer-protection case events), EndOfAuction, Feedback, FeedbackLeft, FeedbackReceived, FeedbackStarChanged, **FixedPriceTransaction**, INRBuyerRespondedToDispute, ItemAddedToWatchList, ItemClosed, ItemWon, **ItemSold**, ItemUnsold, ItemExtended, ItemListed, ItemLost, ItemMarkedPaid (decommission 2026-06-22), ItemMarkedShipped, **ItemOutOfStock**, ItemReadyForPickup, ItemRemovedFromWatchList, **ItemRevised**, ItemRevisedAddCharity, ItemSuspended, MyMessages*, OrderInquiryReminderForEscalation, OutBid, PaymentReminder, Return* (Created/Closed/Delivered/Escalated/RefundOverdue/SellerInfoOverdue/Shipped/WaitingForSellerInfo), SecondChanceOffer, ShoppingCartItemEndingSoon, **TokenRevocation**, WatchedItemEndingSoon — https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/NotificationEventTypeCodeType.html.

### Client Alerts (polling)
Official guide URL (`/devzone/client-alerts/docs/Concepts/ClientAlertsAPIGuide.html`) returns 404 and the API is not in either portal list — **status unverified; do not build on it.**

### What still needs polling
- Orders: `GET /sell/fulfillment/v1/order?filter=lastmodifieddate:[2016-05-15T08:25:43.511Z..]` — "The time period during which qualifying orders were last modified (the orders.modifiedDate field)… ISO 8601… UTC"; also `creationdate:[..]` and `orderfulfillmentstatus`; default window is the last 90 days — https://developer.ebay.com/develop/api/sell/fulfillment_api/order/getorders. ORDER_CONFIRMATION only fires at checkout+payment; every later state (paid → shipped by seller, refunds, disputes) needs polling.
- Payouts/transactions: Finances API (no topic).
- Listing violations/regulatory: Compliance API is gone; REGULATORY_GUIDELINE topic is partner-restricted.
- Payment disputes: Fulfillment `getPaymentDisputeSummaries` (no topic).

---

## F. Rate limits & bulk

Default per-app daily limits (https://developer.ebay.com/develop/get-started/api-call-limits; "designed for individuals and smaller businesses", raise via Application Growth Check):

| API | Default |
|---|---|
| Account | 25,000/day |
| Analytics | customer_service_metric 400/day; seller_standards_profile + traffic_report 100/day |
| Feed | 100,000/day |
| Finances | 15,000/day |
| Fulfillment | order resource 100,000/day; getPaymentDispute 250,000; getPaymentDisputeSummaries 250,000; other payment_dispute methods 250,000 combined |
| Inventory | 2,000,000/day |
| Logistics | 2,500,000/day |
| Marketing | Promotion API 100,000/day; Ads API 10,000/day |
| Metadata | 5,000/day |
| Negotiation | 1,000,000/day |
| Recommendation | 5,000/day |
| Inventory Mapping | 20/day |
| Browse (Buy) | 5,000/day (getItems 5,000/day) |
| Deal / Buy Marketing / Offer / Order v1 / Order v2 | 5,000/day each; Buy Feed Beta 10,000 (item_snapshot 75,000); Buy Feed v1 75,000 |
| Catalog | 10,000/day († user restrictions) |
| Charity | 5,000/day |
| Identity | 5,000/day († ) |
| Media | image 1,000,000/day, video 5,000/day, document 1,000,000/day; each POST "50 requests per 5 seconds" per user |
| Notification | 10,000/day |
| Taxonomy | 5,000/day |
| Translation (beta) | 5,000/day |
| Developer Analytics | 5,000/day |
| Merchandising | 5,000/day |
| Trading | **5,000/day** |
| Business Policies (deprecated) / Product / Product Metadata | 5,000/day each |
| Post-Order | 5,000/day per resource (cancellation, case, inquiry, return) |
| OAuth token endpoint | 1,000 / 10,000 / 50,000 per day by grant type (A) |

429 behaviour: RESTful guide common-errors table — domain `ACCESS`, errorId **2001**, HTTP **429**, "Too many requests — The request limit has been reached for the resource"; also OAuth 1100 "Access denied — Insufficient permissions" (403) and 1001 "Invalid access token" (401) — https://developer.ebay.com/develop/guides/sell/using-ebay-restful-apis. Reset time/window per resource comes from Developer Analytics `getRateLimits` / `getUserRateLimits` (D). Reset time-of-day: **unverified**.

Feed API (LMS) — https://developer.ebay.com/api-docs/sell/static/feed/lms-feeds-quick-reference.html:
- Inventory upload feeds (`createTask`, scope sell.inventory): LMS_ADD_FIXED_PRICE_ITEM, LMS_END_FIXED_PRICE_ITEM, LMS_REVISE_FIXED_PRICE_ITEM, LMS_RELIST_FIXED_PRICE_ITEM, LMS_VERIFY_ADD_FIXED_PRICE_ITEM, LMS_ADD_ITEM, LMS_END_ITEM, LMS_REVISE_ITEM, LMS_RELIST_ITEM, LMS_VERIFY_ADD_ITEM, LMS_REVISE_INVENTORY_STATUS (price+quantity; multi-SKU needs ItemID + SKU per `<InventoryStatus>`). "FIXED_PRICE feed types… support… single and multiple variations".
- Fulfillment upload feeds (`createTask`, scope sell.fulfillment): LMS_ORDER_ACK, LMS_SET_SHIPMENT_TRACKING_INFO.
- Report downloads: LMS_ACTIVE_INVENTORY_REPORT (`createInventoryTask`, sell.inventory), LMS_ORDER_REPORT (`createOrderTask`, sell.fulfillment; "all unacknowledged orders… from the past 30 days", configurable to a day/week). Results via `getResultFile` (GZIP XML); Trading/LMS errors come back in the result file, not the REST response; version via `X-EBAY-API-COMPATIBILITY-LEVEL` or `Version` in payload. File size/retention limits: on "File retention"/"Rate limits" sub-pages — **not read (unverified)**.

Inventory API bulk: `bulkCreateOrReplaceInventoryItem` — "create and/or update up to 25 new inventory item records" (https://developer.ebay.com/develop/api/sell/inventory_api/inventory_item/bulkcreateorreplaceinventoryitem); `bulkPublishOffer` — "convert unpublished offers (up to 25) into published offers" (…/offer/bulkpublishoffer); `bulkMigrateListing` — "an array of one to five eBay listing IDs" (…/listing/bulkmigratelisting); `bulkUpdatePriceQuantity` limit **unverified** (page did not render; 25 expected); also `bulkCreateOffer`, `bulkGetInventoryItem` exist (nav list).

---

## G. Sandbox

- Separate keyset, RuName, token endpoint (`api.sandbox.ebay.com`, `auth.sandbox.ebay.com`); "Most eBay REST APIs support a sandbox environment… replace api.ebay.com with api.sandbox.ebay.com" — RESTful guide.
- Test users: created in the portal (User Access Tokens → "Register a new Sandbox user"); usernames prefixed `TESTUSER_`; unique e-mail; registration site should match the site under test ("you may want to experiment with test users from other countries if you want to test cross-border trade") — https://developer.ebay.com/api-docs/static/gs_create-a-test-sandbox-user.html.
- "eBay doesn't allow a seller to purchase or bid on their own listing, a rule that also applies in the Sandbox" → at least one seller + one buyer test user; two buyers for auctions — https://developer.ebay.com/api-docs/static/gs_tips-on-working-with-test.html.
- Digital signatures can be tested in the sandbox only if "the domicile of the sandbox user MUST be set to be one of the EU countries or the UK (e.g., 'DE' or 'GB')" — digital-signatures guide.
- Notification `getPublicKey` "is supported in Sandbox environment" (method page). Whether sandbox actually delivers topic notifications, processes payments/payouts, or indexes sandbox listings for Browse: **unverified** (no official page found stating limits).
- Sandbox scopes may differ from production for the same app (A).

---

## H. What a serious integrator also does

1. **Digital signatures (EU/UK sellers) — mandatory** — https://developer.ebay.com/develop/guides/sell/digital-signatures-for-apis : required "when the call is made for EU- or UK-domiciled sellers" for **all Finances API methods, Fulfillment `issueRefund`, Trading `GetAccount`**, and Post-Order Issue Inquiry/Case/Return Refund, Process Return Request, Create/Approve Cancellation Request. Headers: `x-ebay-signature-key` (the "Public Key as JWE" from Key Management), `Content-Digest` (`sha-256=:…:` over the body; omitted for GET), `Signature`, `Signature-Input` = `sig1=("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created=<unix>`; RFC 9421/9530; ciphers ED25519 (recommended) or RSA; "eBay does not store Private Key values… If a developer loses their Private Key they must generate new keypairs" (`createSigningKey` — https://developer.ebay.com/develop/api/sell/key_management_api/signing_key/createsigningkey ; key expiry/validity period **unverified**). Missing/invalid → **403** with error codes 215000–215122 (e.g. 215001 missing x-ebay-signature-key, 215113/215114 bad `created` timestamp, 215117 "appid in signature doesn't match app in token", 215120–122 signature validation failed). Unneeded signatures on other calls are ignored. SDKs: Java, Node.js, PHP.
2. **Notification payload verification** (E) and the mandatory account-deletion endpoint (C) — same `x-ebay-signature` + `getPublicKey` mechanism; cache key ~1 h.
3. **Data-handling change (2025-09-26)**: "Usernames will be replaced with immutable user IDs, and financial data will be protected for certain users" (site banner; account-deletion guide) — key on `userId`, not username.
4. **Promoted Listings**: Marketing API v1.23.2 (campaigns, ads, keywords/bids, reports; "priority strategy" campaigns raise `PLA_CAMPAIGN_BUDGET_STATUS`); Recommendation API for ad-rate suggestions; quick-campaign methods were decommissioned 2026-03-31.
5. **Compliance/listing violations**: Compliance API decommissioned 2026-03-30 — no replacement API found; REGULATORY_GUIDELINE topic is partner-gated; watch the "Right of Withdrawal (ROW) return reason… for eligible EU returns" in Post-Order `getReturnDetails` and the Apparel/Footwear size-standardization block from August 2026 (site banners on every page).
6. **Negotiation**: `findEligibleItems` + `sendOfferToInterestedBuyers`; Best Offer responses still live in Trading (`GetBestOffers`, `RespondToBestOffer`); `OFFER_ACTIVITY` topic carries buyer/seller offers.
7. **Post-Order**: cancellations, returns (decide/issue_refund/mark_as_received/preferences), inquiries, cases — pruned list in D; refunds there need signatures.
8. **Taxonomy**: category tree + `getItemAspectsForCategory` (aspects), `getCategoryMappings`; `metadata.insights` scope for aspect relevance; Metadata API for item-condition/return-policy/listing-structure rules per marketplace (EU marketplaces each have their own policies).
9. **Media API**: image (createImageFromFile/Url), **video**, document — replaces `UploadSiteHostedPictures` (gone 2026-09-30); 50 POST / 5 s per user.
10. **Translation API** (beta, app token) for IT/DE/FR/ES titles/descriptions.
11. **Stores**: Stores API (`sell.stores`) for store categories; Trading `SetStoreCategories`/`GetStore` still listed.
12. **Real-time Inventory Check**: seller-provided endpoint eBay calls at checkout to confirm quantity (Inventory overview).
13. **Out-of-Stock control** + `bulkMigrateListing` caveats: after migration the seller "will be completely blocked… from revising" listing-level buyer requirements and listing enhancements.
14. **eDelivery** is Greater-China-only — irrelevant for an EU seller. **Logistics API** (v1_beta) is the label/quote surface; note the Marketplace ID table and Accept-Language/Content-Language requirements for multi-locale marketplaces (BE/CA) — RESTful guide.
15. **Message API** (`commerce.message`) + `NEW_MESSAGE`/`BUYER_QUESTION` topics for buyer comms; Trading `AddMemberMessageRTQ` etc. still listed.
16. **Identity API** `getUser` (`commerce.identity.readonly`) to key the connection to the immutable userId at connect time.

---

## Source index
- https://developer.ebay.com/develop/guides/sell/authorization
- https://developer.ebay.com/devzone/xml/docs/Concepts/MakingACall.html
- https://developer.ebay.com/develop/guides/sell/digital-signatures-for-apis
- https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion
- https://developer.ebay.com/develop/api/buy/notification_events
- https://developer.ebay.com/develop/api/sell/notification_api ; …/topic/gettopics ; …/public_key/getpublickey
- https://developer.ebay.com/develop/guides/sell/sell-communications-guide
- https://developer.ebay.com/api-docs/static/platform-notifications-landing.html ; https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/platform-notifications.html ; https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/NotificationEventTypeCodeType.html
- https://developer.ebay.com/develop/get-started/api-call-limits ; https://developer.ebay.com/develop/get-started/api-deprecation-status ; https://developer.ebay.com/develop/guides/sell/using-ebay-restful-apis
- https://developer.ebay.com/grow/application-growth-check ; https://developer.ebay.com/api-docs/static/gs_request-an-application-growth.html
- https://developer.ebay.com/api-docs/static/gs_create-a-test-sandbox-user.html ; https://developer.ebay.com/api-docs/static/gs_tips-on-working-with-test.html
- https://developer.ebay.com/api-docs/sell/static/feed/lms-feeds-quick-reference.html ; https://developer.ebay.com/api-docs/sell/inventory/static/overview.html ; https://developer.ebay.com/api-docs/sell/static/seller-accounts/business-policies.html
- https://developer.ebay.com/develop/api/sell ; https://developer.ebay.com/develop/api/buy ; https://developer.ebay.com/develop/api/sell/post_order_api ; …/key_management_api ; …/developer_analytics_api ; …/stores_api/store/getstore ; …/edelivery_international_shipping_api ; …/leads_api ; …/vero_api_v2 ; …/feedback_api/feedback/getfeedback ; …/message_api/conversation/sendmessage ; …/account_api_v2 ; …/inventory_mapping ; …/fulfillment_api/order/getorders ; …/inventory_api/inventory_item/bulkcreateorreplaceinventoryitem ; …/inventory_api/offer/bulkpublishoffer ; …/inventory_api/listing/bulkmigratelisting ; …/traditional_listing_apis ; …/traditional_sell_order_management_apis ; …/traditional_offers_and_leads_apis ; …/traditional_sell_user_account_apis ; …/traditional_listing_metadata_apis ; …/traditional_store_apis ; …/traditional_sell_communication_apis
- OpenAPI specs: https://developer.ebay.com/api-docs/master/{sell|commerce|developer|buy}/<api>/openapi/3/<api>_oas3.json (inventory, account v1, analytics, feed, finances, fulfillment, logistics, marketing, metadata, negotiation, recommendation, stores, notification, identity, catalog, charity, taxonomy, translation, vero, media, message, developer analytics, key-management, client-registration, browse, buy marketing, offer, order v2, deal)
