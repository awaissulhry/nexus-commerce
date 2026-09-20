# Channel connections — progress and handover

Updated **2026-09-20**. **P0, P1, P2, ALL of P3, P5.1 and ALL of P4.1 are
built** (slices a–e; `build/P4.1e.md` §6 has the row-by-row table). P5.3 is
measured. Next is **P4.2 (images)**, then P4.3 / P4.4 / P4.5.

🔴 **Four of P4.1's seven rows were COUNTERWEIGHTS** — already built, or built
better than the row described. The real defects were not the gaps the plan
named: they were **failure paths and drifts inside work that already existed**.
Measure the row before building it.

**Standing instruction from the Owner (2026-09-20):** *implement the whole plan in
order, without stopping, unless I specifically ask you to stop.* Recommendations are
accepted by default — take the pick and carry on. Do not pause between packages for
approval; commit, push and move to the next one.

**The rules that still bind:** ask first for a production **write**, a **live channel
call**, or a **P7 drop**. A blanket "implement the plan" does not lift those.

**🔴 The flat-file no-touch rule is LIFTED (Owner, 2026-09-20):** *"we recently had a
flat file no-touch rule, which is no longer valid… because we're rebuilding the flat
file as well. If there's any work related to that, please do not hesitate."* The
flat-file routes and pages are now ordinary files. P3.2 was the first package to need
it — the Amazon feed path lives inside the flat-file service, and that is where 140 real
rejections were stranded.

Read in this order:

1. `docs/channel-connections/FINAL-PLAN.md` — the one plan. Section 6 has the package rows; section 14 has the rules (14.1), the progress table (14.2) and the Owner's decisions (14.3).
2. This file — where work stopped, what is next, and the traps that cost time.
3. The build record of the package you touch: `docs/channel-connections/build/<ID>.md`.

---

## 1. Rules from the Owner (in force)

- "Start to implement the whole plan. I'll stop you where we need it." → packages run **in plan order**, no per-package "go". Commit each package when its proof is green.
- **Ask first** for: any production **write**, any **live channel call**, each P7 drop, and the Owner-only steps in plan section 8. Production **reads** (Railway traffic and logs) are allowed since 2026-09-20.
- **Pushing is allowed** (Owner, 2026-09-20) once the package's proof is green. A push deploys to production and **applies migrations there**.
- ~~Flat-file routes need a yes per change~~ — **LIFTED 2026-09-20.** The flat file is
  being rebuilt, so `apps/api/src/routes/{ebay,amazon}-flat-file.routes.ts` and
  `apps/web/src/app/products/*-flat-file/**` are ordinary files. No edit list, no ask.
- Never `--no-verify`. **Never lower a ratchet baseline to make it pass.** **Never weaken a test to make it pass** — if a test proves a real defect, fix the code (that is how the P1.3 per-row read was caught).
- Migrations: apply to the **local** database only (check the host is `127.0.0.1` first); production gets them from the deploy.
- Other sessions share this tree. `git status` first. Do not touch their files: the assortment files, `.githooks/post-commit`, `.githooks/pre-push.backup`, `docs/channel-connections/PLAN.md`, `RESEARCH.md`, `full/`, `apps/web/src/app/settings/sharing/`.
- Reports to the Owner: simple English, short sentences, **max 2 options with a pick**.

## 2. Done — on `origin/main`

**P0 – P3.6 are all deployed and live.** The newest is deployment `92ec6158` from
`22eafb4bf`: SUCCESS, `Applying migration 20260920e_p36_trace_id`, both crons scheduled.

