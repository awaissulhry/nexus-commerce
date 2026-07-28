# EA-series — reconciliation against source, and a re-scoped EA.1 / EA.2 plan

> Deliverable for the EA-series kickoff gate. Compiled 2026-07-27 from a full read of
> `obsidian-vault/28 - eBay Ads Strategy Research.md` (423 L) and `29 - eBay Ads Cockpit Spec (EA-series).md` (477 L),
> the related vault notes (05, 09, 10, 12, 20, 24, 27), the entire `docs/ads-ebay/` corpus (E0–E7, v2, v3),
> and a line-level audit of the running code. **No code was changed.**
>
> Where the spec and the source disagree, **the source wins** — as instructed.

---

## 0. Verdict

**Do not build EA.1 and EA.2 as specced.**

EA.1 is essentially already shipped. EA.2, executed literally, would damage a working system: it creates a route
file that already exists, duplicates nine live tables under new names, collides outright with two existing Prisma
models, and hangs the whole thing off a traversal (`ChannelListing → ProductVariation → canonical SKU`) that
**cannot resolve — `ProductVariation` is a deprecated, empty table with no FK from `ChannelListing`.**

This is not a reason to discard the EA work. The EA documents contain four genuinely new and valuable ideas that
the shipped console lacks — pool-level decisioning, κ/α margin-true economics, policy-risk tagging, and the fee
ledger. They are the correct next increment, mis-packaged as a greenfield rebuild. Recommended re-scope is at §5.

The single most important finding is at §8: **two ~30-minute operator data tasks block the entire margin thesis**,
and no amount of engineering substitutes for them.

---

## 1. What already exists

The kickoff brief describes this as a new build. It is not. `docs/ads-ebay/` documents a complete prior program —
**E0–E7, then ER1–ER5 and EV0–EV4** — built and prod-verified 2026-07-03/04 across ~50 commits.

| Layer | Shipped |
|---|---|
| API | `apps/api/src/routes/ebay-ads.routes.ts` — 1,295 lines, **68 routes**, registered `index.ts:71` (import) / `:631` (register), RBAC `permissions-manifest.ts:175` |
| Crons | **8**, in `jobs/ebay-ads-sync.job.ts:101-111` — entity sync hourly, listing discovery 4-hourly, report schedule daily, report poll 3-min, economics daily, rule evaluator daily, anomaly guard hourly, digest weekly |
| Quota | `services/ads-core/quota-ledger.ts` — distributed fixed-window INCR+TTL ledger, `QuotaStore`/`MemoryQuotaStore`/`RedisQuotaStore`, 3s op timeout, `failMode: open\|closed` |
| Reports | `createReportTask → poll → download → gunzipSync → parse TSV → absolute upsert`, 7-day chunk cap (35090), TSV_GZIP (35118), dimension minimums (35119), `EUR 1.234,56` locale parser, fail-loud on unknown schema |
| Writes | 13 gated eBay write wrappers + 6 bulk multi-status handlers, batch 500 |
| Guards | write gate · kill switch · **margin guardrail that blocks above break-even** · full `CampaignAction` audit |
| Data | 23 `Ebay*` Prisma models incl. `EbayCampaign`, `EbayAd`, `EbayAdGroup`, `EbayAdsReportTask`, `EbayAdsDailyPerformance`, `EbayListingIndex`, `EbayListingEconomics`, `EbayAdsRule(+Version,+Execution)`, `EbayAdsProposal`, `EbayAdsDigest` |
| Web | 8 surfaces under `/marketing/ads/ebay` — dashboard, campaigns + detail, builder wizards, products rollup, automation hub, digest, change log |

Adversarial re-verification of the ten load-bearing "already exists" claims returned **8 CONFIRMED, 2 PARTIAL,
0 REFUTED**. The two PARTIALs are real defects and became the substance of the re-scoped EA.1 (§4).

---

## 2. Verified conflict ledger

