# Amazon Ads Platform Market Research — feature scan

**Date:** 2026-08-04
**Purpose:** what the best-in-industry tools do, which features to take, and what it means for ADX.
**Companion to:** `2026-08-03-ads-autonomy-domination-adx.md`

---

## 1. The field

| Platform | Segment | Price | Optimisation model |
|---|---|---|---|
| **Pacvue** | Enterprise / agency, $50k+/mo spend | $500+/mo | Algorithmic + rules; 90+ marketplaces; **Pacvue Agent** (Apr 2026) |
| **Skai** (Kenshoo) | Enterprise, cross-publisher | Custom | Automated Actions, Budget Navigator; 100+ retail media publishers |
| **CommerceIQ** | Enterprise | Custom | 50+ shelf-aware signals; role-specific AI agents |
| **Quartile** | Enterprise | $895+/mo | Algorithmic, non-editable; hourly bidding |
| **Perpetua** (Ascential) | Mid/enterprise | $695+/mo | Goal-based, algorithmic, non-editable |
| **Teikametrics** | Mid-market | $149+/mo | Algorithmic + goal-based; Amazon + Walmart |
| **Helium 10 Adtomic** | Mid-market | $359/mo (Diamond) | Rules + AI; dayparting, budget guardrails, harvesting |
| **Jungle Scout Cobalt** | Enterprise tier | Custom quote | Ad Accelerator: rule-based bids, dayparting, multi-account |
| **Intentwise** | Analytics-first | — | Editable rules + AMC reporting depth |
| **Adbrew** | Brands/agencies | — | Rules + AI; dayparting with hourly bid *and* budget |
| **Scale Insights** | Small/mid | Flat, ASIN-based | Deep editable rules; 200+ parameters |
| **BidX** | Small/mid | $495/mo | Editable rules + campaign creator |
| **M19** | Mid | $479/mo + spend | Algorithmic only; SP + AMC + DSP |
| **Ad Badger** | Small | — | Algorithmic bidding; rules for harvest/negation |
| **Trellis** | Mid | — | Algorithmic; rank tracking |
| **Prism** (Calibrated Intelligence) | Agency/ops | — | **Approval-first workflow** — the control-model reference |
| **DataHawk / SellerSonar / SellerSprite** | Analytics | — | Share-of-Voice / rank tracking specialists |

Note: **Flywheel Digital is an agency**, not a platform — it appears in tool lists but sells services.

---

## 2. The industry's central design axis: editable rules vs algorithmic

Every source splits the market the same way, and it is the single most useful frame for our decision:

- **Editable rules** — you can read, preview and edit the conditions that change a bid: SellerStack, Scale Insights, Intentwise, SellerApp, AdLabs, BidX, Adbrew, Helium 10 Adtomic.
- **Algorithmic, non-editable** — the tool decides with logic you cannot inspect: M19, Perpetua, Trellis, Ad Badger, Eva, Pacvue, Quartile.

M19 markets *against* rule-based tools explicitly. Perpetua's cited weakness is the mirror image: guardrails that reduce flexibility.

**Where this leaves Nexus.** We have both, and the goals-first decision (ADX approach review) puts us in a position no listed vendor occupies: **an inspectable goal engine.** `RankTarget` is algorithmic in operation — a closed loop holding a setpoint — but every parameter is visible and operator-set (`targetISPct`, `acosCapPct`, `maxCpcCents`, motion profile, lanes). That is the third option: the control of a rule engine with the behaviour of an algorithmic one.

---

## 3. The bar has moved — Amazon's free layer

**Free natively in 2026:** dynamic bidding, auto-targeting, budget rules, basic bid automation. Plus Performance+, Brand+, Ads Agent, and SP/SB prompts (open beta Nov 2025 → GA, charged as CPC).

**Still not covered natively:** bulk optimisation, automated negative-keyword harvesting, **dayparting controls**, **cross-campaign budget reallocation**.

> *"The test for any PPC tool in 2026 isn't 'does it automate bids?' — Amazon does that for free now."*

**Implication for ADX:** do not rebuild what Amazon gives away. The defensible ground is precisely where Nexus already sits — dayparting, cross-campaign budget, profit-native economics from real fees + COGS, and share of voice. Our repaired `bid_to_target_acos` rules are the *least* differentiated thing we own.

---

## 4. Share of Voice is its own product category

A whole segment sells only this: DataHawk, Adbrew, Trellis, SellerSonar, SellerSprite, Intentwise.

