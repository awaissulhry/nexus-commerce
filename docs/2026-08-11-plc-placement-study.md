# PLC — Placement: study 3 of 11

*Rules & Automation, tab-by-tab, right to left.
Study 1 · [Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md) · Study 2 · [Share of Voice](2026-08-11-sov-share-of-voice-study.md).*
**Read-only study. Nothing was changed. No code was written.**

Measured on production 2026-08-11 with `apps/api/scripts/_plc-study.mts` and `_plc-study2.mts`.

---

## 0 · The one-sentence version

The Placement tab lists **8 rules, all disabled, that have never written anything** — while a
different engine made **15,185 placement writes in 60 days**; and the multipliers those writes
maintain are **inverted against the evidence**: we pay a median **+87%** premium into Top of Search,
which returns **1.85× ROAS**, and **+27%** into Rest of Search, which returns **3.10×** — in *all
four markets*.

---

## 1 · What the tab is, and every wire behind it

```
?tab=placement
└── RulesAutomationClient.tsx:355  <RuleListTab noun="Placement Rule" liveType="placement" />
    └── GET /advertising/automation-rules  → filtered by RULE_TAB_ACTION_TYPES.placement
                                             = ['set_placement_multiplier', 'defend_top_of_search']
    Columns: Automation · Criteria · Frequency   (all three edit LOCAL STATE only)
    Bulk:    Automation · Criteria · Frequency · Delete   ← Delete says "cannot be undone",
                                                            removes the row from React state,
                                                            and the rule survives on the server

Builder   builder/placement → _shared/RuleBuilder.tsx
The lever  Campaign.dynamicBidding.placementBidding = [{ placement, percentage }]
           lanes: PLACEMENT_TOP · PLACEMENT_REST_OF_SEARCH · PLACEMENT_PRODUCT_PAGE
Engines    ads-tos-defense.job.ts   → services/advertising/ads-top-of-search.service.ts
           ad-rank-defend.job.ts    → writes placementBidding directly (blended lanes)
Guard      Campaign.pinPlacement — "hands off placement", enforced in ads-write-gate.ts
```

**The tab is a rule list. The lever is a campaign field. Nothing on this tab shows the field.**

---

## 2 · The 8 rules

| rule | enabled | level | trigger | executions | last run |
|---|---|---|---|---|---|
| Top-of-Search rank defender | ✗ | PROPOSE | KEYWORD_ZERO_IMPRESSIONS | 0 | never |
| Aggressive growth: raise bids on low-ACOS winners | ✗ | PROPOSE | AD_TARGET_UNDERPERFORM | 0 | never |
| **Rank control — Top +100% · 99 campaign(s) (IT)** | ✗ | PROPOSE | SCHEDULE | 988 | 2026-08-03 |
| Hold top rank ≥ 45% — XAVIA GALE (×2) | ✗ | PROPOSE | SCHEDULE | 0 / 1,971 | never / 2026-08-03 |
| Hold top rank ≥ 60% — XAVIA MOSS (×2) | ✗ | PROPOSE | SCHEDULE | 0 / 1,971 | never / 2026-08-03 |
| Top-of-search placement optimiser | ✗ | PROPOSE | SCHEDULE | 167 | 2026-08-03 |

**Every one is disabled and capped at PROPOSE. None has ever written a placement multiplier.**
Four of them have executed thousands of times — those are proposals, not changes.

🔴 **One rule carries 99 of the 102 `set_placement_multiplier` actions in the account.** *"Rank
control — Top +100% · 99 campaign(s) (IT)"* is a batch wearing a rule's clothes: one action per
campaign, baked into the rule body. It cannot be scoped (the scope fields are per-rule), cannot be
partially disabled, and its name has to carry the campaign count because nothing else can express
it. Compare the two "Hold top rank" pairs — duplicated per product line, also by hand.

---

## 3 · 🔴 The tab is not a view of the placement system

| | |
|---|---|
| placement writes by the tab's rules, 60 days | **0** |
| `AdvertisingActionLog` rows mentioning placement, 60 days | **15,185** |
| `ad-rank-defend` cron runs | **6,261**, last 2026-08-11 00:30 |
| `top-of-search-defense` cron runs | **NEVER RUN** |

The placement lever is one of the busiest write paths in the account — and **every one of those
15,185 writes comes from `ad-rank-defend`, an engine with no presence on this tab.** An operator
who opens Placement to ask "what is happening to my placements" sees eight switched-off rules and
concludes nothing is happening. The opposite is true.

This is the inverse of the failure this programme keeps finding. Usually a surface renders what no
executor reads. Here **an executor writes what no surface renders.**

