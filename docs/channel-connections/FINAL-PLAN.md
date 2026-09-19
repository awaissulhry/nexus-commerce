# Channel connections — FINAL PLAN

Written 2026-09-19. Status: **FOR YOUR REVIEW. Nothing in this plan is built yet. Nothing was committed.**

This is the one plan for how Nexus talks to its sales channels, in both directions:

- **Outgoing:** every call Nexus makes to a channel — publish a product, change content, send images, send stock, send prices, end or close a listing, manage ads.
- **Incoming:** everything a channel tells Nexus — orders, stock and listing changes, account changes, errors, rejections, warnings, and failures of our own calls.

Channels in scope now: **Amazon SP-API, Amazon Ads, eBay, Shopify, Etsy.** WooCommerce is out (your decision, 2026-08-29). New channels come last (section 6, phase P8).

> Note on the file name: macOS does not tell `plan.md` and `PLAN.md` apart. A file called `plan.md` would overwrite the existing `PLAN.md`. So this file is `FINAL-PLAN.md`.

## How this plan was made

1. I read `RESEARCH.md` and `PLAN.md` in full.
2. I used the source index of the two FULL files (129 sources) to find what the short files leave out.
3. Helpers checked the **real code** today, because both short files say their build states were never checked in code.
4. One helper checked the channel deadlines on the channels' own websites.
5. You asked me to save weekly limit, so the helpers were stopped early. Anything they did not reach is marked **NOT CHECKED**.

Evidence tags used below:

| Tag | Meaning |
|---|---|
| **CODE** | Checked in the code today (2026-09-19). |
| **DOC** | Only a doc says so. Not checked in code. |
| **PROD?** | Only a production read can answer it (env values, live data). |
| **NOT CHECKED** | Nobody looked yet. |

## The three phases

| Phase | State | What it means for you |
|---|---|---|
| 1. Research | **Done, with a few small gaps.** Section 2 lists them. | No big new research is needed. |
| 2. Planning | **This file.** | Read it. Mark what you approve, change or refuse. |
| 3. Implementation | Not started. | One work package at a time. Each one needs your "go". Each one ends with a proof on production. |

---

## 1. What each file says (short summaries)

### 1.1 `RESEARCH.md` — what was found (150 KB)

- **Sources:** the channel audit of 2026-08-29 (A0–A7), the channel research of 2026-08-29 (R1–R9a), and four later checks (09-01 to 09-10).
- **Main message:** on 2026-08-29 only eBay had a real sign-in flow. Tokens were in plain text. "Connected" meant nothing true. Webhooks were unsafe or broken. One real push engine existed next to four "ghost" engines. Operator mappings never reached a real push.
- **By topic:** connection model and accounts; tokens and sign-in; how a change goes out (queue, BullMQ, feeds, flat files); how Nexus reads from channels; webhooks; 23 security findings (S1–S23); screens and routes; what production showed.
- **By channel:** Amazon SP-API, Amazon Ads, eBay, Shopify, Etsy, WooCommerce (out), and 20 possible future channels (OTTO, Zalando, Kaufland, bol.com, Allegro, Cdiscount, ManoMano, Mirakl, eMAG, Fnac, Miravia, Privalia, TikTok Shop, Walmart, Temu, SHEIN, Google Merchant Center, Meta, and six shop platforms).
- **Industry study:** Nango, Airbyte, Saleor, Medusa, the Shopify SDK and paid platforms. What to copy, what not to copy, and licence limits (Nango and Airbyte connectors: read only, never copy code).
- **Design conclusion:** the channel's own full data is the truth. The Nexus product is a view built from it.
- **Hard deadlines:** a list of 8 dates (checked again in section 3 of this plan).
- **Open questions:** 20 questions for you.
- **Warning:** most of it describes the code of 2026-08-29. A lot was fixed after that.

### 1.2 `PLAN.md` — what was designed or decided (103 KB)

- **A table of every plan** (about 55) with its state per doc.
- **Your decisions:** the 12 CX decisions (2026-08-29), the business-profile and sharing decisions, the multi-account decisions, and older standing rules (FBA untouchable, one shared stock pool, flat-file editors untouchable).
- **Target design:** channel catalogue, extended `ChannelConnection`, child tables, the token service (the only code that decrypts), sign-in routes, one webhook entry point, the sync engine, the normalisation layer, scopes and "Reconnect".
- **Write path per channel** and **sign-in flow per channel**, plus a key-paste list for channels with no sign-in.
- **Keep / refactor / delete list.**
- **Phases CX.0–CX.9+:** CX.0, CX.1, CX.2, CX.3a–c and CX.4a are built per the docs. The Amazon sign-in half of CX.3 was held. CX.4b–d and CX.5–CX.9 were planned.
- **Business profiles (BP, BP.S) and multi-account (MAP, EMA)** in detail.
- **Older plans (June–July):** shared eBay SKUs, flat files, real-time stock sync, Sync Control.
- **32 open items** for you.
- **Warning:** the states come from docs and notes, not from the code.

### 1.3 `full/RESEARCH-FULL.md` — every research source, word for word (1.47 MB, 64 sources)

Part A — the current programme (26 sources):

| # | Source | In one line |
|---|---|---|
| 1 | `2026-08-29-cx-audit.md` | The full audit: how every channel was connected on 08-29, with the security ranking. |
| 2 | A0 prod observations | What production showed on 08-28/29 (pages, DB rows, cron runs, HTTP probes). |
| 3 | A1 connection model | `ChannelConnection`, tokens, encryption, OAuth state, resolver, disconnect paths. |
| 4 | A2 Shopify / Woo / Etsy | Env-only connections, broken webhooks, ingest that throws. |
| 5 | A3 Amazon | 19 ways to get a token, one region, notifications, Ads OAuth route. |
| 6 | A4 eBay | The only real OAuth flow, 6 scopes, missing signatures, order and refresh faults. |
| 7 | A5 sync engine | One real engine, four ghosts, the queue, gates, quantity resolver, mappings. |
| 8 | A6 UI, routes, docs | Every screen, 157 channel routes (80 with no caller), stale docs. |
| 9 | A7 security | 21 findings, fix order. |
| 10 | `2026-08-29-cx-research.md` | The research summary and the design conclusion. |
| 11 | R1 Amazon | SP-API and Ads: sign-in, roles, versions, limits, notifications, deadlines. |
| 12 | R2 eBay | Scopes, signatures, APIs, events, limits, what is gone or going. |
| 13 | R3 Shopify | App types, grants, GraphQL, bulk, webhooks, limits. |
| 14 | R4 Etsy | PKCE, token rotation, 76 paths, webhooks, EU gating. |
| 15 | R5 EU marketplaces | OTTO, Zalando, Kaufland, bol.com, Allegro, Cdiscount, ManoMano, Mirakl, eMAG, Fnac, Miravia, Privalia. |
| 16 | R6 global channels | TikTok Shop, Walmart, Temu, SHEIN, Google Merchant Center, Meta. |
| 17 | R7 shop platforms | BigCommerce, Magento, Wix, Squarespace, PrestaShop, Shopware. |
| 18 | R8 Nango | 19 patterns to copy, what not to copy, weaknesses, licence. |
| 19 | R9 references | Saleor, Medusa, Supaglue, Panora, Revert, Shopify SDK, paid platforms, anti-patterns. |
| 20 | R9a Airbyte | Error vocabulary, async reports, per-stream state, licence. |
| 21 | 09-01 channel-ops research | Where per-listing channel actions should live in the studio (drawer + one action registry + an "Errors & Sync" console). |
| 22 | 09-08 Amazon managed connection | The Amazon app is **private**; seller authorization goes through the Solution Provider Portal. |
| 23 | 09-08 Shopify + Etsy re-audit | Sign-in hardening, verified locally; no real grant yet. |
| 24 | 09-09 Shopify local connect | Reached Shopify's Install screen locally; consent not finished. |
| 25 | 09-10 Etsy local connect | Shop ItalianHideCraft connected locally with all 12 scopes. |
| 26 | 09-08 business profiles audit | Workspaces, isolation, rollout conditions. |

Part B — 38 older guides (June–August): API docs, setup guides, the Amazon sync and Phase 12f/27 docs, image guides (`IMAGES-MIRROR.md`, `amazon-image-upload.md`), eBay guides and runbooks, inventory-sync and Sync Control runbooks, webhook and testing guides. **Many describe code that changed or was deleted.** Use them only as history.

### 1.4 `full/PLAN-FULL.md` — every plan source, word for word (1.2 MB, 65 sources)

Part A — the current programme (15 sources):

| # | Source | In one line |
|---|---|---|
| 1 | `2026-08-29-cx-channel-connections.md` | The CX proposal: design, per-channel sign-in, phases CX.0–CX.9+, 12 decisions. |
| 2 | CX.0 stop the bleed | Delete public probes and receivers, fail-closed checks, revoke on disconnect. |
| 3 | CX.1 connection core | Catalogue, KMS encryption, leased token refresh, one sign-in flow, eBay signing, heartbeat. |
| 4 | CX.2 Channels UI | `/settings/channels` on the design system: Accounts, Connect, Diagnostics. |
| 5 | CX.3a Ads on the core | Amazon Ads becomes one connection with profile scopes. |
| 6 | CX.3b Ads engine on the core | Ads token from the leased refresh; duplicate secrets archived. |
| 7 | CX.3c Ads truth on the page | The Advertising page shows measured health, not dead fields. |
| 8 | CX.4a inbound ledger | Webhook ledger columns; real eBay signature check. |
| 9 | KMS runbook | Your steps to turn on KMS encryption. |
| 10 | Business profiles architecture | One login, many businesses; each account has one owning business. |
| 11 | BP.S shared accounts | Share an account with another business (read or publish); per-person account limits. |
| 12 | MAP multi-account | Several seller accounts per channel; account chip; fail-closed resolver. |
| 13 | MAP.0 burn-down | Generated list of old connection lookups (now 0). |
| 14 | MAP.6 flat-file edit list | The 12 eBay flat-file lookups. |
| 15 | EMA eBay multi-account | The older eBay-only plan, replaced by MAP. |

Part B — 50 older plans (June–July): eBay shared-SKU phases 1–4, flat-file rebuilds, Amazon browse nodes and custom groups, real-time inventory sync phases 0–7, eBay sync fix (locale headers), feed summary parity, eBay import/export excellence, flat-file trust, real-time FBM sync, pool-to-Amazon study, Sync Control series, and Amazon market offer close/reopen (SCT.6). **Some are replaced by later work.**

### 1.5 Related files outside this folder (read these with this plan)

