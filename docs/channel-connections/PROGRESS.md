# Channel connections — progress and handover

Updated **2026-09-20**. **P0, P1, P2, P3.1 and P3.2 are built.**
The next package is **P3.3**.

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

## 2. Done — on `origin/main` and live

Deployment `a05565cc` from commit `e124f24ac`: SUCCESS, migrations applied.

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
| P3.2 | `ListingIssue` held **0 rows**; 25 stored feed jobs held **140 real Amazon rejections on 48 SKUs**; `OutboundApiCallLog.listingId` was filled on **0 of 469,462** calls. The attribute was lost on **140/140**, which would have collapsed them to 60 rows and dropped 80 | see below | `build/P3.2.md` |

**Production proofs.** P2.2 deploy `f9910fac`: `amazon-notification-reconcile cron started {"schedule":"40 3 * * *"}`. P2.3 deploy `816c4e48`: `ebay-notification-reconcile cron started {"schedule":"55 3 * * *"}`. P2.4–P3.1 pushed and deployed; **none verified by real traffic yet** — see section 4. Earlier: P2.1 — deploy `ee4d1810` from `c8265b1dc`: `Applying migration 20260920a_p21_inbound_retry` + `…20260920b_p21_inbound_route_aliases`, `inbound-retry cron started {"schedule":"* * * * *"}`, **363 requests / 0 errors** in the 25 min after (the retry path itself has not yet been hit by real traffic). Earlier: anonymous `GET /api/monitoring/queue-stats` → **401**, with `/api/health` → **200** in the same run as the control; `Applying migration 20260919a_p11_gateway_call_ledger` in the deploy log; the contract cron logs itself off; **0 × 5xx** since the deploy.

## 3. Next — P3.3, then P3.4 … in plan order

P3.3: *screens — the studio "Errors & Sync" console (owned by the studio programme)
reads this store; the Channels page Diagnostics shows the call ledger, rate headroom and
last error per account.* Done when: both screens read the same numbers.

**P3.2 filled the store P3.3 reads.** `ListingIssue` now takes Amazon feed rejections,
Amazon suppression, Amazon issue notifications, eBay Trading failures and Shopify
`userErrors`, each with the channel's own code, the channel's own words, the attribute
and an as-of time. The flat-file grid's health chip reads it already.

**Two things P3.2 left open and P3.3/P4.1 inherit** (full list in `build/P3.2.md` §6):

1. **No eBay caller passes `ctx.listingId`.** `callTradingApi` accepts and uses it, and
   it is tested — but `studio-publication-ebay.ts` and `ebay-shared-fanout.service.ts`
   still call without it, so a real eBay rejection reaches the ledger and not the
   listing. Small change; belongs with P4.1, where those builders are rewritten.
2. **Amazon put/patch issues have no producer.** `putListingsItem` / `patchListingsItem`
   are **0 occurrences in `apps/api/src`** — Amazon content goes out as
   `JSON_LISTINGS_FEED`. That part of the P3.2 plan row is P4.1's to build.

### 3a. Start here, every time

**Measure before building.** Nine packages in, the plan's description of a package has
been out of date or incomplete in eight of them. The measurement takes twenty minutes
and has found a live production defect nearly every time.

**`OutboundApiCallLog` holds 469,455 real calls** with request and response payloads.
It is the fixture source for anything P3 or P4 touches — P3.1 found four defects in an
hour by running its 201 stored failures through the classifier. Use it before writing a
fixture by hand.

### 3b. What the nine packages found, in one line each

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
- **P3.2** — `ListingIssue` was **empty** while 140 real rejections sat in a JSON column
  nothing joined to a listing; the flat-file grid's health chip had been reading that
  empty table since it was written. And the attribute was lost on **140/140**, so
  mirroring them would itself have dropped 80.

**The pattern in eight of the nine:** a component that looks finished, is referenced by
working code around it, and **has never once run.** Ask *"what would I see if this had
never executed?"* before believing it does. The cheapest test is a grep for its call
site with a known-live function as the control.

**P2.6 is the counterweight:** sometimes it already works. Measure anyway, and say so
when the answer is "nothing to build here" — that is a result, not a wasted step.

### 3c. Everything after P3.2

P3.3 → P3.4 → P3.5 → P3.6 → **P5.1 before 2026-12-15** → P4.x → P5 → P6.2 / 6.4 / 6.6 /
6.7 / 6.8 → P7 (each drop needs a yes) → P8.

## 4. 🔴 What is NOT proven by real traffic

Everything from P2.2 onward is proven by test, by mutation check and by local
end-to-end runs. **Almost none of it has been exercised by a real event**, because
almost none can arrive until the switches in section 5 are thrown. Do not read a green
deploy as a working channel.

| Channel | State |
|---|---|
| **eBay** | The nightly reconcile at **03:55 UTC** creates the destination and subscribes, because `EBAY_NOTIFICATION_ENDPOINT_URL` + `EBAY_NOTIFICATION_VERIFICATION_TOKEN` are already set in production. **Check `GET /api/admin/ebay-notification-status` after it runs** — a topic under `notOffered` means its id in `ebay-topics.ts` is wrong |
| **Shopify** | Sends nothing until the registration is run per shop (section 5) |
| **Etsy** | Sends nothing until the Owner configures the portal (section 5) |
| **Amazon** | Live, but no ORDER_CHANGE arrived in the deploy window, so the P2.2 parse fix is unexercised by real traffic |
| **AMS** | The subscription check's first run is the answer to P2.7's done-when |

**The first real event on any channel is worth stopping to read.** Three of the nine
packages had to guess a name or a shape because nothing real had ever arrived; the
ledger now records every arrival with its payload, so those guesses can finally be
checked. `GET /api/sync-logs/webhooks?status=failed,dlq` or the **Ingress tab** on
Settings → Channels.

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
9. **Turn on the new Amazon notification types** when you want them: set
   `NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES=true`. That makes the next boot, the nightly
   reconcile and the admin endpoint attempt `LISTINGS_ITEM_ISSUES_CHANGE` and the four
   types whose SQS support is unverified. A 400 InvalidInput on one of those is a
   finding, not a fault — it means that type needs an EventBridge destination. Two types
   already need one: `LISTINGS_ITEM_STATUS_CHANGE` and `BRANDED_ITEM_CONTENT_CHANGE`.
10. **Amazon and eBay inbound events cannot be replayed from the ledger** (P2.1 section 4). Amazon's handling lives inside the SQS poll loop, eBay's inside the live notification envelope; neither can be re-run from a stored payload. Both are named in the guard's `UNREPLAYABLE` map and the worker dead-letters them on the first sweep with that reason.
11. **91 AMAZON rows sit at `pending`** with no `nextAttemptAt`, so the retry worker does not see them. `replayInbound` accepts them by hand; nothing sweeps them yet.
12. **The archiver does not exist.** `archivedAt` / `archiveUri` are honoured by the worker and by replay, but nothing writes them. D8 is held by the guard.
13. **Not this programme, found in production 2026-09-20:** the dashboard tax panel reads `OrderItem."vatRate"`, a column in neither the schema nor the database (query from `6c5c6d79a`, 2026-05-09), and its `.catch(() => 0)` shows **tax = 0** instead of saying it could not be read. Separately, the eBay readback cron fails every 30 minutes on missing `EBAY_APP_ID` / `EBAY_CERT_ID` (the same lines are on the previous deployment, so it predates this work).

## 6. Traps that cost time here — read before measuring anything

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