`top-of-search-defense` — described in its own header as *"the autonomous 'always stay on top of
search' loop"* and elsewhere as the most direct SERP lever we have — is triple-gated and has never
been switched on. `NEXUS_ENABLE_TOS_DEFENSE_CRON` is unset.

---

## 4 · The lever's actual state

Across 220 campaigns:

| lane | campaigns carrying it | non-zero | median | max |
|---|---|---|---|---|
| `PLACEMENT_TOP` | 128 | 126 | **+87%** | **+300%** |
| `PLACEMENT_REST_OF_SEARCH` | 75 | 75 | +27% | +75% |
| `PLACEMENT_PRODUCT_PAGE` | 84 | 84 | +3% | +9% |

**145 of 220 campaigns carry a non-zero multiplier.** This is not an unused feature — it is an
aggressively used one that no screen displays.

- Bidding strategy: **166 fixed · 43 dynamic down-only · 11 dynamic up-and-down**
- `pinPlacement` (automation forbidden to touch placement): **0 campaigns**
- `liveBidWritesEnabled`: 82 of 220

---

## 5 · 🔴 The multipliers are inverted against the evidence

60 days, by placement and market:

| placement | mkt | impressions | spend | sales | **ROAS** | CPC | CVR |
|---|---|---|---|---|---|---|---|
| Top of Search | DE | 10,980 | €538.83 | €1,604.32 | 2.98 | €1.08 | 3.8% |
| Top of Search | IT | 43,304 | €998.23 | €1,418.01 | **1.42** | €0.62 | 1.2% |
| Top of Search | ES | 2,645 | €77.90 | **€0.00** | **0.00** | €0.62 | 0.0% |
| Top of Search | FR | 632 | €14.91 | **€0.00** | **0.00** | €0.51 | 0.0% |
| Rest of Search | DE | 90,441 | €426.95 | €2,563.96 | **6.01** | €0.48 | 3.3% |
| Rest of Search | FR | 17,202 | €68.17 | €165.00 | 2.42 | €0.48 | 1.4% |
| Rest of Search | ES | 33,788 | €115.45 | €210.00 | 1.82 | €0.49 | 0.8% |
| Rest of Search | IT | 401,229 | €677.24 | €1,054.91 | 1.56 | €0.34 | 0.7% |
| Product Pages | ES | 218,306 | €103.01 | €420.00 | 4.08 | €0.57 | 2.2% |
| Product Pages | DE | 270,466 | €179.11 | €423.85 | 2.37 | €0.57 | 1.6% |
| Product Pages | IT | 1,297,621 | €345.53 | €784.45 | 2.27 | €0.38 | 1.0% |
| Product Pages | FR | 71,821 | €50.33 | €82.50 | 1.64 | €0.47 | 0.9% |

**Rest of Search out-returns Top of Search in every single market.** DE 6.01 vs 2.98 · IT 1.56 vs
1.42 · ES 1.82 vs 0.00 · FR 2.42 vs 0.00.

Account-wide, Top of Search takes **45% of the ad spend for 2.3% of the impressions** and returns
the worst ROAS of the three lanes (1.85× against 3.10× for Rest of Search).

**And the multipliers point the other way**: +87% median into the worst lane, +27% into the best.

### Two honest caveats

- Placement ROAS uses **7-day attributed sales**. Top of Search plausibly earns delayed and halo
  credit this window does not capture. It would have to earn a *lot* to close a 2.98-vs-6.01 gap.
- **ES and FR Top of Search are small samples** — €77.90 / 125 clicks and €14.91 / 29 clicks. Zero
  sales on 154 clicks is weak evidence of a zero, but it is not evidence of a positive.

Neither caveat rescues the ranking. The conclusion that survives both: **the premium is on the
wrong lane, and nothing on any screen would tell you.**

---

## 6 · The compounding trap — measured, and currently safe

Amazon's placement modifier multiplies the base bid (up to +900%). Dynamic bidding **multiplies
again**: up to +100% for top-of-search, +50% elsewhere. A $1.00 bid with a +100% Top modifier on
*up-and-down* bidding becomes a $4.00 bid; at +900% it becomes $20.00. The standing industry rule
is blunt: **if the Top modifier exceeds +100%, dynamic bidding must be "down only" or "fixed".**

| check | result |
|---|---|
| campaigns on up-and-down bidding | 11 |
| …of those with a Top modifier **>100%** | **0** ✅ |
| …of those carrying any Top modifier | 6 |
| campaigns with a Top modifier **≥100%** on any strategy | **61** |

**The dangerous pairing does not exist today.** But it is one dropdown away, and nothing prevents
it. The 61 heavy campaigns:

