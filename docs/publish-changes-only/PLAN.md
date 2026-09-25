# PCO — Publish sends only what changed (task A) + direct calls to the channels (task B) — PLAN, Q1(a) + Q2(a) APPROVED 2026-09-25

Session prompt: `docs/publish-changes-only/SESSION-PROMPT-2026-09-25.md` (its §3 rules bind). Written 2026-09-25 (UTC night of 09-24/25).
**At the ruling: nothing was built. No channel write. No production write.** Production was read with `BEGIN READ ONLY` tools only.
Labels: **read** = seen in code or data this session · **measured** = counted by a tool run this session · **inferred** = not proven.

## Summary (plain English)

1. **Amazon and eBay are already switched ON in production.** The running server (deploy of 2026-09-24 20:15 UTC) logged
   `Amazon=live eBay=live Shopify=gated`. Studio Publish is not blocked by a gate on Amazon or eBay in production.
   Only your LOCAL copy is off for all three, because its `apps/api/.env` sets no gate flag.
2. **Shopify is the only gate that is off.** You will link the Shopify products and listings first. It stays off until then.
3. **The old queue will not fire.** All 2,199 failed rows are "dead". The normal retry sender excludes these FAILED + dead rows. 2,198 are eBay rows
   from July. This is a queue finding, not a claim that automatic jobs cannot create new work (§1b).
4. **The big blocks are not gates.** 208 of 332 eBay listings (8 families) use the eBay "Inventory" model, and studio Publish
   refuses them. 350 Amazon listings in Germany, Spain and France have a closed offer; one closed product stops its whole family.
5. **The KNOWN overwrite risk is 13 listings, not 45 — but most listings were never read.** All 45 differences are Amazon
   Germany. 2 of the 3 families (xracing, xavia-knee-slider) have every German offer closed, so Publish already refuses them.
   Only **GALE-JACKET · Amazon DE** (13 listings) is known to be overwritten by a Publish today. The nightly content read has not
   reached most listings yet: Amazon IT 183 of 273 not read (the 90 read: 0 differ), DE 23 of 36 open not read, ES 30 and FR 36
   open not read, and **eBay content 0 of 332 read**. For those, the risk is unknown, not zero.
6. **Task A measured:** change one field on one child, and Publish still sends all 9 messages. Only 206 of 8,662 bytes
   (2.4 %) carry the change.
7. **Ruling received:** Q1(a) + Q2(a), recorded in §8. The warning is the first build step.

---

## §0 How Publish works today (read, 2026-09-25)

Paths: a bare file name is in `apps/api/src/services/pim/`; a path with folders starts at `apps/api/src/` (web paths start at `apps/web/`).

1. Routes: `POST /products/:id/studio-publication/preview`, `…/:reviewId/submit`, `GET …/:reviewId` (`routes/product-studio.routes.ts:113, :120, :126`); all need `products.publish` (`lib/auth/permissions-manifest.ts:204`).
2. `publishMode(channel)` = the Amazon / eBay / Shopify gate; any other channel = `unavailable` (`studio-publication.service.ts:18`).
3. `buildReview` reads the facts (`studio-publication-plan.ts`), prepares the channel payload (`:47-58`), and adds the refusal "Live publishing is disabled / in … mode" when the mode is not `live` (`:60`).
4. The review is bound to a revision: `publicationDigest([facts.revision, prepared, mode])` (`:69`), stored on a `BulkOperation` in `PREVIEW` for 15 min (`:88-89`).
5. Submit rebuilds the review and refuses a changed revision (`:135-136`), takes an advisory lock per destination (`:144`), re-checks the mode (`:159`) and the facts (`:160`).
6. **Amazon = the WHOLE family.** One message per product (`studio-publication-amazon.ts:76-159`): `full_update` (UPDATE) for a new listing, else `partial_update` (PARTIAL_UPDATE) (`:92-93`), carrying offer, price, quantity, fulfillment, images, owned fields, mapped cells and content.
7. Amazon validates every message with `validateListing` (VALIDATION_PREVIEW) (`:169-174`), then sends ONE `JSON_LISTINGS_FEED` (`:176-183`).
8. The feed goes through the channel gateway, which applies the gate to listing writes (`services/gateway/gateway.ts:215-217`, `gateway/channels.ts:24-28`).
9. Amazon refuses the whole family when ANY product's offer is closed in that market (`studio-publication-amazon.ts:38`).
10. **eBay = the WHOLE item.** Trading `AddFixedPriceItem`, or `ReviseFixedPriceItem` when an ItemID exists (`studio-publication-ebay.ts:44, :242`); the XML carries title, description, category, specifics, pictures, policies and every included variation.
11. eBay compares the live `GetItem` digest to the review's before a revise (`:221, :228`); a new item runs `VerifyAdd…` first (`:232-237`).
12. eBay refuses Inventory-model listings (`:97`) and Amazon-fulfilled listings (`:110`).
13. **Shopify** reuses the native content sync: `previewContentSync` at review (`studio-publication.service.ts:51-57`), `synchronizeContent` at submit (`:171`).
14. Etsy and WooCommerce: "Direct publishing … is not available yet" (`:58`).
15. The web dialog refuses while an editor is unsaved (`apps/web/src/app/products/[id]/edit/_studio/workspaceSave.ts:22-28`).
16. **After a send, nothing records WHAT was sent.** The `BulkOperation` keeps the review and digest, not the payload (`:142, :155, :203-204`); no `ChannelPublishAttempt` row, no snapshot, no `lastSyncedAt`.
17. `ChannelListingSnapshot` exists, but only a manual route captures one (`routes/product-studio.routes.ts:995`); **production holds 0 rows** (measured).
18. `ChannelPublishAttempt` stores only a sha256 `payloadDigest`, not the payload (schema `ChannelPublishAttempt`).
19. `ChannelDrift` = the nightly content read: "ours" = what the builder would send NOW, not what was last sent (`services/channel-drift.service.ts:17-18, :39`).
20. Price and stock already travel alone: the price door (`channel-price-write.service.ts:15`) and the stock sync. They are change-only today.

---

## §1 The gate map (task B)

### 1a. The gates (read + measured)

