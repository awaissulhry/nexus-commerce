# AR — Apply Rules, as its own page

*Page study 11 of 11. The landing tab of Rules & Automation.
Companion to [the tab study](2026-08-11-ar-apply-rules-study.md), which measured what the tab is.
This one designs what the page should be.*

**Read-only study. Nothing was changed, no code was written, nothing was committed.**

Measured on production 2026-08-11 — three read-only scripts plus a live browser probe of
`https://nexus-commerce-three.vercel.app/marketing/ads/rules-automation` and of
`GET /advertising/campaigns` / `GET /advertising/control-room/guardrail-grid` on the Railway API.

---

## 0 · The one-sentence version

The five columns on this grid are a faithful copy of Helium 10's, three of them are fiction, and
**every fact they should have shown is already in the response the page fetches and throws away** —
`biddingStrategy`, `minBidCents`, `maxBidCents`, `placements`, `deliveryStatus`, `spend`, `sales`,
`acos` — while a *second* endpoint that this codebase already wrote, already deploys and already
serves to two other screens returns the write gate, the bid bounds, the pins and the bound rules for
all 220 campaigns in one call.

**Nothing here needs to be built. It needs to be connected.**

---

## 0.1 · Seven corrections to the tab study — measured today

I am correcting my own study of ten hours ago. Each of these changes a recommendation.