| Package | What | Commits | Record |
|---|---|---|---|
| P0.1 – P0.8 | Safety: every dry-run / sandbox path that wrote live is closed, monitoring routes authed, operator webhooks, signed eBay refunds, secret-expiry alert, notifications per profile, wrong-account guard, deadlines | `8fcd1d500` … `ab92ed828` | `build/P0.*.md` |
| P6.1, P6.3, P6.5 | Automatic Amazon secret rotation (**off** until the Owner registers the queue), Etsy refresh-token save, per-profile heartbeat | `a7ad73294`, `6e9db49a6`, `6a243db24` | `build/P6.*.md` |
| P1.1 – P1.2 | One outgoing gateway + its ratchet: **0 channel sends outside it** (47 exempt, each with a written reason) | `aadbfc374` … `e8c84b0d0` | `build/P1.1.md`, `build/P1.2.md` |
| P1.3 | Every queue row carries its destination account; 2 per account at a time; one creation helper for all sites | `7eaf48d59`, `eaa8f5856` | `build/P1.3.md` |
| P1.4 | Shopify on the 2026-07 GraphQL client with the row's / order's / listing's own account; order actions; the gateway refuses any other Shopify change | `842841031`, `86d128291`, `2a0493c6b`, `bc9baf734`, `836c66f15` | `build/P1.4.md` |
| P1.5 | eBay market headers from the Marketplace row (`EBAY_IT` → `it-IT`) | `b2af8d68b` | `build/P1.5.md` |
| P1.6 | 26 files of dead channel code deleted (groups A, B, C); the eBay feed lane is no longer chosen by row count | `7f2d43422`, `8666b9d29`, `96ed9c65c`, `cb1677123` | `build/P1.6-delete-list.md` |
| P1.7 | Validate before send: Amazon previews every content write, eBay verifies before every Add, the push lock refuses an ENDED listing | `04166df5d`, `ee9fe18ea`, `986b2862e`, `4158ff87c` | `build/P1.7.md` |
| P1.8 | Nightly sandbox contract run — **off** until the Owner turns it on | `314916688` | `build/P1.8.md` |
| P1.3 follow-up | The claim check reads once per chunk, not once per row (found by the profiles-ON gate: a real defect) | `e124f24ac` | section 6 below |
| P2.1 | The inbound ledger retries, dead-letters and replays. Shopify reaches the ledger for the first time; eBay rejects recorded in production; one replay registry | `c8265b1dc` | `build/P2.1.md` |
| P2.2 | Amazon's order-change parse read one level too high — `fulfillmentType` was `'MFN'` on **1413/1413** real payloads when the truth was AFN 1071. Per-type payload versions + destination support; nightly reconcile | `09c757a91` | `build/P2.2.md` |
| P2.3 | eBay had **no destination and no subscription** — no genuine eBay notification had ever arrived. `MARKETPLACE_ACCOUNT_DELETION` was answered **503**. Trading setup retired | `c4f5ef93d` | `build/P2.3.md` |
| P2.4 | Shopify's webhooks: production has **no `SHOPIFY_*` variable**, so every one was answered **400** before its signature was read. Registration by GraphQL per shop; 5 lifecycle/privacy topics | `9bc6485d9` | `build/P2.4.md` |
| P2.5 | Etsy: **no order had ever entered Nexus by any route**. Standard-Webhooks verifier, receipts pull, receiver on the ledger | `8a67adc23` | `build/P2.5.md` |
| P2.6 | Account lifecycle. Most of it already worked; two signals went round the state machine — one of them written by P2.4 | `328339997` | `build/P2.6.md` |
| P2.7 | AMS hourly writes **increment** and nothing deduped, while SQS is at-least-once — a redelivery silently added the same spend again. Nightly subscription check | `ffdb2494b` | `build/P2.7.md` |
| P2.8 | **P2 complete.** The API exposed none of the lifecycle, so a dead letter looked identical to a retry. Ingress tab on the design system | `8a1853b94` | `build/P2.8.md` |
| P3.1 | The error vocabulary had no test at all. **161 of 201 real failed bodies are double-encoded** and lost their error code entirely. `attribute` + `severity` added; a mapping table per connector | `2f4f9d3bd` | `build/P3.1.md` |
| P3.6 | **P3 complete.** No target level existed anywhere, and the trace followed a **RUN not a change** — one cron tick id covers **1,243 calls**, and the change's id died at the queue (no id column). `traceId` beside `requestId`; a Health tab where `no_data` is never a pass | `22eafb4bf` | `build/P3.6.md` |
| P3.5 | **Nothing read `Deprecation` / `Sunset` / Shopify's header** — 0 occurrences, with a positive control. Read on the SUCCESS path; `Deprecation`'s date is never shown as the shutdown date; a MOVED sunset date is news | `b36fe4c80`, `ad0a45c04` | `build/P3.5.md` |
| P3.4 | The alert path reached **nobody**: the in-app channel is a `console.log` stub and the email channel is off in production, so P0.5's secret-expiry alerts went to a log line. Five alert kinds moved onto `Notification` + the bell (391,197 rows, ads-only until now) | `d8923283c` | `build/P3.4.md` |
| P3.3 | The call ledger could not be asked about an **account** — every other identifier was filterable, `connectionId` was not — and the Diagnostics tab had never shown an outgoing call. One shared service so both screens read the same numbers | `1cff6e219` | `build/P3.3.md` |
| P4.2b | **An eBay offer rejection reaches its listing.** The decision first: `pushVariationGroup`'s 12 result sites mix eBay's verdicts with OUR validation, and P3.2's contract says *"in the channel's words"* — so 4 file, 8 do not, derived in the test. Retryable answers dropped (the file already retries those ids itself); the answer is CLASSIFIED, not pasted. Covers the flat-file push too | `<this push>` | `build/P4.2b.md` |
| P4.2a | **An Amazon image rejection reaches its listing.** 🔴 NO image publish on ANY channel filed an issue; the feed already built a per-SKU receipt with Amazon's codes and stored it for a drill-down screen nobody opens. Filed as a MERGE source (an image feed must not close a content rejection), with Amazon's attributeNames re-indexed from the raw report — without them distinct rejections on one SKU collapse to one row | `<this push>` | `build/P4.2a.md` |
| P4.1e | **eBay's Inventory/Trading split — keep it, never GUESS it.** The split is deterministic (Incident #23 replaced a heuristic that "misrouted Trading primaries"). 🔴 But its prefetch `catch` said "shared flag decides alone" — so a database hiccup routed an Inventory-managed family down the Trading lane, the exact misrouting #23 exists to stop. Refused per family now | `<this push>` | `build/P4.1e.md` |
| P4.1d | **eBay business policies — one reconciliation, both builders.** Per ACCOUNT was already right (P0.7's guard + the connection's own metadata). 🔴 Per MARKET had a DRIFT: on an unavailable account snapshot the group publisher REFUSED (FFP.12, learned from an incident) while the single-SKU publisher WARNED and wrote the unverified ids — the exact behaviour FFP.12 exists to prevent. Three copies of one rule across two files, now one accessor + a parity gate | `<this push>` | `build/P4.1d.md` |
| P4.1c | **The description engine in every builder — it already was.** A counterweight: 7 render call sites across BOTH channel models. But the rule lived in the CALLERS: `pushVariationGroup` fell back to the RAW body when its parent content was omitted, dead only until a third caller. Now required at compile time and refused at run time. 🔴 The refusal was placed FIRST and masked the publish mode, the push lock, the presentation lock and the review gate — **14 existing tests caught it** | `<this push>` | `build/P4.1c.md` |
| P4.1b | **An Amazon single-item rejection reaches its listing.** 🔴 The handover said `putListingsItem` was "0 occurrences"; it is **28** — the 0 is true only of the SDK operation STRING while a real client method with a live call site sat beside it, parsing Amazon's `issues`, logging them and filing nothing. An accepted write files an EMPTY set on purpose, because `listings-api` REPLACES and that is what CLOSES a fixed listing's stale rejection | `<this push>` | `build/P4.1b.md` |
| P4.1a | **Every eBay Trading rejection reaches its listing.** 🔴 The handover said "two callers"; a derived census says **14 write sites across 12 files, 0 passing a listing** — and one of the two files it named makes no Trading call at all. Resolved centrally from the `<ItemID>` + the account, so a fifteenth caller cannot forget it. A shared eBay item is MANY listings and all are filed | `<this push>` | `build/P4.1a.md` |
| P5.1 | **Amazon Orders v0 → 2026-01-01, switch OFF.** The plan's own instruction is nearly a no-op: `version_fallback` sends 9 of 11 operations back to v0 **silently**, and the version must sit in `options.version` or it is ignored. 🔴 Amazon's own example proves the money trap — `unitPrice` is PER UNIT (49.99) while v0's `ItemPrice` is the LINE total (99.98 at qty 2) and the ingest DIVIDES by quantity | `<this push>` | `build/P5.1.md` |
| P3.2 | `ListingIssue` held **0 rows**; 25 stored feed jobs held **140 real Amazon rejections on 48 SKUs**; `OutboundApiCallLog.listingId` was filled on **0 of 469,462** calls. The attribute was lost on **140/140**, which would have collapsed them to 60 rows and dropped 80 | `c86c20424` | `build/P3.2.md` |