| Channel | Settings (Railway `@nexus/api`) | Production (measured, boot log 2026-09-24 20:23:57 UTC, deploy `674bf97f`, still running) | Local `apps/api/.env` |
|---|---|---|---|
| Amazon | `NEXUS_ENABLE_AMAZON_PUBLISH` + `AMAZON_PUBLISH_MODE` (`services/amazon-publish-gate.service.ts:36-52`) | **live** | not set → `gated` |
| eBay | `NEXUS_ENABLE_EBAY_PUBLISH` + `EBAY_PUBLISH_MODE` (`services/ebay-publish-gate.service.ts:30-46`) | **live** | not set → `gated` |
| Shopify | `NEXUS_ENABLE_SHOPIFY_PUBLISH` + `SHOPIFY_PUBLISH_MODE` (`services/shopify-publish-gate.service.ts:26-36`) | **gated** | not set → `gated` |

The flag off → `gated`. The flag on + any mode text that is not `live`/`production`/`sandbox` → `dry-run` (default-safe). All 21 boots in the log read
(2026-09-21 21:36 → 2026-09-24 20:23 UTC) logged the same three values (`index.ts:1926`, Railway deploy logs).

### 1b. Automatic writers and the limits of the gates (read; sweep completed 2026-09-25)

**Correction to session 1:** one publish gate per channel governs the listing writes traced here, **not every channel write**.
The gateway tests publish mode only for `kind === 'write'` (`services/gateway/gateway.ts:215`).
Order/buyer actions, advertising and connection setup have separate controls below. No ungated automatic listing/content
sender was found in the traced Amazon SDK/feed, eBay Trading/Inventory or Shopify GraphQL paths.

Scope: API startup, crons, workers, their event/cascade producers and remote transports; also Shopify's editor-triggered setup.
Paths in this section start at `apps/api/src/` unless marked. Defaults below are **code reads, not measured production settings**.
The production measurements in this continuation are limited to the active deployment and worker-start logs. Existing queue/listing
counts remain the earlier measurements, not new reads. Amazon Ads is a separate channel with its own gate (see below).

**Shared startup:** `NEXUS_DISABLE_BACKGROUND_JOBS=1` disables the startup block; default permits it (`index.ts:968-979`).
This does not disable HTTP/webhook-triggered cascades. Crons can also be held by workspace scheduling controls. “ON” below means
registered by default when the shared startup block runs, not proof of eligible work or a successful send.

#### Common queue, event and scheduled producers

| Automatic path | Trigger / env flag / default | What it sends; gate; source |
|---|---|---|
| Database outbound drain | Every minute, no separate enable flag; starts before BullMQ opt-in | Due PENDING and eligible non-dead FAILED rows: price, stock, content, listing lifecycle. Amazon gate: `services/listing-publish.service.ts:93`, injected by `services/outbound-sync.service.ts:1358`; eBay Inventory/Trading gates `:1540, :1981`; Shopify live-only `:2199` (non-live → terminal SKIPPED). Startup `index.ts:474-489`; tick `workers/sync.worker.ts:60, :89-91`. |
| BullMQ outbound worker | `ENABLE_QUEUE_WORKERS=1`, default OFF; requires Redis config + successful initialization | Same dispatcher; competes with drain, which skips active BullMQ-owned rows. Delist branch `workers/bullmq-sync.worker.ts:191-213`; special variation branch `:359-362` → full Amazon parent/children payload via gated client (`services/variation-sync-processor.service.ts:115-138`). No current caller of the legacy variation producer was found; do not infer live variation traffic. |
| Stock movement / order / return / webhook cascade | On committed stock changes, no separate sender flag | Changed quantities for eligible following listings plus shared eBay fan-out; FBA/closed/paused/pinned controls checked. Queue uses destination channel's gate. `services/stock-movement.service.ts:613-649, :807-866, :929-950`. `NEXUS_SYNC_ORDERING_V2` controls coalescing, not write permission. |
| Shared-stock pool worker | `NEXUS_ENABLE_STOCK_POOL_WORKER !== '0'`, ON; first poll after 5s, then 2s busy / 10s quiet; also kicked after changes | Recomputes borrower stock → same quantity cascade. `index.ts:1575`; `services/stock-pool/pool-tasks.ts:95, :287-310`. |
| Listing end times | `NEXUS_ENABLE_LISTING_END_TIMES_CRON !== '0'`, ON; every minute | Expired quantity pin/pause and shared eBay exclusions resume following; quantity queue + channel gate. `index.ts:1582`; `jobs/listing-end-times.job.ts:19`; `services/listing-end-times.service.ts:78, :197`. |
| Reservation sweep / reconciliation | TTL sweep ON unless `NEXUS_ENABLE_RESERVATION_SWEEP_CRON=0`, schedule `NEXUS_RESERVATION_SWEEP_SCHEDULE` default `*/5 * * * *`; reconcile ON unless `NEXUS_RESERVATION_RECONCILE=0`, schedule `NEXUS_RESERVATION_RECONCILE_SCHEDULE` default `15 * * * *` | Local reserve/release/consume changes can feed pool/stock cascades. Remote sends use quantity dispatcher. `index.ts:1414-1417`; `jobs/reservation-sweep.job.ts:31, :52`; `jobs/reservation-reconcile.job.ts:15-29`; `services/reservation-reconcile.ts:104`; `services/stock-level.service.ts:347`. |
| FBA inventory ingestion | `NEXUS_ENABLE_AMAZON_INVENTORY_CRON=1`, OFF; `NEXUS_AMAZON_INVENTORY_CRON_SCHEDULE` default `*/15 * * * *` | Reads Amazon FBA stock, applies a local stock movement; resulting eligible cross-channel quantities use normal gated cascade. No direct eBay bypass. `index.ts:1390`; `jobs/amazon-inventory-sync.job.ts:35, :67`; `services/amazon-inventory.service.ts:232-240`. |
| Master price/status/content cascade | A reviewed master change, including one applied by a scheduler; no separate env flag | PRICE_UPDATE / STATUS_UPDATE / language-qualified CONTENT_UPDATE for following listings. Normal channel gates. `services/master-price.service.ts:263`; `master-status.service.ts:191`; `master-content.service.ts:144-150`. **Content can already send without clicking studio Publish.** |
| Scheduled product changes | `NEXUS_ENABLE_SCHEDULED_CHANGES !== '0'`, ON; `NEXUS_SCHEDULED_CHANGES_SCHEDULE` default every minute | Due price/status changes → master services above. `jobs/scheduled-changes.job.ts:57-97, :104, :182`. |
| Scheduled imports | Registered by default, every 5min; enabled due URL schedule with explicit `mapping.execution === 'automatic'` | Staged immutable review → automatic apply when valid; source content can use reviewed master-content cascade above. `jobs/scheduled-import.job.ts:84-91`; `services/scheduled-import.service.ts:201-228`; `services/pim/catalog-transfer-jobs.ts:242, :272, :295`; `catalog-transfer.service.ts:241`; `content-write.ts:47-48`. |
| Scheduled bulk actions / bulk automation | Scheduled bulk ON, boot catch-up + 60s; bulk-rule timer ON every 15min, no boot tick. Rules require enabled/acting posture; dry-run does not execute | Configured actions can change price/stock/content or submit channel batches. Normal dispatcher or gated batch adapters. `jobs/scheduled-bulk-action.job.ts:70-87, :144-151`; `jobs/bulk-automation-tick.job.ts:38-45`; `services/automation/bulk-ops-actions.ts:111-134, :180-204`; `services/bulk-action.service.ts:2395-2514`. BullMQ bulk-job worker shares `ENABLE_QUEUE_WORKERS`. |
| Snapshot repricer | `NEXUS_ENABLE_PRICING_CRON=1`, OFF; `NEXUS_REPRICER_LIVE=1`, OFF; `NEXUS_REPRICER_CRON` default every 30min | Changed resolved price → PRICE_UPDATE without interactive grace; destination channel gate. `index.ts:1154-1159`; `jobs/repricer.job.ts:45`; `services/repricer-scheduler.service.ts:76, :197-213`. Promotion scheduler changes local sale-price/snapshots; no independent remote sender (`promotion-scheduler.service.ts:109, :216`). |
| Rule repricing evaluator | Timer ON unless `NEXUS_ENABLE_REPRICING_EVALUATOR=0`; `NEXUS_REPRICING_EVALUATOR_SCHEDULE` default every 5min; real application requires `NEXUS_REPRICER_LIVE=1`, OFF | PRICE_UPDATE → destination channel gate. `jobs/repricing-evaluator.job.ts:74, :94, :193-221, :276-282`. |
| Scheduled wizard publication | `NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH=1`, OFF; every 60s, due PENDING rows | Whole composed listing/family: Amazon parent/child PUT; eBay Inventory item/offer/publish; Shopify draft native family. `jobs/scheduled-wizard-publish.job.ts:122-143, :322-346`; Amazon adapter gate `services/listing-wizard/amazon-publish.adapter.ts:191`; eBay `ebay-publish.adapter.ts:271`; Shopify `shopify-publish.adapter.ts:55` → gated content sync/Admin client. |
| Bulk eBay listing worker | `ENABLE_QUEUE_WORKERS=1` + Redis; queued `bulk-ebay-listing` job, `dryRun` defaults false | Full draft listing → Inventory adapter; common eBay gate. `workers/bulk-list.worker.ts:30-34, :123-125`; `services/ebay-publish.service.ts:55-74`; `services/marketplaces/ebay.service.ts:431`. |