| # | the tab study said | measured on prod today |
|---|---|---|
| **C1** | *"The Status filter defaults to Enabled, so it opens on 86 of 220, hiding 133 paused"* | 🔴 **False. The grid renders all 220.** The browser reads **"Viewing 1-100 of 220 Campaigns"**. `AdsDataGrid.tsx:249` skips an empty multiselect (`if (vals.length === 0) continue`) and `RulesAutomationClient` never passes `initialFilters`. What "Enabled" is, is the filter's **placeholder** (`RulesAutomationClient.tsx:253`) — inside a panel that loads **collapsed** (`filtersDefaultOpen={false}`, line 333). **The defect is the opposite of the one I reported, and worse:** nothing is hidden, there is **no Status column at all**, and status lives only in a hover card. Page 1 is 86 ENABLED + 14 PAUSED because `enabledFirst` *ranks*; the operator cannot tell which is which. |
| **C2** | *"Min/Max Bid … needs an endpoint instead of `setState`"* | 🔴 **The endpoint exists and is already used by the sibling grid.** `PATCH /advertising/campaigns/:id/guardrails` (`advertising.routes.ts:769`) takes `minBidCents`/`maxBidCents`, validates through `validateGuardrails`, writes an `AdvertisingActionLog` row. `GET /advertising/campaigns` already **returns both** (line 202-203 of the select). And **`CampaignsGrid.tsx:1140` already writes it**, having fixed this exact bug: *"Before this the column was UI-only: the editor updated local state, toasted 'Amazon field pending', and threw the value away on refresh."* The fix was made on one grid and never propagated to the other. |
| **C3** | *"Bid Rule — nothing, no field, no endpoint"* | 🔴 **There is a real per-campaign bid field, in the same payload, with two values.** `Campaign.biddingStrategy`: **`LEGACY_FOR_SALES` × 209 · `AUTO_FOR_SALES` × 11**. It is Amazon's own bidding strategy, it is enforced by Amazon, it is in the `GET /campaigns` select, and `AD_BIDDING_STRATEGY_UPDATE` audit rows exist. The fake "Bid Rule" occupies the slot a real column belongs in. |
| **C4** | *"171 campaigns carry a placement multiplier"* | **167** carry a `placementBidding` array · **165** have at least one non-zero lane · **149** have a Top-of-Search value specifically. Lanes per campaign: 1→74 · 2→41 · 3→45 · 4→7. |
| **C5** | *"60 paused campaigns with ≥100% Top-of-Search"* | **58**. (Study 3's number, re-measured today. The point survives; the figure moved.) |
| **C6** | *"43 of 51 rules are unscoped, so every row reads '51 automations can reach this campaign'"* | Precise version: **all 8 scoped rules are DISABLED**. Of the **22 enabled** rules, **zero** carry any scope, so the enabled reach is **22 on every one of the 220 rows** — no differentiation at all. The 51/43 split I predicted is real but comes entirely from the 8 *off* rules: 51 reach the 150 IT campaigns, 43 reach the other 70. |
| **C7** | (not covered) | 🔴 **`Campaign.spend` is an unlabelled ~30-day figure.** Of the 70 campaigns with stored spend > 0, **65 match the last-30-days window to the cent**; only 8 match 7d and 30 match 60d. Σ stored spend €3,052.86 vs Σ 30d-windowed €3,047.44. A metric column rendered from the stored value ships a hidden window with no label. |

---

## 1 · What exists — every wire

```
/marketing/ads/rules-automation            page.tsx (force-dynamic, Suspense)
└── RulesAutomationClient.tsx              467 lines, 11 tab branches
    ├── AdsPageHeader                      title · market select (local useState:93) · "+ Rule"
    │                                      showLearn=false showDataSync=false showDateRange=false
    ├── RuleImpactStrip                    GET /advertising/automation-analytics?windowDays=30
    └── AdsDataGrid<Camp>                  GET /advertising/campaigns?limit=500     (:104)
        columns   Bid Rule · Target ACoS · Min/Max Bid · Bid Automation · Budget Rule   (:174-198)
        filters   Status · Campaign Type · Portfolio · Campaign · Bid Automation        (:252-263)
        search    by campaign name                                                      (:329-331)
        edit      hover-pencil, 3 fields, bulk:false                                    (:201-250)
        bulk      Automation · Assign Rule · Target ACoS · Min/Max Bid                  (:320-327)
        opts      customizable={false} · filtersDefaultOpen={false} · pagerCentered
                  no storageKey · no defaultSort · no initialFilters · no toolbarLeft/Right

writes  PATCH /advertising/campaigns/:id/automation      advertising.routes.ts:837
          → dynamicBidding.bidAutomation  (bool)
          → dynamicBidding.targetAcos     (FRACTION, clamped 0–5)
        …and nothing else. The other two editable fields never leave the browser.

reads it does not use, from the SAME response:
        biddingStrategy · minBidCents · maxBidCents · placements{tos,pdp,ros}
        deliveryStatus · deliveryReasons · dailyBudget · spend · sales · acos · roas
        impressions · clicks · trueProfitCents · startDate · endDate · lastSyncedAt

endpoints that exist, are deployed, and this page never calls:
        GET   /advertising/control-room/guardrail-grid?limit=500    :10837   ← §6
        PATCH /advertising/campaigns/:id/guardrails                 :769     ← §5
        PATCH /advertising/campaigns/:id/live-writes                :857
        POST  /advertising/campaigns/live-writes/bulk               :877
        PATCH /advertising/campaigns/:id/pins                       :10860
        PATCH /advertising/campaigns/:id/cpc-ceiling                :648
```

### 1.1 The sibling grid already does most of this

`/marketing/ads/campaigns` → `CampaignsGrid.tsx`. Its `ALL_COLS` (line 165+) contains, among
~45 columns: **Amazon Delivery · Automation · Bid Algorithm · Status · Min/Max Budget · Rules ·
Bidding Strategy · Bid Multiplier · Daily Budget · Current/Average Budget Utilization · Spend ·
Sales · ACoS · ROAS · …** — plus `targetAcos`, `minMaxBid` and `bidAutomation` (lines 229-231), a
date range, column customisation, and an export that hands over the ids its own filters resolved to.

**Two of Apply Rules' five columns exist there in a working form; a third (Bid Algorithm) exists
there in the same broken form.** This is the duplication the plan's §4.0a-FINAL used to argue for
dropping this tab. The operator reversed that. **So the duplication is now a design problem this
page must answer, not a reason to delete it** — see §9.

---

## 2 · How it works — what each column reads, and exactly where it lies

Measured in the browser across the 100 rendered rows. Every column returned **one distinct value**:

| column | source | distinct values on 100 rows | truth |
|---|---|---|---|
| **Bid Rule** | `c.bidAlgorithm ?? 'TARGET_ACOS'` — a field no API returns | `Target ACOS` ×100 | The client type declares `bidAlgorithm` (`:41`); `grep -a` finds it in **no API file**. `BID_ALGOS` (`:56-60`) is a copy of Helium 10's three choices. Editing it calls `patchLocal` (`:242`) and nothing else. |
| **Target ACoS** | `dynamicBidding.targetAcos` ✅ real, read by five services | `30.00%` ×100 | `((c.targetAcos ?? 0.3) * 100).toFixed(2)` (`:181`). **0 of 220 campaigns have a target.** The 0.3 is `ads-bid-optimizer.service.ts:72`'s fallback — and it is also **Helium 10's own product default**, which is where the copy came from. Two decimal places on a number nobody set. |
| **Min/Max Bid** | `c.minMaxBid` — **a key the payload does not contain** | `None` ×100 | Probed live: `'minMaxBid' in items[0]` → **false**. The payload carries `minBidCents` (null ×220) and `maxBidCents` (80¢ ×72 · 190¢ ×8 · 90¢ ×2 · null ×138). The column reads the wrong name for data that is right there. |
| **Bid Automation** | `dynamicBidding.bidAutomation` ✅ real | 100 switches, **0 on** | The one column that both reads and writes correctly. It has never been used. |
| **Budget Rule** | nothing — `render: () => <span>None</span>` (`:195`) | `None` ×100 | `grep -arn "budgetRule" apps/api/src` → **no matches**. |

### 2.1 The bulk actions, one by one

| action | what it does |
|---|---|
| **Automation** | ✅ persists — `PATCH /campaigns/:id/automation`, one request per selected row (`:159`) |
| **Assign Rule** | 🔴 **discards the selection.** `onClick={() => setShowRuleType(true)}` (`:323`) opens the same modal as "+ Rule", whose Next does `router.push('/builder/<type>')` (`RuleTypeModal.tsx:17`). Select 40 campaigns, click Assign Rule, land on a blank rule builder that has never heard of them. |
| **Target ACoS** | ✅ persists — same route, one request per row (`:164`) |
| **Min/Max Bid** | 🔴 `setRows` only (`:169`). Gone on refresh. |

Same split in the hover-pencil editor: `targetAcos` PATCHes, `bidRule` and `minMaxBid` are
`patchLocal` (`:242-246`).

### 2.2 `RuleImpactStrip`, and the number it makes an operator believe

Rendered on prod, 30-day window:

> 1,702 actions recorded · 25,437 runs that acted · **0 bids adjusted** · 1,702 budgets changed ·
> 0 terms negated · 0 campaigns guarded · 2,132 actions failed · 2 / 9 of the rules that ran

**"0 bids adjusted" sits directly above a grid whose entire subject is bid automation.** In the same
60 days `AdvertisingActionLog` holds **23,589 `AD_TARGET` rows** — bid writes — across **1,707
targets in 65 campaigns**. Both numbers are true: the strip counts *rule executions*, and rules made
0.2% of the account's writes (study 10). The strip's header already warns about three ways its
figures mislead; this is a **fourth**, and it is the one that matters on this page, because the
reader's conclusion — *"no bids are moving"* — is false at the account level.

This is the reconciliation the plan's ledger deferred to "the Overview study" (*"two grains, two
answers"*). **The answer: the strip must state its grain in the label** — "bids adjusted **by
rules**" — and the row must carry the other grain (§7).

---

## 3 · The two dead columns — delete, or is there a version worth building?

**Neither should be deleted. Both should be replaced by the real thing they were standing in for.**

### 3.1 Bid Rule → **Bidding Strategy** (real, varying, already in the payload)

| | |
|---|---|
| today | a Helium 10 concept — "create your own bid change logic using PPC metrics" — with no field, no route, no reader |
| available now | `Campaign.biddingStrategy`: `LEGACY_FOR_SALES` **209** · `AUTO_FOR_SALES` **11** |
| what it means | Amazon's own campaign bidding strategy: *down only* vs *up and down*. It changes what Amazon does to every bid in the campaign, before any of our multipliers apply. |
| already built | in the payload (`advertising.routes.ts` select); rendered and **editable** on the Ad Manager (`CampaignsGrid.tsx` `case 'biddingStrategy'`, with a pencil → `setStrategyModal`); audited as `AD_BIDDING_STRATEGY_UPDATE` |
| cost | one column definition. Reuse the Ad Manager's modal — do not fork it. |

The H10 "custom bid rule" idea is not worthless, but its home is the rule builder (session 10's
subject), not a per-campaign cell. **A cell should show a value, not advertise a feature.**

### 3.2 Budget Rule → **Budget authority** (the referent exists; the rows do not)

Three things could back a Budget Rule column, and I measured all three:

| candidate | measured |
|---|---|
| `BudgetSchedule.campaigns[]` — our own scheduler | **0 rows** (read directly, not a swallowed error: the query returned `[]` and the member map is empty). Session 4 owns it. |
| Amazon-native budget rules | `grep -arn "budgetRule\|budget_rule\|budgetRules" apps/api/src` → **no matches**; this codebase has never called them. And they are **increase-only, SP-only**, with hours-of-day geo-blocked for IT/DE/ES/FR [[reference_amazon_native_budget_rules]]. |
| armed `adjust_ad_budget` rules + `budget-manager-cron` | **2 armed rules reach all 220 campaigns**; `budget-manager-cron` wrote **1,165** campaign rows in 30 days; `AD_BUDGET_UPDATE` totals **2,387** in 60 days |

So the honest column is not "which budget rule is attached" (nothing is) but **"what can change this
campaign's budget today"** — which study 4 measured at *five* claimants and which no screen states.
Today that answer is `budget-manager-cron` + 2 armed rules + 0 schedules, identical on every row —
**so it is a header sentence, not a column, until a schedule or a scope exists.** State it once,
link it to sessions 4 and 6, and reclaim the column width.

**Verdict:** delete the *label* "Budget Rule"; keep the *question* in the account band; promote it to
a column the day `BudgetSchedule` has rows or budget rules carry scope.

---

## 4 · The 30.00%

`RulesAutomationClient.tsx:181`. **0 of 220 campaigns have `dynamicBidding.targetAcos` set.**

Render **`—`**, and put the fallback in the column header tip, once:
*"Campaigns with no target use the optimiser's 30% default."*

Two things this must not do:

1. **Do not write `Campaign.targetAcosPct`.** `ads-guardrails.ts:18` is explicit that the column is
   a mistake kept unused pending a destructive migration. It remains **0 of 220** — the discipline
   held for a year. *(One clarification to my own earlier reading: `getGuardrailGrid`
   (`ads-control-room-detail.service.ts:423`) emits a field **named** `targetAcosPct` but computes it
   as `db.targetAcos * 100` with the dead column only as a fallback. It reads the right field under a
   confusing name. No defect — but the name will mislead the next reader, and renaming it is a
   one-line kindness.)*
2. **Do not treat 30% as a target.** `bid_to_target_acos` already stores this number in two units on
   two different rules (0.3 vs 30 — plan ledger, guarded 2026-08-10). Anything this page writes must
   be a fraction, clamped, and echoed back from the server.

---

## 5 · Wire Min/Max Bid — the smallest real change on this page

### 5.1 It is already solved, three files away

`CampaignsGrid.tsx:850-856` derives the display shape from the payload:

```ts
const centsToEur = (v) => (v == null ? null : v / 100)
setRows(items.map((c) => ({ ...c,
  minMaxBid: (c.minBidCents != null || c.maxBidCents != null)
    ? { min: centsToEur(c.minBidCents), max: centsToEur(c.maxBidCents) } : null })))
```

and `:1135-1145` writes it:

```ts
const r = await patchWrite(`${backend}/api/advertising/campaigns/${c.id}/guardrails`,
                           { minBidCents, maxBidCents })
```

**That is the whole fix.** Apply Rules needs the same mapping in its `load()` (`:104-108`) and the
same call in place of the two `patchLocal`s (`:169`, `:245`). No endpoint, no migration, no schema.

### 5.2 What the endpoint already guarantees

`validateGuardrails` (`ads-guardrails.ts`) is **already written for a bulk caller** — it takes
`existing: ExistingGuardrails[]`, *"every campaign the patch will land on — all of them are checked,
so a bulk update fails whole rather than leaving some campaigns in an unwritable state"* — and it
catches the one-sided case: setting max 50¢ across a selection where one campaign already has min
80¢ would produce a campaign no engine can write to at all. **The validator for the bulk route
exists; the bulk route does not.** See §12 R6.

The route also writes an `AdvertisingActionLog` row with `evidence: { metric: 'operator_guardrail' }`
— *"enforced at the write gate, never pushed to Amazon"*. In 60 days that action type
(`set_campaign_bid_bounds`) has fired **once**.

### 5.3 Enforcement, and the one thing a floor must never be confused with

`ads-write-gate.ts:275-285`:

```
maxBidCents  → refuse: "bid N¢ exceeds Campaign.maxBidCents=M¢"
minBidCents  → refuse: "bid N¢ is below Campaign.minBidCents=M¢"   … unless ctx.isSuppression
```

That `!ctx.isSuppression` exemption is the answer to the brief's question. The gate already
distinguishes:

- **a floor** — "never bid below X" — a *policy* about how cheap this campaign is allowed to be;
- **a suppression** — a deliberate drive to ~€0.02 to stop spend without pausing
  ([[feedback_no_pause_use_low_bids]]) — an *event*, owned by an engine, recorded in
  `bidsSuppressedAt` / `bidsSuppressedBy` / `bidsSuppressedFloorCents`.

**They must never render as the same cell.** The design: `Min/Max Bid` shows the policy
(`— · 0.80` today for the 82 bounded campaigns). Suppression is a **separate row state** — an arrow,
a pill, whatever the shell settles on — carrying the owner (`suppressedBy`), because a campaign
sitting at 2¢ under a €0.80 floor is not a floor violation, it is a suppression in progress. Both
fields already ride the guardrail-grid payload; **0 campaigns are suppressed today**, so this can be
built correctly now and cost nothing until it matters.

### 5.4 Boundary with session 9 (Bid)

| this page | session 9 |
|---|---|
| the **bound** on a campaign: min/max cents, who set it, when, and whether a refusal has hit it | the **policy**: what a floor should be, derived from CPC/CVR/margin; the bid-change engine; `maxBidChangePct` semantics; `cpcCeiling` semantics |
| the bulk write across a selection of campaigns | the recommendation of a value |
| rendering a refusal that names the bound | the model that decides the bound is right |

`minBidCents` is **0 of 220** — nothing on any page has ever asked for the number. This page is where
the number gets entered; session 9 is where it gets chosen. Those are different jobs and both are
open.

---

## 6 · 🔴 The Automations column

### 6.1 The read-only version, measured — and it is not one number

I ran `ruleMatchesScope` (the evaluator's own matcher, with product-parent expansion) against every
campaign × every advertising rule.

| what the cell would say | value | on how many rows |
|---|---|---|
| rules that **exist** and could reach it | **51** | 150 (all IT) |
| " | **43** | 70 (DE 38 · FR 22 · ES 10) |
| rules that are **enabled** and reach it | **22** | **all 220 — identically** |
| enabled **and on AUTO** (armed) | **9** | all 220 |
| armed and able to **write** (1 is notify-only) | **8** | all 220 |
| armed, by dimension: **bid** | **5** | all 220 |
| armed, by dimension: **budget** | **2** | all 220 |
| armed, by dimension: **placement** / **state** | **0** / **0** | all 220 |

**The 51/43 split comes entirely from 8 rules that are switched off.** Every enabled rule in the
account is unscoped, so "22" prints on all 220 rows. `CampaignsGrid.tsx:1300` reached the same
conclusion in 2026-08-05 and used it to *omit* the column: *"all 22 enabled advertising rules are
account-wide, so folding them in would print '22' on all 216 rows and say nothing about any of
them."*

**That reasoning is right about the number and wrong about the column**, for one measured reason:

> 🔴 **Matched by an armed writing rule but gate SHUT: 138. Matched *and* permitted: 82.**

That *is* per-row, it *is* the doctrine's honest reading (D3: *"Matched 40, allowed to act on 12"*),
and it is invisible everywhere. The cell should not be a count of rules. It should be **a verdict
about this campaign**:

```
   Managed · 7 armed rules can write here (5 bid · 2 budget)      ← 82 rows
   Off-limits · 7 armed rules match; every write is refused        ← 138 rows
```

Same two facts, opposite meanings, and today the page shows neither. A column that says "22" on
every row is noise; a column that says **"this campaign is one of the 82 automation may actually
touch"** is the single most useful sentence on the grid.

### 6.2 The payload already exists

`GET /advertising/control-room/guardrail-grid?limit=500` — probed live, **HTTP 200, 220 rows**:

```
top level  { rows, accountWideRules: 22, totals: { campaigns 220, managed 82,
                                                   withMinBid 0, withMaxBid 82,
                                                   pinned 0, suppressed 0 } }
per row    id · name · marketplace · status · portfolioId · portfolioName
           managed · minBidCents · maxBidCents · dailyBudgetCents · targetAcosPct
           cpcCeiling · suppressedAt · suppressedBy · suppressedFloorCents
           pins{placement,bids,budget} · pinnedDimensions · pinNote · pinnedBy · pinnedAt
           boundRules[]
```

Its own header (`advertising.routes.ts:10830`) states the purpose exactly: *"the counts were true
and useless: '0 of 216 campaigns have a minimum bid' tells an operator there is work to do and gives
them nowhere to do it."* It is already consumed by the Ad Manager **and** the Control Room's
Guardrails tab, *"so they cannot drift apart — they are the same rows."* **Apply Rules should be the
third consumer, not the first author of a fourth version.**

Two accuracy notes for whoever wires it:

- `boundRules` reads **only `scopeCampaignId`** (`ads-control-room-detail.service.ts:379`), which is
  null on all 51 rules → `boundRules` is empty on **0 of 220** rows, correctly, today.
- `accountWideRules` counts `enabled AND scopeCampaignId=null AND scopePortfolioId=null` — it does
  **not** exclude market scope. Today that is harmless (**all 8 market-scoped rules are disabled**,
  measured). The moment one is enabled, "22 rules govern every campaign" becomes false for the 70
  non-IT rows. **Add `scopeMarketplace` to that filter, or resolve reach per row.**

### 6.3 🔴 There is a *second* scope mechanism, and it is invisible to the first

Two rules name campaigns **inside their action JSON** rather than in the scope column:

| rule | mode | names |
|---|---|---|
| *Rank control — Top +100% · 99 campaign(s)* | OFF | 198 campaign ids in its config |
| *AIREON — Target ACoS bidding* | PROPOSE | `campaignIds`: 11 campaigns — the array the handler **silently ignores** (guarded 2026-08-10, plan ledger) |

A campaign-side Automations column that reads `scopeCampaignId` alone **would show "no rule is bound
here" on all 11 AIREON campaigns while a rule names them by id.** This is a constraint on session
10's contract, not a defect I can fix: **either the scope columns become the only binding mechanism
(and the config arrays are migrated or refused), or the reach resolver must read both.** Two places
to declare the same thing is how this programme's two-vocabularies defects start.

### 6.4 The assignable version — what the migration costs

The blocker is unchanged and it is session 10's: `scopeCampaignId` / `scopePortfolioId` /
`scopeProductId` are **single-valued**, so assigning from the campaign side would *move* a rule off
its 219 other campaigns rather than add one. The fix is additive arrays.

**Cost, as far as I can price it from this side:**

| piece | cost | owner |
|---|---|---|
| `scope*Ids String[]` columns, additive, nullable, indexed — pre-approved class of migration | one migration | 10 |
| `ruleMatchesScope` — the product grain is **already** an array (`scopeProductIds?: string[]`, a plain intersection); the other three become the same shape | small, pure, testable | 10 |
| the evaluator's per-tick expansion — already exists for products | small | 10 |
| `PATCH /autonomy/rules/:id/scope` — accepts arrays, keeps the 409 `scope_matches_nothing` refusal | small | 10 |
| **an add/remove-at-campaign-grain route** — "add these 40 campaigns to these 3 rules" | **new** | 10, consumed here |
| this page: the cell, the multi-select, the confirm | days | **this page** |

**The four grains, from a campaign row.** Law 3 says every grain gets the same control and the same
number of clicks. From this page that resolves cleanly, because a campaign row *knows* its own
market, portfolio and products:

> Select 40 rows → **Apply automations** → pick automations → pick the grain to bind at:
> **these 40 campaigns** · **their 2 portfolios** (12 campaigns unreachable — 148 of 220 carry no
> portfolio) · **their 4 markets** (=220 campaigns) · **their 3 product lines** (=77 campaigns).
> Each option states its resolved campaign count *before* it runs, computed client-side from
> `GET /advertising/scope-options` so the preview cannot disagree with enforcement.

**The confirm is the product.** D4 requires a full sentence wherever money moves:

> *"Bind 3 automations to 40 campaigns. 2 of the 3 can write (bid, budget). 14 of the 40 have the
> write gate open — the other 26 will match and be refused. Undoable for 24h."*

That sentence is why a campaign-side assignment is worth building at all: it is the only place in the
system where reach, permission and blast radius can be stated in one line, because it is the only
grid whose rows *are* the blast radius.

### 6.5 How "N automations reach this campaign" stops being noise

Four rules, in order of value:

1. **Lead with the verdict, not the count** — Managed / Off-limits (§6.1). 82 vs 138 is real
   variance on day one.
2. **Count only what can act.** 22 enabled is noise; **7 armed writers** is a fact. An OFF rule is a
   plan, not a participant (the conflict detector already reasons this way).
3. **Split by dimension.** "5 bid · 2 budget · 0 placement" tells an operator which of this row's
   other columns are live. One number cannot.
4. **Name the engines too, or say you have not.** The armed-rule count is **7**; the actors that
   actually wrote to campaigns in 30 days are `rank-defend` **24,524** · null **5,460** ·
   `user:anonymous` **1,994** · rule executions **1,216** · `budget-manager-cron` **1,165**. A column
   headed "Automations" that counts only rules is 0.2% of the truth. **Either it counts engines too
   or its header says "rules".** *(Whether engines get first-class rows is session 10's open question
   1; this page needs the answer, it should not invent it.)*

---

## 7 · Governance on the row

Everything below is **enforced per campaign today** and appears **nowhere on this page**.

### 7.1 On the row

| control | measured | why the row |
|---|---|---|
| **Managed** (`liveBidWritesEnabled`) | **82 of 220** | the single strongest per-row fact in the account, and the thing the operator said they want to widen deliberately. Toggle inline; bulk via `POST /campaigns/live-writes/bulk` (`:877`), which takes `campaignIds[]` **or** a whole marketplace. |
| **Bid bounds** (`minBidCents`/`maxBidCents`) | 0 / **82** — and `maxBidCents ∩ managed = 82 exactly`. Only three distinct values ever set: **80¢ ×72 · 190¢ ×8 · 90¢ ×2** | §5. The perfect overlap with the gate says one process set both; it is the shape of a cutover, not of per-campaign judgement. |
| **Pins** (`pinBids`/`pinBudget`/`pinPlacement`) | **0 / 0 / 0**, and `set_campaign_authority_pins` fired **9 times** in 60 days (set, then cleared) | three booleans, gate-enforced, whose only UI is a Control Room tab the operator does not use. `PATCH /campaigns/:id/pins` audits with `pinnedBy`/`pinnedAt`/`pinNote`. |
| **Status** | ENABLED 86 · PAUSED 133 · ARCHIVED 1 | 🔴 **there is no status column** (§8). |
| **Delivery** | **NOT_DELIVERING 140 · DELIVERING 79 · null 1** — already in the payload | 7 ENABLED campaigns are not delivering. "Enabled" and "delivering" are different facts and the page shows neither. |
| **Automations verdict** | 82 permitted / 138 matched-but-refused | §6 |

### 7.2 In a drawer

Low-cardinality, high-detail, or needing a second call:

- `cpcCeiling` — **6 campaigns carry the object, 2 have it enabled** (the guardrail grid returns only
  the enabled ones, which is why it reports 2; both numbers are right and mean different things)
- `maxBidChangePct` **2** · `maxWritesPerDay` **2** · `liveBidWritesToday` > 0 on **45**
- suppression: `bidsSuppressedAt`/`By`/`FloorCents` — **0 today**
- `pinNote` / `pinnedBy` / `pinnedAt`
- **the last N changes to this campaign**, from `AdvertisingActionLog` — see §7.4
- the placement lanes in full (read-only) with a link to session 3

### 7.3 On another page entirely

| subject | owner | this page shows |
|---|---|---|
| placement multiplier **values** and the ToS/RoS inversion | **3 · Placement** | a read-only lane summary + link. 149 campaigns carry a ToS bias; the biggest is **+202%**, on five paused campaigns. |
| what a bid floor **should be** | **9 · Bid** | the bound and its refusals |
| the € spend ceiling per market / line / portfolio | **6 · Budget**, **4 · Budget Schedules** | the **refusal**, rendered on the row |
| a rule's definition, mode, caps, conflicts | **10 · Automations** | the reach verdict + a link |
| which clock owns this campaign this hour | **5 · Rank & Dayparting** | that a live schedule governs it — **33 campaigns, all 33 gate-open** (45 `AdSchedule` rows name 45 campaigns; 33 sit under an enabled group) |

### 7.4 The per-scope spend ceiling, at campaign grain

The operator's standing decision: ceilings per **market · product line · portfolio · campaign**,
never one global number; at the cap, **refuse the write and say so**.

**What belongs at campaign grain, on this page:**

1. `maxBidCents` / `minBidCents` — enforced today, settable nowhere. (§5)
2. `maxWritesPerDay` — enforced today, set on 2 campaigns, settable nowhere.
3. **The daily budget is already the campaign-grain € ceiling** and Amazon enforces it. Nothing new
   is needed there — but the page should show it, because §8's numbers make it the most alarming
   column on the grid.
4. 🔴 **The refusal surface.** This is the piece that does not exist anywhere. **138 campaigns are
   matched by an armed writing rule and refused at the gate**, and that produces **zero** pixels on
   any screen. A refusal must be visible **on the row it refused**, naming the scope that refused it
   and how to clear it. `pinDenial` already writes these sentences
   (`ads-authority-pins.ts:128`); the page should **display them, never paraphrase**.

   ⚠ **One caveat on the other refusal class, from a parallel session today:** the 693,704
   `DAILY_CAP_EXCEEDED` rows study 10 counted are **historical residue** — newest 2026-08-03, none in
   the last 7 days — because a `NOT: { errorMessage: … }` three-valued-logic filter disabled the
   per-rule daily cap on 2026-08-04 and a cap refusal has written no durable row since
   [[reference_daily_cap_not_enforced]]. **So the cap is not currently a refuser, and this page must
   not render it as one.** The gate is. That is another session's finding and another session's fix;
   it is recorded here only so this page does not build a refusal column on a dead signal.

**What does not belong here:** the € number for a market, a product line or a portfolio. Those
aggregate across rows this grid does not group by, and sessions 4, 6 and 3 own the policies. This
page is where a ceiling is *entered at campaign grain* and where *its refusals surface*.

### 7.5 The audit trail has a hole

`AdvertisingActionLog`, `entityType='CAMPAIGN'`, 60 days: **18,039 rows across 139 entity ids; 116 of
the 220 grid campaigns have at least one.**

| actionType | rows |
|---|---|
| `update_placement_bidding` | **15,379** |
| `AD_BUDGET_UPDATE` | 2,387 |
| `reconcile_verification` | 177 |
| `create_campaign` | 67 |
| `AD_CAMPAIGN_PORTFOLIO_UPDATE` | 11 |
| `set_campaign_authority_pins` | 9 |
| `AD_ENTITY_STATE_UPDATE` | 5 |
| `set_campaign_bid_bounds` | **1** |

🔴 **9,378 of the 18,039 rows carry `userId = null`** — 9,199 of them `update_placement_bidding`.
The most frequent write in the account is **anonymous**. A "last changed by" column would read `—` on
half the rows, and there is no way to tell an engine's write from a human's on those. *(The other
6,180 `update_placement_bidding` rows do carry `automation:rank-defend-<id>`, so the same action type
has two writers and only one identifies itself.)*

Bid writes live at a different grain: **23,589 `AD_TARGET` rows → 1,707 targets → 65 campaigns**
(35 target ids no longer resolve). Rolling them up to a campaign is a two-hop join and gives a real,
varying column: the top row is *GALE | IT | Broad | Category* at **2,378 bid writes in 60 days**.

---

## 8 · Metrics — and naming the pixel

### 8.1 The pixel, named

The 2026-08-10 revert was correct: *a date control on a grid with no metric columns changes
nothing.* It becomes wrong the instant a metric column lands, and I measured exactly how wrong.

Probed live against the production API:

| request | response |
|---|---|
| `GET /advertising/campaigns?limit=500` | `range: null`; `spend` = the stored columns |
| `GET /advertising/campaigns?limit=500&preset=last7` | `range: { startDate: "2026-08-05", endDate: "2026-08-11", preset: "last7" }`; **spend differs on 62 of 220 rows** |

**The pixel is 62 spend cells, plus sales, ACoS, ROAS, clicks, impressions and PPC orders in the same
rows.** The server re-derives them from `AmazonAdsDailyPerformance` and **echoes the resolved range**
(`advertising.routes.ts:267`). That echo is the law from plan §3.4: *the server owns the date
vocabulary; the client sends a key the server understands, never its own computed dates, and displays
the range from the response.* Sending a `DateRangePicker` preset key straight through returns **7
days under any label** — only `today` and `yesterday` exist in both vocabularies.

### 8.2 And the stored numbers are a hidden window

Without date params the payload returns the stored columns, and **65 of the 70 campaigns with spend >
0 match the last-30-days window to the cent** (8 match 7d, 30 match 60d). So the "no date control"
option is not neutral — **it ships an unlabelled 30-day figure**. Either put the control on, or label
the header "last 30 days". Silence is the one choice that is wrong.

Coverage, for honesty about what the columns can carry:

| window | campaigns with rows | with spend > 0 | spend | sales | ACoS |
|---|---|---|---|---|---|
| 7d | 72 | 62 | €654.63 | €1,372.96 | 47.7% |
| 30d | 83 | 65 | €3,047.44 | €7,280.69 | 41.9% |
| 60d | 84 | 66 | €5,755.52 | €13,337.26 | 43.2% |

**~150 of 220 campaigns have no performance rows at all** — they are paused and have been for a
while. `0` and *"no data in this window"* must render differently, or the grid will read as an
account that spends nothing.

### 8.3 Which metrics belong beside a setting

Not all of them — this is a settings grid, not the Ad Manager. The test is: **does this number let me
judge the setting on the same row?**

| column | judges | in payload |
|---|---|---|
| **Daily budget** | whether a budget ceiling is the binding constraint | ✅ `dailyBudget` |
| **Spend** (windowed) | whether a bid bound is capping anything real | ✅ |
| **ACoS** | whether a target ACoS would help or hurt | ✅ (26 of 220 non-null stored) |
| **Budget utilisation** | whether the €1 floor is starving a campaign | derivable — Ad Manager already computes it |
| **Bid writes (60d)** | whether automation is actually touching this row | needs the AD_TARGET roll-up (§7.5) |

**Not** impressions, clicks, CTR, CVR, CPC, AOV, ASP — those are the Ad Manager's job and
reproducing them makes this a second Ad Manager, which is the trap §9 exists to avoid.

---

## 9 · The default filter, and what the grid actually hides

### 9.1 It hides nothing, and that is the problem

All 220 render. There is **no Status column**. Status appears only inside a hover card. The Status
filter's resting label reads **"Enabled"** in a panel that starts collapsed — **a control that names
a filter it is not applying.**

### 9.2 What the operator therefore cannot see

| | ENABLED | PAUSED |
|---|---|---|
| campaigns | 86 | 133 |
| Σ daily budget | **€318.57/day** | **€8,440.00/day** |
| median daily budget | **€1.00** | €50.00 |
| at ≤ €1 | **58** | 0 |
| write gate open | 82 | **0** |
| carrying a placement lane | 62 | 105 |
| Top-of-Search ≥ 100% | — | **58** |

🔴 **The live account runs on €318.57/day across 86 campaigns, 58 of them pinned at the €1 floor,
while €8,440/day of standing budget sits on paused rows.** That is the budget ratchet (study 6)
rendered at campaign grain, and it is on this page's data, in this page's payload, on this page's
rows — and this page shows neither the budget nor the status.

The top paused rows by Top-of-Search bias: **AIREON JACKET DE +202% (€100/d) · AIRMESH JACKET
DE/ES/FR/IT +202% (€200/d each) · MISANO BROAD DE +201% (€100/d)**. Every one of them has the write
gate **shut** — so resuming any of them re-enters an unmanaged campaign with a doubled
Top-of-Search bid and a €200/day budget, and no automation may correct it.

### 9.3 What to do

**Do not add a hidden default filter.** Three changes, all cheap:

1. **Add a Status column.** The grid has no way to say what a row is.
2. **Fix the placeholder** — `placeholder: 'All'`, since that is what an empty filter does. A
   placeholder that names a value it is not applying is the same class of defect as the 30.00%.
3. **State the shape of the population above the grid**, in one sentence with links:
   *"220 campaigns — 86 live on €318.57/day (58 at the €1 floor) · 133 paused holding €8,440/day ·
   58 of those carry a Top-of-Search bias ≥ 100%."*

Then offer **saved views** rather than a hidden default. `AdsDataGrid` already ships
`filterPresetsKey` (named filter presets, localStorage) and `initialFilters` (deep-link seeding) —
neither is passed here. "Live only", "Off-limits", "Unbounded", "Paused with a hot multiplier" are
four presets, not four screens.

---

## 10 · The landing question

> **When all eleven are pages, what is `/marketing/ads/rules-automation`?**

**Recommendation: the bare route stays this page. No redirect, no separate overview.**

Four reasons, in order of weight:

1. **It is the only campaign-grain surface in the section.** The other ten are rule-grain (10),
   keyword-grain (1, 2, 7, 8), schedule-grain (4, 5) or placement-grain (3). "Which campaigns does my
   automation govern, and what is it allowed to do to them" has exactly one natural home and this is
   it. A separate overview would be a twelfth page whose every number belongs to another page —
   which law 1 forbids and the operator has already rejected once (*"I do not feel the need to make
   separate pages for everything"*).
2. **§4.0b already assigns it.** *"is automation working, and does it need me → Apply Rules (the
   landing tab)"*. The §4.1 Overview spec — posture band, did/wanted/blocked, needs-you, health strip,
   what-changed — is **a band above a grid**, not a page. `RuleImpactStrip` is two-thirds of it
   already.
3. **A redirect costs a hop and breaks every existing bookmark**, and the plan's own precedent (ACR
   Stage 6) is that redirects belong in `next.config.js` for *retired* trees, not for a live landing
   route.
4. **A landing page with no rows is a landing page nobody returns to.** The pending queue is 203
   suggestions with 1 ever applied. An overview whose main content is a queue nobody empties would
   inherit that.

### 10.1 The shape

```
/marketing/ads/rules-automation                    ← this page. No redirect.
  ├── header:  title · market · "+ Rule"
  ├── tabs:    the eleven, all routed
  ├── band:    account state, four sentences, every number linking to its rows
  │            · 22 automations can act · 7 armed · 82 of 220 campaigns permit a write
  │            · 86 live on €318.57/day (58 at the €1 floor) · 133 paused holding €8,440/day
  │            · rules made 95 of 42,885 writes in 60d — engines made the rest  → 10
  │            · 203 decisions pending, oldest 50 days                          → Activity
  └── grid:    220 campaign rows, the governance lens
```

The band replaces `RuleImpactStrip` rather than sitting beside it, and it fixes the strip's
grain problem (§2.2) by stating both numbers with both labels.

### 10.2 The boundary with the Ad Manager — the thing that must be decided

`/marketing/ads/campaigns` has ~45 columns including Automation, Rules, Bid Algorithm, Bidding
Strategy, Min/Max Bid (**wired**), Min/Max Budget, budget utilisation and every metric, with column
customisation and export. **This page must not become a second one.**

| | Ad Manager `/campaigns` | Apply Rules `/rules-automation` |
|---|---|---|
| question | *how is this campaign performing, and what is it set to?* | *what is automation allowed to do here, what has it done, what did it cost?* |
| default columns | performance | authority |
| grain of the verbs | one campaign | **a selection of campaigns** — bulk is the point |
| owns the write | structure + settings | **the gate, the bounds, the pins, the bindings** |

And one hard rule, because the min/max bug is the proof: **a control that appears on both grids has
exactly one implementation.** The `centsToEur` mapping and the `guardrails` PATCH are already
written; Apply Rules imports them or the two grids drift within a quarter.

### 10.3 The name

"Apply Rules" describes an action the page cannot perform — its Assign Rule button discards the
selection. Two honest options: **keep the name and make it true** (the §6.4 assignment), or **rename
it** to what it is (*Campaign Control* / *Authority*). I would keep the route either way, and I would
not rename until the Automations column ships — a rename before the capability just moves the lie.
**Operator's call.**

---

## 11 · Industry research — features *and* interface

### 11.1 The reference the operator already named

**Pacvue's front page reads "Introducing the Agentic Commerce Grid."** The campaign grid is no longer
a table of settings — it is where agents propose and operators approve. Pacvue Agent (14 Apr 2026)
frames it as moving *"from analysis and explanation to recommendation and governed execution within a
single workflow"*, with built-in approvals and the stated principle **"autonomous where it matters,
control where it counts."** Press coverage puts the claim at *200× faster workflows*.

### 11.2 What a campaign-management grid contains

| platform | tier | the grid |
|---|---|---|
| **Amazon Campaign Manager** | free | Revamped at unBoxed (Nov 2025): one command centre merging sponsored ads with DSP, an **"All View"** across campaign types, a universal "+" button. **Customize columns** from every metric in the console, reorderable. **Smart search filtering** — you type `SP, Impressions > 1000, Purchases > 0` and the table filters instantly; Amazon reports **26% less time** on bid-optimisation workflows. Bulk edit of budgets, dates, status, bids across a selection. Download exactly what the filters resolved to. |
| **Amazon Bulk Operations** | free | the bulksheet — still the fallback every serious operator uses, and the reason a grid must export what it shows |
| **Pacvue** | $2,000+/mo | the Agentic Commerce Grid; bulk editor across campaigns/ASINs in one click; **Pacvue XL** puts the same bulk edit inside Excel, online and offline |
| **Skai** | enterprise | Automated Actions + Budget Navigator across 100+ publishers; rule-based automation as the primary object |
| **CommerceIQ** | enterprise | role-specific AI agents alongside automated bid and budget pacing |
| **Quartile** | $895+/mo | AI automation *plus* custom rules; hourly bid adjustments; the grid is a monitor more than a control |
| **Teikametrics** | $149–179/mo, then ~3% of spend over $10k | mid-market; rule + algorithm hybrid |
| **Perpetua** (merged with Sellics) | spend-banded | goal-based ad automation across Amazon/Walmart/Instacart/Target |
| **Scale Insights** | SKU-tiered | 12 stackable algorithms at ASIN level; **the operator owns the logic** — the opposite pole from Pacvue's agent |
| **Sellozo** | SKU-based | **Campaign Studio** — visualises the whole ad structure as a map rather than a table |
| **Helium 10 Adtomic** | bundled | **the grid this page is copied from.** Default Target ACoS **30%**. Min/Max Bid is an explicit opt-in — *"add a Min/Max Bid by checking the box and entering your preferred amounts"* — and the max **restricts how high bid suggestions and automation can go**. Three bid algorithms (Target ACOS / Max Impressions / Max Orders), reachable by scrolling right. Column customisation. |

**Two things that reframe our own columns.** First: the 30.00% is not an invented default — it is
H10's product default, copied faithfully. Second: H10's Min/Max Bid is a **checkbox opt-in that
bounds automation**, which is precisely what `minBidCents`/`maxBidCents` do at our write gate. We
copied the control and left out the wire.

### 11.3 What these grids look like

Recurring across every mature product, and each one is a gap here:

| pattern | us |
|---|---|
| **Inline editing on the cell**, pencil-on-hover, with a popover | ✅ built — but 2 of its 3 fields write to `useState` |
| **Bulk edit from a selection bar**, with a confirm stating scope | ⚠ 4 actions: 2 persist, 1 doesn't, 1 discards the selection |
| **Column customisation + saved column sets**, per view | ❌ `customizable={false}`, no `storageKey` — while the sibling grid has both |
| **Saved views / filter chips** | ❌ `filterPresetsKey` exists in the component and is not passed |
| **Smart/typed filtering** (Amazon's `Impressions > 1000`) | ❌ five dropdowns and a name search |
| **A row drawer** for detail rather than a 45th column | ❌ none; `onRowClick` exists in the grid |
| **Empty states that explain themselves** | ⚠ `emptyLabel="No campaigns found."` |
| **Proposals/approvals rendered on the row** | ❌ — 203 pending suggestions live on another screen entirely |
| **Export exactly what the filters resolved to** | ❌ here; ✅ on the Ad Manager (`ExportScopeModal` hands over the ids `filtered` produced) |
| **Status + delivery as visible row state** | ❌ both in the payload, neither rendered |

### 11.4 One to steal, one to avoid

**Steal: Amazon's smart search.** A single typed expression that filters the table — measured by
Amazon at 26% less time on bid-optimisation workflows. Our filter panel is five dropdowns behind a
"Show Filters" toggle, and the one thing an operator actually wants to type here is
`gate:shut budget:>50 tos:>=100` — which is exactly the query that finds the 58 land mines in §9.2.

**Avoid: Pacvue's grid-as-everything.** Its Agentic Commerce Grid absorbs planning, execution,
approvals and reporting into one surface, and the price is that no column can be removed without
breaking someone's workflow. Our §4.0b boundary table exists precisely to stop that, and it should
survive the Automations column. **A campaign row should surface a proposal and accept a decision; it
should not become the place where the proposal is authored.**

### 11.5 What we have that they do not

- **A per-campaign default-deny allowlist.** 82 of 220. No commercial tool in the research ships one.
  It is this account's strongest safety property and it has never been rendered on a campaign row.
- **A reversibility-grounded ceiling** (`ads-graduation.ts`) — Pacvue gates on approval; we gate on
  whether an action can be undone at all.
- **An honesty note above a headline figure.** `RuleImpactStrip`'s own header lists three ways its
  numbers mislead and corrects each. Nothing in the research does this. Its one gap is the fourth way
  (§2.2), and the fix is one word in a label.

---

## 12 · Requirements on the shared layer

*Constraints, not solutions. A twelfth pass reconciles all eleven sets. Where a sibling has already
stated a requirement, I second it by number rather than restating it.*

**R1 · Market must be one selection, surviving navigation, carried in the URL.**
Seconded from KT R1/R2 and SOV 1. Concretely here: `RulesAutomationClient.tsx:93` holds
`const [market, setMarket] = useState('all')`, seeded from whichever campaigns loaded, and the
sentinel is the string `'all'` — plan §3.5 records that emitting `?marketplace=all` filters to a
marketplace of that literal name and returns **zero rows with no error**. Whatever the shared layer
chooses, the sentinel must be impossible to send.

**R2 · One URL contract this page can adopt wholesale.** Needed:
`?market=` · `?status=` · `?type=` · `?portfolio=` · `?q=` · `?sort=&dir=` · `?page=` ·
`?preset=|?startDate=&endDate=` · `?row=<campaignId>` (drawer). Today the page has **one** URL and
`AdsDataGrid` keeps filter/sort/page/search entirely in `useState` — `initialFilters` seeds them once
and nothing is written back. **The grid needs to emit its state, not just accept it.** This is the
single largest shared-layer ask from this page and it blocks §9's saved views and every "see all →"
link in the account band.

**R3 · The date vocabulary is the server's.** Seconded from plan §3.4, and now with a measurement
behind it: `GET /advertising/campaigns` accepts `preset|startDate|endDate|windowDays`, re-derives
metrics from `AmazonAdsDailyPerformance`, and **echoes `range: {startDate, endDate, preset}`**. The
client must send a key `resolveRange` understands and render the echo. `_shell/DateRangePicker`'s
`DATE_PRESETS` share only `today` and `yesterday` with the server's `RangePreset`, and the `default:`
branch silently falls back to 7 days. **Fixing that picker is the shared owner's job, not this
page's** — but this page cannot ship a metric column until it is fixed or bypassed.

**R4 · One `authority` payload, one consumer contract.**
`GET /advertising/control-room/guardrail-grid` already serves the Ad Manager *and* the Control Room's
Guardrails tab, explicitly so that *"they cannot drift apart — they are the same rows"*. This page
must be the **third consumer, not a fourth author**. Two corrections it needs first: (a)
`accountWideRules` must exclude market-scoped rules or resolve reach per row (§6.2); (b) the field
named `targetAcosPct` should be renamed — it correctly reads `dynamicBidding.targetAcos`, and the
name invites the next reader to wire the dead column.

**R5 · Rule reach must have exactly one resolver, and it must read every binding mechanism.**
`ruleMatchesScope` is the one answer to "does this rule apply here" — but **two rules bind campaigns
inside their action JSON** where it cannot see them (§6.3). Either those are migrated/refused, or the
resolver reads both. **Three surfaces already ask this question** (this page, the Ad Manager's
Automation column, the Control Room's Guardrails grid); a second definition guarantees they
disagree.

**R6 · A bulk guardrails route.** `validateGuardrails` was written for one and takes
`existing: ExistingGuardrails[]` so that a bulk update *"fails whole rather than leaving some
campaigns in an unwritable state"*. Only the per-campaign `PATCH …/:id/guardrails` exists. Without a
bulk route, "set a €0.80 floor on these 40 campaigns" is 40 requests with 40 independent failure
modes — and the validator's whole-or-nothing guarantee is lost exactly where it matters.
`POST /campaigns/live-writes/bulk` is the precedent and already takes `campaignIds[]`.

**R7 · A refusal renders identically wherever a write is refused.**
Seconded from PLC 10. This page needs it for four different refusers: the gate (138 campaigns), the
bid bounds, the pins, and the per-scope € ceiling that sessions 4/6 own. One sentence, naming the
scope that refused and how to clear it. **This page must display refusals, never implement them.**

**R8 · Every write from the UI carries an actor and a reason.**
Seconded from PLC 6, with the measurement: **9,378 of 18,039 campaign action-log rows carry
`userId = null`**, 9,199 of them `update_placement_bidding`. A "last changed by" column is
unbuildable until the write client makes omitting attribution impossible.

**R9 · A change on one page reaches the others without a reload.**
The mechanism is not mine to choose. Two constraints from here: (a) `GET /advertising/campaigns` is
**cached for 300s** in a two-tier L1/L2 cache and invalidated by an `onResponse` hook that fires
`void flushAdsCache()` **after** the response is sent (`advertising.routes.ts:130-136`) — a client
that refetches immediately after a PATCH can race the flush; (b) this page's rows are changed by
engines, not only by operators — `rank-defend` wrote 24,524 campaign rows in 30 days — so an
optimistic edit must not be clobbered by an inbound tick (seconded from RD 7).

**R10 · `AdsDataGrid` capabilities this page needs.** All believed present, listed for the
reconciliation: `filterPresetsKey` (saved views), `storageKey` + `customizable` (column sets),
`initialFilters`, `onRowClick` (drawer), `toolbarLeft`/`toolbarRight` (the date control's home per
plan §3.2), `showTotal` with a **function** total so the pinned row reacts to filters, and **CSV
export of the resolved ids** — the Ad Manager's `ExportScopeModal` pattern, not a re-implementation.
**Requested addition:** a way to render *two* states on one row (status **and** delivery **and**
managed) without three competing pills — seconded from RD 1.

**R11 · One "engine identity" resolver.** Seconded from PLC 1. This page renders actors as
`automation:rank-defend-cmr2695n…`. Placement, Bid, Rank and this page all need the same
id → human-name mapping, or four pages will name the same writer four ways.

**R12 · Where I need session 10 to commit, and where I cannot follow.**

| session 10's likely contract | can this page honour it? |
|---|---|
| `scope*Ids` become additive arrays | ✅ — and this page is the natural place to *use* them |
| every scope control states its resolved reach before acting | ✅ — `GET /advertising/scope-options` is ~220 campaigns + 13 lines, small enough to compute any combination client-side |
| a scope resolving to zero is refused (409 `scope_matches_nothing`) | ✅ |
| **the four grains get identical controls and identical click counts** (law 3) | ⚠ **partly.** From a campaign row, market/portfolio/product are *derived from the selection* — the operator picks rows and then picks the grain to bind at. That is one extra step than picking a grain from a form, but it is the only shape that lets the confirm state a real campaign count. **If law 3 means "the same form on every page", this page conflicts with it and I would argue the row-first shape is better here.** |
| engines get rows and a mode dial alongside rules | ⚠ **needs an answer before the Automations column ships.** A column headed "Automations" that counts only rules describes 0.2% of what writes to these campaigns (§6.5). |
| scope binding stays exclusively in the scope columns | 🔴 **conflicts with what exists.** Two rules bind campaigns in their action config today (§6.3). |

---

## 13 · How it is supposed to be

> **One question: for this campaign, what is automation allowed to do, what has it done, and what is
> that costing?**

```
Rules & Automation                                          [ IT ▾ ]  [ + Rule ]
 Apply Rules │ Automations │ Bid │ … │ Keyword Tracker
─────────────────────────────────────────────────────────────────────────────────
 22 automations can act · 7 are armed · 82 of 220 campaigns permit a write   →
 86 live on €318.57/day (58 at the €1 floor) · 133 paused holding €8,440/day →
 Rules made 95 of 42,885 changes in 60 days — engines made the rest          →
 203 decisions pending, oldest 50 days                                       →
─────────────────────────────────────────────────────────────────────────────────
 [ Filters ]  🔍 gate:shut tos:>=100          Viewing 1-100 of 220   [ Views ▾ ] [ ⚙ ] [ ↓ ]
 ☐ Campaign          Status  Deliv.  Automation        Strategy   Bid bounds  Budget  Spend  ACoS
 ☐ GALE EXACT DE     Live    Deliv.  Managed · 7 ▸     Down only  — · €1.90   €10.00  €445   38%
 ☐ AIRMESH JACKET IT Paused  —       Off-limits · 7 ▸  Down only  —           €200.00 —      —
                                     ⚑ ToS +202%
─────────────────────────────────────────────────────────────────────────────────
 3 selected   [ Managed ▾ ] [ Bid bounds ] [ Target ACoS ] [ Apply automations ] [ Export ]
```

- **Every column has values.** If it cannot vary, it is a header sentence, not a column.
- **Governance on the row**: gate · bounds · pins · which automations reach it — from one endpoint
  that two other screens already read.
- **Performance beside settings**, windowed by a control that visibly moves 62 cells, with the range
  the server resolved printed where the operator can see it.
- **Bulk edits that persist — all four.** Including the one that today throws the selection away.
- **Nothing hidden, and nothing unlabelled.** Status on the row, the population stated above it,
  and a placeholder that says "All" when it means all.
- **The URL is the view.** Market, filters, sort, page, range and the open row.

---

## 14 · The tiered plan

### Tier 0 — stop rendering fiction · **hours, no new endpoint, no migration**

| # | change | cost | unlocks |
|---|---|---|---|
| 0.1 | **Target ACoS → `—`** when unset; the 30% fallback moves to the column tip | 2 lines | the grid stops asserting a setting on 220 campaigns |
| 0.2 | **Wire Min/Max Bid** — copy `CampaignsGrid.tsx:850-856`'s `centsToEur` mapping into `load()`; replace the two `patchLocal`s with `PATCH …/guardrails` | ~15 lines | **two enforced guardrails become settable**; `minBidCents` (0 of 220) gets its first UI ever |
| 0.3 | **Bid Rule → Bidding Strategy** — real field, 2 values, already in the payload; reuse the Ad Manager's strategy modal | 1 column | a fifth column stops being a constant |
| 0.4 | **Budget Rule → deleted**, its question moved to the account band with links to 4 and 6 | −1 column | width reclaimed; the *"what can change this budget"* question stated once, truthfully |
| 0.5 | **Add a Status column**; set the Status filter's placeholder to `All` | 1 column + 1 string | the page stops being unable to say what a row is |
| 0.6 | **Fix "Assign Rule"** — either pass the selection through, or (until §6.4 lands) rename it "New rule" | 1 line | a bulk action stops silently discarding 40 selected rows |
| 0.7 | **`RuleImpactStrip`: label the grain** — "bids adjusted **by rules**" | 4 words | "0 bids adjusted" stops contradicting 23,589 bid writes |

### Tier 1 — show what actually governs each campaign · **days**

| # | change | cost | unlocks |
|---|---|---|---|
| 1.1 | **Consume `guardrail-grid`** — one fetch, 220 rows → **Managed** column (82/220, toggle inline, bulk via the existing `live-writes/bulk` route), **pins**, **bounds**, suppression state | one fetch + 3 columns | the write gate becomes visible and widenable *from the page the operator said it should be widened from* |
| 1.2 | **Delivery column** — `NOT_DELIVERING 140 / DELIVERING 79`, already in the payload | 1 column | 7 enabled-but-not-delivering campaigns become findable |
| 1.3 | **Metric columns + date control** in `toolbarRight`, server vocabulary, echoed range, `0` ≠ "no data" | days | the settings become judgeable; 62 spend cells move when the control moves |
| 1.4 | **The account band** (§10.1) replacing `RuleImpactStrip`, every number linking to its rows | days | the landing question answered without a twelfth page |
| 1.5 | **Placement lane summary**, read-only + link to session 3 | 1 column | the 58 paused +200% land mines become visible before they resume |
| 1.6 | **Row drawer** — `cpcCeiling`, `maxBidChangePct`, `maxWritesPerDay`, `liveBidWritesToday`, pin note/author, last 10 changes | days | the long tail leaves the columns |
| 1.7 | **Saved views + column sets + export** — `filterPresetsKey`, `storageKey`, the Ad Manager's export pattern | small | "live only" / "off-limits" / "unbounded" stop being four manual filter dances |
| **blocked on shared** | R2 (URL state), R3 (date vocabulary), R6 (bulk guardrails route) | — | 1.3 and 1.7 are the ones that need them |

### Tier 2 — the Automations column · **days, then blocked on session 10**

| # | change | cost | unlocks |
|---|---|---|---|
| 2.1 | **Read-only verdict cell** — `Managed · 7 armed can write (5 bid · 2 budget)` vs `Off-limits · 7 match, all refused` | days | the 82/138 split becomes the most useful sentence on the grid |
| 2.2 | **Expand to name them**, with a link to each rule on Automations | small | reach becomes traceable |
| 2.3 | **Bid-writes (60d) column** via the `AD_TARGET` → adGroup → campaign roll-up | small | "has automation actually touched this row" — non-zero on 65 of 220 |
| 2.4 | **Assignable** — multi-select automations, bind at the grain the selection implies, confirm in a full sentence with resolved counts | days | **blocked on `scope*Ids` arrays + a campaign-grain bind route (session 10)** |

### Tier 3 — the agentic grid

Proposals on the row, approvable inline. The substrate exists — `AdsRuleSuggestion` (**203 pending,
1 ever applied, oldest 50 days**), the autonomy ladder, the reversibility ceiling, the write gate,
the audit spine. What is missing is the surface, and this grid is the only one whose rows are the
entities the proposals are about. **This is where Pacvue has gone, and it is the one place where
this account is closer than it looks.** Prerequisite: an answer to *why* 202 of 203 proposals were
never worked — because putting an unemptied queue on a row makes it 220 unemptied queues.

---

## 15 · What I need from you

1. **The two dead columns** — replace Bid Rule with **Bidding Strategy** (real, 2 values, free) and
   delete Budget Rule, moving its question to the band? (§3)
2. **The default filter** — my earlier answer was wrong. Nothing is hidden; there is no Status column
   and the filter's placeholder lies. Add the column, fix the placeholder, state the population, and
   offer saved views instead of a hidden default? (§9)
3. **The Automations cell** — lead with **Managed / Off-limits** (82 vs 138) rather than a rule
   count that is 22 on every row? (§6.1)
4. **Engines in that count.** Rules are 0.2% of writes. Does the column count engines too, or does
   its header say "rules"? *(This depends on session 10's open question 1 — flagging, not asking you
   twice.)*
5. **The landing route** — bare `/rules-automation` stays this page, with a four-line account band
   and no redirect? And does the tab keep the name "Apply Rules" before it can apply anything? (§10)
6. **€318.57/day.** 86 live campaigns, 58 of them at the €1 floor, against €8,440/day standing on
   paused rows. That is the budget ratchet at campaign grain, on this page's own data. It is still
   running.

---

## Appendix — scripts

All read-only. Run from `apps/api`:
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>.mts`

| script | measures |
|---|---|
| `_ar-page-grid.mts` | the exact `GET /campaigns` select · stored metric-column population · windowed metrics at 7/30/60d · every enforced per-campaign control · what the Status filter hides · rule reach per campaign via `ruleMatchesScope` · write attribution by actor and action type |
| `_ar-page-rowtruth.mts` | budget by status · market split · placement lanes (present vs non-zero) · **stored `spend` vs the 7/30/60d windows, per campaign** · `AD_TARGET` writes rolled up to the campaign · the null-actor breakdown · delivery distribution |
| `_ar-page-actors.mts` | referents for the two dead columns (`BudgetSchedule`, `biddingStrategy`) · rank/dayparting schedule membership · armed rules per campaign **by dimension** · rules that name campaigns inside their action JSON · engine actors in 30d |
| `_ar-page-scopecheck.mts` | how many enabled rules carry a market scope (**zero** — the fact that makes `accountWideRules: 22` correct today and fragile tomorrow) |

Browser probes (production Vercel + Railway, no writes): rendered column values across 100 rows ·
`Viewing 1-100 of 220 Campaigns` · the filter panel's resting labels · `RuleImpactStrip`'s live
figures · the `GET /campaigns` key set and the absence of `minMaxBid` · `?preset=last7` vs no
preset · `GET /control-room/guardrail-grid` shape and totals.

### Sources

- [Pacvue — Introducing the Agentic Commerce Grid](https://pacvue.com/) ·
  [Pacvue Agent](https://pacvue.com/platform/artificial-intelligence/) ·
  [Pacvue Agent promises 200x faster commerce media workflows — PPC Land](https://ppc.land/pacvue-agent-promises-200x-faster-commerce-media-workflows/) ·
  [Pacvue enters AI agent race — Adweek](https://www.adweek.com/commerce/pacvue-enters-ai-agent-race-with-amazon-focused-tool/) ·
  [Pacvue XL / Excel integration](https://www.prnewswire.com/news-releases/pacvue-releases-industry-first-excel-integration-for-amazon-advertisers-300881477.html)
- [Amazon Ads — improved campaign manager features](https://advertising.amazon.com/library/news/introducing-improved-campaign-manager-features) ·
  [Amazon Ads dashboard 2026 — Improvado](https://improvado.io/blog/amazon-ads-dashboard) ·
  [Bulk operations user guide (PDF)](https://m.media-amazon.com/images/G/01/api/guides/Bulk_operations_user_guide.pdf) ·
  [Amazon PPC bulk operations 2026 — SellerApp](https://www.sellerapp.com/blog/amazon-ppc-bulk-operations/)
- [Helium 10 — Adtomic Rules & Automation (KB)](https://kb.helium10.com/hc/en-us/articles/18076439623963-Adtomic-Rules-Automation) ·
  [Using automation within Helium 10 Ads (KB)](https://kb.helium10.com/hc/en-us/articles/4760865288475-How-Do-I-Use-Automation-Within-Helium-10-Ads) ·
  [Adtomic review 2026 — RevenueGeeks](https://revenuegeeks.com/helium10-adtomic/)
- [Skai — AI-powered commerce media platform](https://skai.io/) ·
  [State of Retail Media 2026 — Skai](https://skai.io/blog/the-2026-state-of-retail-media-building-the-foundation-for-ai-driven-commerce/) ·
  [Retail media trends 2026: AI & agentic commerce — Mirakl](https://www.mirakl.com/blog/top-retail-media-trends-2026)
- [Teikametrics alternatives & pricing 2026 — Adastraa](https://www.adastraa.ai/blogs/11-teikametrics-alternatives-for-amazon-ppc-growth-in-2026) ·
  [Perpetua alternatives — SellerApp](https://www.sellerapp.com/blog/perpetua-alternatives/) ·
  [Sellozo alternatives — AiHello](https://www.aihello.com/resources/blog/sellozo-alternatives/) ·
  [Scale Insights pricing 2026 — RevenueGeeks](https://revenuegeeks.com/scale-insights-pricing/) ·
  [Best Amazon PPC software 2026 — Trellis](https://gotrellis.com/resources/blog/best-amazon-ppc-software/)

### Internal sources

`docs/2026-08-11-ar-apply-rules-study.md` (the tab study, corrected in §0.1) ·
`docs/2026-08-11-auto-automations-study.md` (§6, the 0.2% and the scope model) ·
`docs/2026-08-11-bid-study.md` (§5.4) ·
`docs/2026-08-11-plc-placement-study.md` + `-page.md` (§7.3, §12) ·
`docs/2026-08-11-bud-budget-study.md` (§9.2, the ratchet) ·
`docs/2026-08-11-bs-budget-schedules-study.md` + `-page.md` (§3.2) ·
`docs/2026-08-10-ads-rules-automation-ra.md` §0.5 (doctrine), §3.0 (the reverted scope bar and its
law), §3.4 (the date-vocabulary trap), §4.0b (the boundary table), Part 5 (the laws), Part 9 (the
ledger) · `docs/2026-08-10-ra-session-locks.md` §0, §3, §5.