**Production proofs.** P4.1d deploy `68ab8a33` from `f356688ad`: **SUCCESS** (P4.1b and
P4.1c are inside the deploys between it and P4.1a). P4.1e deploy `ff4a5d94` from
`2f9fbd661`: **SUCCESS** — all of P4.1 is live. Earlier: P4.1a deploy `09b971c9` from `11cb9d31d`: **SUCCESS**. Nothing to
switch on — the change only fills a value the code already accepted — so the proof is
that the app boots and nothing changed. ⚠️ **Neither P4.1 slice can be proven by real
traffic yet:** both are WRITE paths, eBay's last real traffic is a test artefact (§4's
honest denominator), and Amazon is not connected at all (below). The done-when for each
is one real rejection appearing on its listing. Earlier: P5.1 deploy `470f20fd` from `d3f1228dc`: **SUCCESS**, the app
booted and every cron scheduled, with `NEXUS_ENABLE_AMAZON_ORDERS_2026` unset so the
Orders path is unchanged — which is the proof that shipping it changed nothing.
🔴🔴 **CORRECTION (2026-09-20, after the Owner challenged it) — the claim below was
WRONG and it is the most instructive mistake of the day.** I wrote *"Amazon is NOT
CONNECTED in production"* from these lines: `amazon-orders cron: Amazon SP-API not
configured — skipping`, `amazon-inventory cron: … skipping`, `data-kiosk-poll cron:
failure {"error":"… Connect an Amazon seller account in Channels …"}`.

**Those crons run ONCE PER BUSINESS PROFILE, and there are TWO.** I read one profile's
skip as a fact about production. The same deploy says, in plain words:

- `seedEnvManagedConnections: persisted Amazon authorization exists — skipping env synthesis {"existingId":"cmothu9bo0000nz01asw6wx8j"}`
- `[amazon-notifications] reusing existing destination {"destinationId":"7e944042-…"}`
- `[amazon-notifications-boot] setup visited business profiles {"visited":2,"ran":1}` — **two profiles, Amazon set up in one**
- `📣 PUBLISH MODES at boot — Amazon=live eBay=live Shopify=gated`

**Amazon IS connected**, in one of the two profiles. And eBay confirms the Owner's two
accounts: `ebay-orders cron: tick complete {"connectionsTried":1,"connectionsOk":1,…}`
appears **TWICE per tick** — one connection per profile, both OK.

🔴 **The banked trap I walked into, written in this very file:** *"A non-platform
`cron.schedule` already visits every active business profile and runs the handler inside
each one."* A per-profile skip is not a global fact. **Before reading a cron line as a
statement about production, ask which profile it came from — and look for the OTHER
profile's line.**
Earlier: P3.6 deploy `92ec6158` from `22eafb4bf`: `Applying migration 20260920e_p36_trace_id`, `channel-alerts cron: scheduled {"schedule":"*/15 * * * *"}`, `suppression-issues cron: scheduled {"schedule":"25 4 * * *","amazonPull":"off"}`. The migration applied, so `traceId` exists in production — but **no row carries one yet**; the first queued change creates the first. Earlier: P3.3–P3.5 deploy `d39ece61` from `b36fe4c80`: `channel-alerts cron: scheduled {"schedule":"*/15 * * * *"}`, `suppression-issues cron: scheduled {"schedule":"25 4 * * *","amazonPull":"off"}` (the P3.2 correction landed), and — the one that matters — **the sweep actually ran**, once per business profile: `[channel-alerts] sweep {"created":0,"deduped":0,"belowThreshold":0}` and `{"created":0,"deduped":0,"belowThreshold":1}`. The `belowThreshold: 1` is the proof: an alert was **evaluated** against real production data and correctly stayed quiet. Earlier: P3.2 deploy `421fee4f` from `c86c20424`: `Applying migration 20260920d_p32_listing_issue_occurred_at`, `suppression-issues cron: scheduled`, **570 requests / 0 errors** in the hour after. Earlier: P2.2 deploy `f9910fac`: `amazon-notification-reconcile cron started {"schedule":"40 3 * * *"}`. P2.3 deploy `816c4e48`: `ebay-notification-reconcile cron started {"schedule":"55 3 * * *"}`. P2.4–P3.1 pushed and deployed; **none verified by real traffic yet** — see section 4. Earlier: P2.1 — deploy `ee4d1810` from `c8265b1dc`: `Applying migration 20260920a_p21_inbound_retry` + `…20260920b_p21_inbound_route_aliases`, `inbound-retry cron started {"schedule":"* * * * *"}`, **363 requests / 0 errors** in the 25 min after (the retry path itself has not yet been hit by real traffic). Earlier: anonymous `GET /api/monitoring/queue-stats` → **401**, with `/api/health` → **200** in the same run as the control; `Applying migration 20260919a_p11_gateway_call_ledger` in the deploy log; the contract cron logs itself off; **0 × 5xx** since the deploy.

## 3. Next — P4.x

**P5.1 is built and P5.3 is measured.** The deadline package is done, so the
plan's order now points at **P4**.

> **P5.1 — BUILT 2026-09-20, switch OFF.** `NEXUS_ENABLE_AMAZON_ORDERS_2026=true`
> turns it on. Everything is proven by test and by Amazon's own published model
> and example response; **no live 2026-01-01 call has been made**, which is the
> Owner's step. Full record and the two options in `build/P5.1.md` §6.

### 3.0 What P5.1 found — read this before any version migration

1. **A version pin can be a no-op.** `amazon-sp-api@1.2.1` defaults
   `version_fallback: true`. `endpoints_versions: { orders: '2026-01-01' }`
   moves **one** operation and silently sends nine back to v0. The census guard
   (`amazon-orders-version.p51.vitest.test.ts`) walks the library's own resolver
   so this can never be assumed again.
2. **The version goes in `options.version`.** A top-level `version` key is
   accepted by the object and **ignored** — 2026 parameters to the v0 path, no
   error. TypeScript caught it only by luck (`ReqParams` is a closed type).
3. 🔴 **`unitPrice` is PER UNIT; v0's `ItemPrice` is the LINE TOTAL.** Amazon's
   example: quantity 2, unitPrice 49.99, ITEM breakdown 99.98. `upsertOrderItem`
   **divides by quantity** (DA-RT.15), so the obvious mapping divides twice.
   **38 lines** in the development database have quantity > 1 (36×2, 1×4, 1×8).
4. **Three envelopes in one migration.** v0 wraps in `payload`; `searchOrders`
   puts the list under `orders`; `getOrder` wraps one order in `order`. The
   wrong one gives every field `undefined` and no error.
5. **A screen was already claiming the work was done.** The CX connector spec
   reported `orders-2026-01-01` while every call went to v0. It is a getter now.
6. 🔴🔴 **A startup error and a failing test share an exit code.** The mutation
   harness reported all nine rules "guarded" while `--reporter=basic` (which
   vitest 4 does not have) killed every run at startup. It now demands evidence
   that tests actually ran. **"Could not measure" was reading as "measured".**

### 3.0b P4.1's remaining rows — measured 2026-09-20, read before building

**"The description engine in every builder" is NOT a gap either.** — CLOSED as
P4.1c. 7 render call sites on both channel models, one engine. What WAS wrong is
that the rule lived in the callers: the Inventory group publisher fell back to
the raw, unthemed body when its parent content was omitted. Required now. See
`build/P4.1c.md`.

**"Shopify: `productSet` only" is NOT a gap. It is a stale plan row against a
deliberate design, and the code is right.** `productSet` is already used —
`services/shopify/content-publisher.ts:260`, `mutation NexusProductSet(...)
{ productSet(input:, identifier:, synchronous:true) }` — for the product and its
variant structure. The targeted mutations beside it (`productUpdate`,
`productVariantsBulkUpdate`, `inventorySetQuantities`) are there on purpose:
`services/shopify/information-gateway.ts:123` says so in as many words —
*"Each operation patches exactly one field. No broad productSet or variant
replacement."* Rewriting every field write as a whole-product `productSet` would
make one operator's title edit overwrite another's concurrent price edit.

**This is the P2.6 / P3.3 counterweight.** Say so and mark the row; do not
"fix" it. If the plan's intent was "no REST product writes", P1.4 already did
that and its gateway ratchet holds it at 0.

**"Business policies per account" — CLOSED as P4.1d.** Per account was already
right. Per MARKET had a real drift and it is fixed; see `build/P4.1d.md`.

**"Keep the eBay Inventory/Trading split" — CLOSED as P4.1e.** The split is
deterministic and correct; its FAILURE path guessed. See `build/P4.1e.md`.

**P4.1 is complete.** The row-by-row table is `build/P4.1e.md` §6.

**P4.2 (images) — first slice done.** 🔴 Measured: **no image publish on any
channel filed a single issue** — `amazon-image-feed` 0, `ebay-inventory-image-publish`
0, `ebay-shared-image-publish` 0, `shopify-live-images` 0 — while P3.2's
`recordFeedReportIssues` had exactly ONE caller. P4.2a files the Amazon image
feed's rejections (`build/P4.2a.md`). eBay's shared image publish is covered by
P4.1a; Shopify's is a READ. **P4.2b is now built too** (`build/P4.2b.md`): the
decision was decidable from P3.2's own contract — *"in the channel's words"* — so
**4 of `pushVariationGroup`'s 12 `results.push` sites file and 8 do not**. Our own
validation ("No images found", "No DE price set") stays a per-row result and never
reaches a listing. A RETRYABLE answer is not filed either (P3.1: a thousand
throttles must not bury four real rejections), and the same file already retries
those errorIds itself. Covers the flat-file push too — one home.

Still open in P4.2: the R-5 census, the eBay Media-API decision (R-1), and
image read-back per channel.

### 3.0a P5.3 — measured, not built

P1.4 did most of it. `SHOPIFY_API_VERSION = '2026-07'` is the single accessor;
the plan's "6 client files" are down to **two**, both READS:
`utils/config.ts:45` (a stale default) and
`services/images/shopify-live-images.service.ts:97` (a REST
`GET /products/{id}.json`). 🔴 The second is guarded by `hasCreds()`, and **P2.4
measured that production has no `SHOPIFY_*` variable at all** — so it has almost
certainly never run. Establish that before moving its version: a REST products
read is not like-for-like on `2026-07`. Details in `build/P5.1.md` §5.

### 3.1 🔴 What P3 left open — most of it is P4.1's

1. ~~No eBay caller passes `ctx.listingId`.~~ **CLOSED 2026-09-20 by P4.1a**
   (`build/P4.1a.md`). 🔴 **And this entry was wrong twice.** A derived census
   says **14 write call sites across 12 files, 0 passing a listing** — not two —
   and `ebay-shared-fanout.service.ts`, one of the two named here, makes **no
   Trading call at all**. `callTradingApi` now resolves the listing itself from
   the `<ItemID>` in the call plus the account, so it cannot be forgotten by a
   fifteenth caller. A shared eBay item is MANY listings and every member is
   filed; the ledger's single column takes one only when exactly one resolves.
2. ~~Amazon put/patch issues have no producer.~~ **CLOSED 2026-09-20 by P4.1b**
   (`build/P4.1b.md`). 🔴 **And this entry was wrong too.** `putListingsItem` is
   **28 occurrences**, not 0 — the "0" is true only of the SDK operation STRING
   (2 places, both tests), while `AmazonSpApiClient.putListingsItem()` is a real
   method with a live call site at `routes/marketplaces.routes.ts:1038`. The real
   gap was that Amazon's `issues` were parsed, logged and handed back, and never
   written to `ListingIssue`. Filed from both paths of `putListingsItem` and
   `submitListingPayload`; an accepted write records an EMPTY set on purpose,
   because `listings-api` REPLACES and that is what closes a fixed listing's
   stale rejection. Offer patches deliberately do NOT file, for the same reason.
3. **eBay rate headroom has no source.** eBay does not report quota on a call (its
   parser returning null is CORRECT); `getRateLimits` is never called. P3.3's screen
   says so in eBay's own terms rather than showing a blank.
4. **`connectionId` is unset by most senders**, so P3.3's per-account screen
   under-counts until each sender names its account. P4.x, package by package.
5. **Three of P3.4's four live alerts have no fuel** — 0 dead letters ever, 0 listing
   issues until a feed runs, and **no `ChannelApp` has a secret expiry date set** (which
   is the second, independent reason P0.5's alert never fired). **Signature failures can
   fire now: 7 real rows are waiting.**
6. **`alert.service.ts`'s in-app channel is still a `console.log`** and its destination
   is the string `'admin'`. Other programmes still call it and still reach nobody. Named
   in `build/P3.4.md`, **not fixed** — it is shared, so it needs its own decision.
7. **No `traceId` exists in any row yet.** The first queued change after the P3.6 deploy
   creates the first one.
8. **The studio "Errors & Sync" console's rejections pane** is the studio programme's.
   Its `DORMANT_SOURCES` entry for `ListingIssue` was right when written (measured 0 on
   prod 2026-09-01); **P3.2 made that source live**, so the pane can now be built on
   real rows. That is the handoff.

### 3a. Start here, every time

**Measure before building.** Nine packages in, the plan's description of a package has
been out of date or incomplete in eight of them. The measurement takes twenty minutes
and has found a live production defect nearly every time.

**`OutboundApiCallLog` holds 469,455 real calls** with request and response payloads.
It is the fixture source for anything P3 or P4 touches — P3.1 found four defects in an
hour by running its 201 stored failures through the classifier. Use it before writing a
fixture by hand.

### 3b. What each package found, in one line

- **P2.1** — Shopify had never recorded a webhook; the idempotency key was the resource
  id, not the delivery id.
- **P2.2** — the Amazon order parse read one level too high: `'MFN'` on **1413/1413**
  real payloads when the truth was AFN 1071. A test was green about it because its
  fixture copied the parser's mistake.
- **P2.3** — no eBay destination, no subscription, so **no genuine eBay notification had
  ever arrived**; account-deletion notices were answered **503**.
- **P2.4** — production has no `SHOPIFY_*` variable at all, so every Shopify webhook was
  answered **400** before its signature was read. Nothing had ever registered them.
- **P2.5** — **no Etsy order had ever entered Nexus by any route**; the only Etsy order
  code has no call site.
- **P2.6** — the opposite lesson: most of it already worked. Two signals went round the
  state machine, **one of them written by P2.4 in this same programme**.
- **P2.7** — the AMS hourly write **increments** and nothing deduped it; a redelivery
  silently added the same spend again.
- **P2.8** — the API exposed none of the lifecycle, so a dead letter looked identical to
  a failure that retries in four minutes.
- **P3.1** — **161 of 201** real failed bodies are double-encoded and lost their error
  code entirely.
- **P3.6** — the trace existed, worked, and answered the WRONG question: `requestId` is
  a RUN id (1,243 calls share one tick's), and the change's own id died at the queue,
  which had no id column. Not "never ran" — the P2.6 counterweight in a new shape.
- **P3.5** — nothing read the deprecation headers at all; and the alert dedupe from
  P3.4 would have hidden a MOVED shutdown date behind the old one, which a failing test
  found and the design had missed.
- **P3.4** — the alert path reached nobody: an in-app `console.log` stub plus an email
  channel disabled in production, while the thing that delivers (`Notification`, 391,197
  rows) sat beside it unused by this programme. P0.5's alert had **two** independent
  reasons never to have fired.
- **P3.3** — the call ledger could not be asked about an account at all: every other
  identifier on the row was filterable and `connectionId` was not. Two apparent gaps
  turned out to be correct behaviour — eBay reports no per-call headroom, Amazon reports
  a rate not a remaining count — which is a result, not a wasted step.
- **P5.1** — the plan's own instruction was nearly a no-op (a version pin that
  moves one operation of eleven, silently), and the real defect was money: v0's
  `ItemPrice` is a LINE total and 2026-01-01's `unitPrice` is PER UNIT, into an
  ingest that already divides by quantity. A fourth shape: **the plan itself can
  be the thing that is wrong**, not just the code.
- **P3.2** — `ListingIssue` was **empty** while 140 real rejections sat in a JSON column
  nothing joined to a listing; the flat-file grid's health chip had been reading that
  empty table since it was written. And the attribute was lost on **140/140**, so
  mirroring them would itself have dropped 80.

**The pattern in most of them:** a component that looks finished, is referenced by
working code around it, and **has never once run.** Ask *"what would I see if this had
never executed?"* before believing it does. The cheapest test is a grep for its call
site with a known-live function as the control.

**Three counterweights, and they matter as much:**

- **P2.6** — sometimes it already works. Say so; that is a result, not a wasted step.
- **P3.3** — two apparent gaps were **correct behaviour**: eBay reports no per-call
  headroom, Amazon reports a rate and not a remaining count. The fix was to say so on
  the screen in the channel's own terms, not to build a number.
- **P3.6** — a third shape: the thing **works, for a different question than the one
  being asked.** `requestId` is real and well-filled and answers "what did this run
  do". Check what a component is FOR before recording that it is broken.

### 3c. The order from here

**P4.x** → the rest of P5 (P5.3 measured, P5.2 / P5.4; P5.5 not needed)
→ P6.2 / 6.4 / 6.6 / 6.7 / 6.8 → P7 (each drop needs a yes) → P8.

## 4. 🔴 What is NOT proven by real traffic

Everything from P2.2 onward is proven by test, by mutation check and by local
end-to-end runs. **Almost none of it has been exercised by a real event**, because
almost none can arrive until the switches in section 5 are thrown. Do not read a green
deploy as a working channel.

**🔴 The honest denominator, and it governs every P3 screen.** Of the 395 calls since
the gateway landed (2026-09-19), **only the 48 Shopify ones are real traffic**. Every
eBay row is a test artefact — a `conn-1` account, an `apiz.sandbox.ebay.com` host, a
null `statusCode`, counts repeating in multiples of 42. Amazon has 2. Anything
"verified" against that population is verified against nothing. P3.3's and P3.6's
screens say so on the screen itself.

| Channel | State |
|---|---|
| **eBay** | The nightly reconcile at **03:55 UTC** creates the destination and subscribes, because `EBAY_NOTIFICATION_ENDPOINT_URL` + `EBAY_NOTIFICATION_VERIFICATION_TOKEN` are already set in production. **Check `GET /api/admin/ebay-notification-status` after it runs** — a topic under `notOffered` means its id in `ebay-topics.ts` is wrong |
| **Shopify** | Sends nothing until the registration is run per shop (section 5) |
| **Etsy** | Sends nothing until the Owner configures the portal (section 5) |
| **Amazon** | **CONNECTED and live** — a persisted authorization (`cmothu9bo0000nz01asw6wx8j`), a reused notification destination, `Amazon=live` at boot. 🔴 An earlier version of this row said "not configured", read off a cron skip that came from the OTHER of the TWO business profiles. A per-profile skip is not a global fact. Still true: no ORDER_CHANGE arrived in a deploy window, so P2.2's parse fix remains unexercised by real traffic |
| **eBay** | **TWO accounts connected, both OK** — `ebay-orders cron: tick complete {"connectionsTried":1,"connectionsOk":1}` appears twice per tick, one connection per business profile. 0 orders fetched so far |
| **Etsy / Shopify** | 🟡 **UNKNOWN from the logs, and that is the honest answer.** The only lines are `[ConfigManager] ⚠ Etsy/Shopify configuration incomplete (missing env vars)` — that is the LEGACY env-based config, not the CX connection table, so it says nothing about a connection made through the Channels screen. P2.4 did measure that production has no `SHOPIFY_*` variable, which is consistent with both. **Do not read those two lines as "not connected"** — that is the same mistake as the Amazon one above |
| **AMS** | The subscription check's first run is the answer to P2.7's done-when |

### 4.1 The three cheapest proofs available right now

Each is one command, and each converts a "built" into a "verified":

1. **P3.6's trace.** Make any change that queues an outbound row, then
   `GET /api/cx/trace/<traceId>`. **No `traceId` exists in any row yet** — the first
   queued change after the deploy creates the first one.
2. **P3.4's signature alert.** **7 real `signatureOk = false` rows are waiting.** The
   sweep runs every 15 minutes; if production holds any of those in its 24-hour window
   the notice appears on the bell. It is the only one of the five alerts with fuel
   today.
3. **P3.2's listing issues.** The next Amazon flat-file feed that gets a rejection
   writes to `ListingIssue`, and the flat-file grid's health chip — which has been
   reading an empty table since it was written — lights up.

## 5. Open items the Owner owns

1. **P1.8 is off.** Turn it on with `NEXUS_ENABLE_CHANNEL_CONTRACT_RUN=true` plus one sandbox account per channel (`NEXUS_CONTRACT_ACCOUNT_EBAY`, `…_AMAZON_SP`, `…_AMAZON_ADS`, `…_SHOPIFY`, `…_ETSY`, and `NEXUS_CONTRACT_AMAZON_SELLER_ID`). Shopify needs a development-store account named; Etsy has no sandbox and needs the Owner's decision about a test listing marked "test".
2. **P6.1 is off** until the Owner registers the credential queue and sets `AMAZON_APP_CREDENTIAL_QUEUE_URL` (`build/P6.1.md` section 4).
3. **Shopify order-action switches** now reach the connected account when set to `true`: `NEXUS_ENABLE_SHOPIFY_REFUND`, `NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL`, `NEXUS_ENABLE_SHOPIFY_SHIP_CONFIRM` (new in P1.7).
4. **Re-publishing an ended listing has no path**: the push lock refuses it and nothing in the code relists. Presence's relist verb is the planned answer.
5. **A live stock round-trip on a real Shopify dev store** is still unproven (P1.4 done-when 2) — it is a live channel call, so it needs the Owner's yes.
6. **Start Etsy's webhooks**: in Etsy's portal, point the webhook at
   `https://<api host>/api/webhooks/etsy`, and set `ETSY_WEBHOOK_SIGNING_SECRET` in
   production to the `whsec_…` secret Etsy gives you. Etsy has no subscription API, so
   this is a portal step. Until it is done nothing arrives. The done-when is a real
   `order.paid`.
