# BID.S2 — the columns that make a bid legible, and the vocabulary the rest of the page speaks

*Section 2 of 10 of the Bid page. Extends [BID.S0](2026-08-12-bid-s0-basis.md); the design study is
[the page study](2026-08-11-bid-page.md), which corrects the tab study five times and wins.*

**Built and shipped 2026-08-12. Read-only: no bid moves, no schema changed, `AdBidPolicy` not
created, `NEXUS_BID_OPTIMIZER_SOURCE` untouched.**

---

## 0 · The one-sentence version

Four columns and nine chips — and the two things worth remembering are that **`updatedAt` cannot
detect a bid change** (it is a sync heartbeat: 2,442 of the 2,540 never-written targets had it move
within two hours) and that the drift it was supposed to find is **not Seller Central** but our own
nightly restore going unaudited on ~123 campaigns a night.

---

## 1 · What shipped

| | |
|---|---|
| columns | **Band · Bidder · History · State**, plus **Eff. max CPC** (default-hidden) |
| vocabulary | `bid/bidState.ts` — 9 chips, one pure resolver, **24 tests** |
| sparkline | `bid/BidSpark.tsx` — step interpolation, no library, no Bid coupling |
| API | `bid-grid` gains 12 row fields + `series`; `bid-history` gains 4 additive params |
| URL | `?state=` goes live (S0 reserved it) |
| commits | API `d194cfa17` · web `89aa23bb4` |

**Observed CPC was not added** — S0's `CPC` column already *is* spend ÷ clicks from
`AmazonAdsDailyPerformance` over the selected window. A second column would have duplicated it.

**Suggested Bid stays cut**, and the brief's reason is confirmed: the corpus
(`kind=KEYWORD AND clicks>0 AND spendCents>0`) is **0 rows**, `MAX(spendCents)=MAX(clicks)=0` across
all 3,154 targets, and no `suggest`/`recommend` table exists anywhere in the schema. An
Amazon-sourced suggestion is not stored — reaching it means a live per-row API call, which is not a
column.

---

## 2 · 🔴 The state vocabulary — canonical for S3–S9

**Import `resolveBidStates` from `bid/bidState.ts`. Do not re-derive any of these.** The moment two
sections answer "is this at the floor" differently, the page contradicts itself in front of the
operator.

```ts
resolveBidStates(row, max = 2): BidStateChip[]   // ordered, capped
hasBidState(row, key): boolean                   // UNCAPPED — what a filter must use
```

### Precedence, and why

| # | key | tone | fires when |
|---|---|---|---|
| 1 | `out-of-band` | bad | bid > campaign ceiling (or < floor) |
| 2 | `unrecorded` | bad | live bid ≠ newest audited value |
| 3 | `suppressed` | warn | `suppressedFromBidCents != null` |
| 4 | `min-bid-window` | warn | `campaign.bidsSuppressedAt != null` |
| 5 | `at-floor` | warn | ≤ 2¢ **and neither 3 nor 4** |
| 6 | `no-bidder` | warn | campaign resolves to `none` |
| 7 | `not-in-auction` | mute | target ENABLED, campaign not |
| 8 | `unnamed` | mute | no `expressionValue` |
| 9 | `no-data` | mute | no performance row in the window |

Ordered by *what would change a decision*. `no-data` is last because it is true of 82% of rows and
the metric cells already say "not served" — it earns the chip only when nothing else is worth saying.

🔴 **3, 4 and 5 are mutually exclusive by construction.** `at-floor` is *defined* as the absence of
the other two. Measured: **every one of the 151 targets at ≤2¢ is in bucket 5** — none carries a
restore value, none is in a window. The tab study called the whole 2¢ population "suppressed";
telling an operator a bid restores itself when nothing will bring it back is the error this
vocabulary exists to prevent.

🔴 **`hasBidState` ignores the two-chip cap, and the filter must use it.** The cell shows two; a row
that is both `out-of-band` and `no-data` drops the second. Filtering on the rendered list would hide
that row from `state=no-data`, so the chip would return fewer rows than its own count claims — the
NEG.1 defect, arriving through a display concern. **68.6% of rows carry more than two chips**, so
this is the common case, not an edge one.

---

## 3 · Populations — every count against a named denominator

