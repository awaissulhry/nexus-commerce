# SOV.6 — the page stops silently declining newer data, and you can take it with you

*Section 6 of 7 on `/marketing/ads/rules-automation/share-of-voice`. Session slug `sov6`, 2026-08-16.*
*Basis: [SOV.0](2026-08-12-sov-page-sov0-basis.md) · [SOV.1](2026-08-12-sov-page-sov1-market-share.md) ·
SOV.2–SOV.5: [the retroactive record](2026-08-16-sov-page-sov2-5-record.md).*

Measured with `_sov6-verify.mts` and `_sov6-handoff.mts` (new), and by re-running `_sov6-state.mts`
/ `_sov6-state2.mts` rather than trusting the brief's summary of them.

> **A note on the brief, again.** This prompt arrived corrupted — §3, §4.1's table, §5, §6 and §11
> were heavily truncated mid-sentence. The headers and the do-not-build list survived, which fixed
> the scope. Every number below was re-derived. **Five things in it did not survive measurement**
> and they are in §6 — one of them changes what the upstream owner should look at.

---

## 1 · What was built

```
share-of-voice.service.ts
  :521  periodOverride       ?period= resolved, or refused ('malformed' | 'not-in-market')
  :539  chosen               the gate's choice, or the override — recomputed completeness
  :~560 rejection            the newest DECLINED period: rows · threshold · shortBy · pctOfBar
                             · asins · chosenAsins · count · others[]
  payload  period.rejection · period.override · period.available[]
advertising-intel.routes.ts :1058   period: q.period || null

ShareOfVoiceClient.tsx
  the decline line (amber)      renders only when something newer was rejected
  the override marker (red)     persistent while ?period= is on
  the refusal line              a bad ?period= states its refusal, never a silent fallback
  onExport                      AdsDataGrid's own exportable/onExport — no new button
  SovSavedViews                 in the toolbar
sovExport.ts        the CSV and its header block — the substance of §5
SovSavedViews.tsx   a URL and a name, on the EXISTING SavedView substrate
rules-automation.css  +42 lines at EOF, h10-sov-* only
```