Ordered by severity. Every row was confirmed by opening the file.

### BLOCKER

| # | Spec claim | Source reality |
|---|---|---|
| C1 | "Create `apps/api/src/routes/ebay-ads.routes.ts` as a **new file**" | Exists — 82,367 bytes, 1,295 lines, 68 routes, registered at `index.ts:631`. Creating it anew clobbers the live console; a duplicate registration is the boot crash the brief itself warns about |
| C2 | EA.2 creates 15 models incl. `EbayAd` and `EbayAdGroup` | **Direct Prisma name collision** — `EbayAd` at `schema.prisma:11650`, `EbayAdGroup` at `:11625`, both live and populated hourly by entity sync. The migration would not generate |
| C3 | "Backfill `poolId` on `EbayAd` from `ChannelListing → ProductVariation → canonical SKU`" | **Unimplementable.** `ChannelListing` has no `sku` column and no FK to `ProductVariation`; its only identity FK is `productId`. `ProductVariation` is a *deprecated empty table* — `schema.prisma:1270` and `products.routes.ts:4561` both say "do not query it". 43 call sites already query it and silently get nothing |
| C4 | Pool keyed on `canonicalSku`, from "multiple `ProductFamily` rows containing the same SKU" | `Product.sku` is `@unique` (`schema.prisma:85`) and `Product.familyId` is a single scalar FK → one SKU maps to ≤1 `ProductFamily`. The diagram is structurally impossible. The *phenomenon* is real; the mechanism is `SharedListingMembership` (`@@unique([marketplace, itemId, sku])`) |

### MAJOR

| # | Spec claim | Source reality |
|---|---|---|
| C5 | EA.2 introduces `EbayAdCampaign`, `EbayAdKeyword`, `EbayAdNegativeKeyword`, `EbayAdDailyPerformance`, `EbayAdSuggestion`, `EbayAdRule`, `EbayAdChangeLog`, `EbayAdSavedView` | Nine shipped tables duplicated under new names — `EbayCampaign`, `EbayKeyword`, `EbayNegativeKeyword`, `EbayAdsDailyPerformance`, `EbayAdsProposal`, `EbayAdsRule`+`EbayAdsRuleVersion`, `CampaignAction`, `SavedView`. Two parallel spines is the "two-of-everything" hazard `E0-EXISTING-ADS-AUDIT.md` §5 flags |
| C6 | "Build the Redis-backed quota governor in EA.1, **before anything calls eBay**" | Already built (`ads-core/quota-ledger.ts`) with exactly the specced budgets — 9000/day reads fail-open, 180/hr reports fail-closed. Code has been calling eBay in production since 2026-07-03 |
| C7 | Rate doctrine built on eBay's suggested rate ("Suggested × 1.5", "Suggested − 0.3–0.5pp") | **No CPS suggested-rate endpoint exists.** The only source is Sell Recommendation `POST /v1/find`, restricted to AU/DE/GB/US → of our markets DE only, which has **zero live listings**. On eBay IT — 100% of the account — every "vs suggested" card is unbuildable |
| C8 | EA.1 gate = "sandbox round-trip on all 5 EU sites" | E-series evaluated and rejected eBay's sandbox (report data untrustworthy) and built an internal sandbox instead — gate unset ⇒ validate + guardrail + mirror + audit, zero external calls. Also unachievable: 4 of 5 sites have no inventory |
| C9 | "Every campaign needs a versioned clone-and-swap migration path, not an edit path" | Over-broad. `updateAdRateStrategy` has existed since 2022-07-11; `updateBid`, `updateCampaignIdentification`, `updateCampaignBudget` all ship and are exercised. Only `selectionRules`, `fundingModel`, `campaignTargetingType` are immutable |
| C10 | Doc-29 §9.4 "every campaign gets an end date" vs §9.5 "pause, never end" | Internally contradictory, and contradicts shipped behaviour: `canTransitionCampaignStatus` makes `ENDED` terminal and rejects resume |