7. **Register the Shopify webhooks** per connected shop:
   `POST /api/…/shopify-linked-products/<id>/webhook-subscriptions`. Until this runs,
   Shopify sends nothing at all. The result reports each topic as created, already ours,
   already pointed elsewhere (left untouched), or refused with Shopify's own message —
   which is where we learn whether the Admin API accepts the three privacy topics or
   whether they must be set in the Partner Dashboard.
8. **Start eBay's live notifications** by setting `EBAY_NOTIFICATION_ENDPOINT_URL`
   (the public `/api/webhooks/ebay-notification` URL) and
   `EBAY_NOTIFICATION_VERIFICATION_TOKEN` (32–80 characters) in production. Until both
   are set, `setupEbayNotifications` makes **no call at all**. Once set, the nightly
   reconcile creates the destination and subscribes the topics. Check the result with
   `GET /api/admin/ebay-notification-status`; a topic listed under `notOffered` means
   its id in `services/cx/ingress/ebay-topics.ts` is wrong.
9. **Turn on the Amazon suppression pull** (P3.2) with
   `NEXUS_ENABLE_AMAZON_SUPPRESSION_PULL=true`. It is **off** by default because it
   asks SP-API for a `GET_MERCHANT_LISTINGS_DEFECT_DATA` **report** per marketplace,
   and reports are quota-limited — the same reason `amazon-returns-poll` is off. The
   cron's local mirror half runs daily either way and is what resolves a stale issue.
   Until the pull is on, `AmazonSuppression` stays at 0 rows and no suppression reaches
   a listing.