Two commits: the API (`ca46c2314`) and the web (`f0ea…`, this session's second).

---

## 2 · The freshness reckoning

### 2.1 What the page was doing

The band stated an age. An age cannot distinguish *"this is the newest there is"* from *"there is
newer and we are choosing not to show it."* Since 13 Aug the second has been true and the page said
the first.

Measured 2026-08-16 — a 2026-08-02 period exists in all four markets and the gate will never show it:

| market | rendering | declined | rows / threshold | short by | % of bar | ASINs (declined vs rendered) |
|---|---|---|---|---|---|---|
| IT | 2026-07-19 (27d) | **2026-08-02** (13d) | 259 / 279 | **20** | 93% | 13 vs 19 |
| DE | 2026-07-19 (27d) | 2026-08-02 | 135 / 198 | 63 | 68% | 10 vs 14 |
| ES | 2026-07-19 (27d) | 2026-08-02 | 46 / 192 | 146 | 24% | 12 vs 15 |
| FR | 2026-07-12 (34d) | 2026-08-02 | 11 / 33 | 22 | 33% | 3 vs 4 |

Each market also declined 2026-07-26 (IT 8 rows, DE 5, ES 71, FR 1); FR declined 07-19 as well.

**The gate is not touched.** `chooseViewPeriod`, `SQP_COMPLETENESS_RATIO`, `SQP_BASELINE_PERIODS`
and `KT_LOOKBACK_DAYS` are shared with Keyword Tracker, and the rule is right: a share from a
93%-complete week wearing the same label as a whole one is worse than a blank. What was wrong is
that the refusal was silent. The page now names the period, its rows, the threshold, the shortfall,
the percentage of the bar and **the ASIN count** — and renders nothing when nothing newer was
rejected, so it cannot become furniture.

🔴 **A rejected period and an excluded period stay in separate channels.** The gate rejects a week
for being thin (fixable upstream, by the feed); `choosePriorPeriod` excludes one for carrying a zero
our-side count on every row (the pre-`ACR.0.2` parser defect, fixable only by re-ingest). Different
causes, different owners, different fixes. Merging them into one "unavailable" list would hide which
applies.

### 2.2 `?period=` — verified on prod

Every share-derived number moves with it, not just the grid:

| market | gate | override | rows | weighted share | Δ prior | gap |
|---|---|---|---|---|---|---|
| IT | 07-19 | **08-02** (93%, 13 ASINs) | 480 → **216** | 0.7710% → **1.1384%** | 2026-07-19 | **14d** |
| DE | 07-19 | 08-02 (68%) | 276 → 111 | 0.7356% → 0.7318% | 2026-07-19 | 14d |
| ES | 07-19 | 08-02 (24%) | 154 → 42 | 0.5896% → 0.4062% | 2026-07-19 | 14d |
| FR | 07-12 | 08-02 (34%) | 37 → 11 | 0.3390% → 0.6129% | 2026-07-12 | **21d** |

Worth stating because it is counter-intuitive: on the declined week IT's share reads **higher**
(1.14% vs 0.77%). Declining it is not protecting anyone from a bad number — it is withholding a
*flattering* one measured on 13 ASINs instead of 19. That is exactly why it needs its completeness
stated rather than being shown by default, and exactly why the override is red and permanent.

The Δ re-picks its own prior under the override and **names the gap** — 14 days, not 7; FR 21.

Refusals, verified — never a silent fallback:

| `?period=` | result |
|---|---|
| `last-tuesday` | `refused: 'malformed'` → the gate's choice + a stated refusal |
| `2020-01-06` | `refused: 'not-in-market'` → same |
| a real period for that market | accepted |

---

## 3 · 🔴 The hand-off — and it points somewhere else than the brief thought

**To the SQP feed owner.** The brief's diagnosis is *"the ASIN coverage narrowing 25 → 15"*. That is
the account-wide distinct-ASIN count, and per market — which is what this page renders — **there is
no narrowing trend.** Distinct ASINs per period, newest first:

```
IT  08-02=13  07-26=4   07-19=19  07-12=13  07-05=13  06-28=13  06-21=13  06-14=12
DE  08-02=10  07-26=1   07-19=14  07-12=13  07-05=12  06-28=12  06-21=11  06-14=13
ES  08-02=12  07-26=9   07-19=15  07-12=14  07-05=15  06-28=14  06-21=15  06-14=14
FR  08-02=3   07-26=1   07-19=3   07-12=4   07-05=3   06-28=4   06-21=4   06-14=4
```

IT sits at 13 ASINs in five of the last six periods. **07-19's 19 is the outlier — high, not low.**
08-02's 13 is exactly normal. The ASIN count is not what changed.

**What changed is rows per ASIN**, and it changed by a factor of four:

| market | 06-21 | 07-05 | 07-12 | **07-19** | **08-02** |
|---|---|---|---|---|---|
| IT | 80.2 | 76.1 | 82.0 | **34.5** | **19.9** |
| DE | — | 36.5 | 51.9 | **26.0** | **13.5** |
| ES | — | 23.6 | 31.6 | **12.9** | **3.8** |
| FR | — | 14.7 | 10.5 | 1.3 | 3.7 |

Same ASINs, a quarter of the queries each. **And the decline starts at 07-19 — the week the page
currently renders is itself already half-degraded**, which the completeness gate cannot see because
07-19 still clears a threshold set by a median that the same decline is dragging down.

Two things checked and eliminated: `SQP_QUERIES_PER_ASIN_CAP = 100`
(`keyword-tracker.service.ts:127`) is nowhere near binding at 19.9 rows/ASIN; and the week is
**frozen, not filling** — `sqp-collect` has reported `nothing outstanding · states=INGESTED=151`
hourly since 08-15 04:34, and 08-02's rows were written 08-13=66 · 08-14=384 · 08-15=1.

So the question for the feed owner is **"why does each covered ASIN return a quarter of the queries
it did in early July"**, not "why do we cover fewer ASINs".

**To the KT / substrate owner — the ratio, presented and not acted on.** `SQP_COMPLETENESS_RATIO` is
shared, so SOV.6 does not touch it. Of the last 8 periods, how many pass:

| market | baseline(12) | pass @0.5 | @0.4 | @0.3 | would 08-02 pass? |
|---|---|---|---|---|---|
| IT | 558.5 | 6 | 7 | 7 | 0.5 fail · **0.4 PASS** · 0.3 PASS |
| DE | 396 | 6 | 6 | 7 | 0.5 fail · 0.4 fail · **0.3 PASS** |
| ES | 384 | 6 | 6 | 6 | fail at all three |
| FR | 65 | 5 | 5 | 5 | fail at all three |

**Lowering the ratio does not solve this.** At 0.4 it admits one market; at 0.3, two — and ES and FR
still show a 28-day-old week. A constant change would buy IT a fresher page and leave the other
three exactly where they are, while changing what Keyword Tracker shows for reasons that have
nothing to do with either page. The row yield is the fix; the ratio is not.

**Can this page ever be current?** No, and it is worth knowing the floor. A weekly period is dated at
its **start** and is only requestable once the week has closed, so a period start is already 7 days
old when it becomes eligible; 2026-08-02 first landed **11 days** after its start date. So **~11
days is the structural floor**, and today's 27 is that floor plus two rejected weeks. Fixing the row
yield removes ~16 days of the 27, not all of it.

---

## 4 · Export and saved views

**Export** reuses `AdsDataGrid`'s `exportable` + `onExport` — no button, no menu, no download
helper. The header block is the substance: the period and its completeness against the threshold
(including the `?period=` override, loudly), the ad window and **its own age stated separately**, the
resolved scope with both reach numbers, every active filter, the Δ's prior week and gap, and
rows-exported vs rows-in-scope so the file says so if they ever differ.

It exports the **full filtered set** — the read already requests one page of 2,000 and the grid pages
locally, so `data.rows` is every row in scope; no second round trip is needed and the header states
the two counts regardless.

🔴 **Exports are formatters**, and this page has been bitten twice by a formatter undoing the API
(SOV.0's `toFixed(2)`, SOV.1's grid re-sort). So every share is written **both raw and formatted**, no
non-zero value may format as `0.00`, and the five blank states survive as **tokens** —
`NOT_COVERED` · `NO_ROW_THIS_WEEK` · `NEVER_MEASURED` · `NO_PRIOR_WEEK` · a real `0.00` — legended in
the header. A CSV that rendered all five as an empty cell would throw away the page's central
distinction. Leading `=+-@` are guarded so an Amazon search term cannot become a spreadsheet formula.

**Saved views: no new table, no new route, no migration.** `SavedView` (schema.prisma:10812) is
already `(userId, surface)`-scoped with a name uniqueness constraint, and the full CRUD already
exists at `/api/saved-views` in `products-catalog.routes.ts:848+` — it is what /products, /listings
and the dashboard use. Checked before building, per the brief; the only thing missing was a caller.
This page is one more `surface` value (`ads-share-of-voice`).

A view stores `{ qs }` — the query string — and **re-resolves on open**. One that pinned 2026-07-19
with its rows would still be serving that week in October, which is a worse version of the defect
§2 exists to fix. A view whose URL carries `?period=` is **marked in the list**, because a name
alone cannot say that it pins a deliberately-incomplete week.

---

## 5 · SOV.7's four preconditions — current state

| # | precondition | state 2026-08-16 |
|---|---|---|
| 1 | `buildSovBidContexts` reads the wrong number | **still wrong.** `advertising-rule-evaluator.job.ts` still assigns `impressionSharePct` from `sovPct` under a comment asserting an equivalence this page disproves. Another programme's file — recorded, not touched |
| 2 | the guards are vacuous | **still vacuous.** 2,130 positive KEYWORD `AdTarget` rows, **0 with `spendCents > 0`**. A rule guarded on spend or ACoS fires on everything or nothing |
| 3 | `AdSpendCeiling` holds numbers | **0 rows.** The mechanism AUTO.A7 shipped exists and nobody has set a ceiling. An operator decision, not an engineering one |
| 4 | the data is current | **27 days old** in IT/DE/ES, 34 in FR — and §3 shows ~11 days is the floor even after a fix |

### 🔴 The cap marker — the brief's suggested reading is wrong, and so was the old finding

The brief asks whether `DAILY_CAP_EXCEEDED` is *"still that string at all"* and suggests that
**693,704 all-time / 0 in the last 7 days** most likely means the caps are correctly sized. Measured:

- The string still exists — `CAP_REFUSAL_MESSAGE` (`automation-cap-predicate.ts:23`) — and is still
  returned by the **`maxExecutionsPerDay`** path (`automation-rule.service.ts:634`).
- 🔴 **But that path writes no execution row.** Its own comment says so: *"No execution row: that is
  the bug."* It publishes to the activity feed and returns; nothing lands in
  `AutomationRuleExecution`.
- 🔴 **And a second mechanism was added that writes no marker at all.** `maxWritesPerDay`
  (`automation-rule.service.ts:676`) **demotes the execution to dry-run** rather than refusing it,
  deliberately — refusing the whole execution would also refuse the rule's `notify`.

So a count of `AutomationRuleExecution` rows carrying that errorMessage is **evidence about neither
cap's sizing**. Zero in seven days is what you would see if the caps were perfectly sized, if every
capped rule were being silently demoted instead, or if nothing were being capped at all. **Do not
read it as a health signal in either direction** — the honest statement is that the current
mechanisms are not observable through that column, and making them observable is the fix.

*(Not traced: which path wrote the 693,704 historical rows. They predate the 14 Aug re-sizing and
this session did not need the answer; whoever owns the cap will.)*

---

## 6 · Where this brief was wrong

1. 🔴 **"the ASIN coverage narrowing 25 → 15"** is account-wide and is not a narrowing. Per market
   the count is flat (IT 13 in five of six periods) and **07-19's 19 is the outlier**. §3.
2. 🔴 **The cause is rows per ASIN, not ASIN count** — a ~4× collapse, starting at 07-19, i.e. in the
   week the page currently renders. §3. This changes what the feed owner should look at.
3. **"short by 21"** → measured **20** (threshold `round(558.5 × 0.5) = 279`; 279 − 259 = 20).
4. **§8's cap reading** — "0 in the last 7 days most likely means the caps are correctly sized" is
   not supportable; the column cannot see either current mechanism. §5.
5. **`_sov6-state.mts` reported ES's chosen period as 07-19**, where SOV.1 measured 07-12. Not an
   error in either — ES's baseline moved as periods aged, and 07-19 now clears by **one row**
   (193 vs a threshold of 192). Worth knowing that a market's rendered week can change without any
   new data arriving, purely because the median moved.

---

## 7 · Known gaps

- **The rejection line names only the newest declined period** and counts the rest. Naming all of
  them would be a list nobody reads; the count plus the newest is the actionable part.
- **`?period=` is validated per MARKET, not per scope.** The brief says "market and scope". The
  period gate is market-level by SOV.0's standing decision — that is what lets two scopes in one
  market be compared — so a scope-level existence test would refuse a week the market has and the
  scope does not, which is already rendered honestly as `not-covered` rows. Stated as a deviation
  rather than silently narrowed.
- **`?page=` still does not round-trip** — unchanged since SOV.1 §7.1; `AdsDataGrid` has no
  `onPageChange`. The additive fix is written up there.
- **Saved views are per-user via `userIdFor(request)`**, inheriting whatever that resolves to in
  this deployment. Not investigated; it is the same identity /products' saved views already use.
- **No cursor for this page**, deliberately. SQP moves weekly and the ad side daily; SOV.2's ad
  columns are the only argument for one, and the honest version of that argument is a measurement of
  how often those columns actually change between two loads — which nobody has taken. Not wired.
- **A real zero is still unreachable** — 0 rows with a real market total and none of ours in any
  chosen period, in all four markets. Fourth session to confirm it; recorded, not manufactured.

---

## Appendix — scripts

| script | what it measures |
|---|---|
| `_sov6-verify.mts` | **new** — the rejection reckoning per market; `?period=` accepted (every share-derived number moves) and refused (malformed · not-in-market); the Δ's prior under an override and its gap; the periods the override may offer |
| `_sov6-handoff.mts` | **new** — the ASIN series per period per market and which ASINs dropped; the ratio sensitivity at 0.5/0.4/0.3; the feed's best achievable age |
| `_sov6-state.mts` · `_sov6-state2.mts` | pre-existing; re-run, not modified |