**The vocabulary is worth adopting:**
- **Share of Voice** — the slice of first-page visibility held through **paid** placement.
- **Share of Shelf** — the same through **organic** ranking.

Best-in-class implementations add:
- Daily organic *and* sponsored rank for you **and named competitors**
- **Position / fold weighting** — a slot above the fold counts more than one below it
- A combined organic + sponsored timeline showing competitor presence on your keywords over time
- Export into BI

**Constraint confirmed:** Amazon does not report SOV. The API exposes only `topOfSearchImpressionShare`; Search Term Impression Share/Rank is console-report-only. Sponsored-rank coverage in these tools comes from **scraping** (DataHawk sells it as "Premium Keywords").

**What we already hold:** `KeywordRank` (ingested, provenance-tracked), `topOfSearchImpressionShare` ingest, SQP, `AmazonAdsPlacementReport`, and a derived within-account SOV service. The substrate is there; the gaps are competitor presence and fold weighting.

---

## 5. Dayparting — Pacvue's blueprint, and we hold the same substrate

**Pacvue Dynamic Dayparting adjusts bids hourly via Amazon Marketing Stream on a 14-day rolling refresh.** Adbrew does hourly bid *and* budget. Skai exposes intraday optimisation through retailer stream feeds.

We already ingest AMS. `AmazonAdsHourlyPerformance` + the rank/dayparting engine is the same architecture. Two things to take:
1. **The 14-day rolling refresh** — recompute the hour-of-day profile on a moving window rather than a fixed one.
2. **Hourly *budget* as well as bid** — Adbrew does both; we only move bids.

---

## 6. The control model — Prism is the closest analogue, and it validates the ADX design

Prism (Calibrated Intelligence) is built around exactly the problem you described:

- 5-phase guided workflow, 24 guided action categories
- **Approval-first automation with per-category thresholds**
- Async approvals
- **7-day undo for revertable actions**
- Audit trail with *recommendation, evidence and timestamps* retained
- "Full decision provenance for every change, but you are not clicking approve on every bid update"

**The industry default for what to automate vs gate** — this answers ADX open question 2 with a market consensus rather than a guess:

> Auto: bids on mature campaigns, search-term negations under clear criteria, budget rebalancing within sane limits.
> **Always gated:** new campaign creation, major restructuring.

That is a per-category split, not a global autonomy switch — and it matches the Google Ads model (per-behaviour opt-in, visible queue, change history including automated actions, per-behaviour accountability).

---

## 7. The uncomfortable finding for the SERP-coverage goal

Two things are true, and they pull against each other.

**Confirmed — you do not bid against yourself:**
> *"When two of your products appear in Sponsored Product placements for the same SERP, you will not be bidding against yourself."* CPCs may differ per ASIN because Amazon weights proven products.

**But the industry default is consolidation, not coverage:**
> *"Three ASINs split the budget and performance data — decide which variant owns each keyword and consolidate bidding there."*

So multi-ASIN coverage on one keyword is mechanically possible and costs you nothing in auction terms, **but it fragments conversion signal per ASIN**, which slows Amazon's relevance learning for each of them. Most practitioners therefore consolidate.

**This is a real caveat to the original goal and should be measured, not assumed.** ADX.10's bid ladder should be run as an experiment on one family with a control group, tracking cost per page-one appearance *and* per-ASIN conversion-rate drift — not rolled out account-wide on the theory that more slots is better.

---

## 8. Features to fetch — ranked by value to ADX

| # | Feature | Source | Why |
|---|---|---|---|
| 1 | **Per-category approval thresholds** (auto bids/negatives/budget; gate structural) | Prism, Google Ads | Directly the control model; industry consensus |
| 2 | **7-day undo on revertable actions** | Prism | We have `rollback.service.ts`; needs a time-boxed operator-facing surface |
| 3 | **Decision provenance: recommendation + evidence + timestamp retained** | Prism | Exactly ADX.3 attribution |
| 4 | **SOV vs Share of Shelf as distinct metrics** | DataHawk | Correct vocabulary for the coverage scoreboard |
| 5 | **Position / fold weighting** in SOV | DataHawk, Trellis | A slot above the fold is worth more; flat share hides this |
| 6 | **Named-competitor presence timeline** per keyword | Trellis, Pacvue | Turns SOV from a number into a competitive read |
| 7 | **14-day rolling refresh** on the hour-of-day profile | Pacvue | We recompute differently; moving window is more responsive |
| 8 | **Hourly budget** control, not just hourly bid | Adbrew | We move bids only |
| 9 | **Shelf-aware rule inputs** (Buy Box, inventory) | CommerceIQ | We own the PIM — these are local joins, not integrations |
| 10 | **Cross-campaign budget reallocation** | Skai Budget Navigator | We have `BudgetPool`; under-used |
| 11 | Natural-language → query agent over ads data | Pacvue Agent (Apr 2026) | Later; the Ask-AI surface exists |