**Measured 2026-08-12 at 13:18 Rome.** 🔴 **Read the hour before reading the numbers.**

| denominator | count | definition |
|---|---|---|
| **T** | 3,154 | all positive targets, any status |
| **A** | 2,944 | `status=ENABLED AND isNegative=false` |
| **B** | 1,091 | A **and** campaign ENABLED — "in auction" |

A and B differ by **2.7×**. Every figure below names which it uses.

| chip | of A | of B | share of A |
|---|---|---|---|
| `out-of-band` | **56** | 56 | 1.9% |
| `unrecorded` | **146** | 145 | 5.0% |
| `suppressed` | **0** | 0 | ⏰ afternoon |
| `min-bid-window` | **0** | 0 | ⏰ afternoon |
| `at-floor` | **151** | 151 | 5.1% |
| `no-bidder` | **2,295** | 449 | 78.0% |
| `not-in-auction` | **1,853** | 0 | 62.9% |
| `unnamed` | **195** | 42 | 6.6% |
| `no-data` | **2,421** | 568 | 82.2% |

Rows with **no chip at all**: 253 (8.6%). Rows with **more than two**: 2,019 (68.6%).

### Reconciled against the brief

| brief said | measured | why |
|---|---|---|
| 149 at-floor | **151** | clock; the floor population moves overnight |
| 57 out-of-band | **56** | clock |
| 53 no-bidder campaigns | **41** (+12 manual) | the brief's 53 is manual+none combined |
| 256 unnamed | **195 of A** | 256 is all statuses (T); 195 is ENABLED |
| 1,853 not-in-auction | **1,853** | ✓ |
| 659 with a curve | **607 of A** | 659 counts all statuses |

**Bidder, per campaign** — `schedule 33 · goal 0 · manual 12 · none 41` over the 86 ENABLED
campaigns. *(Counted over campaigns that hold a positive target it is 32/0/12/39 = 83; three ENABLED
campaigns hold no positive target. A denominator worth stating.)*

### 🔴 Every count on screen was verified to deliver itself

The State control advertises a count per option; the grid returns exactly that many, checked on
production: `at-floor` **151 → 151** · `out-of-band` **56 → 56** · `unrecorded` **146 → 146** ·
`unnamed` **195 → 195** · `no-data` **2,421 → 2,421**.

---

## 4 · 🔴 `updatedAt` is a heartbeat — the §6 hypothesis, confirmed and then corrected

**Confirmed.** `ads-keyword-list-sync.service.ts:121,170,219` writes `lastSyncedAt: new Date()` on
**every row it sees**, hourly at `45 * * * *`, and Prisma's `@updatedAt` follows. Measured: of the
**2,540** targets with no bid write in 60 days, **2,442 (96%) had `updatedAt` move within two
hours**. It cannot detect a change. Drift is computed **by value**, one `DISTINCT ON` over
`CampaignBidHistory`.

*(S0's refresh cursor should stay on `updatedAt` — it is the correct **invalidation** signal for
exactly the reason it is the wrong **display** signal: it catches the unaudited path.)*

### But the chip is not "Changed outside Nexus"

Of the 146 rows drift finds:

| | |
|---|---|
| last audited write was a **floor to €0.02** | **126** |
| delivery of that write | SUCCESS 140 · PENDING 3 · FAILED 1 |
| campaign ENABLED | 143 |

In 48 h the audit table holds **895 floors at 00:xx and 772 restores at 08:xx** — both directions
*are* audited, so the earlier guess that restores go unrecorded wholesale was wrong. But ~123 a
night are missing their restore, and those rows now sit at a value nothing recorded.

**So the chip says `Unrecorded change`**, and its tooltip names both numbers and the likely cause.
Labelling it "Changed outside Nexus" would tell an operator a human edited in Seller Central; it was
our own engine. A Seller Central edit is genuinely indistinguishable from this — the tooltip says
that too.

⏰ **This chip is itself a clock reading**: near zero just after the audited midnight floor, ~146 by
midday.

---

## 5 · The `bid-history` contract

```
GET /advertising/bid-history
  ?entityIds=<csv, ≤500>    NEW — grouped mode
  &field=bid,defaultBid     NEW — a bid curve must not plot a status change
  &perEntity=<n, ≤60>       NEW — 🔴 N points PER ENTITY, not N rows total
  &since=<iso>              NEW — defaults to 60 days
  (entityId · entityType · campaignId · limit — unchanged)
```