10. **Turn on the new Amazon notification types** when you want them: set
   `NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES=true`. That makes the next boot, the nightly
   reconcile and the admin endpoint attempt `LISTINGS_ITEM_ISSUES_CHANGE` and the four
   types whose SQS support is unverified. A 400 InvalidInput on one of those is a
   finding, not a fault — it means that type needs an EventBridge destination. Two types
   already need one: `LISTINGS_ITEM_STATUS_CHANGE` and `BRANDED_ITEM_CONTENT_CHANGE`.
11. **Amazon and eBay inbound events cannot be replayed from the ledger** (P2.1 section 4). Amazon's handling lives inside the SQS poll loop, eBay's inside the live notification envelope; neither can be re-run from a stored payload. Both are named in the guard's `UNREPLAYABLE` map and the worker dead-letters them on the first sweep with that reason.
12. **91 AMAZON rows sit at `pending`** with no `nextAttemptAt`, so the retry worker does not see them. `replayInbound` accepts them by hand; nothing sweeps them yet.
13. **The archiver does not exist.** `archivedAt` / `archiveUri` are honoured by the worker and by replay, but nothing writes them. D8 is held by the guard.
14. **Amazon Orders 2026-01-01 is BUILT and OFF** (P5.1). Turn it on with
   `NEXUS_ENABLE_AMAZON_ORDERS_2026=true`. It is off because the mapping is
   proven against Amazon's published model and its own example response, not
   against a real payload — **no live 2026-01-01 call has been made**, and that
   is a live channel call. Two details can only be settled by one: whether
   `paginationToken` may be sent with `includedData` on page 2, and how
   `marketplaceIds` is serialised. The safer order is one captured live read
   first; `build/P5.1.md` §6 puts it as two options with a pick. The deadline is
   **2027-03-27**, the target **2026-12-15** — there is no hurry.