- `docs/product-sheet/` — the Product Edit Studio. Its topics 06 (market features), 11 (Presence, the listing lifecycle programme) and 12 (the 12 September studio audit) own the **studio-side** channel actions: publish flow, delist, pause, relist, and the listing object. This plan owns the **connection side**: the calls, the events and the errors under those actions. Section 10 draws the line.
- `docs/2026-09-19-shared-stock-plan.md` — shared stock between business profiles. Being built now in another session. It changes where stock comes from, not how it is sent.

---

## 2. Research: is it done? Is more needed?

**Short answer: the research is enough to plan and to start. No big new study is needed.**

The 08-29 research covered every channel API in depth. What was missing was a check of today's **code** and a re-check of the **deadlines**. Both were done today (sections 3 and 4). Six small checks are still open. None of them blocks your review of this plan. Each one is the first step of the work package named.

| # | Check | Why it matters | Type | Who | Work package |
|---|---|---|---|---|---|
| R-1 | Finish the deadline check for Amazon Ads, eBay, Shopify and Etsy (not reached today). Most important: which eBay Post-Order methods end in 2026 (we still call `return/search`), whether eBay still accepts our own image URLs, and whether Shopify 2026-07 needs `@idempotent` on `compareQuantity` stock writes. | A missed date breaks a live flow. | Web, ~1 short session | Claude | P0.8 — **DONE 2026-09-19** (`build/P0.8.md`) |
| R-2 | Read two new Amazon posts: "Simplified Authorization for Service Providers" and "Solution Provider Portal Agreement and Policy Updates". | They may change decision D1 (private or public Amazon app). | Web, 15 min | Claude | D1 |
| R-3 | Find our Amazon LWA client-secret expiry date. | If the secret is not rotated in time, **every** Amazon call stops. | Solution Provider Portal, 2 min | **You** | P0.5 |
| R-4 | Read the production settings (list in section 7, item 10). | Code shows what a flag does. Only production shows which flags are on. | Railway read, 10 min | You or Claude with your go | P0 |
| R-5 | Finish the image census: how each channel receives images today. | Only partly checked today (section 4.4). | Code read | Claude | P4.2 |
| R-6 | eBay Feed API: our code creates an **upload** task with a **download** report type (`LMS_ACTIVE_INVENTORY_REPORT`). | The feed push mode is probably broken. | Code + eBay docs | Claude | P1.6 |

---

## 3. Hard deadlines (checked 2026-09-19)

Status key: **CONFIRMED** = checked on the channel's own site. **DOC** = from the 08-29 research, not re-checked. Since **P0.8 (2026-09-19)** no DOC row is left: every row below was checked on the channel's own pages (eBay: the API deprecation status page; Shopify: shopify.dev changelog and versioning page; Amazon Ads: its release-notes feed, because the deprecations page renders only with JavaScript; Etsy: the etsy/open-api announcements). Record: `build/P0.8.md`.

### 3.1 Dates already passed — our code still has work to do

