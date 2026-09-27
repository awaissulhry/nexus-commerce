# Channel connections — progress and handover

## Current status

**Status lives in one file: [COMPLETION-MATRIX](COMPLETION-MATRIX.md)** — the releases, every switch
with its default and production state, and one state per requirement (implemented / deployed /
enabled / production-verified). This file is the programme's working history; where it disagrees
with the matrix, the matrix wins.

In short, on 2026-09-26: PR #4 (architecture: API, worker and scheduler; pre-deploy migrations;
restricted runtime login), PR #14 (FBM stock double-deduction hotfix), PR #15 (Package A,
C9–C11f6c) and PR #32 (release B+C: one stock model, eBay price, eBay privacy, contract checks,
Amazon Finances A0/A1/A2/A5, listing issues) are merged and deployed. Every new switch is OFF. The
switch-on phase with the Owner has not started. Releases go by pull request; the Owner decides each
merge.

## 0. Cold start — read this much and you can work

Read [COMPLETION-MATRIX](COMPLETION-MATRIX.md) first, then the
[2026-09-26 approach review](2026-09-26-APPROACH-REVIEW.md) and
[the stock model](2026-09-26-STOCK-MODEL.md). The checkpoints that used to stand here (Package A
gating and rehearsal on 2026-09-25, the 2026-09-23 local continuation, the 2026-09-22 release and
its pre-deployment audit) are superseded; their evidence is in
[RELEASE-C9-C11F6C](RELEASE-C9-C11F6C.md), [CX-REMAINING](build/CX-REMAINING.md),
[RELEASE-C1-C8](RELEASE-C1-C8.md), [CX-COMPLETION](build/CX-COMPLETION.md) and git history.

### Earlier package history (current corrections above take precedence)

| Package | State |
|---|---|
| P0 – P3 | done, deployed |
| **P6.2b** | 🔴 **P6.2 was 0% working in production.** Found by doing §0b. Fixed, deployed, and **proven**: the eBay signing key's expiry is now recorded from a real read. `build/P6.2b.md` |
| **P4.1 – P4.5** | done, deployed. P4.5 = seven slices + `P4.5h` |
| **P7a.1** | 🟢 **FIXED 2026-09-21** — the channel-sync worker picked an arbitrary market and invented a `_US` one. Both latent; both closed. It is now **provably inert** and is the first real deletion candidate. `build/P7a.1.md` |
| **P4.6** | 🟢 **deployed** (written 2026-09-21) — the Owner **overrode D6**: *"I approve you for the ETSY writes."* Five slices, `build/P4.6a.md` … `P4.6e.md`. Ships with `NEXUS_ENABLE_ETSY_PUBLISH` **OFF** |
| **P5** | done. P5.1/5.3/5.4 closed; **P5.2 half-closed** (§0a); P5.5 not needed |
| **P6** | P6.1–P6.6 + P6.8's instrumentation done. ✅ **P6.7 RESOLVED 2026-09-21 — nothing to add**: returns/cancellation/inquiry run on eBay's **Post-Order API**, which takes an `IAF `-prefixed user token and requires **no OAuth scope**. Read in a browser (eBay 403s bots, not people). No reconnect needed for it |
| **P7a** | 🟢 **MEASURED 2026-09-21 — ZERO deletion candidates.** Its one candidate (the Ads credential fallback) was chased down and the answer is **keep it**: unreachable in production, but it is the only credential path with profiles OFF, it is the documented revert lever, and P4.5e's disconnect enforcement is built on its `throw`. *Unreachable today is not unnecessary.* P1.6 already did the safe half; every remaining named target is registered or on a live import chain. `build/P7a.md` |
| **P7b** | **each drop needs the Owner's yes**, after a green week |
| **P8** | 🔴 **DEFERRED** — the Owner, 2026-09-21: *"we'll add the remaining channels later. Currently, we'll keep our focus solely on Amazon, eBay, and Etsy."* Do not start it. Shopify and WooCommerce are also out of the active three |

### 0a. What is genuinely still OPEN, and who owns it (updated 2026-09-26)