15. **Not this programme, found in production 2026-09-20:** the dashboard tax panel reads `OrderItem."vatRate"`, a column in neither the schema nor the database (query from `6c5c6d79a`, 2026-05-09), and its `.catch(() => 0)` shows **tax = 0** instead of saying it could not be read. Separately, the eBay readback cron fails every 30 minutes on missing `EBAY_APP_ID` / `EBAY_CERT_ID` (the same lines are on the previous deployment, so it predates this work).

## 6. Traps that cost time here — read before measuring anything

- 🔴🔴 **A BANKED RULE CAN GO FALSE, and a cited one gets LESS scrutiny.** This
  handover's own §3.1 was wrong twice in one section: "two eBay callers" was
  fourteen across twelve files (and one of the two named makes no Trading call at
  all), and "`putListingsItem`: 0 occurrences" was 28 — true only of the SDK
  operation STRING, while a real method with a live call site sat beside it.
  **Re-derive a count before building on it.** Both cost one command.
- 🔴 **A GUARD WHOSE CLAIM IS TOO BROAD gets relaxed until it passes.** P4.1a's
  first guard claimed one sender of eBay Trading XML; there are six. The fix is
  to NARROW the claim to what is true (no listing WRITE outside `callTradingApi`),
  write the exemptions down with reasons, and add a second test that CHECKS each
  reason — not to loosen the pattern until it goes green.
- 🔴🔴 **A RULE LEARNED FROM AN INCIDENT IS OFTEN ABANDONED ON ITS FAILURE PATH.**
  Twice in one day, in two files: eBay's policy reconciliation warned instead of
  refusing when the snapshot was unavailable, and the lane marker's `catch` said
  "shared flag decides alone" — which routes an Inventory-managed family down
  the Trading lane, the exact misrouting Incident #23 exists to stop. When you
  find a rule with an incident number, **read its `catch`**.
- 🔴🔴 **A PER-PROFILE CRON LINE IS NOT A FACT ABOUT PRODUCTION.** Business
  profiles are ON, so every non-platform cron runs once PER PROFILE. Reading
  `amazon-orders cron: not configured — skipping` as "Amazon is not connected"
  was wrong: it came from one of TWO profiles, and the same boot log said
  `persisted Amazon authorization exists` and `Amazon=live`. **Find the other
  profile's line before you conclude.** The Owner caught this one.
- 🔴 **A `ConfigManager` "configuration incomplete (missing env vars)" line is
  about ENV, not about a connection.** Etsy and Shopify log it while a CX OAuth
  connection may exist perfectly well. Check the connection table, not the boot
  warning.
- 🔴🔴 **A SHAPE TEST CANNOT CARRY A RULE ABOUT A VALUE.** P4.2a asserted
  `toContain('attrsByCode')` and `toContain('attributeNames')`; replacing the
  expression with `attributeNames: []` left both names in the file and the test
  green. Export the function and test the VALUE. (Second time in one hour — see
  the next line.)
- 🔴🔴 **A `toContain` ON PART OF A CONDITION DOES NOT TEST THAT CONDITION.**
  `if (false && cond)` and `cond && Date.now() < 0` both keep the substring, so
  the rule is off and the test is green. Two P4.1e mutations proved it. Match the
  WHOLE trimmed line (with its `if (` and `) {`), and assert only ONE line tests
  the flag.
- 🔴 **A GUARD CAN BE SILENCED BY ITS OWN EXPLANATORY COMMENT.** P4.1e's "the old
  sentence is gone" test failed because the NEW code quotes it in a comment.
  Strip comments before matching, with a positive control that the stripper did
  not empty the file.
- 🔴🔴 **TWO BUILDERS, ONE LESSON LEARNED IN ONLY ONE OF THEM.** eBay's group
  publisher REFUSES an unverifiable policy snapshot (FFP.12, after an incident);
  the single-SKU publisher WARNED and wrote the unverified ids anyway (R12,
  which stopped one step short). Same waterfall, same market rule, opposite
  failure rule — visible only by reading both. When you find a rule with an
  incident number on it, **grep for the other builder**.
- 🔴 **A DISCRIMINATED UNION DOES NOT NARROW IN `apps/api`.** Its tsconfig sets
  `"strict": false`, so without `strictNullChecks` TypeScript never eliminates
  the `{ ok: true }` member and `resolution.message` is a compile error after
  `if (!resolution.ok)`. The `ok`-flag result type is a reflex that buys nothing
  here — use two nullable fields.
- 🔴 **A PARITY REGEX MUST USE A BACKREFERENCE.** `\w+\.message \|\| !\w+\.policies`
  counts `a.message || !b.policies` as a check. `(\w+)\.message \|\| !\1\.policies`
  does not. And when a source-shape test fails, check the PATTERN before
  loosening it: the first version assumed one variable name.