The listing-automation evaluator can enqueue price/quantity/FULL_SYNC (`services/listing-automation/action-handlers.ts:117, :163, :277`),
but it is only in the **manual** cron registry (`jobs/cron-registry.ts:355`; registry purpose `:4-12`); no startup timer/caller was
found. Likewise `enqueueCascadeRepublish` is reached from a manual route (`routes/channel-publish.routes.ts:344`), not an automatic
image event hook. The old BullMQ `channel-sync` eBay/Shopify branches compose payloads without sending
(`services/marketplaces/ebay-sync.service.ts:139-165`; `workers/channel-sync.worker.ts:348-364`).

#### Automatic listing/content writers outside that queue

| Writer | Trigger / env flag / default | What it sends; gate; source |
|---|---|---|
| Amazon FBA flip guard | Every 10min; `NEXUS_ENABLE_FBA_FLIP_GUARD !== '0'`, ON; `NEXUS_FBA_AUTO_RESTORE !== '0'`, ON | Confirmed successful FBA→merchant quantity incident → restore PATCH of fulfillment to AMAZON_EU, **no quantity**. `jobs/fba-flip-guard.job.ts:23, :35-74, :94-96, :125`; `services/fba-restore.service.ts:112-133`; Amazon client gate `clients/amazon-sp-api.client.ts:466`. Header's “detection-only” claim is stale. |
| Amazon external FBA drift detector | ON unless `NEXUS_ENABLE_FBA_DRIFT_DETECTOR=0`; `NEXUS_FBA_DRIFT_CRON_SCHEDULE` default `0 5 * * *`; same default-ON auto-restore flag | Merchant report shows unexpected FBM → same gated restore for detected SKUs/markets. `jobs/fba-drift-detector.job.ts:28, :80-93, :110-115, :143`. |
| Amazon media worker | No own flag; immediate boot tick + every 30s | REVIEW_QUEUED validation; owner-approved READY image-root PATCH. Live-only client + gateway. `jobs/amazon-media.job.ts:9-22`; `services/images/amazon-media-publish.service.ts:99-104, :134-147`. UNKNOWN/stale dispatches are read back, never automatically resent. |
| Scheduled images (Amazon/eBay) | `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1`, OFF; every 60s, due PENDING schedules | Amazon image feed; exact mirror by default, `NEXUS_AMAZON_IMAGE_MIRROR_ENABLED=0` selects additive; common Amazon gate. eBay Inventory group send can include title/description/full rows, **not images alone**; common eBay gate; shells use Trading image revise. `jobs/scheduled-image-publish.job.ts:34-39, :68-92, :145-165`; `services/images/amazon-image-feed.service.ts:49-51, :307-310, :409`; `ebay-inventory-image-publish.service.ts:84, :97, :300-344`. Shopify image adapter refuses (`shopify-image-publish.service.ts:5-7`). |
| eBay label guard | `NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON=1/true`; unset defaults to `NEXUS_EBAY_REAL_API === 'true'`; `NEXUS_EBAY_LABEL_GUARD_SCHEDULE` default `15 */6 * * *` | GetItem then ItemID + parent SKU/custom label only if different. Trading real-API switch + eBay publish gate + listing controls. `jobs/ebay-label-guard.job.ts:37-46`; `services/ebay-label-guard.service.ts:186-222`; `services/ebay-trading-api.service.ts:333-347`. |
| Shopify linked-family automation | Registered by default, every 5min; no own env switch; each listing defaults PAUSED | MONITOR reads; AUTOMATIC writes non-null relationship/shared-field values, one verified batch (≤25) per tick. Saved native/media/gallery edits and removals need manual review. Admin-client live-only gate. `jobs/shopify-linked-automation.job.ts:17-32`; `services/shopify/linked-products.service.ts:20, :231, :298`; `linked-automation.service.ts:43-59`; `admin-client.ts:21`. |
| Shopify editor schema subscriptions | Page/path change with edit permission; no own flag | Creates missing subscriptions for three schema topics. Explicit Shopify live check, despite gateway setup classification. `apps/web/src/app/products/[id]/edit/_studio/shopify/useLiveShopifySchema.ts:43-51`; `services/shopify/schema-sync.service.ts:22-32`. |