### MINOR

| # | Spec claim | Source reality |
|---|---|---|
| C11 | Keyword cap ≤80 chars | Shipped validator is `1–100 chars, ≤10 words` (`ebay-ads-write.service.ts:674`), OAS-cited. Adopting 80 would silently reject legal keywords |
| C12 | Budget edits — self-impose ≤12/day | **Measured at 15** — `_e4-verify.mts` asserts the quota trips on the 16th edit; dual-stored counter and a "N / 15" UI meter already ship. Shipping 12 discards 20% of a scarce quota |
| C13 | `advertising.routes.ts` is 395 KB | 406,565 bytes — it has grown. The instruction not to touch it stands |
| C14 | `EbayAdPool.armedUntil` = max of members'; `EbayAdTransaction` rolls up to pool | Spec-internal modelling gaps: member-level `armedUntil` is only on `EbayAd`, and `EbayAdTransaction` has no `poolId` at all |

**Claims that check out:** attribution dates (DE Feb 2025, IT/FR/ES Jun 2025, fee = rate at time of *sale*);
quota numbers (10k/day, 200/hr); resolve campaigns by `externalCampaignId` alone (obeyed — `entity-sync:76`, name
never a resolution key); ads routes need a local `ToastProvider`; marketplace is a partition key on the shipped
`Ebay*` models. The four grey-tactic mechanics and the §4.9 never-build list are sound and worth adopting.

---

## 3. Gate status

**Gate 1 — `sell.marketing` OAuth scope: RESOLVED.** `E0-FINDINGS.md` F1 (403, needs re-consent) is closed.
`E2-DATA-LAYER.md:5-8` records `GET /sell/marketing/v1/ad_campaign → HTTP 200` after operator re-consent on
2026-07-03, discovering 11 live Seller Hub campaigns. Corroborated by eBay error codes only obtainable from real
responses (35118/35090/35119, and `seller_keyword_id` ≠ `keyword_id`), and by E5 changing a live rate 2%→2.5% and
rolling it back with eBay confirming. All five scopes incl. `sell.marketing` are in `ebay-auth.service.ts:73-84`,
so a reconnect re-grants automatically. **Do not carry F1 into EA.1.**

> **CORRECTION (2026-07-28).** Gate 2 below is now **settled: prod is LIVE and live writes have fired.** `CampaignAction` rows dated 2026-07-20 carry `_mode:"live"` / `SUCCESS` for `create_campaign` + `bulk_create_ads` + `bulk_delete_ads`. The claim below that "no live write is proven to have fired" was wrong — it was inferred from the docs rather than the audit table, which I had not queried at the time.
>
> A separate, larger finding landed the same day: **eBay has suspended Promoted Listings for this account** — `INELIGIBLE / NOT_IN_GOOD_STANDING` on all three programs, every ads call returning `409/35077`, and all 13 campaigns forced to `SYSTEM_PAUSED`. This blocks EA work upstream of everything in this plan, alongside B1 and B2. Pre-flight it with `GET /api/ebay-ads/account-health`.

**Gate 2 — `NEXUS_MARKETING_WRITES_EBAY`: docs say live, unverifiable from the repo.** `RUNBOOK.md:18` and
`E5-AUTOMATION.md:3` (both 2026-07-03) say `=1` live; `E4-WRITES.md:3` and `docs/MARKETING-OS.md:103` still say
unset — stale, never back-edited. Railway vars live outside the repo. Note the gate is strict `=== '1'`; `true`
does not open it. **Also: E4's go-live step 2 (a labelled 2% test campaign, verified in Seller Hub, then ended)
has no recorded completion — no live write is proven to have fired.**

Settle both read-only, in one minute each:
- `GET /api/ebay-ads/write-mode` → `{"mode":"live"|"sandbox"}`
- `GET /api/ebay-ads/actions` → any `CampaignAction` with `_mode:"live"` proves a live write fired
- `/sync-logs` → latest `ebay-ads-entity-sync` `CronRun`; `campaigns=11 … errors=0` proves the scope still works

