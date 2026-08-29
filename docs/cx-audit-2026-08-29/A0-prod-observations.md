# Prod observations 2026-08-29 (web https://nexus-commerce-three.vercel.app, api railway) — read-only

## Screens (docs/cx-audit-2026-08-29/*.jpg)
01 channels loading · 02 channels + AccountsPanel · 03 after Test · 04 after Diagnose · 05 eBay popup sign-in · 06 eBay detail · 07 Amazon detail · 08 Amazon notifications list · 09 advertising connections · 10 advertising add-connection form · 11 mappings · 12 webhooks (outbound) · 13 api-keys

## Channels page
- Cards: Amazon "Env-managed" (text: "Managed via API server env vars. Disconnect by removing creds in Railway."), eBay "Connected" (Seller xaviaracing, Token expires in 1h 12m, Last sync 47m ago; buttons Test / Diagnose / Disconnect), Shopify/WooCommerce/Etsy "Coming soon" + disabled "Connector deferred".
- Footer copy: "OAuth tokens are refreshed automatically every 30 minutes before expiry" / "Disconnecting revokes the token and stops all syncs".
- AccountsPanel: Amazon 1 (A1VRHKTGYO1JNU Primary env-managed "Healthy · no name from the channel — rename it", no Disconnect: "Set by environment — no grant to revoke"); eBay 2: xaviaracing (Primary, Healthy), motovento (Healthy) each Rename/Reconnect/Disconnect (+Make primary); "+ Connect another eBay account".
- Test → GET /api/ebay/auth/test?connectionId=cmr4aaqb00025nz016k18rup9 → banner "Connection OK. Seller: eBay seller (verified)" (placeholder string, although card shows real username).
- Diagnose → GET /api/ebay/diagnostics?marketplaceId=EBAY_IT → "OK — eBay categories should fetch in the wizard. Connection token: OK / Env credentials: set / Sample category search: OK (3 matches)". Diagnose is NOT connection-scoped (marketplaceId only).
- "+ Connect another eBay account" → popup opened synchronously on signin.ebay.com (`sgfl=oauth2_login`) showing "Welcome back! motovento — Switch account" (browser was signed into motovento). Authorize URL on prod: client_id=Muhammad-XaviaRac-PRD-…, redirect_uri=RuName `Muhammad_Awais-Muhammad-XaviaR-bnkamqjw`, response_type=code, state=base64url(JSON{channel:"EBAY",n:<32hex>,iat}) + "." + base64url(HMAC). SCOPES REQUESTED (6): api_scope, sell.account, sell.inventory, sell.fulfillment, sell.marketing, commerce.identity.readonly. NOT requested: sell.finances, sell.analytics.readonly, sell.payment.dispute, sell.reputation, sell.stores, commerce.notification.subscription, sell.item.draft, sell.item, commerce.catalog.readonly, sell.edelivery, sell.inventory.readonly …
- No "prompt=login" visible in ru param but the landing was signin (sgfl=oauth2_login) — consistent with prompt=login behaviour.

## eBay detail (/settings/channels/ebay)
- ACTIVE badge; Token expires in 1h 11m; Last sync SUCCESS 48m ago; Connected since 03/07/2026; Managed by OAUTH.
- "OAuth scopes: No scopes captured. The OAuth callback writes them to connectionMetadata.scopes when granted … older grants may need a reconnect to populate." (connectionMetadata is NULL on every row in prod — see DB.)
- Marketplaces: IT DE FR ES UK pickers, "No marketplaces selected — defaults to ALL".
- Recent webhook events: "0 OK · 0 total — No inbound webhook events yet." (eBay has NEVER received a notification on prod.)

## Amazon detail
- ACTIVE; Token expires "Env-managed (no token rotation)"; LAST SYNC: **never** (while 50 ORDER_CHANGE/ANY_OFFER_CHANGED notifications in last days show OK); Connected since 06/05/2026; managed by ENV; scopes none; marketplaces pickers IT DE FR ES UK only (prod Marketplace table has 11 EU + US).
- Recent webhook events: 50 OK · 50 total; types ORDER_CHANGE, ANY_OFFER_CHANGED.

## Advertising (/settings/advertising)
- "Credentials are encrypted with AES-256-GCM before storage." Server mode: live. 9 connections (XAVIA DE/ES/FR/IT live+writes; IE/NL/PL/SE/UK sandbox), each Test / Back to sandbox / Disable writes / Allowlist / delete.
- "Add Another Connection" = MANUAL PASTE form: Profile ID, Account Label, Marketplace, Region, LWA Client ID, Client Secret, Refresh Token, "Save & Encrypt Credentials". Setup Guide: go to advertising.amazon.com → Partner Network → Developer Console → register app → complete LWA consent yourself → paste refresh token → set NEXUS_AMAZON_ADS_MODE=live in Railway. NO "Connect with Amazon" button on the page (find() confirmed). Browser autofill filled Profile ID with an email and Client ID with a saved password (fields look like a login form).