---

## 9. Where Nexus already leads

Worth stating plainly, because it should shape what we *don't* build:

- **Profit-native ACOS** from real Amazon fees + COGS. Perpetua explicitly cannot see margin.
- **The write gate** — live-mode + connection-level enablement + value cap + **default-deny per-campaign allowlist** + daily cap. No commercial tool exposes this.
- **Motion profiles** (`jumpStartPct`, `stepUpPct`, `keepClimbing`) — more expressive bid-ramp control than any published competitor.
- **Blended lanes** — simultaneous Top + Rest-of-Search + Product-page control in one write.
- **PIM ownership** — retail readiness, stock and Buy Box are local joins.
- **An inspectable goal engine** — see §2. Genuinely unoccupied ground.

---

## Sources

- [Best Amazon PPC Automation Tools 2026 — SalesDuo](https://salesduo.com/blog/amazon-ppc-automation-tools/) · [Best Amazon PPC Software 2026: 20 Tools Compared — SellerStack](https://www.sellerstack.ai/compare)
- [Pacvue — Retail Media Ad Management](https://pacvue.com/retail-media-ad-management/) · [Pacvue — Dayparting with Share of Voice data](https://pacvue.com/blog/how-to-adjust-your-amazon-ppc-dayparting-during-shopping-events-using-share-of-voice-data/) · [Pacvue vs Skai — Atom11](https://www.atom11.co/blog/pacvue-vs-kenshoo-skai)
- [Retail Media Automation 2026: Platform Comparison — Osmos](https://www.osmos.ai/blog/automation-auctions-the-science-of-scalable-retail-media)
- [m19 vs Rule-based PPC Tools](https://www.m19.com/blog/m19-vs-rule-based-ppc-tools) · [Scale Insights Review 2026 — RevenueGeeks](https://revenuegeeks.com/software/scale-insights)
- [Top Adbrew Alternatives — Atom11](https://www.atom11.co/blog/adbrew-alternatives) · [Top Intentwise Alternatives — Atom11](https://www.atom11.co/blog/intentwise-alternatives)
- [Prism — Amazon PPC Software for Safer Execution](https://calibratedintelligence.com/) · [Prism — Amazon PPC Software](https://calibratedintelligence.com/amazon-ppc-software/)
- [AI Amazon PPC Management: The Operator Playbook — Profasee](https://profasee.com/blog/ai-amazon-ppc-management-playbook/) · [How to Automate Amazon Advertising in 2026 — BellaVix](https://www.bellavix.com/how-to-automate-amazon-advertising-in-2026-hybrid-ppc-automation-strategies-tools/)
- [Amazon Share of Voice — DataHawk](https://datahawk.co/blog/retail-analytics/share-of-voice/) · [Share of Voice — Intentwise](https://help.intentwise.com/shareofvoice) · [Amazon SOV and Keyword Rank Tracking — Adbrew](https://adbrew.io/amazon-sov-and-keyword-rank-tracking-software/) · [9 Best Amazon Keyword Rank Trackers — Trellis](https://gotrellis.com/resources/blog/9-best-amazon-keyword-rank-trackers/)
- [Keyword Cannibalization and Placement in Amazon PPC — Ad Badger](https://www.adbadger.com/blog/keyword-cannibalization-and-placement-in-amazon-ppc/) · [Amazon PPC Keyword Cannibalization — Sermondo](https://sermondo.com/amazon-ppc-keyword-cannibalization/)
- [How to Use Amazon PPC in 2026 — SellerSprite](https://www.sellersprite.com/en/blog/amazon-ppc-guide-2026-AI-automation) · [Amazon Ads Bidding & Budgets: The 2026 Auction Guide — MBAdv](https://www.mbadv.agency/amazon-ads/amazon-ads-bidding-and-budgets)
- [Helium 10 vs Jungle Scout 2026](https://www.smartscout.com/blog/helium-10-vs-jungle-scout) · [Amazon Sponsored Brands Strategy 2026 — Velocity Sellers](https://www.velocitysellers.com/2026/05/06/amazon-sponsored-brands-strategy-2026/)