Image-publish reconciliation starts after 30s and every 3min, but only reads feed/results; no feed replay
(`jobs/image-publish-reconcile.job.ts:44, :69, :117-135`). Shopify content webhooks mark remote changes rather than publishing
(`services/shopify/content-webhook.service.ts:3-19`). Quantity/content/image read-back jobs are not independent remote correction writers.

#### Writes outside all three listing publish gates

These exceptions are **read in code**. Their production flags and eligible backlogs were not measured; “default OFF” is not a claim
that production has them off. They are unrelated to retrying the dead outbound rows.

| Path | Trigger / switch / default | Remote action and gate boundary |
|---|---|---|
| eBay / Shopify shipment tracking | Pending tracking rows, often from Sendcloud SHIPPED (`routes/sendcloud-webhooks.routes.ts:401-427`); cron ON unless `NEXUS_ENABLE_TRACKING_PUSHBACK_CRON=0`; `NEXUS_TRACKING_PUSHBACK_SCHEDULE` default every 2min | Fulfillment/tracking, including Shopify customer notification. Each requires `NEXUS_ENABLE_EBAY_SHIP_CONFIRM === 'true'` / `NEXUS_ENABLE_SHOPIFY_SHIP_CONFIRM === 'true'`, OFF. `jobs/tracking-pushback.job.ts:171, :189, :321-325`; `services/ebay-pushback/index.ts:84-150`; `services/shopify/order-actions.service.ts:111-112`. Classified action, no listing gate. |
| Failed eBay / Shopify refund retry | `NEXUS_ENABLE_REFUND_RETRY=1`, OFF; `NEXUS_REFUND_RETRY_SCHEDULE` default `5 * * * *`; eligible CHANNEL_FAILED returns, stops after five attempts | eBay issue_refund has **no additional eBay refund-live flag** on this path; requires connection/auth/signature. Shopify requires `NEXUS_ENABLE_SHOPIFY_REFUND === 'true'`, OFF. Both action-classified, no listing gate. `jobs/refund-retry.job.ts:48-59`; `services/refunds/retry.service.ts:39-40, :80, :165`; `refund-publisher.service.ts:334-375, :523, :564`. Amazon refunds return manual-required, no remote send (`:472-504`). |
| Amazon automatic MCF for eBay orders | New eBay order ingestion; `NEXUS_EBAY_AUTO_MCF=1` and `AMAZON_MCF_LIVE=1`, both OFF; `AMAZON_MCF_SANDBOX=1` selects sandbox, otherwise production adapter | Fulfillment order with address/SKUs/quantities, only eligible FBA-backed eBay items. `services/ebay-orders.service.ts:740-749`; `ebay-auto-mcf.service.ts:24-63`; `amazon-mcf.service.ts:479-507, :549`. SP-API action, no listing gate. |
| Amazon review solicitation | Boot `NEXUS_ENABLE_REVIEW_INGEST=1`, OFF; mailer hourly (`NEXUS_REVIEW_MAILER_SCHEDULE`), pause state honored; real send `NEXUS_ENABLE_AMAZON_SOLICITATIONS === 'true'`, OFF | Product review/seller feedback request. `index.ts:1774-1785`; `jobs/review-request-mailer.job.ts:73-87, :312, :489`; `services/reviews/amazon-solicitations.service.ts:86-112`. SP-API action. |
| Amazon notification setup / repair | Boot requires `NEXUS_ENABLE_AMAZON_SQS_POLL=1`, OFF, and SQS config; nightly reconcile independently ON unless `NEXUS_ENABLE_AMAZON_NOTIFICATION_RECONCILE=0`, `NEXUS_AMAZON_NOTIFICATION_RECONCILE_SCHEDULE` default `40 3 * * *` | Creates destination/subscriptions, repairs wrong destination; a stored recycle directive deletes/recreates them. New types need `NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES === 'true'`, OFF. Setup-classified. `index.ts:1348`; `services/amazon-notifications-boot.service.ts:71-149, :253-261, :292-320, :340-368, :443-447`; `jobs/amazon-notification-reconcile.job.ts:41-43, :72-85`. |
| Amazon secret rotation | Every 10min only with `AMAZON_APP_CREDENTIAL_QUEUE_URL`; otherwise OFF; expiry/recency checks | Requests new application client secret, later consumes credential message. Setup-classified, no publish gate. `jobs/amazon-secret-rotation.job.ts:22-30`; `services/cx/amazon-secret-rotation.service.ts:232, :260-273`. |
| eBay signing-key create/renewal | Lazy on signed request if key missing or near expiry; no independent flag; can be triggered by a signed **read** such as financial sync (`NEXUS_ENABLE_EBAY_FINANCIAL_CRON=1`, OFF; daily 03:30) | Creates ED25519 signing key. Setup-classified; neither listing nor marketing write gate. `services/cx/connectors/ebay/client.ts:61-85`; `key-management.ts:152-154, :187-190`; `index.ts:1377-1381`; `jobs/ebay-financial-sync.job.ts:30`. No such connector read was executed in this audit. |
| eBay advertising automation | `NEXUS_ENABLE_EBAY_ADS_SYNC=1/0`, default ON in production; evaluator `NEXUS_EBAY_ADS_EVALUATE_SCHEDULE` default `45 5 * * *` | Rates, ad removal/reactivation, keyword pause/bid reduction. Requires `NEXUS_MARKETING_WRITES_EBAY=1` (OFF), active AUTO global posture and AUTOPILOT rule; SUGGEST does not send. Action-classified. `jobs/ebay-ads-sync.job.ts:23-27, :109`; `services/marketing/ebay-ads-automation.service.ts:184-188, :351-428, :443-447`; `marketing-write-gate.ts:49`. |
| eBay advertising report creation | Same ads-sync registration; `NEXUS_EBAY_ADS_REPORT_SCHEDULE` default `40 2 * * *`; active account + stored campaigns required | POST ad_report_task creates remote report work. No listing or marketing-mutation gate; quota gate only. `services/marketing/ebay-ads-reports.service.ts:192-200, :281, :330`; `ebay-ads-api.service.ts:166-185, :307-319`; marketing path classified action. |