| Date | Channel | What ended | Our code today | Action |
|---|---|---|---|---|
| 2025-12-03 | Amazon | XML and flat-file listing feeds (including `POST_PRODUCT_IMAGE_DATA`, `POST_PRODUCT_DATA`). Only the Listings Items API and `JSON_LISTINGS_FEED` remain. **CONFIRMED** | **CODE:** no use of the removed feed types found. | None. |
| 2026-07-29 | Amazon | `ORDER_STATUS_CHANGE` notification. **CONFIRMED** | **CODE:** still subscribed (`services/amazon-notifications-boot.service.ts:156-168`). It receives nothing. | Remove it (P2.2). |
| 2026-08-26 | Amazon | `LISTINGS_ITEM_ISSUES_CHANGE` payload v1.0 stopped. Current version is 2023-12-13; it adds `LISTING_SUPPRESSED`, `ATTRIBUTE_SUPPRESSED`, `CATALOG_ITEM_REMOVED`. **CONFIRMED** | **CODE:** we do not subscribe to it at all. | Subscribe to the 2023-12-13 version (P2.2). |
| 2026-08-26 | Amazon | Catalog Items v0 `listCatalogCategories`. **CONFIRMED** | **CODE:** not used. | None. |
| 2026-01-20 → 03-16 | eBay | Post-Order: most return, case and inquiry write methods decommissioned (e.g. Create Return Draft, Mark Return Refund Sent, Issue Case Refund 03-02, Create Inquiry 03-16). **Search Returns is NOT on the list.** **CONFIRMED** | **CODE:** we call only `GET /post-order/v2/return/search` (`services/ebay-returns/ingest.service.ts:283`), which still works. The signed-path list names Post-Order refund paths that nothing calls. | None; P5.5 is not needed. |
| 2026-03-31 → 08-15 | eBay | Marketing `setupQuickCampaign` / `launchCampaign` (03-31), Trading `GetCategories` (04-15), Product Metadata API (04-27), Trading `GetCategoryFeatures` (06-04), Product API (08-15). **CONFIRMED** | **CODE:** none of them is called (searched with a positive control). | None. |
| 2026-02-09 | Etsy | The `x-api-key` header must be `keystring:secret`. **CONFIRMED** (etsy/open-api) | **CODE:** the connector and the read client send it (`services/cx/connectors/etsy/spec.ts:78`, `services/etsy/read-client.ts:17`). The old `services/marketplaces/etsy.service.ts:273` sends the access token as the key, so every call on that path fails; nothing scheduled uses it. | P1.6 removes it. |
| 2026-04 (API version) | Shopify | `@idempotent` mandatory on inventory and refund mutations; `compareQuantity` / `ignoreCompareQuantity` removed in favour of `changeFromQuantity`. **CONFIRMED** | **CODE:** `services/shopify/offer-sync.service.ts:52` calls `inventorySetQuantities` on the `2026-07` client with `compareQuantity` and **no** `@idempotent`, so it fails on every call. The other `2026-07` stock writes are correct (`information-inventory.ts:55`, `content-publisher.ts:271`). Shopify is `gated` in production. | P1.4. |
| 2026-06 | Amazon Ads | v2 suggested-keyword endpoints shut off; `/v2/stores` deprecated; negative bid adjustments on Sponsored Brands placement groups (06-15). **CONFIRMED** | **CODE:** none used. | None. |
| 2026-07-06 | Amazon Ads | Sponsored Brands "Product collection" ad entity deprecated in favour of Manual / Auto Collection (**CONFIRMED**). A full shut-off in January 2027 is reported by a third party only (**NOT CONFIRMED** on Amazon's pages). | **CODE:** Sponsored Brands creation defaults to `creativeType: 'productCollection'` (`services/advertising/ads-create.service.ts:940`). | P4.5: default to Manual Collection. |

### 3.2 Dates to come

| Date | Channel | What ends | Our code today | Action |
|---|---|---|---|---|
| **Every 180 days** | Amazon | The LWA client secret must be rotated. Notice comes 90 days before. The old secret works 7 days after rotation. If missed: **no Amazon call works.** **CONFIRMED** (applies to all apps). | **CODE:** no rotation handling. `ChannelApp.secretExpiresAt` is read by the heartbeat but **never written**. | You find the date now (R-3). Then P6.1. |
| 2026-09-21 | eBay | Trading `GetAdFormatLeads` → REST Leads API. **CONFIRMED** | **CODE:** not used. | None. |
| 2026-09-30 | eBay | Trading `UploadSiteHostedPictures` → Media API `createImageFromFile` / `createImageFromUrl`. **CONFIRMED**. eBay still accepts our own HTTPS image URLs in `PictureURL` (up to 24) and in Inventory `imageUrls`: no deadline on self-hosting. | **CODE:** not called (one comment only, `services/channel-publish.service.ts:141`). The Media API is not used either. | None for the date. See P4.2 for image hosting. |
| 2026-11-11 | Amazon | Settlement reports `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE` and `..._XML`. **CONFIRMED** | **CODE:** we use `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` (`services/amazon-settlements.service.ts:27`). That is a different type and is **not** on the list. | None. Keep an eye on it. |
| 2027-01-01 | Shopify | Public apps must use expiring offline tokens. **CONFIRMED**, and Shopify states it does **not** apply to custom apps. | Our app is custom distribution. The connector already accepts expiring tokens. | None. |
| 2027-01-19 | eBay | Trading `GetSellerDiscountProfiles` / `SetShippingDiscountProfiles` → Account API v2 combined shipping rules. **CONFIRMED** | **CODE:** not used. | None. |
| 2026-09-30 | eBay | VeRO API (all methods) → VeRO API v2. **CONFIRMED** | **CODE:** not called (only a scope name in `services/cx/connectors/ebay/spec.ts:113`). | None. |
| 2027-01-11 | eBay | Trading `ShoppingCartItemEndingSoon` notification. **CONFIRMED** | **CODE:** not used. | None. |
| About 2027-01 | Shopify | When `2026-01` leaves support, the oldest accessible version becomes `2026-04`, where `@idempotent` is **mandatory** on inventory and refund mutations and `compareQuantity` is **removed** (**CONFIRMED**: mandatory from `2026-04`; the month is derived from the 12-month rule). | **CODE:** the `2024-01` clients fall forward into it: `refundCreate` (`services/refunds/refund-publisher.service.ts:647`) and the bulk stock write (`services/bulk-action.service.ts:2493`, which also writes ONE env inventory item for every product) send no `@idempotent`. Shopify publishing is `gated` in production today. | P1.4 / P5.3. |
| 2027-07 | Amazon Ads | Legacy account endpoints (`/dsp/advertisers`, `/adsAccounts…`) answer 404 (deprecated July 2026). **CONFIRMED** | **CODE:** not used. | None. |
| **2027-03-27** | Amazon | **Orders API v0 removed.** Replacement: Orders v2026-01-01 (`searchOrders`, `getOrder`). **CONFIRMED** | **CODE:** we use v0 (`services/marketplaces/amazon.service.ts:930, 977, 1149`; `services/channel-reconciliation.service.ts:102`). The `amazon-sp-api` library (1.2.1) has no `endpoints_versions` set, so it picks the **oldest** version of each call. | Migrate by 2026-12 (P5.1). |
| **2027-08-27** | Amazon | **Finances API v0 removed.** Replacement: Finances 2024-06-19 (`listTransactions`, plus `listSummary` and `listBalances` since 2026-07-29). **CONFIRMED** | **CODE:** both exist: v0 in `services/marketplaces/amazon.service.ts:1655`, 2024-06-19 in `services/amazon-financial-events.service.ts:574`. | Move every caller to 2024-06-19 (P5.2). |
| 365 days after consent | Amazon Ads | Refresh tokens issued **on or after 2026-07-30** expire 365 days after consent; tokens issued **before** that date are **not affected**. **CONFIRMED** (Amazon Ads release note of 2026-05-26). | **CODE:** the stored expiry is an estimate (365 days from the adopt job), not the real consent date. If our grant predates 2026-07-30, it has no 365-day expiry at all, and a reconnect would START one. | P4.5: decide from the grant date before reconnecting. |
| 18 months | eBay | Refresh token lifetime (no rotation). | **CODE:** tracked (`refreshTokenExpiresAt`), alerts at 30/7/1 days. | None. |
| 90 days, rotates | Etsy | Refresh token rotates on every use. | **CODE:** tracked. A rotated token can be lost if the save fails (risk). | P6.3. |
| ≥ 12 months per version | Shopify | Each stable version is supported at least 12 months; a call to a retired version is answered by the **oldest accessible** version ("falls forward"). **CONFIRMED** | **CODE:** 6 client files still pin `2024-01`, long out of support, so they already run on whatever version is oldest. | P5.3. |

### 3.3 New from Amazon since June (CONFIRMED, for information)

- 2026-07-29: Invoices API v2026-06-25; Fulfillment Outbound v2026-07-04 (expect a removal date for v2020-07-01 later); Listings Items takes several marketplace ids in one region; Orders v2026-01-01 gained cancellation fields.
- 2026-08-26: Promotions API v2025-12-01.
- No removal date exists for Product Pricing v0 calls.
- Source: `https://developer-docs.amazon/sp-api/docs/sp-api-deprecations` (updated 2026-09-09). Note: Amazon moved its docs from `developer-docs.amazon.com` to `developer-docs.amazon`.

---

## 4. Where we stand today (checked in code, 2026-09-19)

Paths are under `apps/api/src/` unless shown. This is a partial check (the helpers were stopped early). It is enough to set priorities.

### 4.1 Sign-in and tokens — **mostly good**

- **Built and working (CODE):** all 5 channels are in the catalogue and connectable (`services/cx/catalog.ts`). One sign-in flow with single-use state, cookie check and business-profile binding (`services/cx/oauth.service.ts:189, 270-305`). Leased token refresh with a 30 s database lease. Heartbeat every 15 min for all 5 channels. Expiry alerts at 30/7/1 days (`jobs/cx-heartbeat.job.ts:125, 174`). eBay: 20 scopes, and a deploy check stops a scope the eBay keyset refuses (`.github/workflows/deploy-api.yml:64-85`).
- **Gaps (CODE):**
  - `assertWritable` (pause writes when an account needs sign-in) has only 2 callers: Shopify's new client and Amazon images. **The outbound queue never checks the account status.** Writes fail instead of waiting.
  - eBay refunds: `issue_refund` is sent **unsigned** (`services/refunds/refund-publisher.service.ts:363`). eBay requires a signature for EU/UK sellers, so refunds will fail with a 215xxx error. Only Finances is signed today.
  - eBay has no returns, cancellation or inquiry scopes in its 20.
  - Amazon Ads uses the North America consent page for every region (`services/cx/connectors/amazon-ads/spec.ts:189`). Research says the EU page is `eu.account.amazon.com`.
  - Disconnect calls the channel only for eBay. For Ads, the old per-profile secrets stay, and with profiles OFF the Ads client falls back to them — **Ads calls continue after a disconnect** (`services/advertising/ads-api-client.ts:463-491`).
  - Key rotation covers account tokens only. App secrets and the eBay signing key are never rotated.
  - Amazon SP-API: the code supports both website OAuth and "self" import of the env token. Which one production uses depends on `AMAZON_SP_AUTH_MODE` (PROD?).
  - Possible fault (not tested): the heartbeat updates rows a guest profile can read but not write, so its run for that profile may stop with an error.

### 4.2 Outgoing: publish and content — **the biggest problem area**

> **Update 2026-09-19:** every "dry run or sandbox that writes live" path below is closed by **P0.1** (commit `8fcd1d500`, not yet pushed). The P0.1 census found more than this list (for example the ungated `DELETE /ebay/flat-file/offer` and every eBay Trading write): see `build/P0.1.md` sections 3 and 6. The other gaps in this section are still open.

- **There is no single choke point.** Every path builds its own call.
  - **Amazon: 11 write stacks** (queue, wizard, a direct publish route, flat file, cockpit, studio, batch feed, price, offer close/reopen, delete, FBA restore).
  - **eBay: 12+ write stacks** (queue, flat file, variation push, wizard, legacy app-token service, bulk operations, shared-SKU Trading, studio, 8 small Revise side-stacks, delist, image provider).
  - **Shopify: 6 old clients on `2024-01` next to 1 new client on `2026-07`.**
- **Dry run or sandbox that still writes live (CODE, highest risk):**
  - Amazon `patchListingPrice` (`clients/amazon-sp-api.client.ts:669`), `patchPurchasableOffer` (:792) and `deleteListingsItem` (:1145) call **production** when the mode is `sandbox`.
  - Amazon route `POST /products/:id/listings/:channel/:marketplace/publish` saves a **dry run as published and ACTIVE** (`routes/marketplaces.routes.ts:1043-1046`).
  - eBay flat-file push and republish write **live** when the mode is `dry-run` (`routes/ebay-flat-file.routes.ts:1516, 79, 3330`).
  - eBay bulk operations are **live by default** with no publish gate. The stock operation sends an `inventory_item` with only `availability`. That call replaces the whole item, so it would **wipe the listing content** (`services/channel-batch/ebay-parallel-batch.service.ts:69, 88-110`).
  - The old eBay service has no gate, uses an app token and sends `en-US` (`services/marketplaces/ebay.service.ts`).
  - Shopify: `POST /shopify/sync/inventory` writes with no gate (`routes/shopify.ts:81`). The bulk mutation and two old services ignore the gate.
  - Image publish services read no publish-mode gate (`services/images/*`; only the Amazon media client checks the account status). The 12 September studio audit also found three ungated live image paths.
  - Etsy is read-only by decision, but an old Etsy stock PATCH is still reachable with an env token (`services/marketplaces/etsy.service.ts:398-405`).
- **Wrong account risk (CODE):** the eBay queue, flat file, wizard and bulk operations always use the **primary** eBay account (`services/outbound-sync.service.ts:1323, 1746`). Shopify's queue uses env credentials, not the connected account (:1962). Amazon's queue uses the default seller. With two eBay accounts live, a change meant for the second account goes to the first. The queue row has no destination column (`OutboundSyncQueue`), so the destination lives only in JSON.
- **eBay headers (CODE):** a language helper turns `EBAY_IT` into `en-US` (`services/ebay-variation-push.service.ts:455`), used by the end path, the cross-market draft delete and all of `pushOffersOnly`. Bulk and the old service hard-code `en-US`; the eBay image publish hard-codes `it-IT`. The wizard sends no marketplace header.
- **Shopify queue bug (CODE):** the queue loads rows with the product only, so `channelListing` is always empty (`services/outbound-sync.service.ts:691, 767`). Result: the new GraphQL lane (with compare-and-set and read-back) is **never reached**, and every Shopify row goes to the old REST `2024-01` path.
- **Other facts (CODE):** worker concurrency is 5 for all channels together; no per-account limits. The 1-minute backup loop reads all pending rows with no limit. No channel rate-limit header is ever read on writes (the parsers exist in the connector specs but nothing calls them). The only idempotency keys sent are Shopify `@idempotent` in 2 places and an eBay UUID in the studio. The listing-claim check (shared accounts) runs in 1 enqueue function; **33 other enqueue sites skip it**.
- **Amazon validation before send:** studio and cockpit validate every message first (`VALIDATION_PREVIEW`). The queue does it only for mapping rows. The wizard, the direct route, the flat file and the batch feed never do.
- **Ghost engines are still there (CODE):** dead: `unified-sync-orchestrator`, `product-sync.service`, `sync/index`, `monitoring.routes.ts`, `sync-monitoring.service`. Still live: `outbound-sync-phase9` (via `VARIATION_SYNC`, which nothing creates), `inbound-sync` route, the channel-sync worker, `routes/marketplaces.ts`, root `amazon-sync.service`, `channel-publish`. **WooCommerce code is still present** (72 API files), although you decided to delete it.
- **eBay Feed API (CODE):** creates the task with a download report type, then uploads to it (`services/ebay-feed.service.ts:164, 214`). Probably broken (R-6).

### 4.3 Outgoing: stock and price

- **Good (CODE):** one quantity resolver (`services/sync-control-core.ts:146`) with a clear order: FBA excluded > closed > paused > pinned > follow. FBA is never written (fail-closed, `services/outbound-sync.service.ts:1003`). The stock lock stops lost updates (`services/stock-lock.ts`). The re-read at send time, the oversell clamp, the EU shared-quantity guard and the priority lane are all ON by default. eBay shared-SKU stock re-derives each listing at send time and skips values already sent.
- **Gaps (CODE):**
  - 6 quantity producers skip the resolver, and 6 more were not checked. The worst: the catalog `PATCH /api/catalog/products/:id` queues product-level rows with gross stock and **no listing id**, so for Amazon there is no re-read and the EU guard does not run (`routes/catalog.routes.ts:936`).
  - The Amazon clamp uses all warehouse rows, not the routed ones.
  - The EU guard lets the push through if the guard itself errors (`services/outbound-sync.service.ts:1098`).
  - Shopify stock: old REST absolute write, no compare-and-set (the new lane is unreachable, see 4.2).
  - The Etsy inbound stock import writes `Product.totalStock` directly, with no lock and no movement record (`services/sync/etsy-sync.service.ts:356`).
  - **Price currency is hard-coded: GBP for UK, EUR for every other Amazon market** (`services/outbound-sync.service.ts:310`). Amazon Sweden (SEK), Poland (PLN) and Turkey (TRY) do not use EUR. If we ever push a price there, it is wrong. (PROD? — do we have priced listings in SE/PL/TR?)
  - eBay price push in `pricing-outbound` is a stub (`NOT_IMPLEMENTED`).
  - Multi-account stock fan-out (MAP.7) is not built; shared-SKU rows always use the primary account.
  - Read-back jobs exist for Amazon quantity and eBay; none for Shopify. Their exact behaviour was NOT CHECKED.

### 4.4 Outgoing: images — partly checked

- **CODE:** 41 image service files (`services/images/`), with separate publish services for Amazon (feed, media client, media publish), eBay (image publish, inventory image publish, shared image publish) and Shopify.
- **CODE:** eBay shared-SKU listings send our own URLs as `PictureURL` (`services/images/ebay-shared-image-publish.service.ts:183, 192`). Inventory listings read `product.imageUrls` back (`services/images/ebay-inventory-image-publish.service.ts:370`).
- **CODE:** no image service checks the publish mode.
- **NOT CHECKED:** the Amazon image route (listing attributes or feed), the Shopify image API version, rejection handling, pre-send size and count checks (R-5).

### 4.5 Outgoing: advertising

- **Amazon Ads — good base (CODE):** Sponsored Products v3, Sponsored Brands v4, Sponsored Display, Reports v3, exports, brand metrics and Marketing Stream subscriptions all exist (`services/advertising/ads-api-client.ts`). A Redis quota ledger, `Retry-After`, dry run for create, batch-error detection, and every live call logged to `OutboundApiCallLog`.
- **Gaps (CODE):** `listProfiles` looks in the EU only (:666). The client's `fetchReport` sends no v3 content type, while the report service does (:2153). Sponsored Brands keywords still use the old v3 endpoint (v4 returned 403). `/v2/profiles` is still used (check in R-1). The write gate and bid engine logic were NOT CHECKED.
- **eBay Promoted Listings: NOT CHECKED.** No use of the ended `setupQuickCampaign`, `launchCampaign` or `GetAdFormatLeads` (CODE).

### 4.6 Incoming: events the channels push to us

- **Good (CODE):** Shopify and eBay receivers use the raw body, timing-safe checks and fail closed. eBay's signature check is the real ECDSA scheme (412 on reject). The ledger row is written before processing. The AMS ingest route fails closed.
- **Gaps (CODE):**
  - **Amazon:** the boot job that keeps the subscriptions **fails with profiles ON** ("Select a business profile"), so subscriptions are not being maintained. Unknown types, parse errors and routing failures are **deleted before any ledger row** — silently lost. Dedupe uses the SQS message id, not Amazon's `NotificationId`. Every subscription is sent as payload version `1.0`. Order-change fields are read at the top level, but Amazon puts them under `Summary` (so the FBA skip likely never fires — needs one real payload to confirm). Amazon ledger rows stay `pending` forever.
  - **eBay:** **no Notification API subscriptions exist** (CX.4b not built); only the old Trading notification setup. Three handled topic names are not real eBay topics. Account-deletion notices are acknowledged only (no erasure) and get a **503 when 0 or 2+ eBay accounts exist** (the notice has no seller id). `AUTHORIZATION_REVOCATION` is ignored. Rejected signatures are not recorded when profiles are ON (`routes/ebay-notification.routes.ts:366`).
  - **Shopify:** dedupe uses the product or order id, not `X-Shopify-Webhook-Id`, so a **second update to the same product or order is skipped** (`routes/shopify-webhooks.ts:945, 1146, 1213`). Topics are registered by old REST, append-only, at `2024-01`. No `app/uninstalled`, `app/scopes_update` or privacy (compliance) topics. The secret comes from env, and every Shopify event is forced into the legacy business profile.
  - **Etsy:** no receiver.
  - **Everywhere:** no retry worker, no dead-letter queue, no archive (CX.4c not built). Only a manual replay route exists. The retention sweep can **delete** webhook rows (default on; the policy value is PROD?) — your decision 9 says archive, never delete.
  - No event anywhere sets an account to `revoked`.

### 4.7 Incoming: what we pull from channels

- **CODE:** every scheduled job runs once per business profile when profiles are ON. Many jobs cannot be run by hand from the registry (Amazon SQS poll, flat-file feed poll, quantity read-back, eBay returns, eBay feed poll, eBay read-back and others).
- **Shopify and Etsy: nothing is scheduled.** Their sync jobs exist but are never started. The Etsy job queries a column that does not exist on Product and would throw (`jobs/etsy-sync.job.ts:83`).
- **Amazon:** orders on v0 (see 3.2); no Restricted Data Token anywhere in the code, so buyer personal data calls are not RDT-based; pricing reads on v0 (no end date); the SP-API client waits a fixed 200 ms and never reads rate-limit headers.
- **eBay:** order, return, finance and listing reads were NOT CHECKED today (the orders account link was fixed on 09-16, `87d97499c`).
- No `ChannelRecord` (raw channel data store) exists.

### 4.8 Errors coming back to us

- **Good (CODE):** Amazon errors and warnings are parsed apart (`clients/amazon-sp-api.client.ts:370-415`). Listing issues are mirrored into a `ListingIssue` table (`services/listing-issues.service.ts`). Ads batch errors are caught.
- **Gaps (CODE):** Amazon suppression data is fetched only by hand (a route, no job). eBay feed errors live only inside `EbayPushJob.perSkuResults`. Shopify `userErrors`, eBay bulk and Trading errors, feed report parsing, error screens and alerts were NOT CHECKED.
- **The pieces exist in 8 different tables** (`ChannelListing`, `SyncHealthLog`, `SyncLog`, `OutboundSyncQueue`, `OutboundApiCallLog`, `AlertEvent`, `Notification`, `ChannelPublishAttempt`). There is no single "what went wrong on this listing" record.

### 4.9 Security

> **Update 2026-09-19:** the 14 public monitoring routes, the `===` bidding-token compare and the Cloudinary re-built body are closed by **P0.2** (committed locally, not pushed): see `build/P0.2.md`. S14 (operator webhooks) is closed by P0.3 (committed locally, not pushed): see `build/P0.3.md`.

- **Closed since 08-29 (CODE):** S1, S2, S4, S5, S6, S7, S8, S12, S13, S16. S9 is partly closed.
- **Still open (CODE):**
  - **14 monitoring and job-monitor routes are public with no auth**, including job cancel and retry, queue pause and resume, and the alert-config PUT (`lib/auth/permissions-manifest.ts:58-59`; `routes/monitoring.ts`, `routes/job-monitor.routes.ts`).
  - S14: operator webhook secrets are stored in plain text, and the test fire has no private-address guard (SSRF) and stores the reply uncapped (`routes/settings-webhooks.routes.ts:150, 351`).
  - The Cloudinary receiver checks a re-built body, not the raw body. The internal bidding token uses `===`.
  - An Amazon message with no seller id goes to the only Amazon route, with no destination check.
  - CSRF and RBAC are enforced only when profiles are ON (PROD? — profiles are ON per your 09-16 switch).
- NOT CHECKED: S3 (Neon password in git history — rotation is still yours), S10, S11, S17, S20–S23.

---

## 5. The approach: how we get to "perfect" (the design in one page)

The research and the code check point to one root cause: **every flow grew its own way to call a channel.** That is why the same fault shows up 10 times (dry run that writes, wrong account, wrong language header, no rate limit, no error record). Fixing each path one by one would take longer and would drift again.

So the plan is built on four pieces. Each one is the industry pattern the research recommended (Nango, Airbyte, Saleor, Shopify SDK), sized for us.

1. **One outgoing gateway per channel.** Every call to a channel goes through one function per connector. It does, in this order:
   1. resolve the account by name or from the listing (never a silent fall-back to the primary account for a write);
   2. check the account status (a "needs sign-in" account waits; it does not fail);
   3. apply the publish mode (dry run = zero calls plus a "would send" record; sandbox = the sandbox host);
   4. apply the push lock (paused, closed, ended, Presence intent);
   5. set the right API version, language and marketplace headers, and sign the call where the channel needs it;
   6. take a token from a rate bucket per account and operation, filled from the channel's own rate headers;
   7. send an idempotency key where the channel supports one;
   8. classify the answer into one error vocabulary;
   9. write one call-ledger row (account, operation, time taken, status, error class, rate headroom, capped and redacted bodies).

   A pre-push ratchet counts channel calls outside the gateway and only lets that number go down (the same method that took the MAP lookups from 60 to 0).
2. **One incoming ledger.** Every event is written first — including rejects, unknown types and routing failures — then processed with retries, a dead-letter queue and replay. Subscriptions are compared with a wanted list on connect and every night. A regular pull catches anything a webhook missed.
3. **One error story.** Every rejection, warning and failure lands on the **listing** it belongs to, with the channel's own words, a class and an as-of time. The studio's "Errors & Sync" console, the Channels page and alerts all read that one store.
4. **Contract tests.** Every gateway operation gets a recorded-fixture test, a dry-run test (zero calls), and one proof on production.

What we keep, because it is right and already built: the connection core (catalogue, token service, sign-in flow, heartbeat), BullMQ (your decision 7), the quantity resolver and FBA guard, the business-profile routing, and the Presence listing model from the studio programme.

What we postpone: the full "raw channel data first" model (CX.7). It is a good design, but the gateway and the error store give more value sooner. See decision D5.

---

## 6. The work packages

Size: **S** ≈ 1 session · **M** ≈ 2–3 sessions · **L** ≈ a week of sessions. "Your yes" = needs your explicit approval before it starts, beyond approving this plan.

### P0 — Make it safe (first, small, urgent)

> **State 2026-09-19:** P0.1 and P0.2 BUILT and committed locally, push blocked (see 14.4). P0.3 BUILT and committed locally. P0.4 BUILT and committed locally. P0.1–P0.8 BUILT and committed locally; nothing pushed. Production proofs wait for a push. The live state is always table 14.2.

| ID | Work | Why (evidence) | Done when | Size | Your yes |
|---|---|---|---|---|---|
| P0.1 | Close every "dry run or sandbox that writes live" path: the 3 Amazon client calls, the Amazon direct publish route, eBay flat-file push and republish, eBay bulk operations (and remove the content-wiping stock PUT), the old eBay service, the ungated Shopify inventory route and bulk mutation, the image publish services, and the old Etsy PATCH. | Section 4.2. | A test per path: dry run = 0 outgoing calls; sandbox = sandbox host or 0 calls. The eBay bulk stock op cannot send a partial `inventory_item`. | M | — |
| P0.2 | Put auth on the 14 monitoring and job-monitor routes. Use timing-safe compare for the internal bidding token. Verify the Cloudinary receiver on the raw body. | Section 4.9. | Unauthenticated calls get 401 on production. | S | — |
| P0.3 | Operator webhooks: encrypt the secret, block private addresses and redirects on the test fire, cap the stored reply. | S14. | Test fire to `127.0.0.1` refused; the secret is not readable in the DB. | S | — |
| P0.4 | Sign eBay `issue_refund` (and every other call on eBay's must-sign list) through the existing signing client. | Section 4.1. | One real refund, or a sandbox refund with an EU test user, succeeds. | S | — |
| P0.5 | Amazon app secret, step 1 (safety net): record the expiry date on `ChannelApp.secretExpiresAt` and alert at 90/30/7 days. Step 2 is the automatic rotation, P6.1, which moves up to run right after P0. | Section 3.2. | The alert shows on the Channels page with the real date. | S | — |
| P0.6 | Amazon notifications: run the subscription job inside each business profile; write a ledger row **before** deleting any message; remove `ORDER_STATUS_CHANGE`. | Section 4.6. | Production shows current subscriptions and zero silently dropped messages. | S | — |
| P0.7 | Wrong-account guard: until P1.3 is done, refuse (loudly) any eBay or Amazon write whose listing belongs to a non-primary account, instead of sending it to the primary. | Section 4.2. | A test with a second-account listing: refused with a clear message, 0 calls. | S | — |
| P0.8 | Finish the deadline check (R-1) and add any new date to section 3. | Section 2. | Section 3 has no DOC rows left. | S | — |

### P1 — One outgoing gateway (every outgoing call perfect)

| ID | Work | Done when | Size | Your yes |
|---|---|---|---|---|
| P1.1 | Build the gateway (section 5, item 1) for Amazon SP-API, eBay, Shopify and Amazon Ads. Start with the call ledger, error vocabulary, rate bucket and publish mode. | Every new call uses it; the call ledger shows account, operation, time and headroom. | L | — |
| P1.2 | The ratchet: a pre-push count of channel calls outside the gateway, which can only go down. Move paths over one channel at a time: Amazon 11 → 0, eBay 12+ → 0, Shopify 7 → 0. | Ratchet at 0 for all channels. | L | — |
| P1.3 | Queue destination: add a `channelConnectionId` column to `OutboundSyncQueue` (additive), fill it before queueing, and use it at send time. Per-account concurrency. Limit the 1-minute backup loop. One enqueue function for all 39 sites, so the listing-claim check always runs. | A second-account row goes to the second account; the P0.7 guard is removed. | M | — |
| P1.4 | Shopify queue: fix the empty `channelListing` load; move every Shopify write to the `2026-07` GraphQL client with the connected account (not env); `productSet`; `inventorySetQuantities` with compare-and-set and `@idempotent`. | 0 REST `2024-01` writes; one stock round-trip with compare-and-set proven. | M | — |
| P1.5 | eBay headers: one header builder in the gateway (language, marketplace id); fix `EBAY_IT → en-US`. | A test for every eBay market sends the right three headers. | S | — |
| P1.6 | Retire old writers: the app-token eBay service, the eBay Feed API mode (fix the task type or remove it, R-6), the old Etsy PATCH, the WooCommerce code (your decision 5), and the ghost engines. | Files gone; the ratchet still at 0. | M | Delete list shown to you first |
| P1.7 | Validate before send: Amazon `VALIDATION_PREVIEW` for every content write; eBay `Verify…` calls before Add. Push lock also blocks `ENDED` listings. | No Amazon content write without a preview; a closed or ended listing cannot come back. | M | — |
| P1.8 | Nightly contract run against each channel's sandbox (details in 13.7). | Runs every night; a channel change turns it red before it reaches a live listing. | M | — |

### P2 — Incoming events complete (CX.4b, 4c, 4d)

| ID | Work | Done when | Size | Your yes |
|---|---|---|---|---|
| P2.1 | A ledger that works for every channel: status lifecycle, dedupe on the channel's delivery id (Amazon `NotificationId`, Shopify `X-Shopify-Webhook-Id`, eBay notification id), rejects recorded in every mode, retry worker, dead-letter queue, replay button, **archive instead of delete**. | A forced failure retries, lands in dead letters, and replays; no row is ever deleted. | M | — |
| P2.2 | Amazon subscriptions: add `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE` (2023-12-13), `LISTINGS_ITEM_MFN_QUANTITY_CHANGE`, `REPORT_PROCESSING_FINISHED`, `PRICING_HEALTH`, `ITEM_PRODUCT_TYPE_CHANGE`, `BRANDED_ITEM_CONTENT_CHANGE`, each with its correct payload version. Fix the order-change parsing. Check the destination. Reconcile nightly. | Each type seen arriving on production; a real order-change payload parsed. | M | — |
| P2.3 | eBay Notification API: create the destination and subscriptions for the real topics (orders, shipping, returns, listing, `AUTHORIZATION_REVOCATION`, `MARKETPLACE_ACCOUNT_DELETION`). Remove the invented topic names. Account deletion: answer 200 and handle it for every eBay account. Retire Trading notification setup. | A real eBay order event verified end to end. | M | **Yes** — it starts live traffic (D3) |
| P2.4 | Shopify webhooks: register by GraphQL and reconcile per shop; per-shop secret; add `app/uninstalled`, `app/scopes_update` and the 3 privacy topics; route to the owning business profile. | Uninstall flips the account to revoked; a second update to the same product is processed. | M | — |
| P2.5 | Etsy: a Standard-Webhooks receiver for the 4 order events, plus a receipts pull. | A real `order.paid` verified. | S | You set up the webhooks in Etsy's portal |
| P2.6 | Account lifecycle: every revoke signal (eBay revocation, Shopify uninstall, Amazon `invalid_grant`, Etsy refresh 401) sets `revoked`, pauses writes and alerts. | Each signal proven with a test; one proven on production. | S | — |
| P2.7 | Amazon Marketing Stream: check the subscriptions per profile and dataset, SNS confirmation and dedupe (not checked today). | Hourly data arrives for every live profile. | S | — |
| P2.8 | Ingress tab on the Channels page: events by channel and status, with retry and replay. | Tab live on the design system. | M | — |

### P3 — Errors back to you (one error story)

| ID | Work | Done when | Size | Your yes |
|---|---|---|---|---|
| P3.1 | One error vocabulary (class, channel code, the channel's own message, attribute, severity, retryable). Every gateway maps into it. | Every connector has a mapping table with tests. | M | — |
| P3.2 | Every channel error lands on its listing in `ListingIssue`, with an as-of time: Amazon put/patch issues, previews, feed reports, issue notifications and suppression (add a scheduled job); eBay bulk, feed and Trading errors; Shopify `userErrors`. | A rejected change shows on the listing within one minute, in the channel's words. | M | — |
| P3.3 | Screens: the studio "Errors & Sync" console (owned by the studio programme) reads this store. The Channels page Diagnostics shows the call ledger, rate headroom and last error per account. | Both screens read the same numbers. | M | Studio side is the studio programme's |
| P3.4 | Alerts: dead-letter growth, signature failures, feed rejections over a threshold, secret expiry, deprecation headers — to the owning profile's owners. | Each alert fired once in a test. | S | — |
| P3.5 | Deprecation watch: the gateway reads `Deprecation` and `Sunset` headers and Shopify's deprecation header, and raises an alert. | A fixture with the header raises one alert. | S | — |
| P3.6 | Live dashboards and target levels (SLOs) per channel and operation, plus one trace ID per change (details in 13.7). | Each channel shows error rate, slow calls, backlog age and dead letters against a target. | M | — |

### P4 — Each flow done right, per channel

| ID | Flow | Work | Size |
|---|---|---|---|
| P4.1 | Publish (content) | Amazon: Listings API for single items, `JSON_LISTINGS_FEED` for bulk, both through the gateway with a preview. eBay: keep the split (Inventory API for unique SKUs, Trading for shared SKUs), business policies per account, the description engine in every builder. Shopify: `productSet` only. Etsy: stays read-only (D6). | L |
| P4.2 | Images | Finish the census (R-5). One image publish per channel, through the gateway and the gate. Amazon via the image attributes only. eBay: decide our own URLs or eBay-hosted copies through the Media API (R-1). Shopify via GraphQL media. Image rejections into `ListingIssue`. Read-back for every channel. | M |
| P4.3 | Stock | Every quantity producer through the resolver (fix the catalog PATCH first). Amazon clamp on routed rows. EU guard fails closed (D9). Coalesce shared eBay rows. Remove the Etsy inbound stock write. Shopify read-back. | M |
| P4.4 | Price | A currency per market from data, not a hard-coded GBP/EUR (Sweden SEK, Poland PLN, Turkey TRY). Build the eBay price push (today a stub). Min/max guard on every price write. Price read-back. | M |
| P4.5 | Advertising | Ads: consent page per region; profile discovery in all 3 regions; the v3 report content type in the client; reconnect once for a true expiry date; disconnect removes the old Ads secrets. eBay Promoted Listings: full check first (not done today), then through the gateway. | M |
| P4.6 | Etsy writes (later) | Listing, stock, price and image writes to Etsy through the gateway, keeping Etsy's "at most 6 hours stale" rule. Only after Shopify is live and only with your yes (D6). | M |

### P5 — API version moves (deadline-driven)

| ID | Work | Deadline | Target | Size |
|---|---|---|---|---|
| P5.1 | Amazon Orders v0 → v2026-01-01 (`searchOrders`, `getOrder`). Set the version on every library call so it never falls back to the oldest one. | 2027-03-27 | 2026-12-15 | M |
| P5.2 | Amazon Finances v0 → 2024-06-19 for every caller. | 2027-08-27 | 2027-03 | S |
| P5.3 | Shopify: remove or move the 6 `2024-01` clients to `2026-07`. Then a routine: move to the newest version every quarter. | Already out of support | With P1.4 | S |
| P5.4 | Amazon buyer data: use a Restricted Data Token where we read buyer personal data — or stop reading it if we do not need it. | Policy | With P5.1 | S |
| P5.5 | eBay Post-Order `return/search` → its replacement, if R-1 finds it ends. **Not needed (P0.8, 2026-09-19): Search Returns is not on eBay's decommission list.** | R-1 | R-1 | — |

### P6 — Sign-in and account life cycle

| ID | Work | Size | Your yes |
|---|---|---|---|
| P6.1 | **Automatic Amazon app-secret rotation** (see 6.1 below). **Moved up: runs right after P0.** | M | You register the queue once |
| P6.2 | Rotate app secrets and the eBay signing key too, not only account tokens. | S | — |
| P6.3 | Etsy: save the rotated refresh token safely before using it, so it can never be lost. | S | — |
| P6.4 | Revoke at the channel where it can be done; where not, clear locally and show the channel page link. | S | — |
| P6.5 | Fix the heartbeat for shared (guest) accounts. | S | — |
| P6.6 | Amazon SP-API sign-in: apply decision D1; retire the env token path. | M | D1 |
| P6.7 | eBay: probe the keyset for returns, cancellation and inquiry scopes; add the accepted ones; reconnect both accounts once. | S | Reconnect is yours |
| P6.8 | Shopify and Etsy on production: production app, HTTPS callbacks, real consent, return to the tab. | M | Your app set-up |

#### 6.1 Automatic Amazon app-secret rotation (P6.1)

Amazon requires a new app secret every 180 days. If we miss it, every Amazon call stops. Amazon offers a way for an app to rotate its own secret, so no person has to remember it.

How it works:

1. **Once, by you:** register a private, encrypted queue for the app's rotation messages (Amazon's "Rotating your app's LWA credentials" guide shows where).
2. **Nexus, automatically, 30 days before the expiry date** (or when Amazon's expiry warning arrives): it asks Amazon for a new secret (`rotateApplicationClientSecret`).
3. Amazon sends the new secret **only** to the registered queue. Nexus reads it, tests it with one real token exchange, saves it encrypted in `ChannelApp`, sets the next expiry date (+180 days), and deletes the message.
4. The old secret keeps working for 7 more days, so there is no gap.
5. If any step fails, Nexus alerts at once. There are still at least 30 days to act by hand, with a checklist.

One code change is needed first: some code still reads the secret from the Railway env (`AMAZON_LWA_*`, for example `clients/amazon-sp-api.client.ts:170`). Every reader must use `ChannelApp`, or a rotated secret would be ignored.

Done when: a rotation runs end to end (on a test app or in the real window), the new secret is used by every Amazon call, and the old one is never read again.

### P7 — Clean-up (after the P1 ratchet is at 0)

- Remove: the ghost engines, WooCommerce, the old eBay routes, `oauth-state.ts`, the old Ads fallback.
- Destructive drops, **each with its own yes** after a green week (your decision 6): `ChannelConnection.ebay*` columns, `AmazonAdsConnection`, `MarketplaceSync`, `Channel`, `Listing`, `EbayPushJob`, `AmazonFlatFileFeedJob`, `UserRole.channelScope`.

### P8 — New channels (only after P1–P3 are green)

- Order per your decision 11: Allegro → TikTok Shop → Google Merchant Center → Meta catalog → then the key-paste channels by revenue.
- Each new channel is born on the gateway, the ledger and the error store. One real connect, one incoming event and one outgoing write proven on production.

---

## 7. The quality bar ("AAA") — every call must pass this

### 7.1 Every outgoing call

1. Goes through its channel's gateway (the ratchet enforces it).
2. Names its account. A write never falls back to the primary account.
3. Gets its token from the token service. A "needs sign-in" account makes the write wait, not fail.
4. Honours the publish mode: dry run = zero calls; sandbox = the sandbox host.
5. Honours the push lock (paused, closed, ended, Presence intent). FBA quantity is never written.
6. Uses the current API version, the right language and marketplace headers, and a signature where required.
7. Respects the channel's rate limits per account and operation, reads the rate headers and `Retry-After`. A 429 never dead-letters.
8. Sends an idempotency key where the channel supports one, so a retry is safe.
9. Is validated first where the channel offers it (Amazon preview, eBay Verify).
10. Classifies the answer into the error vocabulary and saves any issue on the listing.
11. Writes one call-ledger row, with personal data and secrets removed and bodies capped.
12. Is confirmed afterwards for stock, price and status (read-back, feed report or event).
13. Has a recorded-fixture test, a dry-run test, and one production proof.

### 7.2 Every incoming event

1. Raw body, signature checked, timing-safe, fails closed.
2. Ledger row first — rejects, unknown types and routing failures included.
3. Dedupe on the channel's own delivery id.
4. Routed to exactly one owning account and business profile. Ambiguity is recorded, never dropped.
5. Processed with retries, a dead-letter queue and replay.
6. A regular pull covers anything missed.
7. Subscriptions reconciled to a wanted list, on connect and nightly.
8. Revoke and uninstall signals change the account status.
9. Visible on the Ingress tab; failures raise an alert.
10. Archived, never deleted (your decision 9).

### 7.3 What you see

- Every account shows its real status, missing permissions, expiry dates, last incoming, last outgoing and last error.
- Every listing shows the channel's own errors and warnings, with an as-of time.
- Every alert reaches the owners of the business profile it belongs to.

---

## 8. Things only you can do (outside the code)

1. **Find the Amazon LWA client-secret expiry date** in the Solution Provider Portal (R-3). If it is close, rotate it by hand once. After that, register the rotation queue once (section 6.1), and Nexus rotates it automatically from then on.
2. **Turn on KMS encryption** — `docs/2026-08-29-kms-runbook.md`. Until then, credentials use the env key and an alert fires.
3. **Rotate the Neon database password.** It is in git history. Update Railway `DATABASE_URL` at the same time.
4. **eBay:** set the Marketplace Account Deletion endpoint in the eBay developer portal (or opt out if we store no eBay user data). Confirm the RuName points at the API callback.
5. **eBay:** reconnect both accounts after P6.7 adds scopes.
6. **Amazon Ads:** reconnect once (after P4.5), to record a true expiry date.
7. **Shopify:** the production app and the install link for the store (P6.8).
8. **Etsy:** the production HTTPS callback and the 4 webhooks in Etsy's portal (P2.5, P6.8).
9. **Amazon:** answer D1 (private or public app).
10. **Production settings read (R-4)** — say "go" and Claude reads them, or read them yourself: `AMAZON_SP_AUTH_MODE`, `NEXUS_AMAZON_ADS_MODE`, the three publish-mode pairs, `NEXUS_EBAY_REAL_API`, `ENABLE_QUEUE_WORKERS`, `NEXUS_KMS_KEY_ID`, `NEXUS_WORKSPACES_ENABLED`, `NEXUS_ENABLE_RETENTION_SWEEP` and its webhook policy, `EBAY_NOTIFICATION_VERIFICATION_TOKEN`.

---

## 9. Decisions for you

| # | Question | Option A | Option B | My pick |
|---|---|---|---|---|
| D1 | Amazon app: private or public? (Your 08-29 decision said public; the 09-08 review found the registered app is private, and a private flow was built.) | **Private:** self-authorization through the Solution Provider Portal, up to 10 of your own seller accounts, no review, works today. | **Public:** review and listing, re-authorize every 365 days, 25 accounts while unlisted; needed only for sellers who are not yours. | **A**, after R-2. Revisit only if an outside seller must connect. |
| D2 | Order of work. | **Safety (P0), then the gateway (P1), then per-flow fixes.** | Per-flow fixes first (images, price…), gateway later. | **A.** Otherwise we fix about 30 paths twice. |
| D3 | eBay Notification API subscriptions (CX.4b). It starts live event traffic. | **Yes, after the ledger (P2.1) is done.** | No; keep pulling only. | **A.** Pulling alone misses revocation and account deletion. |
| D4 | eBay account-deletion notices. | **Automatic:** remove that eBay user's personal data from our orders, keep the money records, log it. | Manual: add it to a list for you to act on. | **A.** eBay marks the endpoint non-compliant after 30 days of no action. |
| D5 | The "raw channel data first" model (CX.7: `ChannelRecord`, field policy, `AsyncJob`). | Build it now. | **After P1–P3.** Until then, keep the raw payload for order and listing reads. | **B.** |
| D6 | Etsy writes. | Build listing writes now. | **Stay read-only** (studio decision D9) until Shopify is live. | **B.** |
| D7 | Second eBay account: stock and price for its listings. | Build the per-account fan-out (MAP.7) now. | **Refuse loudly now (P0.7); build MAP.7 after P1.3.** | **B.** |
| D8 | Old webhook rows. | Delete by the retention policy (today's code). | **Archive, never delete** (your 08-29 decision 9). | **B.** |
| D9 | The EU shared-quantity guard when its own check fails. | Let the push through (today). | **Hold the push and alert.** | **B.** A wrong EU quantity is worse than a short delay. |

---

## 10. How this plan fits the other programmes

- **Presence (studio listing lifecycle, `docs/product-sheet/` topic 11):** Presence owns the listing object (intent and fact) and the verbs (pause, end, relist). Its Waves 4–5 — the first channel verbs — are held for your approval. **This plan gives those verbs their calls:** the gateway (P1), the error store (P3) and the incoming facts (P2). Rule: no new channel verb outside Presence; no new channel call outside the gateway.
- **Studio publish and market features (topics 06 and 12):** the studio's publish flow and "Errors & Sync" console sit on top of P1 and P3. Their P0 safety items overlap with P0.1 here; do them once, here.
- **Shared stock and the assortment engine (being built now):** they change where stock comes from. Stock still goes out through the resolver and the gateway. No conflict.
- **Business profiles:** every job, event and call carries its business profile. Incoming routing stays "exactly one owner".
- **Multi-account (MAP):** P1.3 finishes what MAP started for writes. MAP.7 follows (D7).

## 11. Not in this plan

- WooCommerce (out by your decision; code removed in P1.6).
- Walmart, Temu, SHEIN, Privalia, Fnac (research says "not now").
- Moving the bidding engine to its own service (held on purpose).
- Reports across business profiles.

## 12. Suggested order and timing

| Step | What | Rough size | Starts when |
|---|---|---|---|
| 1 | Your items 1–3 and 9–10 in section 8 | minutes each | Now |
| 2 | P0 (8 small safety packages) | about 1 week | You approve this plan |
| 3 | P6.1 automatic Amazon secret rotation | 2–3 sessions | P0 done, and you registered the queue |
| 4 | P1 gateway and ratchet (Amazon first, then eBay, then Shopify), with P1.8 nightly sandbox run | 2–3 weeks | P0 done |
| 5 | P2 incoming and P3 errors, with P3.6 dashboards (can run beside P1 after P1.1) | 2 weeks | P1.1 done |
| 6 | P5.1 Amazon Orders move | 1 week | Before 2026-12-15 |
| 7 | P4 per-flow, P5 rest, P6 rest | 3–4 weeks | P1 ratchet near 0 |
| 8 | P7 clean-up, then P4.6 Etsy writes (if you say yes), then P8 new channels | later | P1–P3 green |

Each package ends with: tests green, a production proof, and a short build record in this folder. Nothing ships without your "go".

## 13. Per channel: our approach, and is it the enterprise standard?

**How to read this section.** For each channel: what we will do, what large enterprise tools do (Rithum/ChannelAdvisor, ChannelEngine, Linnworks, Pacvue, Skai, and the channels' own guidance, as found in research R1–R4, R8, R9), and my honest verdict.

Verdict key: **STANDARD** = the same as the enterprise norm. **ABOVE** = stricter than most tools. **GAP** = below the norm; the plan fixes it. **CHOICE** = a business decision, not a quality question.

Sources: the 08-29 research (R1 Amazon, R2 eBay, R3 Shopify, R4 Etsy, R8 Nango, R9 references). Points not re-checked today are marked "check in R-1".

### 13.1 The shared foundation (all channels)

| Piece | Our approach | Enterprise norm | Verdict |
|---|---|---|---|
| Queue | A database outbox (`OutboundSyncQueue`) plus a BullMQ worker. | The "transactional outbox" pattern: save the change in the same database write, then send it from a worker. | **STANDARD** |
| One gateway per channel | One function per channel for every call: account, token, mode, lock, headers, signing, rate limit, idempotency, error class, ledger. | Nango, Airbyte, Rithum and ChannelEngine all have one connector layer per channel with these steps. | **STANDARD** (today's 11–12 write paths per channel are a **GAP**; P1 fixes it) |
| Rate limits | A bucket per account and operation, filled from the channel's rate headers. | The same. Nango lacks it; the channel vendors have it. | **STANDARD** |
| Incoming events | Ledger first, dedupe on the delivery id, retries, dead letters, replay, nightly subscription reconcile, plus regular pulls. | The same. Every channel says webhooks are not guaranteed, so everyone also pulls. | **STANDARD** |
| Errors | One error vocabulary; every error saved on its listing with an as-of time. | Channable and Lengow do one error vocabulary. Most feed tools (Feedonomics, Rithum) report errors in a separate report, not on the product. | **ABOVE** |
| Secrets | KMS envelope encryption; one module decrypts. | KMS or a vault. | **STANDARD**, once you turn KMS on (section 8, item 2) |
| Dry run and sandbox | Every write honours dry run and sandbox. | Most tools have a test mode, but not per write path. | **ABOVE** (once P0.1 is done; today it is a **GAP**) |
| Testing | Recorded-fixture tests, dry-run tests, one production proof. | The same, **plus a nightly run against each channel's sandbox**. | **GAP** → new package **P1.8** below |
| Monitoring | A call ledger and alerts. | The same, **plus live dashboards per channel and operation (error rate, slow calls, backlog) with target levels ("SLOs") and tracing of one change end to end**. | **GAP** → new package **P3.6** below |

**My verdict on the foundation:** the design is the enterprise standard. Today's code is not: it has too many separate write paths. P0 and P1 close that gap. Two upgrades (P1.8, P3.6) take us to the full enterprise bar.

### 13.2 Amazon SP-API

| Area | Our approach | Enterprise norm | Verdict |
|---|---|---|---|
| App type | Private app, self-authorized through the Solution Provider Portal (D1). | Software vendors that serve many sellers (Rithum, Linnworks) use a **public** app. A brand that runs **its own** system uses a **private** app, and Amazon recommends that. | **STANDARD for us.** Public only if Nexus is ever sold to other sellers. |
| Listing writes | Listings Items API (2021-08-01) for single items; `JSON_LISTINGS_FEED` for bulk; Product Type Definitions for the rules; a validation preview before every write. | This is now **the only** write path Amazon allows (old feeds ended 2025-12-03). Everyone uses it. | **STANDARD** |
| Stock | `fulfillment_availability` through the Listings API; FBA never written; a read-back every day. | The same. The read-back and the FBA guard are what careful tools do. | **STANDARD** |
| Price | `purchasable_offer` with a currency per market, a min/max guard and a read-back. | The same. Repricers also use the pricing notifications. | **STANDARD** after P4.4 (hard-coded EUR is a **GAP** today) |
| Orders and money | Orders v2026-01-01, Finances 2024-06-19, a Restricted Data Token for buyer data. | Required by Amazon's dates and data policy. | **STANDARD** after P5 (v0 is a **GAP**, deadline 2027-03-27) |
| Events | SQS notifications (listing status, listing issues, quantity, orders, feeds, reports, pricing) plus regular pulls. | The same. EventBridge is the other option, mainly for teams that already run on AWS. SQS is fine. | **STANDARD** after P2.2 |
| Secret rotation | Automatic app-secret rotation every 180 days, with alerts. | Required by Amazon. Serious tools automate it. | **STANDARD** after P6.1 (**GAP** today) |

**My verdict:** the approach is the one Amazon itself recommends. Nothing better exists. The risk is only in carrying it out (11 write paths today, the old versions, and the secret date).

### 13.3 Amazon Ads

| Area | Our approach | Enterprise norm | Verdict |
|---|---|---|---|
| Sign-in | LWA with PKCE, the consent page of each region, one grant with many profiles. | The same (Pacvue, Skai, Perpetua). | **STANDARD** after P4.5 (NA-only consent page is a **GAP**) |
| Campaign data | Sponsored Products v3, Sponsored Brands v4, Sponsored Display, Exports for full snapshots. | The same set of APIs. | **STANDARD** |
| Performance data | Reports v3 (async) for daily data; **Amazon Marketing Stream** for hourly data. | Amazon Marketing Stream is what the large ad tools use for hourly bidding. | **STANDARD** |
| Writes | A write gate (production mode plus writes enabled), a campaign allowlist, dry run, a call log for every write. | Enterprise tools use rules with approval and an audit trail. | **ABOVE** on safety |
| Direction | Amazon is moving to a new unified "Amazon Ads API v1". Our code tried it and got 403; it stays on v3/v4 for now. | Big tools move when the new API is stable. | **STANDARD**. Check the status in R-1 and plan the move then. |
| Build or buy | We build our own bid engine. | Many enterprise brands buy a tool (Pacvue, Skai). Building your own is normal when ads are a core skill. | **CHOICE** (yours, already made) |

**My verdict:** a strong base, already close to the enterprise level. The fixes are small (regions, the true token expiry date, the report header).

### 13.4 eBay

| Area | Our approach | Enterprise norm | Verdict |
|---|---|---|---|
| Listings | **Two lanes:** the Inventory API for normal products (one SKU per listing); the older Trading API for the "shared SKU" listings (the same child SKU in several parent listings). | eBay wants new work on the Inventory API. But the Inventory API cannot repeat a SKU, and listings it creates cannot be edited in Seller Hub. So most large tools (Rithum, Linnworks, 3Dsellers) still use Trading, or a mix like ours. | **STANDARD** for a business with shared SKUs. Pure Inventory API is not possible for your shared-SKU listings. |
| Old-call risk | eBay retires single Trading calls (for example `UploadSiteHostedPictures` on 2026-09-30). The gateway plus the deprecation watch (P3.5) show each one early. | The same: watch the eBay deprecation page and the headers. | **STANDARD** |
| Orders | The Fulfillment API, pulled by last-changed date, per account. | The same. eBay has no "item sold" push, and says to keep pulling. | **STANDARD** |
| Events | The REST Notification API (ECDSA signature) for orders, returns, revocation and account deletion. | The same. The old SOAP notifications are legacy. | **STANDARD** after P2.3 (**GAP** today: no subscriptions) |
| Signatures | RFC 9421 signing for money calls (finances, refunds). | Required for EU/UK sellers. | **STANDARD** after P0.4 (refunds unsigned is a **GAP**) |
| Images | Today: our own image URLs. Option: copy them to eBay first with the Media API (eBay-hosted). | Both are used. eBay-hosted copies do not depend on our image server staying up. | **CHOICE** — pick after R-1. My lean: the Media API, for independence. |
| Many accounts | One eBay app, one sign-in per seller account, every call names its account. | The same. | **STANDARD** after P1.3 (primary-only is a **GAP** today) |
| Compliance | An account-deletion endpoint with automatic erasure (D4). | Required by eBay for every app. | **STANDARD** after P2.3 |

**My verdict:** the right approach. The two-lane design is not a compromise; it is what your shared-SKU model needs, and the large tools do the same.

### 13.5 Shopify

| Area | Our approach | Enterprise norm | Verdict |
|---|---|---|---|
| App type | A custom-distribution app from the Dev Dashboard, with a sign-in code grant and a non-expiring offline token. | The standard for your own stores. A public App Store app is only for selling to other merchants. The old "paste an admin token" apps can no longer be made. | **STANDARD** |
| API | GraphQL Admin API only, version `2026-07`, upgraded every quarter. | REST is legacy; new public apps must be GraphQL-only. Enterprise tools upgrade each quarter. | **STANDARD** after P1.4 and P5.3 (six `2024-01` clients are a **GAP**) |
| Product writes | `productSet` (one call writes the whole product with its variants). | Shopify recommends `productSet` for syncing from a PIM. | **STANDARD** |
| Stock | `inventorySetQuantities` with compare-and-set and an idempotency key. | Shopify requires the idempotency key on stock writes from 2026-04. Compare-and-set is best practice. | **STANDARD** after P1.4 |
| Bulk | Bulk operations for large reads and writes. | The same (rate-limit free, up to 5 at once per shop). | **STANDARD** |
| Webhooks | GraphQL subscriptions reconciled per shop; raw-body HMAC; dedupe on `X-Shopify-Webhook-Id`; uninstall and scope-change topics; privacy topics. | The same. Large apps often declare topics in the app's config file, and use EventBridge or Pub/Sub at very high volume. HTTPS is fine at our size. The privacy topics are required for App Store apps; for ours they are good practice (check in R-1). | **STANDARD** after P2.4 (the wrong dedupe key is a **GAP** today) |
| International | Markets, catalogs and price lists; translations; metafields owned by our app. | The same. | **STANDARD** (built later, in P4) |

**My verdict:** the approach is exactly Shopify's own recommended path. Today's code is mostly on the old path; P1.4 moves it.

### 13.6 Etsy

| Area | Our approach | Enterprise norm | Verdict |
|---|---|---|---|
| Sign-in | Open API v3, OAuth with PKCE, a Seller App, a rotating refresh token saved safely. | The same. It is the only way Etsy allows. | **STANDARD** after P6.3 |
| Events | Webhooks for the 4 order events, plus regular pulls for listings, stock and receipts. | The same. Etsy has no listing or stock webhooks, so everyone pulls. | **STANDARD** after P2.5 |
| Listing writes | **None for now** (read-only, D6). | Enterprise multichannel tools (Linnworks, ChannelAdvisor, Sellbrite) **do** write listings, stock and prices to Etsy. | **CHOICE**. Read-only is below the norm. It is safe while Shopify comes first. Plan Etsy writes after P1–P3. |
| Data rules | Etsy's terms: listing content at most 6 hours stale. | Required. | Must be met once we write or show Etsy data. |

**My verdict:** the sign-in and events approach is the standard. Read-only is a business choice, not the enterprise norm. I recommend adding Etsy writes as a later package (after Shopify is live).

### 13.7 Two new packages this check adds

| ID | Work | Why | Size |
|---|---|---|---|
| P1.8 | A **nightly contract run against each channel's sandbox** (Amazon SP-API sandbox, eBay sandbox, a Shopify development store, the Amazon Ads test account). One read and one dry-run write per gateway operation. Etsy has no sandbox: use a test listing on the real shop, marked "test". | Enterprise tools find channel changes before customers do. Our fixture tests only replay old answers. | M |
| P3.6 | **Live dashboards and target levels (SLOs)** per channel and operation: error rate, slow calls, backlog age, dead letters; and one trace ID that follows a change from the click to the channel's answer. | The enterprise way to see a problem before a seller reports it. | M |

### 13.8 Summary in plain words

- **The approach is the enterprise standard for every channel.** For Amazon and Shopify it is exactly what the channels themselves recommend. For eBay, the two-lane design is what your shared-SKU model needs, and the large tools do the same.
- **Today's code is below that standard in its execution** — too many write paths, old API versions, missing event subscriptions. The plan's P0–P6 close those gaps.
- **Three things take us from "standard" to "enterprise":** one gateway per channel (P1), nightly sandbox tests (P1.8), and live dashboards with target levels (P3.6).
- **Two items are your choices, not quality gaps:** building our own ad engine, and keeping Etsy read-only for now.

---

## 14. Handover: how an implementation session works

### 14.1 Rules for every implementation session

1. **Read this whole file first.** Then read the rows of the package you work on.
2. **Re-check the evidence.** Every CODE fact here was measured on 2026-09-19. Other sessions change the code every day. Before you change anything, check that each path:line you rely on is still true.
3. **One package at a time.** Before you change any file, write a short exact-change list (files, what changes, how you will prove it) and **wait for the Owner's "go"**.
4. **Do only the package.** Anything next to it needs its own yes.
5. **Other sessions share this tree.** Run `git status` first. Never revert or reformat a file you did not change. The shared-stock work lives in `.claude/worktrees/shared-stock` — do not touch it. The Presence programme owns listing verbs (pause, end, relist): see section 10.
6. **Safe testing:**
   - Run API tests from `apps/api`, never from the repo root (from the root, `DATABASE_URL` points at the production database). Print the database host first.
   - `grep` in this shell skips ignored files. Use `/usr/bin/grep` for any "exists / does not exist" claim.
   - No live channel write and no production database write without the Owner's explicit yes. Prove writes with dry runs first.
7. **UI work** uses the Nexus design system (`apps/web/src/design-system`, see `AGENTS.md`).
8. **Commits:** do not commit or push unless the Owner says so. Never use `--no-verify`.
9. **Finish every package with:** tests green, a production proof (or a clear "could not measure" with the reason), a build record at `docs/channel-connections/build/<ID>.md`, and its row updated in 14.2.

### 14.2 Progress

Update this table when a package changes state. States: NOT STARTED · PROPOSED · APPROVED · BUILDING · BUILT · PROD-VERIFIED.

| Package | State | Build record | Notes |
|---|---|---|---|
| Owner items (section 8) | NOT STARTED | — | Secret date first |
| P0.1 | BUILT (2026-09-19) | `build/P0.1.md` | Not committed. Prod switches read: eBay + Amazon live. Prod proof waits for a push |
| P0.2 | BUILT (2026-09-19) | `build/P0.2.md` | Committed locally, not pushed. Prod proof: anonymous GET /api/monitoring/queue-stats → 401 after a push |
| P0.3 | BUILT (2026-09-19) | `build/P0.3.md` | Committed locally, not pushed. Prod read (encryption key set?) refused by the permission system; prod proof after a push |
| P0.4 | BUILT (2026-09-19) | `build/P0.4.md` | Committed locally, not pushed. Also fixes a P0.3 test break (see P0.3.md section 4). Prod proof: the next real eBay refund |
| P0.5 | BUILT (2026-09-19) | `build/P0.5.md` | Committed locally, not pushed. The Owner records the Amazon date on the page after a push (R-3) |
| P0.6 | BUILT (2026-09-19) | `build/P0.6.md` | Committed locally, not pushed. Prod proof: per-profile setup CronRuns; no Amazon row left pending |
| P0.7 | BUILT (2026-09-19) | `build/P0.7.md` | Committed locally, not pushed. In the queue, replaced by P1.3 (each row its own account; the ownership check stays as a consistency check). Other paths keep it until MAP.7 |
| P0.8 | BUILT (2026-09-19) | `build/P0.8.md` | Committed locally. Docs only: section 3 has no DOC rows left |
| P6.1 automatic secret rotation | BUILT (2026-09-19) | `build/P6.1.md` | Committed locally, not pushed. OFF until the Owner registers the credential queue and sets `AMAZON_APP_CREDENTIAL_QUEUE_URL` (build/P6.1.md section 4) |
| P1.1 | BUILT (2026-09-19) | `build/P1.1.md` | Committed locally, not pushed. Gateway + ledger columns (migration `20260919a_p11_gateway_call_ledger`, additive); no caller moved yet (P1.2). eBay headers from the Marketplace row (LX.2) |
| P1.2 | BUILT (2026-09-19) | `build/P1.2.md` | Committed locally, not pushed. Ratchet in pre-push; ALL channels at 0 (50 exempt, each with a written reason). P1.6 candidates listed in the record |
| P1.3 | BUILT (2026-09-19) | `build/P1.3.md` | Committed locally, not pushed. Queue column (migration `20260919b_p13_queue_destination`, additive); one creation module for all 35 sites; the sender uses the row's account (never the primary); 2 per account at a time; backup loop 200/tick |
| P1.5 | BUILT (2026-09-19) | `build/P1.5.md` | Committed locally, not pushed. Listing writes get their three headers from the Marketplace row (EBAY_IT → it-IT); `toListingLanguage` deleted (LX F-LX-6 closed); flat-file routes included (Owner) |
| P1.4 | BUILT (2026-09-19) | `build/P1.4.md` | Committed locally, not pushed. P1.4a queue + P1.4b order actions, bulk action, gateway rule: a Shopify change leaves only on the `2026-07` GraphQL API with a named account (0 REST 2024-01 writes). Live stock round-trip needs a dev store + the Owner's yes. A linked listing with no reviewed location uses the shop's location when it has exactly one (Owner, 2026-09-20) |
| P1.6 – P1.8 | NOT STARTED | — | P1.6 needs the delete list shown first |
| P2.1 – P2.8 | NOT STARTED | — | P2.3 needs D3 |
| P3.1 – P3.6 | NOT STARTED | — | |
| P4.1 – P4.6 | NOT STARTED | — | P4.6 needs D6 |
| P5.1 – P5.5 | NOT STARTED | — | P5.1 before 2026-12-15 |
| P6.3 | BUILT (2026-09-19) | `build/P6.3.md` | Committed locally, not pushed |
| P6.5 | BUILT (2026-09-19) | `build/P6.5.md` | Committed locally, not pushed |
| P6.2, P6.4, P6.6 – P6.8 | NOT STARTED | — | P6.6 needs D1 |
| P7, P8 | NOT STARTED | — | Later |

### 14.3 Decisions log

Write each answer here with its date, for example: `D2 = A (2026-09-20)`.

| Decision | Answer | Date |
|---|---|---|
| D1 = A, D2 = A, D3 = A, D4 = A, D5 = B, D6 = B, D7 = B, D8 = B, D9 = B (the "My pick" column of section 9) | The Owner, 2026-09-19: "I'll go with your recommendations. We just have to go with the best approach." D1 still reads R-2 first. | 2026-09-19 |
| How to run the plan | The Owner, 2026-09-19: "Start to implement the whole plan. I'll stop you where we need it." Packages run in the plan's order without a per-package "go". Each package is committed locally when its proof is green; **nothing is pushed**. Still asked first: any push, any production read or write, any live channel call, any delete list (P1.6), every destructive drop (P7), and the Owner-only steps in section 8. | 2026-09-19 |
| Flat-file routes (standing no-touch rule) | P0.7, P1.2 and P1.3 edited `routes/ebay-flat-file.routes.ts` (and one comment in `amazon-flat-file.routes.ts`) without the per-change yes the rule needs. Written list: `build/flat-file-edit-list.md`. The Owner, 2026-09-19: **keep them** ("Keep them (Recommended)"). The blanket go above does NOT lift that rule for future edits. | 2026-09-19 |
| P1.5 scope | The Owner, 2026-09-19: **include the flat-file routes** in the eBay language-header switch. | 2026-09-19 |
| Shopify stock location for a linked listing (P1.4) | The Owner, 2026-09-20: **use the shop's own location when it has exactly one active location**; two or more (or none) are refused. Nexus never picks "the first". | 2026-09-20 |
| Production reads for the P1.6 delete list | The Owner, 2026-09-20: **yes** — this session may read production traffic (Railway `http-requests`, read-only) to prove that a route has no caller. Writes still need a separate yes. | 2026-09-20 |

### 14.4 Handover notes (2026-09-19, from the P0.1 / P0.2 session)

**State of the tree**
- P0.1 is commit `8fcd1d500` on local `main`. It is **not on `origin/main`** and **not deployed**. The first push was refused by the pre-push **grid-kit ratchet**: 35 importers of the DS `DataGrid` against a baseline of 32. The committed code has exactly 32. The +3 are another session's untracked files: `apps/web/src/app/settings/sharing/AssortmentProductsModal.tsx`, `CopyDrawer.tsx`, `SharesPanels.tsx`. The ratchet reads the whole working tree, so nobody can push until those move to `NexusGrid` or leave the tree. Never lower the baseline, never `--no-verify`.
- P0.2 is **uncommitted** in the working tree: `apps/api/src/lib/auth/permissions-manifest.ts`, `lib/auth/internal-token.ts` (new), `lib/auth/internal-routes.vitest.test.ts`, `routes/advertising.routes.ts`, `routes/cloudinary-webhook.routes.ts`, `routes/public-surface.p02.vitest.test.ts` (new), plus `docs/channel-connections/build/P0.2.md` and this file.
- A background auto-push loop was refused by the permission system (unattended persistence). Push by hand, once, when the ratchet is clean.

**Production facts read 2026-09-19** (Railway, `@nexus/api`, production): Amazon and eBay publish modes `live`; `NEXUS_EBAY_REAL_API=true`; Shopify publish not set (`gated`); no Shopify, Etsy or WooCommerce env tokens; `NEXUS_RBAC_MODE=enforce`; `NEXUS_WORKSPACES_ENABLED=1`. Re-read before relying on them.

**Traps met in these two packages**
1. `docs/channel-connections/build/` is caught by the generic `build/` rule in `.gitignore` (line 12). Add a build record with `git add -f <file>`, or a `git commit --only` fails on its pathspec.
2. Many existing tests model a live write but never set the publish mode. When a gate makes them fail, pin `live` in that test's fixture (`vi.stubEnv('NEXUS_ENABLE_…_PUBLISH','true')` + mode `live`); do not move the gate to please the test.
3. 6 tests fail locally before and after this work: `clients/amazon-validation-preview` (5) and `services/marketplaces/amazon-classifications` (1). They read the local database's Amazon account through `lib/amazon-sp-client.ts`, which answers "Reconnect the selected Amazon seller account." Not a code regression.
4. In zsh, `$FILES` holding a newline list is ONE argument. Feed file lists with `xargs … < list.txt`.
5. A "no caller" claim for a route needs both the code search and production traffic (Railway `http-requests`, 7 days, with `/api/health` as the positive control).

**Next steps, in order**
1. Check `git log origin/main` for `8fcd1d500` (a sister session's push may have carried it). If not, check `node scripts/check-grid-kit-ratchet.mjs --check`; when clean, push normally.
2. With the Owner's word, commit P0.2 (`git commit --only` with its exact paths; `git add -f` the build record) and push.
3. Production proofs: P0.1 — switches unchanged, `OutboundApiCallLog` shows normal live eBay/Amazon calls and no refusals on live paths. P0.2 — anonymous `GET https://api.xavia.it/api/monitoring/queue-stats` answers 401. Write both into the build records; set the rows to PROD-VERIFIED.
4. Then P0.3 (operator webhooks, S14), P0.4 (sign eBay `issue_refund`), P0.5 (Amazon secret expiry alert — needs the date, R-3, from the Owner), P0.6, P0.7, P0.8, each with its exact-change list and the Owner's "go".