---

## 4. Re-scoped EA.1 — the real gaps

EA.1 as specced is done. Adversarial verification found **four genuine quota-governor defects** plus three
hygiene items. This is the honest EA.1 backlog. All are small, and all are in code that already exists.

**Every item below is a proposal awaiting approval. Nothing is implemented.**

| # | Defect | Location | Fix | Verify |
|---|---|---|---|---|
| **A1** | **Writes are metered against the fail-OPEN reads ledger.** All 13 write wrappers call `marketingPost`, which omits `kind`, so `kind` defaults to `'read'`. During a Redis outage every eBay *write* proceeds unmetered | `ebay-ads-api.service.ts:74`, `:233-235` | Add `kind: 'write'` and a third ledger with `failMode: 'closed'`, or route writes through the reports ledger's fail-closed policy | Unit test: with the store throwing, a write must be refused and a read must pass |
| **A2** | **A bypass exists outside the ledger.** Legacy `syncEbayCampaigns` fetches `/sell/marketing/v1/ad_campaign` directly with no accounting, consuming the same eBay quota pool | `ebay-marketing-api.service.ts:66` | Route it through `marketingFetch`, or retire the legacy UM sync path if `POST /marketing/os/sync/ebay` is dead | `grep -a "sell/marketing" apps/api/src` returns exactly one un-ledgered call site: zero |
| **A3** | **Retry ladder burns up to 4× the reserved quota.** One reservation covers a 4-attempt 429/5xx loop | `ebay-ads-api.service.ts:75-98` | Reserve per attempt, or reserve 4 and release unused | Simulate a 429 storm; ledger `used` must match actual HTTP count |
| **A4** | **Bulk per-item parsing fails open.** `Number(it.statusCode ?? 200)` treats a missing per-item status as success, so a malformed multi-status body reads as all-OK. Nothing in the file branches on 207 | `ebay-ads-api.service.ts:295-310` | Treat missing `statusCode` as failure; assert the envelope is 207 when `responses[]` is present | Unit test with a response array missing `statusCode` |
| **A5** | Non-atomic Redis `INCR`-then-`EXPIRE`; a crash between them leaves a TTL-less key (acknowledged in-code) | `quota-ledger.ts:95-98` | Lua script, or `SET NX EX` + `INCR` | Existing `quota-ledger.vitest.test.ts` extended |
| **A6** | **Silent pagination truncation** — REST caps at 50 pages, Trading discovery at 25. Neither reports being truncated. Fine at 20 listings, wrong at scale | `ebay-ads-api.service.ts:105`, `ebay-listing-index.service.ts:161` | Emit a `truncated: true` warning into the `CronRun` message | Force a low cap in a test; assert the warning surfaces |
| **A7** | **14 env vars govern this subsystem and none are in `apps/api/.env.example`**; `E4-WRITES.md` and `MARKETING-OS.md` are stale on the write gate | — | Document all 14; correct the two stale docs | Doc-only |

Latent, currently unreachable, worth a guard: `chunkDateWindow(from, to, 0)` infinite-loops
(`ebay-ads-reports.service.ts:168-175`); `SEARCH_QUERY` declares `chunkDays: 0` but bypasses the function.

---

## 5. Re-scoped EA.2 — the pool question

### The options

**(a) Pool identity = `Product.id`.** Honest to the data — `StockLevel` aggregates on `productId`
(`stock-movement.service.ts:697-707`), and `enqueueSharedTradingFanout` queries by `productId`
(`ebay-shared-fanout.service.ts:145`). But it adds a third identity to reconcile and still needs a `poolId` column
and backfill.

**(b) New `EbayAdPool` keyed some other way.** Maximum new surface, maximum migration risk, and duplicates
`EbayListingIndex`, which already exists for exactly this purpose.