- 🔴🔴 **A NEW REFUSAL PLACED TOO EARLY MASKS EVERY REFUSAL BEHIND IT.** P4.1c's
  theme check sat before the publish mode, the push lock, the presentation lock
  and the review gate, so a PAUSED listing reported "no theme-rendered content"
  instead of the pause. **14 existing tests caught it in one run.** Put a new
  refusal last unless it is genuinely the most important reason, and assert its
  position by index.
- 🔴 **AN ESCAPE HATCH IN A TEST IS A PASS THAT PROVES NOTHING.** "If a lock threw
  first, accept that instead" would have let P4.1c's behavioural test never reach
  the refusal. WITNESS which arm runs — write the outcome to a file from inside
  the test — then delete the branch that does not.
- 🔴 **A COUNT OF A NAME is not a count of the THING.** "`putListingsItem`: 0
  occurrences" was true of the SDK operation STRING and false of the method: a
  real client method with a live call site sat beside it. Before believing a
  zero, ask WHICH SPELLING was counted and what else could carry the same fact.
- 🔴 **`normalizeMarketplaceCode` returns the STRING `'UNKNOWN'`, never null.**
  An unrecognised id becomes a query for a marketplace called "UNKNOWN", which
  reads as a clean miss and can match a row that really stores it. Pass `''` as
  the fallback and refuse it (P3.2's notification path already does).
- 🔴 **A mutation that adds a NEW function does not mutate the one under test.**
  P4.1b's offer-patch mutation created `patchListingPriceUnused`, so the guard's
  `not.toContain('patchListingPrice')` still passed and the red carried the wrong
  message. Mutate INSIDE the thing you are convicting, and match on the message.
- 🔴 **A literal-only regex UNDER-COUNTS a census.** A call whose operation is a
  ternary (`plan.itemId ? 'Revise…' : 'Add…'`) is invisible to
  `fn\('([A-Za-z]+)'`. Make the census fail when any member's identity cannot be
  read: a hole in the denominator is not a pass.
- 🔴🔴 **A STARTUP ERROR and a FAILING TEST have the same exit code.** A mutation
  harness passing `--reporter=basic` (not a vitest 4 reporter) killed every run
  before a single test executed, and reported **nine rules "guarded"** that it
  had never checked. Demand positive evidence the runner ran — `Tests <n>` in
  the output, no `Startup Error` — before believing a red.
- 🔴 **An SDK can take the option in a DIFFERENT PLACE than you pass it.**
  `amazon-sp-api` reads `callAPI({ options: { version } })`. A top-level
  `version` key is accepted by the object and dropped: the call goes to the old
  version with the new parameters, no error. Check where the library READS it.
- 🔴 **A version pin can move almost nothing.** `version_fallback: true` is the
  default, so pinning an endpoint to a new version silently falls back to the
  oldest one for every operation the new version lacks. Derive the census of
  operations you call from SOURCE and assert the version each one resolves to.
- 🔴🔴 **PER-UNIT vs LINE TOTAL is a money defect with no error.** v0's
  `ItemPrice.Amount` is the line total and the ingest divides it by quantity;
  2026-01-01's `product.price.unitPrice` is per unit. The obvious mapping
  divides twice. Amazon's own example carries both numbers (49.99 and 99.98 at
  quantity 2) — and its second line is quantity 1, where the two are equal, the
  coincidence arm a careless test would pass on.
- 🔴 **One migration can have THREE envelopes.** v0 wraps in `payload`,
  `searchOrders` puts the list under `orders`, `getOrder` wraps one order in
  `order`. The wrong one yields an object whose every field is `undefined`, with
  no error — P3.1's double encoding in a new place. Make the unwrapper return
  **null** for an unrecognised envelope, never a fieldless object.
- 🔴 **A connector spec can claim a version the code does not use.** The CX
  screen read `orders-2026-01-01` while every call went to v0. A switch that is
  OFF must not read as work that is DONE — derive the reported version.
- **`Array.isArray([])` is TRUE, and `[]` is what a channel actually sends.** An
  `isArray` guard reads an empty array as "the channel told us" and suppresses the
  fallback behind it. It cost P3.2 the attribute on **140 of 140** real rejections.
  Guard on whether there is a VALUE, not on whether there is an array.
- **A fingerprint built from a field that is always empty is not an identity.**
  `ListingIssue` is keyed on `code + attributeNames`; with the attribute empty, five
  different rejections on one SKU became one row and four vanished. Before mirroring a
  real population into a keyed table, count the distinct keys it produces.
- **A test that reads state an EARLIER test created proves nothing under `-t`.** P3.2's
  marketplace-scope mutation passed because, run alone, no record call had happened. It
  found a real defect once the test was made self-contained. Every mutation check runs
  the named test ALONE — so every test must set up its own arm and carry a positive
  control.
- **`TIMESTAMP(3)` read by node-pg shifts by your local offset.** A correctly stored
  03:00 UTC comes back as 01:00 on a UTC+2 machine. Read through Prisma (as the app
  does) and assert the raw stored text with `TO_CHAR` as the control.
- **A count of rows is not a count of what is stored in them.** `OutboundApiCallLog`
  keeps `responsePayload` only on failures: 184 of 184 failures have one, **0 of
  468,185 successes do**. Searching successes for errors-inside-a-200 was "could not
  measure", not "measured empty".
- **A gate can be FLAKY, and a retry can push the un-fixed version.** The profiles-ON
  ratchet refused P3.5, the file passed alone under the ratchet's exact environment, and
  a full profiles-ON run captured to JSON showed it passing. While reading that error a
  second `git push` hit a green run of the same flake and **pushed the un-fixed
  commit**. Two rules follow: re-read a gate's error from the LOG, not by re-running
  `git push`; and when a gate flakes, the cause is usually yours — P3.5's was a test
  doing ~1,040 queries to assert a bound on an in-memory Map.
- **A mutation harness must assert its own edit landed.** P3.4's script was edited by a
  `replace` that matched nothing, so it silently kept running the OLD mutation and the
  ❌ looked like a weak rule for two rounds. Every mutation now asserts the marker was
  found and that the file changed.
- **An efficiency guard is asserted by counting the WORK, not the outcome.** Deleting
  P3.5's in-process quiet period left "one endpoint = one alert" passing, because the
  DATABASE dedupe is what guarantees that. Two guards, two propositions.
- **`Array.isArray([])` is TRUE.** An `isArray` guard reads a channel's empty array as
  "it told us" and kills the fallback behind it — 140 of 140 real Amazon rejections lost
  their attribute that way. Guard on whether there is a VALUE.
- **A fingerprint built from an always-empty field is not an identity.** Before mirroring
  a real population into a keyed table, COUNT the distinct keys it produces: 140 real
  issues collapsed to 60 rows.
- **`requestId` is a RUN id, not a change.** One cron tick's id covers **1,243 calls**.
  P3.6 added `traceId` beside it; `getTraceId()` deliberately does not fall back on a
  cron.
- **A wrong CSS token is silently dropped.** `--nds-font-family-mono` does not exist
  (it is `--nds-font-mono`). Grep every token in a new block against
  `design-system/styles/*.css` before committing.