Grouped mode returns `{ series, entities, requested }`. **Every other call path is byte-identical**,
which matters: `ads-console/bulk/BulkOpsClient.tsx:79` calls this route and reads `items`. The page
study recorded *"nothing renders it"* — **that was wrong**, and a non-additive change would have
broken the Bulk operations screen.

Why `perEntity`: 500 targets × 12 points is 6,000 rows, so a flat `limit` returns every point of the
busiest few and nothing for the rest — indistinguishable on screen from "these keywords never
changed", which is true of 79% of rows and therefore invisible as a bug.

**`bid-grid` also returns `series` inline** for the rows it is returning. Both call the same
`getBidSeries`, so there is one implementation. The grid needs 2,944 rows' worth in one shot and a
CSV of 2,944 cuids is a 90 KB URL; `bid-history`'s grouped mode is for S3's single-target drawer.

🔴 The series uses a **fixed 60-day window**, deliberately not `?window=`. That param is the *metric*
window; wiring the curve to it would shorten the sparkline when someone switched the metric columns
to 7 days, which reads as "this bid stopped moving".

---

## 6 · The sparkline

**Step interpolation, not a line.** A bid holds its value until something writes a new one; a sloped
segment draws a drift that never happened. The real shape here is a nightly square wave — a measured
curve reads `2 → 28 → 2 → 28 → …`.

**Coverage is the design constraint.** 607 of 2,944 (20.6%) have any change in 60 days. The other
79% render a **dotted rule**, because the three options were: blank (reads as broken), a flat line
(reads as *stable* — a claim about a bid nobody has ever touched), or a mark meaning "nothing here".

**The curve and the metrics are different sets** and neither implies the other:
both **360** · curve-only **247** · metrics-only **163** · neither **2,174**. A curve means someone
wrote a bid; metrics mean Amazon served it.

**Writes that did not land** render dashed orange with the count in the tooltip — the page study's §1
case is nineteen recorded cuts on a bid that never moved. 0 failures in the last 7 days, but
`FAILED` and `PENDING` both appear in the 60-day window, so the mark does render.

---

## 7 · The Band, and the Effective max CPC

**Band renders three ways because three different things are true.** Both ends → a bar with the
bid's position. One end → the number and *which* end (`MAX €0.80`). Neither → "not set", muted
italic — 🔴 **never "€0.00"**, which is a floor of zero and a much stronger claim than the absence of
one. Measured: `minBidCents` on **0 of 220**, `maxBidCents` on **82** (80¢ ×72 · 90¢ ×2 · 190¢ ×8),
**no campaign declares 0**. So the third rendering is the only one in use and the first is unreachable
until S5.

**The ceiling that binds nothing:** sorted by `Above ceiling`, `IT-AIRMESH-SP-Competitor-Broad` has
**14 of its 15 targets above its own €0.80 ceiling**, bid range €0.05–€2.41. The gate refuses writes
outside the band but never pulls an existing bid in.

### Effective max CPC — and three wrong turns getting there

`bid × (1 + placement%) × strategy uplift`, over the best lane. LEGACY_FOR_SALES ("down only", 2,448
targets) never raises; AUTO_FOR_SALES ("up and down", 59) adds up to 100% at top of search, 50%
elsewhere.

🔴 **Neither factor is where the brief said.** `RankTarget` has **no `cpcCapPct`** — it carries
`maxCpcCents` (5 rows, 4 set). Placement is not in `bidStrategyJson`; it is
`Campaign.dynamicBidding.placementBidding[]`, which is what `placement-grid.service.ts:254` reads.

| probe | looked in | reported | verdict |
|---|---|---|---|
| 1 | `placementBidsJson` / `cpcCapPct` behind `.catch(() => [])` | 0 campaigns | 🔴 **wrong field names; the catch made a name error look like a measurement of zero** |
| 2 | `bidStrategyJson.adjustments[]` | 0 campaigns | honest, still the wrong place |
| 3 | `dynamicBidding.placementBidding[]` | **172 of 220 · 68 of 86 ENABLED · largest +400%** | ✅ |