## Mappings (/settings/mappings)
- Per marketplace ChannelSchema: AMAZON BE 0/0, DE 0/111, ES 0/109, FR 0/109, IE 0/0, IT 0/166, NL/PL/SE/TR/UK 0/0; EBAY DE/ES/FR/UK 0/21, IT 0/41; ETSY/SHOPIFY/WOO 0/0. "0 schema fields · v1 · never synced"; "D.1 will add a 'Sync from AMAZON' button". Zero mapping rules exist anywhere.

## Webhooks (/settings/webhooks) = OUTBOUND (operator → their URL), HMAC X-Nexus-Signature; 0 subscriptions; banner: "Real event-triggered delivery wires into every emitter in a follow-up — until then, only the Test button fires."
## API keys = PIM personal access tokens, 0 keys. Not channel related.

## Prod DB (read-only, 2026-08-28 ~22:45Z)
- ChannelConnection: 14 rows. AMAZON 1 (managedBy env, isActive, isPrimary, externalAccountId A1VRHKTGYO1JNU, accessToken/refreshToken NULL, lastSyncAt NULL, lastSyncStatus 'SUCCESS', connectionMetadata NULL, created 2026-05-06). EBAY 13: active 2 — cmr4aaqb00025nz016k18rup9 xaviaracing (primary, externalAccountId 5UsgfG3BTHa, tokenExpiresAt 23:48Z, lastSyncAt 21:48Z) and cmt142bli01vcp4010fjo2k13 motovento (eherihhhtzc); 11 inactive leftovers (5 all-NULL rows from 2026-05-02/03, 3 with displayName "eBay seller (verified)", 1 superseded duplicate with lastSyncError "Superseded — identity adopted…", 1 empty placeholder from 2026-08-20 06:00).
- eBay tokens PLAINTEXT at rest: accessToken length 2504/2508, prefix `v^1.1#`; refreshToken length 96, prefix `v^1.1#`. Legacy ebayAccessToken/ebayRefreshToken/ebayTokenExpiresAt/ebaySignInName ALSO populated on the active rows (dual-write live on prod).
- connectionMetadata NULL on all 14 rows → no scopes stored anywhere.
- AmazonAdsConnection: 9 rows, credentialsEncrypted prefix `v1:` length 1111 (all 9 identical prefix `v1:pJXnz1CNl` — same IV/ciphertext start ⇒ same encrypted blob, i.e. one client id/secret/refresh token copied to 9 rows); lastVerifiedAt all 2026-05-18 (Test button does not update it); lastErrorAt NULL everywhere; tokenExpiresAt = issued+1y with tokenIssuedAtIsEstimate=true; DE/ES/FR/IT writesEnabled; lastWriteAt 2026-08-28.
- WebhookEvent: AMAZON only. ANY_OFFER_CHANGED 2797 (2026-05-23→08-27), ORDER_CHANGE 1348 (05-21→08-28), ORDER_STATUS_CHANGE 1013 (05-22→**07-29**, stopped). All processed, 0 errors, signature NULL on all. Zero EBAY/SHOPIFY/ETSY/WOO events ever.
- CronRun 24h: amazon-sqs-poll 1440 runs (1/min), ams-sqs-poll 1440, ebay-orders-sync 288 (5 min), ebay-token-refresh 48 (30 min), amazon-orders-sync 96 (15 min), amazon-inventory-sync 96, amazon-returns-poll 24, ebay-readback 48, sync-drift-detection 48, ebay-listing-discovery 6, amazon-notifications-setup 1 (at boot 20:57:53 = deploy). **ebay-financial-sync FAILED daily: "eBay GET /finances/v1/transaction failed: 403 errorId 215001 domain ACCESS"** (= sell.finances scope not granted — scope gap live on prod). No etsy/shopify/woo job has ever run (no CronRun rows).
- Marketplace: AMAZON 11 EU (BE DE ES FR IE IT NL PL SE TR UK, all PARTICIPATING, participationCheckedAt 2026-06-24 — 2 months stale) + US inactive; EBAY DE ES FR IT UK; ETSY/SHOPIFY/WOO GLOBAL rows exist.
- MarketplaceSync: 242 rows, ALL FAILED, last 2026-05-03 — dead. SyncChannelPolicy: 0 rows. Channel: 0 rows (dead model). SyncHealthLog: AMAZON 2285 unresolved warnings, EBAY 7714 unresolved (still being written 22:30Z).
- ChannelSchema: AMAZON DE 111 / ES 109 / FR 109 / IT 166; EBAY IT 20 + null-marketplace 21. 
- Order: AMAZON 4433 (4390 attributed to a connection), EBAY 4.
- AuditLog: NO connect/oauth/token/disconnect actions ever recorded (only 'cross_channel.propagated').