eBay notification reconcile is opt-in `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1` (OFF; default 03:55), but **does not currently send**:
all desired topics are marked handlerMissing and it returns before HTTP (`jobs/ebay-notification-reconcile.job.ts:70-81`;
`services/cx/connectors/ebay/notifications.ts:82-99, :351-353`). If handlers are supplied later, the underlying operations classify as setup.

Amazon shipment confirmation is an exception to the exception: the same tracking cron requires
`NEXUS_ENABLE_AMAZON_SHIP_CONFIRM === 'true'` (OFF), but submits a fulfillment **feed**, so it also checks the Amazon publish gate
(`services/amazon-pushback/index.ts:87-124, :150-199`). Amazon Data Kiosk query creation is also classified as a write by its current
raw-path call and thus publish-gated: opt-in `NEXUS_ENABLE_DATA_KIOSK_CRON=1` (OFF), `NEXUS_DATA_KIOSK_CREATE_SCHEDULE` default 03:20
(`index.ts:1127`; `jobs/data-kiosk.job.ts:56`; `services/amazon/data-kiosk.service.ts:273`).
Named Amazon createReport calls classify as reads; they request report work, not catalog changes.

Transport proof: Amazon `services/gateway/amazon-sdk.ts:20-47, :72-101`, SDK construction `lib/amazon-sp-client.ts:143-160`, raw client
`clients/amazon-sp-api.client.ts:278-311`; eBay REST `services/gateway/ebay.ts:10-26`, Trading `services/ebay-trading-api.service.ts:306-347`;
Shopify `services/gateway/shopify.ts:9-40` and explicit Admin-client action exemption `services/shopify/admin-client.ts:18-21`.
Amazon createFeedDocument/createFeed remain gated; a presigned upload alone does not submit a feed.
The only raw Shopify GraphQL path outside Admin client found here is a heartbeat query
(`services/cx/connectors/shopify/spec.ts:73-80`). Amazon Ads uses its separate write-gate program
(`services/gateway/channels.ts:29-32`); the catalog publish switch does not open it.

#### Production worker and replay findings

**Measured in this continuation (Railway, read only):** active API deploy `674bf97f-fd44-438d-b662-7348a810ccba`, created
2026-09-24 20:15:22.925 UTC, SUCCESS and not stopped. Its logs show:
- 2026-09-24 20:23:55.111 UTC: `BullMQ Autopilot Worker Started`, queue `outbound-sync`, concurrency 5.
- 2026-09-24 20:23:55.112 UTC: all outbound-sync/channel-sync/bulk-list/bulk-job/read-cache workers started.

Commands: `railway status --json` (printed only service/deployment status); `railway logs --service @nexus/api --environment production
--lines 80 --filter '"BullMQ Autopilot Worker Started" OR "Queue workers started" OR "queue workers:"' --json`.
This proves startup in the still-active deployment; no Redis/job health probe or remote channel request was run.

**No automatic replay of the measured FAILED + dead outbound rows found.** Retry query filters `isDead:false`
(`services/outbound-sync.service.ts:973-981`); BullMQ skips any row whose status is not PENDING
(`workers/bullmq-sync.worker.ts:174-180`). Janitor ON unless `NEXUS_QUEUE_JANITOR=0`, schedule
`NEXUS_QUEUE_JANITOR_SCHEDULE` default every 15min: stale IN_PROGRESS → PENDING, ancient PENDING → CANCELLED, terminal FAILED → dead;
it never clears a dead FAILED row (`jobs/outbound-queue-janitor.job.ts:59-107, :117-137`).
Explicit retries clear dead status in `routes/outbound-queue.routes.ts:139-156, :228-249` and
`services/pim/matrix-write.service.ts:294-303`. None was invoked.

Limit: the normal PENDING drain query and BullMQ status check do **not** independently exclude `isDead:true`
(`outbound-sync.service.ts:891-896`). The safety conclusion uses the measured invariant that all 2,199 dead rows are FAILED;
do not generalize it to a malformed future PENDING + dead row. The older Phase9 helper has its own explicit exclusion
(`outbound-sync-phase9.service.ts:42`), but is not the active drain.

Separate durable queues differ: Shopify automatic-origin unfinished operations can continue on a later tick, including ERROR,
while manual operations cannot (`shopify/linked-automation.service.ts:43-59`). Refund retry handles CHANNEL_FAILED returns.
Tracking failures become FAILED, yet its sweep selects only PENDING (`jobs/tracking-pushback.job.ts:255, :292`); only stale
IN_FLIGHT is reset automatically (`:94-96`). Do not claim its failed/dead rows automatically retry.

#### What opening Shopify permits

With the earlier measured **0 Shopify listings and 0 outbound rows**, there is no measured listing queue backlog to release.
After linking, opening the gate permits:
- new stock/price/content queue work, including reviewed master-content cascades;
- linked-family automation on the next 5min tick **only for listings explicitly set to AUTOMATIC**, including its saved unfinished work;
- configured scheduled wizard/bulk jobs, if their separate switches/schedules and prerequisites allow them;
- missing schema-subscription creation when an editable Shopify page opens.