The column is **null, not a copy of Bid**, where nothing lifts it — populated on 2,405 of 2,944.
Default-hidden: it is a derived ceiling, not a fact Amazon holds.

---

## 8 · Verified on live production

`https://nexus-commerce-three.vercel.app/marketing/ads/rules-automation/bid`, Chrome at 1728px,
2026-08-12 ~13:40 Rome.

- **Geometry, measured:** every block `96 → 1698`, identical to S0's baseline. No horizontal body
  scroll, no `main` scroll, `.h10-am-card` `scrollWidth 1600 = clientWidth` — **13 columns fit**.
- **Contrast delta: 0.** Total 29 genuine AA failures, exactly S0's baseline — 11 shared chrome, 18
  in the provisional `RuleListTab`, **none in `h10-bd-*`**. (Elements under 0.05 effective opacity
  excluded as invisible by design; counting them produced 36 phantom failures on the first pass.)
- **Rendering, on one page of 100:** 26 never-changed marks · 74 curves · 1 dashed-failed · 99
  half-bands · 1 "not set" · 24 "No bidder" · **max 2 chips per row**.
- **Class ↔ stylesheet checked both ways**, zero orphans in either direction.
- The provisional rule list still renders 18 Bid Rules.

---

## 9 · What S3–S9 must know

1. **Import `bidState.ts`.** It is the page's language. `hasBidState` for filters, `resolveBidStates`
   for cells.
2. **S3 owns `?target=` and the drawer.** The sparkline is deliberately non-interactive; wiring a
   click that goes nowhere was the alternative. S3 should also **delete the two CSS rules** that
   un-blue the first column, when the target becomes a real link.
3. **S5 owns the band editor and `AdBidPolicy`.** The Band column reads `Campaign.minBidCents` /
   `maxBidCents` and nothing else. Precedence when it lands:
   `market < portfolio < product line < campaign`.
4. **S6 owns `?bidder=` and assignment.** `goal` is reachable and empty — 0 of 220 campaigns set
   `dynamicBidding.targetAcos`, which is the correct field (`Campaign.targetAcosPct` is documented as
   a mistake).
5. **Never render a floor/suppression count without the hour.** Two runs disagreeing across
   midnight is the system working.
6. **`resolveOrigins` is not exported** (`ads-changes.service.ts:111`) and takes `ChangeRow[]`. The
   Bidder column reuses its *rule* — `group?.name ?? name`, because the operator thinks in named
   groups — by reading `AdSchedule` directly. No actor string is parsed on this path.
7. **The sparkline is offered to every session** in session-locks §4, like S0's `onFilterChange`.
   Moving `BidSpark.tsx` to `_shared/` is the whole promotion; it has no Bid-specific types.

---

## 10 · Corrections to the brief

| § | brief | measured |
|---|---|---|
| §6 | `updatedAt` bumped hourly — unverified | ✅ **confirmed**, 2,442 of 2,540 |
| §6 | call it "Changed outside Nexus" | 🔴 **no** — 126 of 146 are our own unaudited restore |
| §2.6 | effective CPC from `RankTarget.cpcCapPct` | 🔴 field does not exist; use `dynamicBidding.placementBidding[]` |
| §3 | add an `Observed CPC` column | already shipped in S0 as `CPC` |
| §4 | none = 53 of 86 | 41 none + 12 manual |
| §5 | 149 at-floor · 57 out-of-band | 151 · 56 (clock) |
| §7 | `bid-history` has no consumer | 🔴 `ads-console/bulk/BulkOpsClient.tsx:79` calls it |
| §7 | 659 of 2,944 have a curve (22.4%) | 607 of 2,944 (20.6%); 659 is all statuses |

### Appendix — scripts

| script | measures |
|---|---|
| `_bid-s2-measure.mts` | the `updatedAt` hypothesis · drift by value · every chip · bidder · sparkline coverage · the dead suggest corpus |
| `_bid-s2-drift.mts` | floor-vs-restore audit symmetry · the hour profile · one worked example across both tables |
| `_bid-s2-cause.mts` | why the drifted rows drifted · placement multipliers from the right field |
| `_bid-s2-verify.mts` | 44 assertions over the extended `getBidGrid` on prod |
| `_bid-s2-populations.mts` | the §3 table, stamped with the hour |

Read-only, untracked with this repo's other probes.
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.