| campaign | mkt | Top | strategy | status | gate |
|---|---|---|---|---|---|
| **GALE EXACT IT** | IT | **+300%** | fixed | **ENABLED** | **open** |
| AIRMESH / AIREON JACKET DE | DE | +202% | fixed | paused | closed |
| AIRMESH JACKET ES / FR | ES/FR | +202% | down only | paused | closed |
| MISANO BROAD / PHRASE / EXACT | DE | +201% | fixed | paused | closed |
| …55 more | | ≥100% | | mostly paused | |

**One live, gate-open campaign sits at +300%** — a 4× multiplier on every top-of-search click, in
the market whose Top-of-Search ROAS is 1.42×. The other 60 are paused, which means they are
land mines rather than fires: any of them resuming restores an aggressive multiplier nobody chose
today.

**This is a guardrail that should exist and does not.** `pinPlacement` protects a campaign from
automation; nothing protects a campaign from a compounding *configuration*.

---

## 7 · How the industry does this

### 7.1 The mechanic everyone is working with

Amazon exposes three lanes — Top of Search, Rest of Search, Product Pages — each with a 0–900%
bid modifier, applied on top of the base bid, and then multiplied again by the dynamic-bidding
strategy (`fixed` / `down only` / `up and down`). Every tool below is automating the same three
numbers; the differences are in what they trigger on, how fast, and what they refuse to do.

### 7.2 Enterprise

| platform | placement capability | notable |
|---|---|---|
| **Pacvue** | **Placement locks** — "consistently hold specific ad positions on high-value keywords"; **Bid Explorer** forecasts performance at different bid levels before committing; SOV-driven dayparting adjusts placement pressure during peak events | the only one framing placement as *holding a position* rather than *setting a percentage* — a goal, not a knob |
| **Perpetua** | **Bid Adjustments** — fixed bids or multipliers applied to specific targets to steer the optimisation engine, and crucially they can be **permanent or set to expire after a defined period** | expiring overrides are the missing primitive almost everywhere: a temporary push that cleans itself up |
| **Skai** (+ Profitero) | shelf/competitive signals surfaced inside campaign management, so placement pressure responds to shelf position | insight and action in one screen |
| **CommerceIQ** | automates the fix across 1,450+ retailers rather than surfacing the issue | placement as one actuator among many |
| **Teikametrics · Quartile** | ML-driven bidding that owns placement internally | black-box: you set goals, not multipliers |

### 7.3 Rules-based / mid-market

| platform | placement capability |
|---|---|
| **Scale Insights** | **12 stackable algorithms**, ASIN-level; an explicit **Placement Rule** that "automatically adjusts campaign placement settings based on performance" |
| **Ad Badger** | rule-based adjustments applied **every hour** |
| **SellerMetrics · Zon.Tools · Xmars** | **placement multipliers by hour or day** — placement dayparting, i.e. push Top of Search only in the hours it converts |
| **Sellozo** | preset strategies; simple, thin beyond ~20 ASINs |

### 7.4 The split in philosophy, which matters for us

Two camps, and they are not converging:

- **Black-box** (Perpetua, Quartile, Teikametrics): you declare a goal; the engine owns placement.
- **Guardrails** (Scale Insights, Ad Badger, Pacvue's rules): you own the logic; the tool executes
  it fast and refuses what you forbade.

This system is already firmly in the second camp — bounds live on the entity
(`minBidCents`/`maxBidCents`/`pinPlacement`, enforced in one write gate), which is the guardrail
architecture. **The placement work should stay there.**

### 7.5 The 2026 feature bar for placement

1. **The three lanes shown as data, not as a form** — current multiplier next to that lane's
   impressions, spend, ROAS and CVR, per campaign.
2. **A goal, not a percentage** — "hold 40% of top-of-search on these terms", with the multiplier
   as the actuator. Pacvue's placement locks; our `ad-rank-defend` already works this way.
3. **Expiring overrides** (Perpetua) — a push for a launch or Prime Day that reverts itself.
4. **Hourly granularity** — placement dayparting.
5. **Compounding guardrails** — refuse >100% Top on up-and-down bidding.
6. **Forecast before commit** — Pacvue's Bid Explorer: what does +50% cost and buy?
7. **One audit trail** — which engine moved this lane, when, and why.

**Where we already lead:** `ad-rank-defend` blends the lanes toward an impression-share target with
an ACoS cap — that is the "goal not percentage" model the enterprise tier charges for, and it is
running 6,261 times. **Nobody can see it.** That is the entire problem with this tab.

---

## 8 · What could be implemented, cheapest first

### Tier 0 — show the lever *(hours)*
- **Add the three lanes as columns** on this tab (or on Apply Rules, which is the campaign-grain
  surface): current multiplier · impressions · spend · ROAS, per lane, per campaign. The data is in
  `AmazonAdsPlacementReport` and `Campaign.dynamicBidding` and needs no new backend.
- **Show who moved it.** `ad-rank-defend`'s 15,185 writes are already logged; surface the last
  change per campaign with its actor and reason.
- **Fix the shared `RuleListTab` lies** — the local-state Automation / Criteria / Frequency edits
  and the Delete that deletes nothing. Applies to five tabs, not just this one.

### Tier 1 — the safety net that should already exist *(days)*
- **A compounding guard in the write gate**: refuse (or warn on) a Top modifier >100% where the
  strategy is up-and-down. Zero campaigns violate it today, which makes it the cheapest guardrail
  we will ever add — nothing to fix first.
- **Flag the inversion**: a campaign whose highest multiplier is on its lowest-ROAS lane. Measured
  today across all four markets.
- **Review the 61 heavy campaigns**, starting with the one that is live: GALE EXACT IT at +300%.

### Tier 2 — make the engine visible and steerable *(a decision)*
- **Give `ad-rank-defend` a surface.** It is the placement system; it deserves the tab. The 8 dead
  rules are not.
- **Decide on `top-of-search-defense`.** It has never run. Either arm it (it is allowlist-gated and
  ACoS-bounded) or delete it — a permanently dark engine described as our most direct SERP lever is
  worse than neither.
- **Expiring overrides** (the Perpetua primitive) — a placement push with an end date.

### Tier 3 — placement dayparting
Hourly placement multipliers, driven by the hourly performance table that already holds **17,963
rows** (study 1). This is what SellerMetrics and Zon.Tools sell, and the substrate exists.

---

## 9 · How this tab is *supposed* to be

> **One question: for each campaign, where are my ads showing, what is each lane worth, and what is
> pushing it there?**

- **A campaign × lane grid**, not a rule list: three lanes per campaign, each with its current
  multiplier and that lane's real return.
- **The inversion flagged automatically** — highest multiplier on lowest-return lane.
- **Goals, not percentages**, wherever `ad-rank-defend` already provides one; the percentage stays
  visible as the actuator.
- **Every change attributed** to the engine or person that made it, with a reason and an undo.
- **Guardrails that refuse**: compounding pairs, >100% without an explicit acknowledgement, and
  `pinPlacement` respected everywhere.

---

## 10 · What I need from you

1. **The inversion — act now or study further?** Rest of Search beats Top of Search in all four
   markets while carrying a third of the multiplier. Correcting it is a bid change across up to 145
   campaigns, which is exactly the kind of thing you said you want automation to do.
2. **GALE EXACT IT at +300%, live, gate open.** Deliberate, or drift?
3. **`top-of-search-defense`: arm or delete?**
4. **Does the Placement tab become a view of `ad-rank-defend`** — the engine that actually does
   this — or stay a rule list?
5. **Should the compounding guard go in?** It is cheap, nothing currently violates it, and it
   prevents a class of overspend rather than detecting one.

---

## Appendix — scripts

| script | measures |
|---|---|
| `_plc-study.mts` | the 8 rules · multipliers across 220 campaigns · per-lane per-market economics · top-of-search share distribution · which engines write, and whether they ran |
| `_plc-study2.mts` | the compounding pairing · every campaign at ≥100% Top · strategy × modifier grid |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.

### Sources

- [Bid Modifiers: Top of Search, Rest of Search and Product Placements — Scale Insights](https://scaleinsights.com/learn/bid-modifiers-top-of-search-rest-of-search-and-product-placements) ·
  [Amazon Ad Placement Strategies — Scale Insights](https://scaleinsights.com/learn/amazon-ad-placement-strategies-for-sellers)
- [Placement Bid Modifiers in Amazon PPC — Amalyze](https://amalyze.com/resources/sponsored-success/placement-bid-modifiers)
- [Dynamic Bidding Strategies on Amazon — Perpetua](https://perpetua.io/blog-amazon-ppc-advertising-dynamic-bidding-bid-strategy/)
- [Amazon PPC Placements: optimising Top of Search, Product Pages, Rest of Search — Daniks.AI](https://daniks.ai/blog/amazon-ppc-placements)
- [Pacvue vs Perpetua — Atom11](https://www.atom11.co/blog/pacvue-vs-perpetua) ·
  [Pacvue vs Perpetua — SmartScout](https://www.smartscout.com/blog/pacvue-vs-perpetua-which-ppc-bid-management-tool-is-best-for-you)
- [10 Best Pacvue Alternatives — SellerApp](https://www.sellerapp.com/blog/pacvue-alternatives/) ·
  [Top Pacvue Alternatives — Atom11](https://www.atom11.co/blog/pacvue-alternatives)
- [Ad Badger pricing & review — Scale Insights](https://scaleinsights.com/learn/ad-badger-pricing-review)
- [Market & Competitive Intelligence — Pacvue](https://pacvue.com/platform/market-competitive-insights/)