Opening the gate does not turn PAUSED/MONITOR into AUTOMATIC. Tracking/refunds already use separate switches and are unaffected.
Scheduled Shopify image and delist adapters refuse today (`services/images/shopify-image-publish.service.ts:5-7`;
`services/channel-delist.service.ts:263-274`). Re-read work queues and automation settings **after linking and before opening**;
today's zero counts are not a forecast for that future day.

**Audit closure:** Done when = automatic entry points, payloads, switches, gate exceptions and replay behavior traced with file:line,
plus production BullMQ startup verified; achieved. Cost when = a missing runtime flag/backlog would require additional production
inspection; those are explicitly unmeasured, and no activation is proposed now. Gate = source/log reads only, no builds/tests/channel
writes, Owner still rules on Q1/Q2. Rollback = remove this documentation amendment only; no runtime state changed.


### 1c. Proof that Amazon and eBay write live today (measured, `ChannelPublishAttempt`, last 14 days)

| Channel | Mode | Outcome | Rows | First → last (UTC) |
|---|---|---|---|---|
| Amazon | live | success | 12 | 09-14 15:34 → 09-23 14:23 |
| eBay | live | success | 575 | 09-16 08:15 → 09-24 12:30 |
| eBay | live | failed | 11 | 09-18 05:15 → 09-23 05:15 |

Studio Publish in production, ever (measured, `BulkOperation` kind `studio-publication`): **one** send — Amazon · IT, 21 products,
2026-09-14 20:29 UTC, `ACCEPTED` (feed `123797020710`), plus one unsent `PREVIEW`. No eBay or Shopify studio send ever.

---

## §2 The queue — what would fire when a gate opens (measured)

`OutboundSyncQueue`: 33,916 rows. **FAILED 2,199 — all `isDead = true`.** The drain's retry lane takes only `isDead = false`
(`outbound-sync.service.ts:973-981`), so **these FAILED + dead rows are not automatically retried**. The PENDING consumer lacks an independent dead filter; see §1b. Rows the drain would pick now: **0**
(the one `PENDING` row is an ads bid, owned by the ads worker and its own gate). **Shopify: 0 rows in the queue.**

| Group | Rows | When | Why they died (measured) | Recommendation |
|---|---|---|---|---|
| G1 eBay `PRICE_UPDATE` | 1,727 | 07-06 → 07-19 | 1,710 × `get offers 404 … Questa Proposta non è disponibile` (Inventory offers that no longer exist) | **Keep** (history). Prices changed since; the price door sends the current price. |
| G2 eBay `QUANTITY_UPDATE` | 464 | 07-06 → 07-26 | max retries, validation, debounce, listing ended | **Keep.** The eBay stock sync runs every day now (SUCCESS 09-16 → 09-24). |
| G3 eBay `CONTENT_UPDATE` | 7 | 09-01 → 09-02 | "refusing content PUT built from an empty read", validation | **Keep.** Content goes through the new Publish. |
| G4 Amazon `AD_BID_UPDATE` | 1 dead + 1 pending | 07-02, 09-15 | ads lane | **Not ours** — ads have their own gate. |

A retry would need an explicit act. Say a group name only if you want one retried.
Tool: `tools/gate-queue-probe.mjs` · record: `records/2026-09-25-gate-queue-probe.json`.

---

## §3 The other blocks (read + measured, production)

| Block | Where | How many (measured) | What it means |
|---|---|---|---|
| eBay Inventory-model listing | `studio-publication-ebay.ts:97` | **208 listings, 8 families, all ACTIVE** (Trading: 124 listings, 32 families) | 63 % of eBay listings cannot be published from the studio. Needs an Inventory adapter (a later step, not in this plan). |
| Amazon offer closed (SCT.6) | `studio-publication-amazon.ts:38` | DE 178 listings / 11 families · ES 93 / 7 · FR 79 / 6 | One closed product refuses the WHOLE family in that market. The change-only design skips closed products instead (§4.5). |
| Amazon-fulfilled eBay | `studio-publication-ebay.ts:110` | 0 | none today |
| Etsy / WooCommerce, no adapter | `studio-publication.service.ts:58` | Etsy: 1 connection (Motovento); WooCommerce: 0 | Out of scope. |
| Shopify | gate `gated`; `content-sync.service.ts:44, :163-165` | 1 connected store; **0 Nexus Shopify listings** | You link first. Unlinked, a Publish creates a NEW draft product (inferred from the code). |
| `products.publish` | `permissions-manifest.ts:204` | OWNER (implicit-all, 2 members); ADMIN + OPS_MANAGER templates have it, 0 members | not a block for you |
| Unsaved editor | `workspaceSave.ts:22-28` | by design | not a block |
| eBay currency | `ebay-shared-listing-push.service.ts:36` (A-41) | IT resolves EUR | not a block today |

Tool: `tools/blocks-probe.mjs` · record: `records/2026-09-25-blocks-probe.json`.

---

## §4 Task A — the design

### 4.1 What Publish sends today (measured locally, rolled back, network blocked)

Family `xavia-knee-slider`, Amazon · IT, FBM. Tool `tools/payload-diff.mts`, record `records/2026-09-25-payload-diff-xavia-knee-slider.json`.

| | Messages | Operation | Attribute roots | Bytes |
|---|---|---|---|---|
| Before | 9 | PARTIAL_UPDATE | 69 (5–8 per message) | 8,582 |
| After `part_number` changed on ONE child | 9 | PARTIAL_UPDATE | 70 | 8,662 |
| **Change-only** | **1** | — | **1** (`part_number`) | **206 (2.4 %)** |

Predictions: D1 (≥ 10 roots per child) **wrong** — 5–8; D2 (1 message, 1 root differs) right; D3 (< 10 %) right.
`rolledBack: true`, `networkAttempts: []`. The earlier M1 run (product-cheat `step-3.2-m1-m2`) agrees: 9 messages, the probe in 1.

### 4.2 Baselines that exist today (measured)