| # | Row | Owner | What closes it |
|---|---|---|---|
| 1 | **Amazon Orders 2026-01-01** — the money question was answered by a live read on 2026-09-21 (`ItemPrice` is the line total; pagination proven). `build/P5.1.md` §5c | **Owner** | Re-run the read-only probe once after B+C, then `NEXUS_ENABLE_AMAZON_ORDERS_2026=true` (exactly `true`) on API, worker and scheduler |
| 2 | **Amazon Finances** — A0/A1/A2/A5 deployed (PR #32); A3/A4 held on `fix/cx-amazon-finances` | **Owner** | Run the A2 dry run (`{"useV0": false, "dryRun": true}`, a live Amazon read) over a window v0 already synced; then decide A3/A4 and A5 |
| 3 | **Etsy orders** — ingest deployed (PR #32), OFF | **Owner** | Webhook in Etsy's portal, `ETSY_WEBHOOK_SIGNING_SECRET`, T0, both switches — [ETSY-INGEST-ACTIVATION](ETSY-INGEST-ACTIVATION.md) |
| 4 | **P6.6** env token | **Owner/either** | A 24-hour log read on API, worker and scheduler with no `[amazon-sp] STILL USING the environment refresh token` line (with a positive control), then `NEXUS_AMAZON_ENV_TOKEN=off` |
| 5 | **P4.6** first live Etsy call | **Owner** | Etsy products in Nexus first; then `NEXUS_ENABLE_ETSY_PUBLISH=true` with `ETSY_PUBLISH_MODE=dry-run`, later `live` |
| 6 | **eBay notifications** — setup OFF, every topic `handlerMissing`, the verification token refused by eBay | **Owner + code** | The Owner fixes `EBAY_NOTIFICATION_VERIFICATION_TOKEN` (32–80 characters, `[A-Za-z0-9_-]`) and checks the deletion endpoint in eBay's portal; code marks handlers ready and adds seller-token subscriptions (planning) |
| 7 | **P7b** destructive drops | **Owner** | A **green week** and a separate yes per table. `AmazonAdsConnection` is NOT a candidate |
| 8 | **Section 8** Owner items (FINAL-PLAN) | **Owner** | KMS done 2026-09-26. Open: Amazon app-secret expiry date, Neon password rotation (in git history), eBay deletion endpoint, Etsy webhook. Items 5 and 6 are not needed |
| 9 | **FBM stock repair** (after the PR #14 hotfix) | done | APPLIED 2026-09-26 11:22 UTC on the Owner's yes (option A: add back, per product, only the units taken twice after that product's last manual stock change; guarded per-product `applyStockMovement`, MANUAL_ADJUSTMENT, proven on a private copy first; channel updates all succeeded). Do NOT run it again. Per-product evidence is kept locally. A second repair (stock created by cancellations of never-held orders, fixed by PR #32) removed the phantom units added after each product's last manual change, 2026-09-26 19:31 UTC. |

### 0a-2. The switches

The full table — every switch's default in code, the processes that read it and its last observed
production state — is in [COMPLETION-MATRIX → Switch table](COMPLETION-MATRIX.md#switch-table).
On 2026-09-26: ON are the image read-back sweep and the contract run (which reports "not configured"
until sandbox accounts are named); every switch added by PR #15 and PR #32 is OFF; Amazon Orders 2026,
suppression pull, new Amazon notification types, eBay notification setup, price heal and the live
repricer are OFF. History of the earlier switch decisions: `build/SWITCH-ON.md`.

### 0b. ✅ ALL VERIFIED on deployment `be9f2554` (build `0adbf6e8`), 2026-09-21

1. ✅ `etsy-content-refresh cron: scheduled {"schedule":"20 */4 * * *"}` — at boot, 13:45:04 (P4.6f).
2. ✅ `[channel-alerts] etsy freshness {"total":0,"stale":0,"neverSynced":0,"oldestAt":null}` —
   **logged at zero**, 14:00. That is `build/P4.6e.md` §3b's fix holding: an empty shop used to
   produce silence, indistinguishable from a crash.
3. 🟢 **Already proven:** `[cx-ebay] recorded the signing key expiry {"expiresAt":"…"}` — **once**,
   where the deploy before it logged the failure four times in two minutes.
4. 🟢 **Already proven:** migrations `20260921a_p62_signing_key_expiry` and
   `20260921b_p46e_sync_channel_etsy` both applied.

**Two observations from the same read, neither a defect:**

- 🔵 **Every 15-minute sweep logs TWICE**, 1.7 s apart, with different numbers
  (`deduped: 2` then `deduped: 3`). That is **one run per business profile**, which is correct
  with profiles ON — but a reader counting lines will double every alert total. Note it before
  calling a count wrong.
- 🔴 **CORRECTED 2026-09-21, later the same day — the earlier note here was WRONG in effect.**
  It said the `[ConfigManager] ⚠ Etsy configuration incomplete` boot line was not the blocker
  because the connect flow reads `getChannelApp('ETSY')`, *"a database-backed channel app"*, and
  concluded *"missing env vars do not stand between the Owner and a first live Etsy call."*
  **They do.** `getChannelApp` reads the `ChannelApp` row **and falls back to `envSeed(key)`**;
  with neither it throws `ChannelAppConfigurationError`. The right half of the claim (the
  ConfigManager line is the legacy path) was carried into a conclusion about a **different**
  mechanism that had not been checked. *A cause is not a verdict.* The live measurement is in
  §0a rows 5 and 6 and `build/P6.8.md`.

### 0b-prev. From the earlier deploy, still worth watching

1. ⏳ `p45b-ads-region-reconcile` daily line: **`regionCorrected=0`**, and **`marketCorrected=1`**
   on its first run only (the `IE`→`BE` repair), then 0. **NOT YET OBSERVABLE, checked
   2026-09-21:** the cron is scheduled and confirmed at boot
   (`{"schedule":"35 4 * * *","creates":"off"}`) but P4.5h shipped at ~11:00 UTC, *after* today's
   04:35 run. **First run that carries the fix is 2026-09-22 04:35 UTC.** An absent line today is
   "has not run", not "ran and found nothing".
2. Two alerts that are **correct**: `SHOPIFY has no sign-in callback registered` and `ETSY's
   sign-in callback is a development tunnel`.

## 0c. Rules that bind every session here

- **Ask first** for: a production **write**, a **live channel call**, a **P7 drop**.
  Production **reads** (Railway logs, deployments) are allowed. A blanket "implement
  the plan" does **not** lift these.
- **CADENCE: commit per slice, push per PACKAGE.** A push runs a ~5-minute gate and
  **deploys to production**.
- **Other sessions share this tree.** `git status` first, stage your own files **by
  name**, never `git add -A`.
- 🔴 **Never `git stash` here.** One `git stash push -u` swept two other sessions'
  files; it was popped within the minute and nothing was lost, but the near-miss is
  the warning. Use `git worktree`, or reason from the diff.
- Never `--no-verify`. Never lower a ratchet. Never weaken a test to make it pass.
- Migrations: apply to the **local** database only, after printing the host.
  🔴 `packages/database/.env` points at a **different** local database
  (`localhost:5432`) than `apps/api/.env` (`127.0.0.1:55439`) — `prisma migrate deploy`
  run from that package migrates the wrong one. Pass `DATABASE_URL` explicitly.
- `docs/channel-connections/build/` is **gitignored**; commit records with `git add -f`.
- **Railway variable reads are refused** by the auto-mode classifier
  (`[Credential Materialization]`). Project/service/deployment/log reads work. So every
  production *measurement* in P4.3d–P6.8 says "dev only".
- **Amazon's and eBay's API references cannot be read automatically** — Amazon's render
  only with JavaScript, eBay's answers **403**. Both blocked a row today (P4.5f, P6.7).

**Full suite, end of P6:** `10634 passed, 6 failed, 130 skipped` — the same two known
Amazon local-account files as every handover before it
(`amazon-validation-preview`, `amazon-classifications`). Neither is in any diff from
this session; they import `services/marketplaces/amazon.service.ts` and
`clients/amazon-sp-api.client.ts`.

**Other sessions' files in the tree — do not commit:** `.gitignore`,
`apps/factory/tsconfig.tsbuildinfo`, `.githooks/*`, `.graphifyignore`,
`docs/product-sheet/`, `graphify-out/`,
`docs/2026-09-21-shared-copy-unknown-market-handoff.md`.

## ▶ OWNER'S THREE DECISIONS — answered 2026-09-21

The Owner approved all three recommendations. What happened to each:

| # | Decision | State |
|---|---|---|
| 1 | **Do not reconnect Amazon Ads** | ✅ No action — and P4.5h found a **second, worse reason** not to (below) |
| 2 | **Settle the P5.2 envelope** | ✅ Turned into a **read**. `POST /api/amazon/financials/sync {"probe": true}` — see `build/P5.2.md` §5 |
| 3 | **The stale `IE` → `BE` Ads row** | ✅ Self-heals on the next daily reconcile — **no production `UPDATE` needed** (`build/P4.5h.md`) |

🔴🔴 **P4.5h — the reconnect landmine.** Checking *which column* to repair for #3 found
that the connect callback wrote `marketplaceStringId` (`APJ6JRA9NG5V4`) into
`AmazonAdsConnection.marketplace` — the column every reader matches with a **country
code**. Measured: all 9 rows hold `IT`/`DE`/`FR`/…, and `Campaign.marketplace` is `IT`
(150), `DE` (38), `FR` (22), `ES` (10).

**The first reconnect would have rewritten all nine rows to Amazon's ids**, after which
`adsProfileFor('IT')` finds nothing and the Ads write gate refuses **every market**
with *"no active Amazon Ads profile for marketplace=IT"*. A reconnect is meant to
repair a connection, not disable advertising. Fixed, and the daily reconcile now
corrects a stale market from the scope's own metadata.

⚠️ **A mutation SURVIVED and was worth chasing.** The "blanking a market" mutation
passed 21/21. Re-running it with an assertion that the pattern actually replaced showed
it had applied — so the hole was real, and it was in this slice's own guard:
`!data.marketplace` is true for an **empty string**, so a change that blanked a market
took the "nothing to do" branch. Now `Object.keys(data).length === 0` — **presence, not
truthiness.** Same family as the banked `Array.isArray([])` trap. **Always verify a
surviving mutation actually applied.**

## ▶ WHAT THE SECOND SESSION OF 2026-09-21 FOUND

Six defects, and **five of them were in code that said it was finished.** Every one was found by
measuring rather than by building.

| # | Found | How |
|---|---|---|
| 1 | 🔴 **P6.2 had never worked in production** — eBay returns epoch **seconds**, `new Date('1731536000')` is `Invalid Date`, so the write failed and took the once-a-day throttle with it: the sweep called eBay **every heartbeat**. Its tests asserted the **source text**, not the value | doing §0b: reading one log line |
| 2 | 🔴 **Amazon Orders page 2 was broken** — the window is not remembered by the cursor, and we sent neither `createdAfter` nor `lastUpdatedAfter`. Every test stubbed a single page, so the branch was unreachable | the live probe |
| 3 | 🔴 **The SB create request was wrong four ways** — `/sb/v4/ads` is PUT-only, `adType` does not exist, `campaignId` is not a create field, and required `name` was missing | reading Amazon's OpenAPI JSON |
| 4 | 🔴 **Finances: v0 and the new path cannot dedupe against each other** — different `amazonTransactionId` shapes, nothing bridging them. The plan's own next step would have **double-written money** | asking "is this safe to run?" before running it |
| 5 | 🔴 **channel-sync picked an arbitrary market** and invented a `_US` listing — both latent, 235 products loaded | P7a's census |
| 6 | 🔴 **The traffic instrument is broken** — Railway `http-requests` ignores `filterPath`; an impossible path returns the whole service total | a control |

### 🔴 The two rules that earned their keep

**1. "The vendor's docs cannot be read automatically" is a claim about the RENDERER.** eBay
403s bots and serves a **real browser** normally. Amazon's reference needs JavaScript to draw
itself but **fetches a plain JSON spec** `curl` can take. Both blockers dissolved; both had stopped
earlier sessions. **Ask what the page fetches.**

**2. Unreachable today is not unnecessary.** P7a had the Ads credential fallback convicted on "it
does not run". It stays: it is the only credential path with profiles OFF, it is the documented
revert lever, and P4.5e's disconnect enforcement is built on its `throw`.

### And two mistakes this session made, kept because they generalise

- **Two calls are two measurements.** One probe call's field paths were read against a *later*
  call's item count — different orders — and briefly looked like a serious defect. Comparing both
  numbers *in the same response* dissolved it.
- **An unwitnessed zero is not a zero.** The new Etsy freshness sweep logged only when rows
  existed, so an empty shop produced **silence** — indistinguishable from a crash. It took a
  positive control to tell them apart. Fixed: the census logs always, including `total: 0`.

## ▶ The 2026-09-21 start point (historical; start from COMPLETION-MATRIX now) — scope is AMAZON, eBAY and ETSY only

The Owner narrowed it on 2026-09-21: *"we'll add the remaining channels later. Currently, we'll
keep our focus solely on Amazon, eBay, and Etsy."* **P8 is deferred**, and Shopify and WooCommerce
fall out of the active set with it — Shopify publishing stays `gated`, and its open P6.8 callback
row is no longer urgent.

P7a is measured (nothing to delete) and P7b needs a green week plus a yes per drop. So the work in
scope is: the open rows in §0a for the three channels, and

**P7 has two halves, and only the first is yours to start** (FINAL-PLAN §6, P7):

| half | what | approval |
|---|---|---|
| **P7a — deletions** | *"Remove: the ghost engines, WooCommerce, the old eBay routes, `oauth-state.ts`, the old Ads fallback."* Code only — no data is lost | 🟢 covered by "implement the plan in order". **Measure each one has no caller first** — P1.6 deleted 26 files this way |
| **P7b — destructive DROPs** | `ChannelConnection.ebay*` columns, `AmazonAdsConnection`, `MarketplaceSync`, `Channel`, `Listing`, `EbayPushJob`, `AmazonFlatFileFeedJob`, `UserRole.channelScope` | 🔴 **each one needs its own yes, after a green week.** Ask; do not batch them |

🔴 **`AmazonAdsConnection` is on the P7b drop list and is still the live money path** —
25+ jobs, routes and services read it, and P4.5b's reconcile writes to it. CX.3c is the
package that moves ownership to `ConnectionScope`; **until that lands, that DROP is not
a candidate.** Say so rather than proposing it.

**Start P7a by measuring**, the way every package here has paid off: for each named
target, a derived census of its call sites with a known-live control, before deleting
anything.

---

**P6 is COMPLETE** as far as code can take it: `P6.2`, `P6.4`, `P6.6` (+**R-2**) and
`P6.8`'s instrumentation are built (all deployed); `P6.7` was **PARTIAL** at this point and was **resolved later on 2026-09-21** (nothing to add; see the package history above).

### Two P6 rows are waiting on the Owner, not on code

| row | what is left |
|---|---|
| **P6.7** | Read eBay's OAuth scope names in a **browser** (their docs answer 403 to an automated fetch), set `EBAY_CANDIDATE_SCOPES` on the deploy, read the verdicts, add only the accepted ones, then reconnect both accounts. `build/P6.7.md` §4 |
| **P6.8** | Register the production HTTPS callbacks in **Shopify's** and **Etsy's** consoles. `build/P6.8.md` §4 |

🔴 **Do not add an eBay scope without the probe's verdict.** One scope outside the
keyset makes eBay refuse the WHOLE consent request and name none of them — that is how
every eBay connect was broken from 2026-08-29 to 2026-09-16.

### What P6 found

- **P6.2** — the eBay signing key that signs **refunds and finances** had **no known
  expiry**: eBay returns `expirationTime`, we logged it into an event and dropped it,
  and `getEbaySigningKey` (a READ that returns it) had **zero callers** — the fifth
  such accessor this programme has found.
- **P6.4** — only **1 of 5** channels can be revoked through an API, and the screen said
  *"Disconnected"* in a **success** tone for the other four while the grant kept
  existing at the channel. `revokedAtChannel` was returned by the API and read by
  **nobody**.
- **P6.6 / R-2** — D1 = A confirmed, and **production is already off the env token**
  (the deploy log says so). The fallback was **not** deleted: that is the largest blast
  radius available, and "the stored grant works" is an inference from the app
  functioning, not a measurement.
- **P6.8** — ETSY's production callback is an **ngrok tunnel** and SHOPIFY has **no
  redirect URI at all**.

### 🔴 The trap that appeared TWICE in one package

`channel-alerts.job.ts` selected `ChannelApp` rows `where: { secretExpiresAt: { not:
null } }`. P6.2 widened it to an `OR` — and P6.8 then found that **Shopify and Etsy have
both dates null**, so the rows its new alert exists for would never have been selected
and the alert would have been **dead on arrival**.

**Selecting on the presence of a value is how a row with nothing set stays invisible.**
The filter is gone (`where: {}` — five rows) and each alert keeps its own guard.

### And one mutation-discipline note

A surviving mutation was chased down twice today and was **real both times**. Re-run any
mutation that passes, with an assertion that the pattern actually replaced — a mutation
that does not mutate proves nothing, and one of these had a genuine hole behind it (a
truthiness check where presence was meant).



**P4.5 and ALL of P5 are COMPLETE.** P4.5: seven slices,
`build/P4.5a.md` … `build/P4.5g.md`. P5: `P5.1` (shipped 09-20), `P5.2`, `P5.3`,
`P5.4`; **P5.5 is not needed** (P0.8 — eBay Search Returns is not on the decommission
list).

🟢 **P4.6 (Etsy writes) is NOT blocked on a decision — the decision is already made.**
FINAL-PLAN §14.3 records `D6 = B` from the Owner on 2026-09-19: *"stay read-only until
Shopify is live"*. Shopify publishing is still `gated` in production. So P4.6 is
correctly not-to-be-built, not waiting on an answer. Do not re-ask.

**P4.5 production proof (deployment `fc2bbdf5`, SUCCESS 2026-09-21 06:20 UTC):**
`p45b-ads-region-reconcile cron: scheduled {"schedule":"35 4 * * *","creates":"off"}`
— scheduled, with row creation off, exactly as designed. Watch its first daily line:
**`regionCorrected` should be 0.** Anything else means production has Ads profiles
stranded on the wrong API host.

### What P5 found

- **P5.2** — half a counterweight. The `2024-06-19/transactions` path is **already
  built and already on the gateway**; what is missing is the switch. It has **0 calls
  ever** against v0's 112. 🔴 Its parse read `data.transactions ?? []`, so a wrapped
  envelope would have returned **success with 0 transactions** — a settlement day
  recorded as a quiet day, on the money path. That is P5.1's *three envelopes in one
  migration* finding, one package later, in a second place.
- **P5.3** — both remaining `2024-01` sites were dead, and this time **measured**:
  `/admin/api/2024-01/` has 0 rows in the call ledger while every Shopify call is on
  `2026-07`. The previous session had inferred it from "production has no `SHOPIFY_*`
  variable"; the ledger says it directly. `2024-01` was not the cautious value it
  looked like — it has been out of support for over a year, so the path was broken on
  both versions.
- **P5.4** — a clean counterweight: the question was *"are we handling buyer PII
  correctly?"* and the answer is *"we are not handling it at all."* 0 emails, 0
  customer ids, 0 street addresses across 4,464 orders, and all 4,464 names are the
  literal fallback. 🔴 The risk runs the other way, so a census now holds the
  no-Restricted-Data-Token decision.

**P5.2's row is NOT closed**, and `build/P5.2.md` §5 says what would close it: one live
`{"useV0": false}` call, a count comparison against v0 over a window with known
settlements, then flip the cron and the default together. Deadline **2027-08-27**.

🔴 **Two of its rows did not end where the plan pointed, and both matter:**

1. **"Reconnect once for a true expiry date" — DO NOT DO IT (P4.5g).** All nine
   Ads rows carry `tokenIssuedAt = 2026-05-17`, and that estimate is a
   conservative FLOOR, so the true consent is at or before it — **before Amazon's
   2026-07-30 cut-off.** The token therefore has **no expiry**, and a reconnect
   would CREATE one. The screen said otherwise because
   `ChannelConnection.refreshTokenExpiresAt` is `lastRefreshAt + our own 365-day
   constant`, and the route called that `measuredExpiry` and set
   `isEstimate: false` from it.
2. **"Default to Manual Collection" — NOT DONE, on purpose (P4.5f).** The wire
   value could not be established: Amazon's `/sb/v4/ads` reference renders only
   with JavaScript, and `/sb/v4/ads` has **0 calls ever** so there is no stored
   answer either. The silent default to the deprecated entity is gone (an omitted
   type is now refused), but the value was **not** replaced by a guess. To close
   it: one captured 200 from a real `POST /sb/v4/ads`, or the enum read off
   Amazon's rendered reference.

**The biggest defect P4.5 found was not in its own rows.** P0.7 had deferred one
line to P4.5 by name — *"eBay Promoted Listings writes (ads, not listings;
P4.5)"* — and it was a wrong-account write: 13 write paths loaded an
`EbayCampaign` (which carries a required `channelConnectionId`) and then asked
for the **primary** account's token. It was latent only because a **second**
defect hid it: the entity sync also visited one account, so no second-account
campaign could ever enter the database. Fixing either alone would have been
worse than fixing neither.

Then **P4.6** (needs D6) → the rest of **P5** (P5.3 measured, P5.2 / P5.4; P5.5
not needed) → P6.2 / 6.4 / 6.6 / 6.7 / 6.8 → P7 (each drop needs a yes) → P8.

🔴 **THE LESSON, and it has now held for twenty-seven rows: the plan row is
usually NOT the defect.** Across P4.1–P4.5, **ten rows were counterweights** —
P4.5 added the eBay Promoted Listings gateway row (done in P1.2) and the
three-region discovery row (the CX connector already sweeps all three; the money
path was the gap). And P4.5 added a **new shape: the plan row that is the wrong
INSTRUCTION** — "reconnect once for a true expiry date" would have destroyed the
property it was trying to measure. Earlier — already
built, or built better than the row described, or describing the wrong build
entirely (P4.4d: "build the eBay price push" would have produced a *second* eBay
sender). The real defects were in **failure paths** and in **drifts** between two
builders. **Measure the row before you build it.**

🔴 **The three sharpest new ones, from P4.5:**

- **A derived number can wear a measurement's badge.** `refreshTokenExpiresAt`
  is `lastRefreshAt + spec.auth.refreshTokenLifetimeSec` — our own constant —
  and the route called it `measuredExpiry` and set `isEstimate: false` from it,
  over a comment saying *"the grant reported a real refresh-token lifetime"*.
  **Ask where a value came from before believing its confidence flag.**
- **Two defects can hide each other, and fixing either alone is worse than
  fixing neither** (P4.5a). The ads write misroute was invisible because the
  entity sync could not produce the data that would expose it. Landing the sweep
  on its own would have made every second-account campaign's writes go to the
  first account.
- **Restraint is a deliverable.** P4.5c would not move a working consent URL to
  close a gap nobody has hit; P4.5f would not replace a deprecated wire value
  with an unverifiable one on a path that has never run. *Predict before you
  write* cuts both ways: **a change whose correct value cannot be stated in
  advance is not a fix.**

🔴 **From P4.4:**

- **Ask what a failure path's PREMISE is before hardening it** (P4.3e), and
  **do not let four fixed fail-opens make refusing automatic** (P4.4c). The price
  bounds guard fails OPEN on purpose: most products have no bound, so "could not
  read" and "none set" are the same population, and refusing every price push on
  a hiccup would take pricing down to protect a bound that does not exist. The
  EU quantity guard is the opposite case and fails closed. **Scepticism has to be
  symmetric — including about your own instinct to convict.**
- **A comment can assert a property of the WORLD, or of our own database, that is
  not true** — and the code stays wrong for as long as it is believed.
  *"EU marketplaces (IT, DE, FR, ES, NL, BE, SE, PL) all use EUR"* (SE is SEK, PL
  is PLN) and *"Could read from Marketplace.currency when that becomes a real
  field"* (it is a required column, and four services read it).

**Standing instruction from the Owner (2026-09-20):** *implement the whole plan in
order, without stopping, unless I specifically ask you to stop.* Recommendations are
accepted by default — take the pick and carry on. Do not pause between packages for
approval; commit, push and move to the next one.

**The rules that still bind:** ask first for a production **write**, a **live channel
call**, or a **P7 drop**. A blanket "implement the plan" does not lift those.

**🔴 The flat-file no-touch rule is LIFTED (Owner, 2026-09-20):** the flat-file
routes and pages are ordinary files.

⚠️ **Session note (2026-09-21):** Railway **variable** reads were refused by the
auto-mode classifier again during P4.5 (`[Credential Materialization]`), so every
production measurement in P4.3d–f, P4.4a–e and P4.5a–g says "dev only". Railway
project/service listing DOES work. If your session can read the production
database, the open questions are listed in each build record's §4.

🟢 **Web research works and is part of this programme** (P0.8 was done that way).
But **Amazon's Ads API reference renders only with JavaScript**, so `WebFetch`
returns the page title and nothing else — P0.8 hit this on the deprecations page
and P4.5f hit it again on `/sb/v4/ads`. A JavaScript-capable browser is what that
needs.

Read in this order:

1. `docs/channel-connections/FINAL-PLAN.md` — the one plan. Section 6 has the package rows; section 14 has the rules (14.1), the progress table (14.2) and the Owner's decisions (14.3).
2. This file — where work stopped, what is next, and the traps that cost time.
3. The build record of the package you touch: `docs/channel-connections/build/<ID>.md`.

---

## 1. Rules from the Owner (in force)

- 🔴 **2026-09-26 — releases go by pull request; the Owner decides each merge.** Settings on `main` deny direct pushes. The "push per package" rules below are history: a pushed branch plus a PR replaces them, and a migrating release carries a recovery branch.

- "Start to implement the whole plan. I'll stop you where we need it." → packages run **in plan order**, no per-package "go". Commit each package when its proof is green.
- **Ask first** for: any production **write**, any **live channel call**, each P7 drop, and the Owner-only steps in plan section 8. Production **reads** (Railway traffic and logs) are allowed since 2026-09-20.
- **Pushing is allowed** (Owner, 2026-09-20) once the package's proof is green. A push deploys to production and **applies migrations there**.
- 🔴 **CADENCE (Owner, 2026-09-20, after 16 pushes in one session): COMMIT per
  slice, PUSH per PACKAGE.** Commits are free and keep the history reviewable.
  **A push is not free**: it runs the full pre-push gate (~5 min) and **deploys to
  production**. Splitting a package into slices is good; pushing each slice is
  not — that is 16 production deploys where 4 would do. Let the slices pile up
  locally and push once the package's proof is green, which is what the rule
  above already said and what I stopped doing.
- ~~Flat-file routes need a yes per change~~ — **LIFTED 2026-09-20.** The flat file is
  being rebuilt, so `apps/api/src/routes/{ebay,amazon}-flat-file.routes.ts` and
  `apps/web/src/app/products/*-flat-file/**` are ordinary files. No edit list, no ask.
- Never `--no-verify`. **Never lower a ratchet baseline to make it pass.** **Never weaken a test to make it pass** — if a test proves a real defect, fix the code (that is how the P1.3 per-row read was caught).
- Migrations: apply to the **local** database only (check the host is `127.0.0.1` first); production gets them from the deploy.
- Other sessions share this tree. `git status` first. Do not touch their files: the assortment files, `.githooks/post-commit`, `.githooks/pre-push.backup`, `docs/channel-connections/PLAN.md`, `RESEARCH.md`, `full/`, `apps/web/src/app/settings/sharing/`.
- Reports to the Owner: simple English, short sentences, **max 2 options with a pick**.

## 2. Done — on `origin/main`

**Newest (2026-09-26):** PR #4, PR #14, PR #15 (Package A) and PR #32 (release B+C) — see [COMPLETION-MATRIX](COMPLETION-MATRIX.md). The 2026-09-22 release C1–C8 is in [RELEASE-C1-C8](RELEASE-C1-C8.md). The list below is the 2026-09-21 state.

**P0 – P3.6, P5.1, P4.1, P4.2, P4.3 and P4.4 are all deployed and live.** The
newest is deployment `f7cd8154` from `18ff48dce`: SUCCESS.

| Package | Shipped | Records |
|---|---|---|
| **P4.3 (stock)** | 2026-09-21, deploys `96f781a1` + `a99c469c` | `build/P4.3a.md` … `P4.3f.md` |
| **P4.4 (price)** | 2026-09-21, deploys `a99c469c` + `f7cd8154` | `build/P4.4a.md` … `P4.4e.md` |
| **P4.5 (advertising)** | 2026-09-21, two pushes (`c8b483c2c` carried a–d with another session's) | `build/P4.5a.md` … `P4.5g.md` |

Eleven slices across the two, each with its own build record, mutation table and
gate results. Section 3d and the P4.3 block in section 3 carry the one-line
findings; the build records carry the measurements.

**Earlier:** deployment `92ec6158` from
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
| P4.3b | **The EU shared-quantity guard fails CLOSED (D9).** Its `catch` allowed the push and said so as a principle; the Owner had already ruled "hold the push and alert". 🔴 **The fourth fail-open found in one day** — a rule's `catch` is where it goes to die. Held + alerted under its own conflict type, because "we could not check" is a different fact from "we checked and found a conflict" | `<this push>` | `build/P4.3b.md` |
| P4.3a | **Etsy does not get to write our stock.** 🔴 `syncInventoryFromEtsy` wrote Etsy's quantities into `ProductVariation.stock` and `Product.totalStock` directly, bypassing the resolver, the shared-stock pool and any audit. It had never run — a manual trigger one env var away from silently overwriting pooled stock. Refusal + a sentence; the behavioural test replaces prisma with a Proxy that THROWS on any access | `<this push>` | `build/P4.3a.md` |
| P4.2d | **The sweep actually runs.** 🔴 P4.2c shipped it into `CRON_REGISTRY` only — a MANUAL trigger, which is the very state P4.2c called the defect — and I told the Owner "one variable starts detecting drift". False: nothing called it. Scheduled now, on the SAME switch (two switches would give a job that runs every 6 h and returns "off" every time) | `<this push>` | `build/P4.2d.md` |
| P4.2c | **Image read-back for Amazon and Shopify + the R-5 census.** Census = counterweight (all publishers already gated). 🔴 Read-back existed on all three channels and was SCHEDULED on one — a read-back that runs only when somebody opens a screen cannot detect drift. Sweeps bounded per run, `unconfigured` counted apart from `empty` so a blind run cannot read as a clean one. OFF behind one variable (spend, not doubt) | `<this push>` | `build/P4.2c.md` |
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

- `seedEnvManagedConnections: persisted Amazon authorization exists — skipping env synthesis {"existingId":"…"}`
- `[amazon-notifications] reusing existing destination {"destinationId":"…"}`
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

## 3. What was built on 2026-09-20/21, and what each package found (historical; current states in COMPLETION-MATRIX)

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

**P4.2c closes two more rows.** The R-5 census is a COUNTERWEIGHT: every image
publisher already goes through the gateway and a gate — proven by the ratchet at
`{"EBAY":0,…}`, not by a grep. 🔴 My own first grep said
`amazon-media-publish.service.ts` was ungated; it was WRONG (it reaches both
through `amazon-media-client.ts`). **A census built from a hand-written pattern
list is a set claim.** And read-back: all three channels had the FUNCTION, only
eBay had the HABIT — a read-back that runs only when somebody opens a screen
cannot detect drift. Amazon + Shopify sweeps built, OFF behind
`NEXUS_ENABLE_IMAGE_READBACK_SWEEP` (`build/P4.2c.md`).

**P4.3 (stock) started.** 🔴 P4.3a removed the **Etsy inbound stock write**, and
it was worse than the row said: `syncInventoryFromEtsy` wrote Etsy's numbers
straight into `ProductVariation.stock` AND `Product.totalStock` with
`prisma.update` — bypassing the stock resolver, the shared-stock POOL (where a
pooled product's own stock is deliberately 0) and any audit. **It had almost
certainly never run** (registry-only manual trigger + no Etsy env config), and
**that is what made it dangerous rather than harmless**: one environment variable
away from overwriting pooled stock silently. Now a refusal that says why
(`build/P4.3a.md`). 🔴 **P4.3b made the EU shared-quantity guard FAIL CLOSED (D9).** Its `catch`
said *"Guard infrastructure failing must not stop legitimate pushes"* and allowed
the send — the Owner had already ruled the opposite in **D9: hold the push and
alert**. Amazon holds ONE merchant quantity per SKU across the EU markets, so if
the guard cannot run we do not know whether the push fights a sibling market's
intent, and the incident behind this guard is a scoped Zero that blanked an
entire storefront. **"We could not check" is not "there is no conflict."** Held +
alerted under its OWN type `EU_SHARED_QTY_GUARD_UNAVAILABLE` — reusing the
conflict type would blame the operator for OUR failure (`build/P4.3b.md`).
⚠️ **Watch after the deploy:** a rise in that type means the guard's query is
failing, not that listings disagree.

**P4.3 is COMPLETE (2026-09-21).** Four more slices, each with its own record:

- **P4.3c** — 🔴 `PATCH /api/catalog/products/:id` ran the stock cascade AND
  queued a second, product-level row carrying the product's **gross**
  `totalStock` with no listing named. With no listing, `syncToAmazon`'s `cl` is
  null, so the send-time re-read is skipped, `stockBuffer` reads 0 and **D9's EU
  shared-quantity guard never runs at all** (it is gated on `cl?.marketplace`,
  and `''` is in no set) — P4.3b had made that guard fail closed one slice
  earlier and this row walked around it. Its twin `PATCH /api/products/:id` had
  always left it to the cascade. The rule is in the engine now: `prepareRows`
  refuses an unnamed quantity row, so a 75th producer cannot forget it.
  🔴 **My first census was wrong in the banked way** — a literal scan for
  `syncType: 'QUANTITY_UPDATE'` misses a producer that passes it as a ternary
  ARGUMENT. Re-derived over the 74 creation CALL SITES: exactly two.
- **P4.3d** — the oversell clamp's ceiling summed **every** warehouse row the
  product held, routed or not, while the quantity being clamped was routed. Two
  derivations of one number, and the cap was the wider one. One routing filter
  now (`routedLedgerRows` / `routedAvailable`), shared with the resolver, in all
  **three** lanes — the plan named Amazon, but fixing only Amazon re-creates the
  drift. 🟡 On the dev database the gap is **latent**: 0 of 3 locations set
  `syncRoutes` and 0 of 1,003 listings pin a source. "Nothing routed" is refused
  (`NO_ROUTED_LOCATION`), never capped to 0 and sent.
- **P4.3e** — the shared eBay fan-out never coalesced, because its rows have no
  `channelListingId`. The dispatch re-read is a real counterweight (no stale
  number reached eBay), **but its `catch` falls back to enqueue-time
  quantities.** See the header: the fix was to make that fallback's premise true,
  not to harden it.
- **P4.3f** — Shopify had no scheduled quantity read-back. Its write-time check
  is the **strongest of the three channels** (read, compare-and-set, read back,
  throw), but a read-back that only runs when we push cannot detect drift.
  🟢 **P5.3's `hasCreds()` warning does not apply to it**: `hasCreds` has one
  definition and one call site, both in the legacy REST image reader, while the
  stock path runs on the CX connection's token and reads no `SHOPIFY_*` variable.
  Scheduled in `index.ts`, ON with an opt-out, because registry-only is a manual
  trigger.

**The only P4.2 row left is the eBay Media-API decision (R-1)** — our own image
URLs or eBay-hosted copies. That is a design choice about where images live, not
a defect, and it is the Owner's with R-1.

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

### 3d. P4.4 (price) — COMPLETE 2026-09-21, five slices

- **P4.4a** — 🔴 **one fact, EIGHT implementations.** `Marketplace.currency` is a
  required column, correct for all 20 dev rows (PL=PLN, SE=SEK, TR=TRY, US=USD),
  and read by four services. Every outbound price write ignored it and re-derived
  the currency from the market code — including **two functions with the
  identical name `currencyForMarket` in two different files, neither importing
  the other**, and `marketplaces/ebay.service.ts` using ONE env currency for
  every market on three live price writes. They agreed on EUR/GBP, disagreed on
  everything else, and did not even agree on the fallback (ten EUR, one USD).
  One accessor now, which REFUSES an unconfigured market. A ratchet holds it,
  runs **its own detector controls** before reporting a pass, and **re-derives
  each exemption's written reason**. 19 test doubles needed a Marketplace row —
  the honest cost of moving a fact out of code into data.
- **P4.4b** — the catalog PATCH queued a duplicate product-level PRICE row
  beside the per-listing cascade. Worse than the stock twin: a listing with
  `followMasterPrice: false` is deliberately at another number, and with no
  listing the push cannot read the stored sale window, so it **wipes a scheduled
  sale**. 🔴 And the repricer had two more: no listing while `listing.id` sat
  four lines above, and a payload key `newPrice` the dispatcher does not read —
  it would have reported a live reprice and sent **no price at all**. Off behind
  `NEXUS_REPRICER_LIVE`, which is the only reason it has cost nothing.
- **P4.4c** — `Product.minPrice`/`maxPrice` bound **nothing**: 0 occurrences
  across all seven price-writing paths, 16 in `repricing.service.ts` as the
  positive control — and those 16 are a **different pair on a different model**.
  It REFUSES rather than clamps, and **fails OPEN** (see the header).
- **P4.4d** — the eBay "stub" was the wrong build. eBay price pushing already
  works three ways; what was missing was a way for the pricing dispatcher to
  reach one. It enqueues now, and P1.1's ratchet at `{"EBAY":0,…}` is the proof
  no second sender was built.
- **P4.4e** — 🔴 both read-backs **already fetched the price and threw it away**
  (`CatalogItem.price` from the daily Amazon report; Shopify's `VARIANT_QUERY`
  selects `price`), so the price read-back costs **zero extra API calls**. It
  reports and does **not** heal. eBay is the one channel where this row would
  cost a real call, and it is not built.

### 3e. P4.5 (advertising) — COMPLETE 2026-09-21, seven slices

- **P4.5a** — 🔴 **the biggest one, and it was not a P4.5 row.** P0.7 deferred it
  here by name: *"eBay Promoted Listings writes (ads, not listings; P4.5)."*
  `EbayCampaign.channelConnectionId` is a **required, related column**, and **13
  write paths** loaded the campaign and then asked for the **primary** account's
  token (22 sites in all across writes, routes, reports and the sync). Latent only
  because a **second** defect hid it — the entity sync also visited one account and
  reported `connections: 1`, so no second-account campaign could enter the
  database. **Fixing either alone is worse than fixing neither**, so both landed
  together. Naming the account also buys a refusal "the primary" can never make: it
  is by definition active, so a write aimed at a *disconnected* account silently
  became a write to a live one.
- **P4.5b** — discovery in three regions **already runs**: the CX connector sweeps
  all three on every heartbeat and has recorded **14 profiles** (9 EU, 3 NA, 2 FE).
  `AmazonAdsConnection`, which 25+ jobs read, holds the **9 EU ones** — US, CA, MX,
  AU and JP are invisible to every ads job. 🔴 And `listAdsProfiles()`, the accessor
  that reads the scopes and returns all 14, has **zero callers**. The region→host
  fact was written out **five times**, two of them EU-only, which is the cause. One
  accessor now, which refuses an unknown region. Creating the missing rows is off
  behind `NEXUS_ADS_ALL_REGIONS` (spend); correcting a row's region always runs.
- **P4.5c** — **restraint.** The NA-for-every-region consent page is a real gap and
  **not** a live breakage: this grant was obtained through it. Made explicit
  (`NEXUS_ADS_CONSENT_REGIONAL`, `/connect?region=`) with the default unmoved — and
  the pre-existing `spec.vitest.test.ts:72` assertion is the control proving it.
- **P4.5d** — a **counterweight with a real fix inside**. `fetchReport` sent no v3
  media type while `createReportJob` did, on the same endpoint. But **1,135 of
  1,197** real creates answered **200** without it, and zero 415s — 10 of the 400s
  and all 9 of the 425s came from the builder *without* it, which are answers Amazon
  can only give after parsing the body. Corrected, and a **parity gate** now holds
  the two builders equal.
- **P4.5e** — 🔴 a disconnect **creates** the condition its own leak needs.
  `revoke()` nulls eight columns, all on `ChannelConnection`, and sets
  `isActive: false` — which is exactly what makes `resolveConnection` throw,
  `credentialsFromCore` return null, and the Ads client fall back to
  `AmazonAdsConnection.credentialsEncrypted`. **Ads calls carried on after the
  operator disconnected.**
- **P4.5f** — the silent default to the deprecated `productCollection` is gone, and
  the wire value was **NOT** replaced by a guess (§ START HERE). `shutdownDate` is
  **null**, not January 2027: that date is third-party only, and storing it as
  Amazon's is how a rumour becomes a deadline.
- **P4.5g** — the reconnect row **inverts** (§ START HERE), and the screen's
  confident expiry date came from our own constant wearing a measurement's badge.

**The only P4.5 row left open** is the Sponsored Brands wire value (P4.5f §4) and
the eBay Media-API decision (R-1, the Owner's).

### 3c. The order from here

**P6.2 / 6.4 / 6.6 / 6.7 / 6.8** → P7 (each drop needs a yes) → P8.
P4.6 waits on Shopify going live, not on an answer (D6 = B, already decided).

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
| **eBay** | 🔴 **CHECKED 2026-09-21, and the check itself was broken.** `GET /api/admin/ebay-notification-status` answered `endpoint: null, destination: null, subscriptions: [], catalogueSize: 27`. The 27 proves the call **reached eBay**, so the nulls are not a transport failure — but the handler read `EBAY_NOTIFICATION_ENDPOINT` while every other reader reads `EBAY_NOTIFICATION_ENDPOINT_URL`, so `destinations.find(d => d.endpoint === null)` reported *no destination* **whether or not one existed**. Fixed through the one accessor, with `configured`, `destinationsAtEbay`, `destinationEndpoints` and the full `catalogue` added (`build/P2.3.md`). 🔴 **`subscriptions: []` IS a real zero — nothing is subscribed in production.** ✅ **Re-read after the fix deployed: `destinationsAtEbay: 0`** — eBay holds **no destination and no subscription**, and that is now a measured zero. 🔴 **eBay delivers no notifications to Nexus at all.** The reconcile is armed (`cron started {"schedule":"55 3 * * *"}`) and both variables are set, so three preconditions hold and the fourth does not follow; the 03:55 deployment is REMOVED and its logs are gone, so *why* is **could-not-measure**. **2026-09-22 03:55 UTC logs its own reason.** `ITEM_SOLD` is **not** among eBay's 27 ids — `ORDER_CONFIRMATION` is, and is deliberately **not** swapped in: it has no handler, and `catalogue` now carries the real list so the next change READS it |
| **Shopify** | Sends nothing until the registration is run per shop (section 5) |
| **Etsy** | Sends nothing until the Owner configures the portal (section 5) |
| **Amazon** | **CONNECTED and live** — a persisted authorization, a reused notification destination, `Amazon=live` at boot. 🔴 An earlier version of this row said "not configured", read off a cron skip that came from the OTHER of the TWO business profiles. A per-profile skip is not a global fact. Still true: no ORDER_CHANGE arrived in a deploy window, so P2.2's parse fix remains unexercised by real traffic |
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

### 🟢 5.0 Closed since 2026-09-21 (kept for history)

**One of the three closed.** ✅ `NEXUS_ENABLE_IMAGE_READBACK_SWEEP=true` was SET
in production on 2026-09-21 — the image read-back sweep is ON. Its first runs are
at `25 2,8,14,20` UTC; the line to look for is
`image-readback-sweep … AMAZON: eligible N · scanned N …`, and `unconfigured`
counted apart from `empty` is what says whether it could actually run.

Still the Owner's:

1. ✅ **Done 2026-09-21** — the P5.1 probe ran and answered (§0a row 1). Kept for history:
   `GET /api/admin/amazon-orders-2026-probe?days=7` — admin-gated, read-only, ONE
   `searchOrders` call, does NOT turn the switch on. The Owner chose option B
   (one captured live read before the migration goes live). Until it runs, P5.1
   is proven against Amazon's published model and its own example response, and
   against **no real payload**. See §14a. 🔴 **An agent cannot run this** — it
   sits behind the operator's admin session.
2. ✅ **Answered 2026-09-22 — both are connected** (Etsy in another business profile). Kept for history: **Etsy and Shopify: are they connected?** The Owner believes Etsy is and is
   unsure about Shopify. ⚠️ **The logs cannot answer this, and that was retested
   on 2026-09-21 from four angles** (`PUBLISH MODES` is the publish mode not a
   connection; `cx-heartbeat` logs only that it started; `connectionsTried` had
   not ticked in the new deploy; `ConfigManager` is the LEGACY env config). **One
   look at the Channels screen settles it.** Two things will also answer it on
   their own schedule now: the image sweep's `unconfigured` count, and
   `shopify-qty-readback` (`15 */6 * * *`) reporting `checked=N` with N > 0.

### 5.0b New, from P4.4 (2026-09-21)

3. **Rule on automatic PRICE correction.** P4.4e detects price drift on Amazon
   and Shopify and **reports only** — it heals nothing. The quantity read-back
   beside it does heal, but a price heal is a money write made by a machine on a
   schedule, with nothing above it but the floor and ceiling most products do not
   set. `NEXUS_ENABLE_PRICE_READBACK_HEAL=true` turns it on, read as exactly
   `'true'`. **Recommendation: leave it OFF** until the first runs show how much
   drift is real. `build/P4.4e.md` §2.1.
4. **`NEXUS_REPRICER_LIVE` is still off, and it is now safe to consider.** P4.4b
   fixed two defects inside it that would have bitten the moment it was switched
   on: the row named no listing, and its payload key (`newPrice`) is one the
   dispatcher does not read — so it would have recorded a live reprice and sent
   **no price at all**. Still the Owner's call, and still a live money write.
5. **A price now REFUSES outside the product's floor / ceiling** (P4.4c,
   `PRICE_OUT_OF_BOUNDS`). If operators have stale bounds on products, this will
   start stopping sends that used to go. That is the point, but it is a
   behaviour change worth knowing about.



1. **P1.8: the contract run is ON (since 2026-09-21) but checks nothing yet.** `NEXUS_ENABLE_CHANNEL_CONTRACT_RUN=true` is set; every run reports "not configured" until one sandbox account per channel is named (`NEXUS_CONTRACT_ACCOUNT_EBAY`, `…_AMAZON_SP`, `…_AMAZON_ADS`, `…_SHOPIFY`, and `NEXUS_CONTRACT_AMAZON_SELLER_ID`). Shopify needs a development-store account named. **Etsy is not applicable** (review rework 2026-09-26): it has no sandbox, so the run sends nothing to Etsy, leaves it out of the verdict and states that reason in every summary; a run can be green without it. A test listing on the real shop, marked "test", remains the Owner's decision. The Amazon SP checks read Amazon's fixed sandbox examples, so they prove sign-in and reachability only (`build/P1.8.md` section 7).
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
8. **eBay's live notifications — corrected 2026-09-26.** Setting `EBAY_NOTIFICATION_ENDPOINT_URL`
   (the public `/api/webhooks/ebay-notification` URL) and `EBAY_NOTIFICATION_VERIFICATION_TOKEN`
   (32–80 characters, only `[A-Za-z0-9_-]`) is necessary but **no longer starts anything**: the
   nightly reconcile is scheduled only with `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1` (exactly `1`),
   and every topic in `services/cx/connectors/ebay/notifications.ts` is marked `handlerMissing`, so
   setup refuses before any subscription call. eBay also refused the current token twice. Order
   notices need subscriptions made with each seller's token (not built). Planning: eBay
   notifications end to end. `GET /api/admin/ebay-notification-status` still reports the state.
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
11. **Amazon and eBay inbound events cannot be replayed from the ledger** (P2.1 section 4). Amazon's handling lives inside the SQS poll loop, eBay's inside the live notification envelope; neither can be re-run from a stored payload. Both are named in the guard's `UNREPLAYABLE` map and the worker dead-letters them on the first sweep with that reason. *(Superseded for eBay 2026-09-26: Package A stores verified eBay receipts and replays them through their own processor; processing is OFF.)*
12. *(Historical, 2026-09-20.)* **Amazon ledger rows sat at `pending`** with no `nextAttemptAt`, so the retry worker did not see them; `replayInbound` accepts them by hand. PR #4 changed claiming and scheduling for trusted rows — re-measure before relying on this.
13. ~~**The archiver does not exist.**~~ **Deployed 2026-09-26 (Package A, PR #15):** eligible finished receipts are archived in place, never deleted (D8); personal data in untrusted and archived rows expires by UPDATE after the retention window.
14b. ✅ **Done 2026-09-21 — the image read-back sweep is ON.** Kept for history: **turn the image read-back sweep ON.**
   `NEXUS_ENABLE_IMAGE_READBACK_SWEEP=true`. Measured cost on the DEV database
   (parents/standalone only): **AMAZON 29 reads, SHOPIFY 1 read per sweep**, four
   times a day, against a 5/second quota and capped at 400 products
   (`NEXUS_IMAGE_READBACK_MAX_PER_RUN`). Production is larger and **uncounted**,
   but eBay's equivalent has run every 6 h all along. With it off, image drift on
   Amazon and Shopify stays invisible until somebody opens the images panel.
   🔴 **P4.2c shipped it registry-only — a MANUAL trigger** — and was reported
   as "one variable starts detecting drift", which was FALSE. P4.2d added the
   schedule (`build/P4.2d.md`). Env is the Owner's authority.
14a. **🟢 THE OWNER CHOSE OPTION B (2026-09-20): one captured live read first.**
   `GET /api/admin/amazon-orders-2026-probe?days=7` — admin-gated, read-only, ONE
   `searchOrders` call. It does **not** turn the switch on. It reports the field
   PATHS Amazon actually sent (no values), the mapping checked against them, the
   mapped v0 order with buyer data redacted, and `wouldStoreUnitPrice` so the
   money question needs no arithmetic from the reader. It also answers the two
   things only a live call can: whether `paginationToken` may travel with
   `includedData`, and whether `marketplaceIds` is accepted as the SDK sends it.
   **Run it, paste the answer, and P5.1 is verified rather than argued.**
14. **Amazon Orders 2026-01-01 is deployed and OFF** (P5.1; the live probe passed 2026-09-21, §0a row 1). Turn it on with
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

- 🔴🔴 **DO NOT LET FIXED FAIL-OPENS MAKE REFUSING AUTOMATIC.** Four were fixed
  in P4.1–P4.3, so by P4.4c "refuse on failure" felt like the rule. It is not.
  The price-bounds guard fails **open** on purpose: most products have no bound,
  so "could not read" and "none set" are the same population, and refusing every
  price push on a database hiccup would take pricing down to protect a bound that
  does not exist. Ask what the two populations actually are before choosing.
- 🔴🔴 **A COMMENT CAN ASSERT A PROPERTY OF THE WORLD, OR OF YOUR OWN DATABASE.**
  *"EU marketplaces (IT, DE, FR, ES, NL, BE, SE, PL) all use EUR when listing on
  Amazon"* — SE is SEK and PL is PLN. *"Could read from Marketplace.currency when
  that becomes a real field"* — it is a required column and four services read
  it. Both comments justified the wrong code for as long as they were believed.
- 🔴🔴 **A TEST THAT MOCKS THE THING IT DEPENDS ON CAN NEVER CONVICT IT.**
  P4.4e's Shopify read-back mocks `listing-write.service.js`, so no arm of it
  could catch a reader that stopped returning the price — a mutation proved it
  green. *The arm that would have failed is the one never run.* Exercise the real
  collaborator somewhere, even if only in one small block.
- 🔴 **`String.replace` TAKES THE FIRST MATCH, AND INDENTATION MAKES ONE LINE A
  SUBSTRING OF ANOTHER.** A 6-space `channelListingId: listing.id,` matched
  inside an 8-space occurrence earlier in the same file, so the mutation hit the
  wrong line and reported GREEN. Seen twice now (P4.3e, P4.4d) — anchor on a
  neighbouring line that is unique.
- 🔴 **A `.catch()` DOES NOT COVER A SYNCHRONOUS THROW.**
  `prisma.product.findUnique(…)` throws outright when the client has no `product`
  model, and `.catch()` on the promise never sees it — so P4.4c's "never blocks a
  send by failing" promise held for only one of its two failure shapes. Use
  `try/catch` when the promise is the point. (And a `vi.mock` factory copies a
  function **by value**, so a test cannot take it away later — expose the model
  through a getter.)
- 🔴 **A PLAN ROW CAN DESCRIBE THE WRONG BUILD.** *"Build the eBay price push
  (today a stub)"* reads as "write a ReviseInventoryStatus adapter". eBay price
  pushing already works three ways; what was missing was the **reach**, and the
  adapter would have been a second sender needing an exemption from the ratchet
  that exists to prevent exactly that. Ask what already sends before you write a
  sender.

- 🔴🔴 **ASK WHAT A FAILURE PATH'S PREMISE IS BEFORE HARDENING IT.** P4.3e found
  a `catch` that falls back to enqueue-time quantities. Four fail-opens had been
  fixed by refusing, so refusing looked like the answer — but this fallback is
  RIGHT for a current row and wrong only for a superseded one. The fix was to
  coalesce the superseded rows away, so the premise ("this row is current") is
  true. **Not every fail-open wants a refusal.** Scepticism has to be symmetric:
  raise the bar on the convicting claim too.
- 🔴🔴 **A LITERAL SCAN MISSES A PRODUCER THAT PASSES ITS TYPE AS AN ARGUMENT.**
  P4.3c's first census, over `syncType: 'QUANTITY_UPDATE'` literals, reported
  **zero** bare producers. The defect the plan NAMED passes its syncType as a
  ternary argument to `queueProductUpdate` and is invisible to any scan for the
  string. Census the **call sites** of the creation helper (74 of them), not the
  spellings. *Ask what could carry the fact other than the spelling you searched.*
- 🔴 **A `toContain` ON A SUBSTRING THAT ALSO APPEARS IN THE BODY PROVES
  NOTHING.** P4.3d's lane census matched `ceiling.refusal`, which survives inside
  `if (false) { … message: ceiling.refusal … }`. Match the **whole trimmed
  condition** and assert **exactly one** line per call site tests it.
- 🔴 **`String.replace` TAKES THE FIRST MATCH, AND TWO SIBLINGS SHARE THEIR
  LINES.** P4.3e's IN_PROGRESS mutation went green because its marker,
  `syncStatus: 'PENDING',`, appears in both coalescers — it mutated the other
  function. Anchor a mutation on a line unique to the thing you are convicting.
- 🔴 **A NEW FIELD READ FROM A `select` THAT DOES NOT FETCH IT IS DEAD ON
  ARRIVAL.** P4.3d's `cl?.sourceLocationCodes ?? []` would have been `[]` forever
  on two of three lanes, with every test green. *A fingerprint built from an
  always-empty field is not an identity* — check the `select` when you add a read.
- 🔴 **A WARNING IN A HANDOVER CAN BE NARROWER THAN IT READS.** *"A Shopify
  read-back cannot run there whatever you build"* was true of the legacy REST
  image reader and false of the stock path, which uses the CX connection's token.
  `hasCreds` has ONE call site. Establishing that took one grep and saved the row.

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
- 🔴🔴 **REGISTRY-ONLY IS A MANUAL TRIGGER, NOT A HABIT.** When the finding is
  "nothing runs this", a `CRON_REGISTRY` entry does NOT fix it — that is still a
  manual trigger. I shipped P4.2c that way while fixing exactly that shape, and
  reported it as working. **Grep for what CALLS it, not what DEFINES it.** Seen
  three times now: Etsy's sync (P4.3a), Amazon/Shopify read-back (P4.2c), and
  P4.2c's own fix.
- 🔴🔴 **A RULE'S `catch` IS WHERE IT GOES TO DIE.** FOUR fail-opens found in one
  day, all in code that was correct on the happy path: eBay policy reconciliation
  warned instead of refusing (P4.1d), the lane marker guessed (P4.1e), unmatched
  SKUs went unreported (P4.2a), and the EU quantity guard allowed the push and
  stated it as a principle (P4.3b). **Read the `catch` of every rule you rely on**
  — and ask whether the Owner has already ruled on it.
- 🔴 **ASSERT THE CALL, NOT THE NAME.** `toContain('syncHealthService')` passed
  while a mutation left `void syncHealthService` and deleted the alert. Third
  variant today, with P4.2a (`attrsByCode` present, value `[]`) and P4.2c (a cap
  tested with too few fixtures to see it).
- 🔴 **"IT NEVER RAN" CAN BE THE ONLY REASON NOTHING IS BROKEN.** The usual
  finding here is dead code that does not exist in practice. Etsy's inbound stock
  write was a MANUAL trigger, gated on an env config production lacks — and one
  variable away from overwriting pooled stock with no audit. Ask whether "never
  ran" means harmless or means **not yet**.
- 🟢 **To prove a function touches no database, replace prisma with a Proxy
  that THROWS on any property access.** Stronger than asserting a string is
  absent, and it convicts a write added anywhere in the call tree.
- 🔴🔴 **A BEHAVIOURAL TEST THAT CANNOT DISCRIMINATE IS NOT A TEST.** P4.2c's
  ceiling arm used 6 fixtures with the cap at 999,999 and asserted "not capped";
  deleting `Math.min(raw, 5000)` changed nothing at that size. It would take
  5,000 fixtures to see it. Export the function and assert the VALUE. (Third
  variant of the same lesson in one day — with the two below.)
- 🔴 **A CENSUS BUILT FROM A HAND-WRITTEN PATTERN LIST IS A SET CLAIM.** Mine
  reported `amazon-media-publish.service.ts` as ungated; it reaches the gateway
  through `amazon-media-client.ts`, which my list did not name. Prefer a DERIVED
  gate (the ratchet) over a grep whose patterns you chose.
- 🔴 **A CRON EXPRESSION CAN CLOSE A BLOCK COMMENT.** `45 */6 * * *` contains
  `*/`. It ended the doc comment mid-sentence and produced four bogus syntax
  errors pointing at the wrong line.
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