**(c) Reuse `SharedListingMembership` as the substrate.** It is *the* documented mechanism for one product across
many item IDs — but its `productId` is nullable *by design* (unmatched rows are deliberately surfaced to the
operator), and its `sku` is the **eBay Custom Label, not `Product.sku`** — live listings use their own conventions
(`T1_Ne_S`, `IT-` prefixes), so SKU-string matching mis-keys them.

### Recommendation — **(d): pool as a derived view over `EbayListingIndex`. No new table, no backfill.**

`EbayListingIndex` already ships with `@@unique([marketplace, itemId])` and a **plural** `productIds[]` — precisely
the grain the pool needs, and it is populated by the 4-hourly discovery sync from the Trading API, so it sees
listings that were never pushed by Nexus.

> **A pool is the set of `EbayListingIndex` rows sharing a `productIds[]` entry**, labelled for operators from
> `SharedListingMembership.parentSku`.

Why this and not a table:
- It sidesteps C3 entirely — no `ProductVariation` hop, no SKU string matching, no nullable-FK holes.
- It sidesteps C2/C5 — no new models, no collisions, no parallel spine.
- **Shared listings have no `ChannelListing` row at all** (`channelListingId: null` throughout the fan-out), so
  any `ChannelListing`-rooted backfill would miss the entire shared lane — the one the pool actually exists for.
- `ChannelListing` is `@@unique([productId, channel, marketplace])` — structurally *one row per product per
  marketplace* — so it can never represent GALE's ~5 concurrent IT item IDs. `EbayListingIndex` can.
- Zero migration risk on a live, guarded subsystem.

If a materialised pool is later wanted for query performance, it becomes a cache of this view with a deterministic
rebuild — a decision deferrable until volume justifies it.

### Invariants I1–I7

| Inv | Enforcement |
|---|---|
| **I1** one PRIMARY per (pool, marketplace, strategy) | Service-layer guard in the write path + daily overlap job. Not expressible as a DB constraint on a view |
| **I2** cross-member negative shielding | Deferred — needs Priority/CPC live; **blocked by B4** (zero search-query data) |
| **I3** no member in both General and Priority | Daily overlap guard, reusing the existing anomaly-guard cron |
| **I4** one ad rate decision per pool | Gate every rate/bid write on the pool, in `ebay-ads-write.service.ts` — the existing single chokepoint |
| **I5** pool `armedUntil` = max over members | Computed in the view; `armedUntil` exists nowhere today, so this is net-new (small) |
| **I6** margin formula | Already exists — `ads-core/ebay-margin.ts` + `EbayListingEconomics.breakEvenAdRatePct`. Extend with α and κ, don't rebuild |
| **I7** fees/sales/margin roll up to pool; per-listing numbers diagnostic-only | Aggregate `EbayAdsDailyPerformance` over the pool's `(marketplace, itemId)` set |

### Corrections to fold in while here

The EA fee base is **more correct than what ships** and closes E-series' own `⚠️VERIFY` marker on `adFeeBase`
(`E0-ARCHITECTURE.md` §4): `A = P + S + T` (item + shipping + tax), `fee = rate × A × (1 + VAT_on_fees)`. Adopting
it makes every existing break-even **more conservative** — heavy, low-ASP items are currently over-permitted.
This is a real bug fix, not a new feature.

α (attribution share) is computable **today** from data already in the DB: attributed sales ÷ total product sales.
κ should ship as a **tunable prior** (suggest 0.75) feeding `r_max = r_BE × (1 − κ)` into the clamps that already
exist — measuring it properly is out of reach at this account's volume (§8).

---

## 6. Verification plan

Correctness of the pool view is provable without trusting any backfill, because there is no backfill.

1. **Independent check, not the same code path.** A read-only probe (`apps/api/scripts/_ea-pool-verify.mts`,
   following the existing `_e*-verify.mts` convention) that reconstructs pools *directly from the live eBay
   account* via `GetMyeBaySelling`, then diffs against the view. Any listing in one and not the other is a defect.