| Candidate | Production today | Good for |
|---|---|---|
| What Nexus SENT (`ChannelListingSnapshot`) | **0 rows**. The 09-14 send stored no payload. | nothing yet — must be captured from now on |
| What the channel HOLDS (`ChannelDrift`, nightly) | Amazon content: DE 57 read (45 differ) · IT 90 read (0 differ) · ES/FR 0 read; one run, 2026-09-24 18:40. **eBay content: 0 read** — the 231 eBay rows are the STOCK read-back (source `ebay-trading-getitem`, `services/ebay-inventory-readback.service.ts:523`); the eBay content source compared none (8 Inventory-model refusals, 4 × the A-56 bug fixed 09-24 20:15, 2 shells) | a hint only: it skips fields (avg **38.5** not compared per DE listing, 16.9 IT), covers a part of the listings, and is up to a day old |
| Flat-file row (`ChannelListing.flatFileSnapshot`) | Amazon 346 of 725, eBay 327 of 332 | not a send record (what the flat file pulled or edited) |

The 45 differences by field (measured): `item_name` 45 (word order: "(S, Gelb)" vs "(Gelb, S)"), `brand` 32, `size` 13,
`supplier_declared_has_product_identifier_exemption` 13 (Amazon holds nothing; Nexus would add), `fabric_type` 13
("Polyester" vs Amazon's "100% Polyester" — a Publish would make it worse). Families: xracing 29 (all DE offers closed),
GALE-JACKET 13 (0 closed — **exposed**), xavia-knee-slider 3 (all closed).

Exposure = listings a Publish can reach (offer not closed), measured (`tools/exposure-probe.mjs` → `records/2026-09-25-exposure-probe.json`):

| Channel · market | Listings | Open | Content read | Read and differ | Not read (unknown) |
|---|---|---|---|---|---|
| Amazon · DE | 214 | 36 | 13 | **13** | 23 |
| Amazon · ES | 123 | 30 | 0 | 0 | 30 |
| Amazon · FR | 115 | 36 | 0 | 0 | 36 |
| Amazon · IT | 273 | 273 | 90 | 0 | 183 |
| eBay · IT | 332 | 332 | 0 | 0 | 332 |

Prediction written first: IT mostly unread, DE open 36, eBay 0 compared — right on all three.

### 4.3 "Changed since WHAT?" — recommendation: option 3 (combination)

- **Send** = the fields where Nexus now ≠ **the last send the channel ACCEPTED** for that listing (option 1).
- **Show** = the fields where **the channel now** ≠ that last send (someone edited in Seller Central / eBay), from a live read at review
  time (option 2). They are listed, **not sent** unless you tick them.
- **No baseline yet** (every listing today): compare Nexus with the live channel read. Fields that differ are listed as
  "Differs on Amazon — no publish record yet", **not ticked**. Nothing is overwritten without your tick. A field the read cannot
  compare is shown as "Cannot compare" — never hidden as "no change".
- Why not option 1 alone: with 0 baselines, the first Publish of every listing would send everything — the same as today — and
  overwrite GALE-JACKET · DE. Why not option 2 alone: it is not "what I changed"; every listing Amazon echoes differently would be
  re-sent forever.

### 4.4 The change-only payload per channel

- **Price and quantity stay out** of Publish for an existing listing. They have their own change-only doors (price door, stock sync).
  This also avoids the Amazon sale-price wipe on `purchasable_offer` (product-cheat review). A NEW listing still sends its offer.
- **Amazon:** one message per CHANGED SKU only; `operationType: PATCH` with `replace` per changed root and `delete` per cleared root.
  Unchanged SKUs send nothing. A new SKU keeps `UPDATE` (full). `validateListing` (VALIDATION_PREVIEW) stays on every message.
  Reuse, not new: PATCH feed messages and a per-root `replace`/`delete` builder already exist (`services/amazon/mapping-payload.ts:71-75`,
  `amazonRootPatch`; `services/channel-batch/amazon-batch-feed.service.ts:190`), and the studio validation already passes `patches`
  (`studio-publication-amazon.ts:171`) (read).
- **eBay:** `ReviseFixedPriceItem` with only the changed parts: Title, Description, ItemSpecifics (the whole set when one changes),
  PictureDetails (whole set), and only the changed Variations by SKU. Price and quantity stay with `ReviseInventoryStatus`.
  Narrow Trading revises already work in this code base (description only `ebay-description-push.service.ts:59`, pictures only
  `images/ebay-shared-image-publish.service.ts:208`, added variations `ebay-variation-add.service.ts:65-90`). The live-digest check stays.
- **Shopify:** stays gated until you link. Later: the native sync already works per product with local/remote revisions.

### 4.5 The edge cases

- **One child changed:** one message (Amazon) / one Variation (eBay). Measured case §4.1.
- **A field cleared in Nexus:** Amazon `delete` patch; eBay: the part is sent empty only where eBay allows it, else refused by name.
- **Images, variation theme, parent/child:** each is an attribute root / Trading part like any other. A variation-theme change on a live
  family is listed with a warning.
- **Closed Amazon offer:** the closed product is **skipped and named** ("offer closed — not sent"); the others go. Today the whole family is refused.
- **The revision binding stays:** the review digest also covers the change set and the channel read; submit re-reads and refuses a change.
- **Traceable:** every send writes, per listing, the exact fields sent (snapshot, reason `publish`, `publishEventId` = the review id),
  marked accepted only when the channel says so (Amazon processing report per SKU; eBay Ack + active read; Shopify verified), plus a
  `ChannelPublishAttempt` row.

### 4.6 The review screen (design system)

`PublishDialog.tsx` (DS `Modal`, `Banner`, `Field`, `ProgressBar`) gains a per-product, per-field list: field · Nexus now · last sent ·
channel now · a tick for "differs" rows, and counts ("2 fields in 1 product will be sent · 8 products unchanged, not sent"). The design
system has no before/after list (checked: `components/`, `patterns/`) → a new DS component (catalog, CHANGELOG web + factory, barrel,
`.claude/DS-GAPS.md`), 7:1 contrast, keyboard, light/dark, 390 px.

---

## §5 Opening order and the first live sends

1. **Amazon · IT** first: 0 differences among the 90 listings read (183 not read yet); the write path proven live on 2026-09-23 (product-cheat A-35).
2. **eBay · IT Trading** families (32): content never read — the first review's live read is the first comparison.
3. **Amazon · DE** after change-only (GALE-JACKET's 13 shown field by field). ES/FR: mostly closed offers.
4. **Shopify** after you link products and listings; then the gate opens on your word (Railway: `NEXUS_ENABLE_SHOPIFY_PUBLISH=true`,
   `SHOPIFY_PUBLISH_MODE=live`, then a redeploy). Opening it permits the listing writers in §1b; order actions keep separate switches.
5. Every first send per channel: ONE listing, on your word in the chat: read → preview → write → read back → restore → delayed re-read.

---

## §6 Build steps (Q1(a), Q2(a) approved; each with its closure fields)

| Step | What | Done when | Cost when | Gate | Rollback |
|---|---|---|---|---|---|
| PCO-0 | Interim studio Publish warning (Q2a): known content differences per product, unread/cannot-compare products, explicit confirmation bound to the review | review shows differences and unknowns honestly; submit cannot bypass confirmation | a source cannot distinguish content reads from stock reads | red-first API/UI tests + mutations; fresh types; DS/browser checks | revert the warning commit; existing whole-family behavior remains |
| PCO-1 | Send record: additive migration (snapshot `outcome` + `acceptedAt`), capture on every studio send, mark accepted from the channel result | a send writes one row per listing with the exact fields; accepted only on the channel's word | more than one migration, or a change to the send path beyond capture | new tests + mutations; fresh `tsc`; `generate-baseline.mjs` | revert the commit; the column stays (additive, unused) |
| PCO-2 | Change-set engine (pure): Nexus now vs last sent vs channel now → per field SEND / DIFFERS / CANNOT COMPARE / SAME; the comparators are the content-drift job's own (`services/channel-drift/amazon-content-compare.ts` `compareAmazonContent` / `compareAmazonAttributes`, `ebay-content-compare.ts` `compareEbayContent`; used at `jobs/content-drift.job.ts:111-113`), not a second copy | table tests for every case in §4.5 | the drift comparator cannot be shared | red-first tests, mutations | revert |
| PCO-3 | Live channel read at review (Amazon `getListingsItem` per SKU, eBay `GetItem` per item) + honest "could not read" | a failed read shows "Cannot compare", never "no change" | > 10 s for a 21-SKU family | tests on stubbed clients; one local read | revert |
| PCO-4 | Amazon change-only feed (PATCH messages, changed SKUs only, closed skipped) | the §4.1 case sends 1 message with 1 root | Amazon refuses PATCH in a feed (then: per-SKU Listings PATCH) | parity gate with the queue builder (A-33); `payload-diff.mts` again | revert; whole-family path returns |
| PCO-5 | eBay change-only revise | one changed specific → a revise with ItemSpecifics only | eBay needs the whole item for a part | tests on the XML; live proof PCO-7 | revert |
| PCO-6 | Review screen + new DS component + factory mirror | the list matches the payload 1:1 (the preview is the truth) | a shared DS file held by another lane | web tests, browser check light/dark/390 px, 7:1 hook 0/0 | revert |
| PCO-7 | First live proofs, one listing per channel, on your word | read → preview → write → read back → restore → delayed re-read, recorded | any mismatch | your word per run | restore step inside the run |

One commit per step group (`git commit --only`), pushes on your word, API tests from `apps/api` only.

---

## §7 Tests and proof

Every test red first on the old code, then green; mutations with the Python harness (per-file backups, sha256 restore, a green
control first, anchors asserted once); a positive control for every "nothing changed" claim (a zero-change run cannot test the
write — flip one field). Real-database arms on `formulaDatabase()`.

---

## §8 OWNER RULING — Q1(a), Q2(a), 2026-09-25

Owner said **“go”** after both recommendations were presented; proceed with (a) on both questions.
**R-PCO-2:** Owner subsequently said **“okay, then continue and push to production when it's all done”**.
Step commits and final production push are authorized. Apply the recommended strict eBay boundary: refuse existing-variation
content revisions that require resending price/quantity; narrow item and gallery updates remain supported.
The eBay contract requires StartPrice/VariationSpecifics and removes SKU/zeros quantity when omitted:
[official VariationsType](https://developer.ebay.com/devzone/xml/docs/reference/ebay/types/VariationsType.html).
This amends §4.4/4.5/PCO-5's promise to send one changed Variation without price/quantity. Refuse these changes by name;
never silently omit a requested change or reset stock. Live channel proofs still require the per-run word after read + preview.
The interim warning covers studio Publish only; the existing automatic writers in §1b continue under their current controls.
Shopify remains gated until linking and a separate opening instruction. Live channel proof still needs the Owner's word per run.
R-PCO-2 supplies the Owner's word for commits and final push/deployment; each live channel proof remains separately scoped.

**Q1 — What counts as "changed"?**
- **(a) Recommended:** what changed in Nexus since the last send the channel accepted. The first time for each listing, Nexus compares
  with a live channel read; fields that differ are listed but NOT sent unless you tick them.
- (b) Only "since the last send". Simpler, but no listing has a record yet, so the first Publish of each listing sends everything
  (like today) and overwrites GALE-JACKET · Amazon DE and any listing whose channel values were never read.

**Q2 — Amazon and eBay Publish are already live. What until change-only ships?**
- **(a) Recommended:** a small first step: the review lists, per product, the known channel differences (from `ChannelDrift`) and
  names the products the nightly read has not reached ("not read yet — unknown"), and asks you to confirm. Then you can publish
  now and see the risk before you send.
- (b) Change nothing now. Publish only where you accept a full overwrite; do not publish GALE-JACKET on Amazon DE until change-only ships.

The queue (§2): default **keep all four groups as they are** — nothing fires. Shopify: stays off until you link.

---

## Tools and records (all in this folder)

- `tools/gate-queue-probe.mjs` (production, read only) → `records/2026-09-25-gate-queue-probe.json` (+ `-local`)
- `tools/blocks-probe.mjs` (production, read only) → `records/2026-09-25-blocks-probe.json` (+ `-local`)
- `tools/payload-diff.mts` (local, rolled back, no network) → `records/2026-09-25-payload-diff-xavia-knee-slider.json`
- `tools/exposure-probe.mjs` (production, read only) → `records/2026-09-25-exposure-probe.json`