- **A Prisma field that looks like an enum may be TEXT.** `OutboundSyncQueue.syncType`
  is plain text; casting it to `"SyncType"` made the suite report
  `type "SyncType" does not exist`. Read `information_schema`, do not guess.
- **The real model names are `UserProfile`, `Role`, `WorkspaceMemberRole`** — not
  `User` / `WorkspaceRole` / `WorkspaceMembershipRole`. Inventing them made a suite fail
  to LOAD, which prints as `N skipped`, not `N failed`.
- **A new route outside an existing prefix needs an RBAC rule** in
  `lib/auth/permissions-manifest.ts`, or the pre-push gate refuses the push.
  `/api/cx/connections/*` is covered by a prefix; `/api/cx/health` was not.
- **`@nexus/shared` runs from `packages/shared/dist`, which is not in git.** Edit the source and local tests still run the OLD code until `cd packages/shared && npm run build`. A green suite straight after a shared-package edit is a stale measurement, not a pass.
- **The pre-push gate runs the API suite with business profiles ON** (`node apps/api/scripts/profiles-on-ratchet.mjs`, baseline `apps/api/scripts/profiles-on-baseline.json`). It fails on any new failure, any baselined file getting worse, **and on a fixed file left in the list**. Production runs with profiles on: give the code a business (`withWorkspace`) and seed rows that belong to it.
- **The local database drifts** as other sessions add migrations: the generated client then expects columns your database lacks and DB-backed tests fail with `The column (not available) does not exist`. Fix from `packages/database`: `DATABASE_URL="<the one in apps/api/.env>" npx prisma migrate deploy --schema=prisma/schema.prisma` (check the host is `127.0.0.1` first — the repo's prisma config points somewhere else).
- Run API tests **from `apps/api`**, never the repo root (from the root, `DATABASE_URL` resolves to Neon **production**).
- A full suite **under load** fails files that pass alone (PGlite setup timeouts). Re-run a file alone before calling it a regression.
- Known-failing baseline of the full API suite: `clients/amazon-validation-preview` (5) and `services/marketplaces/amazon-classifications` (1) — both read a local Amazon account.
- **`scripts/check-push-lock.mjs` is RED and has been since before P2.1**: `studio-publication-amazon.ts:164 sendAmazonPublication -> fetch, callAPI`. Verified at clean `HEAD` 5b5ca6166 in a separate worktree. Do not treat it as yours; do not "fix" it inside another package without saying so.
- **Two names for one fact is the shape of every drift defect here.** P2.3 nearly
  shipped a setup reading `EBAY_NOTIFICATION_ENDPOINT` while the challenge handler read
  `EBAY_NOTIFICATION_ENDPOINT_URL` — which would have failed eBay's ownership check and
  taken the endpoint down. One accessor, called by both sides, is the only fix that
  holds.
- **A derived census guard is worth more than it costs.** `write-account-guard.p07`
  noticed that a file had stopped picking the primary eBay account and that its
  exemption was now stale. It was right and the code had moved — do not adjust a guard
  to pass without establishing which of the two is wrong.
- **A fixture written by hand can agree with the bug.** P2.2's order fixture put the
  fields where the broken parser read them, so the test was green about behaviour
  production had never had, for as long as both were wrong together. Where real payloads
  exist — and since P2.1 they do, in `WebhookEvent.payload` — build the fixture from one
  and check the whole population, not one row.
- **Fixing a parse can switch on a branch that has never run.** P2.2's fix would have
  activated a dormant `if (AFN) skip` for 76% of Amazon order traffic. Before fixing an
  input, ask what reads it and whether that reader has ever seen a true value.
- **A probe must target the layer the code runs on.** The first P2.1 probe used a bare `new PrismaClient()` and reported a missing `workspaceId` argument. The app uses a SCOPING client that completes compound keys itself — the real cause was a missing business profile, and the real fix was different. Probe through `apps/api/src/db.js`, and run the arm WITH a workspace as the control.
- **Raw SQL is invisible to the scoping client.** `$queryRawUnsafe` is filtered only by the database's own row policy. A sweep written that way read zero rows while a due row sat in the table. Use the model API for anything workspace-scoped.
- **A non-platform `cron.schedule` already visits every active business profile** and runs the handler inside each one. A sweep does not need to read across workspaces itself — and if you call one from a probe, enter a profile first or you measure a job that can see nothing.
- `grep` in this shell is an `ugrep` function that skips ignored files. Use `/usr/bin/grep` for any "exists / does not exist" claim, with a positive control for every set claim.
- `docs/channel-connections/build/` is caught by the `build/` rule in `.gitignore` → `git add -f`.
- Channel client tests stub the gateway with `apps/api/src/test-support/gateway-stubs.ts` (`accountModule`, `ledgerModule`, `asResponse`).
- Shopify: `location { id }` on an inventory level needs the `read_markets_home` scope (the app has `read_markets`). Use `inventoryLevel(locationId:)`.
- zsh: pass arguments as arrays; do not put `===` in `echo`; quote `--include` patterns.

### 6a. Traps learned across P2–P3.1

- **`OutboundApiCallLog` is the fixture source.** 469,455 real calls. A hand-written
  fixture can agree with the bug — P2.2's did, and the test was green about behaviour
  production never had.
- **A stored body may be encoded twice.** 161 of 201 failed bodies are a JSON *string*
  containing JSON. One parse yields a string and every field read off it is `undefined`.
- **Fixing a parse can switch on a branch that has never run.** P2.2's fix would have
  activated a dormant `if (AFN) skip` for 76% of Amazon order traffic. Before fixing an
  input, ask what reads it and whether that reader has ever seen a true value.
- **Two names for one fact is the shape of every drift defect here.** P2.3 nearly
  shipped a setup reading `EBAY_NOTIFICATION_ENDPOINT` while the challenge handler read
  `EBAY_NOTIFICATION_ENDPOINT_URL` — which would have failed eBay's ownership check and
  taken the endpoint down. One accessor, called by both sides.
- **The MAP.3 ratchet is right.** It refused a push because a replay fell back to "the
  only connected Etsy shop". The ledger already recorded the account; it just was not
  being asked. Never resolve a connection a caller did not name.
- **A guard that counts comments can be silenced by one.** P2.6's new rule failed on its
  own explanatory comment. Strip comments before matching, then re-mutate.
- **Label a fixture REAL or SHAPE.** Three connectors have zero observed failures, so
  their mapping tables rest on the documented envelope. A fixture that looks measured
  and is not is how a wrong belief survives.
- **Run the gates you did not change too.** The connection-resolver ratchet and the P0.7
  census both failed honestly mid-package and both were correct.
- **`/context` early.** Bash output dominates a long session; pipe through `head`,
  `tail` or `grep` and never `cat` a large file.

## 7. How every package here was closed — do the same

Measure first with commands you can quote. Build the smallest change. **Prove it with mutation checks**: break each new rule on purpose, watch a named test fail, restore the file and compare it byte for byte. Then run `tsc`, the full API suite, the gateway ratchet (`apps/api/scripts/channel-gateway-ratchet.mts --check`, must stay 0) and the push-lock gate (`scripts/check-push-lock.mjs`). Write `build/<ID>.md` with what was measured, what changed, the proof and what is still open, update table 14.2 in the plan, commit, push, and take the production proof.