2. **Named cases.** GALE (~5 concurrent IT listings — the canonical case), plus AIREON and AIRMESH. Assert GALE
   collapses to **one** pool with N members, and that each member's `(marketplace, itemId)` is live.
3. **Negative cases that must not silently pass:** the 11 SKU-less legacy listings must land in the operator match
   queue, **not** in a pool; ended/relisted items must leave the pool on the next discovery run; a listing matched
   to two products must be flagged, not arbitrarily assigned.
4. **Invariant assertions** run as the daily guard: no pool with two PRIMARYs; no member in both General and
   Priority; pool `armedUntil` ≥ every member's.
5. **Prod, not Docker**, per standing practice — read-only, no writes.

---

## 7. The ten open questions (research §6)

**Already answered — remove them from the plan:**

| Q | Resolution |
|---|---|
| **Q3** 15 budget changes/day | **Measured.** `_e4-verify.mts` asserts the quota trips on the 16th edit. Ship 15, not 12 |
| **Q7** Negative PHRASE via API | **Settled with live data** — `EXACT + PHRASE`; 12 live negatives read back off the "Xavia Gale" campaign |

**Blocks EA.2 — but is answered by re-scoping, not by probing:**

| Q | Note |
|---|---|
| **Q4** Does eBay dedup ads by listing within one SERP? | This is the empirical foundation of the pool's *value* (the self-bidding claim). It does **not** block building the pool view — the other three failure modes (unattributable ACOS, multiplied attribution tails, stockout overspend) independently justify it. Settle by SERP observation before acting on any anti-self-bidding suggestion |

**Does not block EA.1/EA.2 — defer:**

- **Q1** end-and-relist / click bank, **Q5** multi-quantity rate timing, **Q10** post-markdown fee base — all gate
  the *grey-tactic* phases (A1/A2/A3, §4.7 arbitration), which are EA.7+ and blocked by volume anyway. Q10 needs a
  real invoice.
- **Q2** 5% Dynamic floor — needs ≥200 SKUs across ≥10 categories to detect. **Impossible on a 20-listing account.**
- **Q6** bulk maxima — the 500-per-call figure that matters is verbatim and already shipped as `CHUNK = 500`.
- **Q8** 50,000 ads/campaign vs 500 × 1,000 — treat 50,000 as binding; irrelevant at current scale.
- **Q9** ES Priority — moot, zero ES inventory. Handle error 35051 defensively if ES ever lists.

**Net: nothing blocks the re-scoped EA.1. Only Q4 touches EA.2, and only its justification, not its construction.**

---

## 8. What actually blocks this — two operator tasks

Neither is an engineering problem, and no phase of EA is worth starting before they are done.

| # | Blocker | Effect | Where |
|---|---|---|---|
| **B1** | **No cost data exists anywhere in the catalog** — `costPrice`, PO history and WAC all verified 0 rows | Every margin-true claim computes to `MISSING_COGS`. κ, `r_max`, break-even, impact scores — **the entire stated moat** — are inert | `/marketing/ads/ebay/products` → **Add cost** |
| **B2** | **16 live listings unmatched to products**; 11 of the original 20 carry no SKU at all | A pool cannot contain a listing with no product. EA.2's own gate — "pools resolve correctly for every multi-family shared-SKU case" — is unreachable until this is done | `/marketing/ads/ebay/products` → **Match…** |

Both surfaces already exist and are built for exactly this. Estimated ~30 minutes each.

Lower-priority carry-overs: **B3** automation dial ships OFF · **B4** all 4 CPC campaigns paused since 2024, so
zero search-query data exists (blocks all EA.8 keyword intelligence) · **B5** DE/FR/ES/GB have zero live listings ·
**B7** EV5/EV-QA design debt any new surface would inherit.

**Governing fact.** The live account is **20 active listings, 11 campaigns, €55.28 in ad fees per 28 days (~€2/day),
100% eBay IT.** The EA spec is written for "all 12,431 matching", 100k-ad enumeration, ~5M SKAGs, 20% holdout
cohorts and 60-day κ experiments. A 20-listing account cannot produce a statistically readable κ — EA.12's gate
("first κ result with confidence intervals") is years out of reach at current volume. Scale the ambition to the
account, or grow the account first.

---

## 9. Recommended shape — EA' as E8–E10, on the existing spine

| Phase | Content | Replaces | Cost |
|---|---|---|---|
| **E8.0 — corrections + free wins** | The seven EA.1 fixes in §4 · adopt the corrected fee base into `ads-core/ebay-margin.ts` · surface α from data already in the DB · bind `j/k/a/r/d/u` on the existing Suggestions queue (`AdsDataGrid` already exposes `keyboardNav` + `onRowKey` — hours, not a phase) · add `SYSTEM_PAUSED` to the status vocabulary + anomaly guard · adopt §4.9 "never build" as a written policy artifact | most of EA.5 + EA.7 | days |
| **E9 — pool as a view** | §5 in full: the derived pool over `EbayListingIndex`, invariants I1/I3/I4/I5/I7, every rate/bid write gated on the pool. No new table, no backfill | EA.2 + EA.4 | ~1 phase |
| **E10 — κ as a prior** | κ tunable, default 0.75, feeding `r_max` into the clamps that already exist. Frozen-cohort machinery via `autoSelectFutureInventory: false` (a genuine API-only unlock). **Not gated on a κ measurement this account cannot produce** | EA.12, de-risked | ~1 phase |

**Drop:** the parallel schema (all 15 models), the new route file, ≤12/day budget throttling, the ≤80-char keyword
cap, the eBay-sandbox gate, doc-29 §9 rule 4, and every suggestion card keyed on "eBay's suggested rate".

**Park behind a volume trigger:** EA.6 durable-bulk, EA.10 scheduler/dayparting/budget-ratchet, EA.11 fee ledger.
The mechanics are right; the account is 20 listings and ~€2/day. (Note EA.10's recipes are *budget/bid stepping*,
so E-series' "no hourly grain → dayparting impossible" verdict does not actually block them — that verdict was
about reporting, not actuation. Worth correcting in `v2/SCORECARD.md`.)

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Touching `ebay-ads-api.service.ts` breaks a live, guarded subsystem | All §4 fixes are additive and unit-testable; the write gate stays closed until explicitly flipped |
| A1 (fail-closed writes) could refuse writes during a Redis blip | Fail-closed is correct for writes, but pair it with `NEXUS_EBAY_ADS_QUOTA_MODE=off` as the documented ops escape hatch (already exists) |
| The pool view is computed per request | Acceptable at 20 listings; materialise only if profiling demands it |
| Discovery's 25-page cap silently truncates the pool source | A6 fixes exactly this; do A6 before E9 |
| Doc drift recurs | E8.0 includes correcting the two stale docs and populating `.env.example` |

**Non-goals for EA.1/EA.2:** no new route file · no parallel schema · no writes to `/products/ebay-flat-file` or
`ebay-flat-file.routes.ts` (untouchable) · no FBA quantity writes · no campaign resolution by name · no destructive
migration · no live-gate flip without explicit approval · no grey-tactic actuation.

---

## Asks at this gate

1. **B1 + B2** — the two operator data tasks. Everything else is downstream of them.
2. Confirm prod write-mode via `GET /api/ebay-ads/write-mode`, and whether E4 go-live step 2 (the labelled 2% test
   campaign) was ever run.
3. Approve **E8.0** (the §4 fixes + the fee-base correction) — small, self-contained, and the fee-base item is a
   real bug making current break-evens too permissive.
4. Approve or adjust the **pool-as-a-view** decision in §5 before any E9 work.
