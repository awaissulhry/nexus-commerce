# Competitor Deep Dives — one company at a time

**Date:** 2026-08-04 · **Companion to:** `2026-08-04-ads-market-research.md`

> **Prior art:** `~/Desktop/COMMERCE-PLATFORM-RESEARCH` already covers **Pacvue, Rithum, Skai, Quartile,
> Stackline** (~90 files) — the enterprise commerce / retail-media tier — with a UI teardown per company.
> Its advertising research is complete only for Pacvue; the other four have index files only.
> **This document covers the ads-native optimisation tier that study never scoped** (Perpetua,
> Teikametrics, Intentwise, Scale Insights, BidX, M19), and §0 reconciles its conclusions with ADX.
Each entry: what they are → architecture → full feature inventory → what to take (mapped to our code) → where we already lead → what to refuse.

Queue: **Pacvue** ✅ · **Rithum** ✅ · **Perpetua** ✅ · **Teikametrics** ✅ · Intentwise · Scale Insights · BidX · M19 · + leaders as found.

---

# 1. Pacvue

## 1.1 What it is

Self-described **"AI-Powered Commerce Media Operating System"** — media + commerce + intelligence across **100+ retailers** in one console. Enterprise and agency segment, aimed at brands spending **$50k+/month**. Pricing is behind a demo wall; industry ballpark **~$500/mo + ~3% of monthly ad spend**. Onboarding is multi-week and "requires dedicated team resources."

It is the closest structural analogue to what Nexus is becoming, which is why it goes first — but the segment difference matters: Pacvue is built for a brand team running dozens of retailers, not one seller running one catalogue deeply.

## 1.2 Architecture — three pillars

| Pillar | Modules |
|---|---|
| **Media** | Cross-Retailer Media Planning · Full-Funnel Media Activation · Discovery Commerce · Real-Time Automation & Optimization |
| **Commerce** | Unified Commerce Operations · Digital Shelf Performance · Revenue Recovery |
| **Insights** | Pacvue Agent · Measurement & Incrementality · Market & Competitive Insights · DaaS · Pacvue MCP |

Named products: **Pacvue Advertising**, **Pacvue Commerce**, **Pacvue Revenue Recovery**, **Pacvue Market Insights**, **Pacvue Agent**, **Pacvue Prism**, **Pacvue MCP** (data centralisation), **Pacvue DaaS**.

## 1.3 Feature inventory

**Ad types:** SP, SB, SD, Amazon DSP, AMC, video across awareness/consideration/conversion.

**Bid & budget**
- AI bidding + performance-based bid adjustments
- **Dayparting** with hourly bid changes, driven by **Amazon Marketing Stream**, **14-day rolling refresh**
- **Placement modifiers**
- Dynamic budget adjustment on performance
- **Budget pacing, flighting, and out-of-budget prevention**

**Retail-aware execution** *(their signature idea)*
- "Activate campaigns based on inventory, pricing, and Buy Box"
- "Automatic pausing or scaling based on Buy Box and inventory"
- Campaigns "prioritize in-stock, winning ASINs"

**Share of Voice**
- **Paid *and* organic** SOV measurement
- **"Share of Voice defense and expansion"** — an operator vocabulary worth borrowing
- Keyword conquesting identification; competitive positioning tracking
- SOV data explicitly used to *drive* dayparting decisions

**Automation & AI**
- Rules-based automation: keyword harvesting, bulk operations, advanced dayparting
- **Pacvue Agent** — "automates bids, budgets, and pacing through **governed workflows**"; "goal-aware intelligence"
- Real-time alerts and triggers

**Measurement**
- Incrementality modelling beyond ROAS, via AMC
- **"Net PPM%"** — margin-aware media metric; connects media exposure, Net PPM%, inventory and chargebacks to ASIN-level profitability
- Chargeback/shortage tracking, revenue recovery

## 1.4 What to take — ranked

### ① Retail-aware activation — the best idea they have, and for us it is a flag, not a build

Pacvue gates campaign activity on Buy Box, inventory and price: don't spend on an ASIN you can't fulfil or don't own the Buy Box for.

**We already built this.** `ads-retail-readiness.service.ts`, a `retail_guard` action, and two enabled rules ("🛡 Retail guard", cap 96). But `NEXUS_ADS_RETAIL_GUARD_APPLY` is **absent from Railway** — the guard detects and never acts.

And we can do it *better than Pacvue*: they sell Buy Box/BSR signals as a **higher-tier add-on** because they must integrate to get them. We own the PIM — Buy Box, stock and price are local joins.

> **Action: verify the guard's proposals, then set `NEXUS_ADS_RETAIL_GUARD_APPLY`.** Highest value-to-effort ratio in this entire research exercise.

### ② "SOV defense" vs "SOV expansion" — the vocabulary that makes coverage operable

Splitting share of voice into two intents is genuinely clarifying, and it maps exactly onto our `RankTarget` keys:
- **Defense** — hold share on terms we already win (`defend-top`, and the self-ASIN targeting in ADX.10)
- **Expansion** — buy share on terms we don't (`own-top`, the bid ladder)

Right now our rank targets are named by *mechanism* (`own-top-allout`). Naming them by *intent* is what makes a coverage plan readable to an operator at a glance.

### ③ Budget flighting + out-of-budget prevention

Two things we lack:
- **Flighting** — a spend curve across a dated campaign flight. We have `RankScheduleEvent` for dated *rank* overrides but nothing equivalent for *budget*.
- **Out-of-budget prevention** — act *before* a campaign goes dark, rather than reporting that it did.

We have `ads-budget-pacing.service` and `ads-budget-enforce.service`, but `NEXUS_BUDGET_ENFORCE_APPLY` is also absent → observe-only. Same shape of gap as ①.

### ④ 14-day rolling refresh on the hour-of-day profile

Their dayparting recomputes on a moving 14-day window off AMS. We hold the same AMS substrate. Adopting the rolling window makes the profile responsive to seasonality without manual re-authoring.

### ⑤ Net PPM% as the *stated* optimisation target

We already compute profit-native ACOS from real fees + COGS — arguably deeper than Pacvue. What they do better is **make margin the headline number the operator optimises against**, rather than a mode buried in a bidding service. A presentation change, not an engineering one.

## 1.5 Where Nexus already leads

**Governance.** Pacvue markets "governed workflows" — and their own platform documentation defines no approval framework, no guardrail mechanism, no threshold model. It is a claim, not a specification. Our write gate is concrete and enforced at a single chokepoint: live-mode flag + connection-level enablement + per-payload value cap + **default-deny per-campaign allowlist** + daily write cap, with read-back reconciliation and drift detection behind it.

**Motion profiles.** `jumpStartPct` / `stepUpPct` / `stepDownPct` / `keepClimbing` / `maxBiasPct` express *how* a bid moves toward its target. Pacvue exposes bid changes, not bid *trajectories*.

**Blended lanes.** Driving Top + Rest-of-Search + Product-pages simultaneously in one combined write has no published Pacvue equivalent.

**Catalogue depth.** They integrate to retail signals; we own them.

## 1.6 What to refuse

- **Cross-retailer breadth.** 100+ retailers is their core value and irrelevant to us — Xavia is Amazon + eBay + Shopify.
- **Revenue Recovery.** Vendor-Central chargebacks and shortages. Not applicable to Seller Central.
- **AMC-based incrementality.** Entitled but blocked at Amazon for this account; don't build.
- **The "operating system" framing.** Pacvue's breadth is why onboarding takes weeks and needs dedicated staff. That same instinct is what produced three consoles and 51 rules here. The lesson from Pacvue is not "build more surface" — it is "the one feature worth copying is a flag we already have."

## 1.7 Verdict

Pacvue's genuine innovations for us are **retail-aware activation**, **SOV defense/expansion as an intent vocabulary**, and **budget flighting**. Two of the three are already built and switched off.

The uncomfortable and useful conclusion: the closest thing to an industry leader in this category has one idea we don't have (flighting), one we have and don't surface (margin as the headline), and one we have and haven't turned on (retail guard).

---

# 2. Rithum (ex-ChannelAdvisor + CommerceHub + Dsco)

## 2.1 What it is

A **global commerce operations platform** — "list, market, and optimize products across all major commerce channels," with fulfilment and delivery attached. Formed by merging **ChannelAdvisor** (brand multichannel commerce), **CommerceHub/OrderStream** (B2B supplier networks) and **Dsco** (product content), rebranded 2024. **600+ marketplace network**, managed-service tier supports up to **250,000 active ASINs**.

This is the closest analogue to **Nexus as a whole product** — PIM + listings + inventory + orders + ads — which makes it a far more instructive comparison than another pure ads tool.

## 2.2 Product lines

| For brands | For retailers |
|---|---|
| Marketplace Listings (600+) · Inventory Management · Order Management · Commerce Insights | Dropship · Private Marketplaces · SupplyExplorer · Commerce Insights |
| **Retail Media Advertising** · Paid Search & Shopping Ads · Product Feeds | Shipping Optimization · Delivery Date Prediction · Label Management · Delivery Insights |

**RithumIQ** — the proprietary intelligence engine across all of it.

## 2.3 The advertising layer — and the finding that matters

**What the platform does:**
- Campaign management across Amazon, Walmart, Target from one hub; onsite retail media formats
- "Streamline bidding, pacing, and budget allocation with scalable, commerce-focused automation"
- Bidding and keyword automation that incorporates **product-level data**
- Campaign activation on a **custom schedule**
- **RithumIQ**: "AI-driven inventory, pricing, and **margin** data insights… to target smarter"
- **Closed-loop reporting** — ties spend to sales at ASIN level for profitability measurement

**What is conspicuously absent from their published materials** (I looked specifically): dayparting, share of voice, placement modifiers, bid trajectories, impression-share targeting. Not "they don't have it" — but it isn't part of how they sell the product.

**And there is a separate Managed Services tier where humans do the work:** ad targeting, bid management, campaign development, keyword management — "human expertise focuses on strategy and optimization; the platform handles execution." 1P accounts spending $25k+/mo additionally get content optimisation, A+ consultation, promotional management.

## 2.4 The strategic read — this is the most important entry so far

| | Catalog / inventory depth | Ads automation depth |
|---|---|---|
| **Pacvue** | Shallow — integrations, Buy Box/BSR upsold to higher tiers | **Deep** |
| **Rithum** | **Deep** — 600+ marketplaces, listings, inventory, orders, dropship | Shallow — *plus a team of humans* |
| **Nexus** | **Deep** — owns the PIM outright | **Deep** — rank engine, motion profiles, blended lanes |

**Rithum is the canonical multichannel commerce platform, and its answer to advertising depth is to sell you people.** That is a strong market signal: joining deep catalogue to deep ads automation is hard enough that the leader in catalogue outsources the ads half to a services organisation.

It also reframes what Nexus is. Not "a worse Pacvue with a PIM bolted on" — the combination itself is the unoccupied position, and the two nearest players each solve only one half.

## 2.5 What to take

### ① RithumIQ's framing: catalogue data as a *targeting* input, not just a guard

This is the single idea worth taking, and it is a genuine advance on Pacvue.

- **Pacvue** uses retail signals as a **gate**: pause if out of stock, don't spend without the Buy Box.
- **Rithum** frames them as **targeting**: use inventory, pricing and margin "to target smarter" — let the catalogue decide *which* products deserve budget.

Gate → allocator. That is the natural extension of `ads-retail-readiness.service`, and it lands directly on the dormant **APS (advertisable product selection)** series: rank advertisable products by margin × stock cover × Buy Box, and let budget follow the ranking rather than merely being blocked by it.

We are unusually well-placed for this — `true-profit-rollup.service` already computes real per-product profit from actual fees + COGS, which is exactly the input RithumIQ is built to supply.

### ② Closed-loop ASIN-level profitability as the reporting spine

We have the data (`true-profit-rollup`). What they do better is make "every ad dollar tied to its outcome at ASIN level" the *shape of the report*, not a metric among many. Same lesson as Pacvue's Net PPM%, arrived at independently — which makes it worth acting on.

## 2.6 What to refuse

- **The managed-services model.** Their existence is a diagnosis, not a template: the market's most complete catalogue platform concluded that operators cannot run ads from software alone. The correct response is to make the system self-explaining, which is precisely the ADX control programme — not to accept the premise and hire people.
- **Breadth.** 600+ marketplaces, 250k ASINs. Xavia is ~279 master SKUs on three channels. Every design decision they made for scale is wrong for us.
- **Generic automation.** "Streamline bidding, pacing and budget allocation" is what you write when there is no mechanism to name. Compare `targetISPct` + `stepUpPct` + `maxCpcCents`.

## 2.7 Verdict

Rithum contributes **one strong idea** — catalogue as allocator rather than gate — and **one strategic clarification**, which is more valuable: the two nearest competitors each own one half of what Nexus is attempting, and neither owns both.

The uncomfortable corollary: if the catalogue leader needed a services team to make ads work, the risk for Nexus is not missing features. It is that the system becomes something only a specialist can drive. That is the same failure already observed here — 51 rules, three consoles, nothing in use.

---

# 3. Perpetua

## 3.1 What it is

The **pure goal-based, algorithmic** pole of the market — the exact opposite of Scale Insights or BidX. Founded as Perpetua Labs, acquired by **Ascential** (2021), absorbed **Sellics**, and carried into **Omnicom** when it bought Ascential's digital-commerce arm (Flywheel Digital) for ~$835M. **$695/mo entry**, with spend caps on lower tiers.

## 3.2 The goal model

The operator does not build campaigns. They pick a **strategic objective** —

> **Growth · Profitability · Brand defense · Awareness**

— give it a **target ACOS and a budget**, and the engine handles keyword harvesting, bid optimisation and campaign structure autonomously. Bids adjust daily against the target; on Amazon Marketing Stream, hourly.

Named surfaces: Marketplace Advertising Optimization (Amazon, Walmart), Display, Video, Market Intelligence Reporting, Total Sales Analytics, Retail Intelligence, Digital Shelf Insights. Optimisation is "contextual, conversion-based bidding algorithms" plus a smart-recommendation engine and automated negative matching.

## 3.3 ⭐ The Share of Voice module — the most valuable finding in this document

Perpetua added an SOV module in 2025. The mechanics matter more than the feature:

- **Share of voice is explicitly *not* available via Amazon Marketing Stream** — Perpetua says so directly. It must be sourced independently.
- They track it **hourly, across 100,000+ terms**, with operator-added custom terms.
- **Keyword-level share against *named competitors*.**
- They publish strategy guidance on combining **hourly AMS performance data with hourly SOV data** to drive dayparting.

**That is precisely the architecture our SERP-coverage goal requires, and it names the half we are missing.**

| Signal | Source | Nexus status |
|---|---|---|
| Hourly ad performance | Amazon Marketing Stream | ✅ 24 subs live, IT/DE/FR/ES |
| Hourly **share of voice** | Independent collection (not Amazon) | ❌ **absent** |

Everything in ADX.8 (coverage measurement) has been reasoning about `topOfSearchImpressionShare` and STIS — which tell us *our own* impression share, not **who else is on the page**. Perpetua confirms the industry answer: you cannot get competitive SOV from Amazon, so you collect it yourself, hourly, against a named competitor set.

This also settles a design question in ADX.10: the bid ladder needs a feedback signal, and our own impression share is not it. **"Do we own this page?" is a different question from "what share of impressions did we get?"** — and only the first one answers the goal you actually stated.

## 3.4 Goal categories as the operator's entry point

Growth / Profitability / Brand defense / Awareness is a better front door than our `RankTarget` keys (`own-top`, `defend-top`, `own-top-allout`), which name *mechanism*. Combined with Pacvue's **defense vs expansion** framing, the synthesis is:

| Operator intent | Our mechanism |
|---|---|
| **Defend** a term we own | `defend-top`, self-ASIN targeting, lower `maxBiasPct` |
| **Expand** onto a term we don't | `own-top`, bid ladder, `keepClimbing` |
| **Profit** | `acosCapPct` binding, `allOut: false` |
| **Suppress** | `pause: true` + `floorBidCents` |

Same engine. The change is that an operator picks an intent and the parameters follow, rather than picking parameters and inferring the intent.

## 3.5 The criticisms — and why they matter more than the features

Perpetua is the market's purest "trust the algorithm" product, so its failure modes are the strongest available evidence about that design:

1. **"Too slow to learn, does not understand seasonality, not smart enough to differentiate pricing tiers across ASINs."** The recurring complaint is not that the model is wrong — it is that **the operator cannot tell it what it does not know.** A moto-jacket seller knows the season changed; the model discovers it weeks later from conversion data.
2. **No margin visibility** (established earlier in this research).
3. Spend caps on lower tiers → overage or forced upgrade when Q4 surges.
4. Predatory annual contracts, difficult cancellation, unresponsive support.

**Point 1 is the decisive one for ADX.** It is the empirical case against going fully algorithmic, and the strongest external validation of the **inspectable goal engine** position: `RankTarget` is a closed loop *whose setpoint and motion profile the operator sets directly*. When you know the season turned, you change `targetISPct` today — you don't wait for the model to notice.

Perpetua's users are complaining about the absence of exactly the control this system already has.

## 3.6 What to take

1. **Independently-collected hourly SOV against a named competitor set.** The missing half of the coverage loop. Scope it small — our shared keyword set is tens of terms, not 100k.
2. **Goal categories as the authoring entry point** for rank schedules (§3.4).
3. **Seasonality as an operator input, not an inference.** Their top complaint is our free win: `RankScheduleEvent` already models dated overrides.

## 3.7 What to refuse

- **Autonomous campaign structure creation.** Perpetua builds and restructures campaigns itself. Combined with Quartile's documented structural lock-in, the constraint from the prior research holds: *automation should leave behind a structure a human could still run by hand.*
- **The opaque model.** Their single most-cited weakness.
- **Spend-cap pricing.** Not applicable, but it explains why their tier boundaries shape the product.

## 3.8 Verdict

Perpetua contributes **one missing capability** (hourly competitive SOV, independently collected) and **one strong negative result**: the market's purest algorithmic product is most criticised for the operator's inability to override it. That is the clearest external argument yet that goals-first was the right call — provided the goals stay inspectable.

---

# 0. Reconciliation with `COMMERCE-PLATFORM-RESEARCH`

*(Numbered 0 because it re-frames everything above.)*

The prior study reached several conclusions independently of this one. Where they converge, confidence is high; where the prior study is sharper, ADX should adopt its formulation.

### Convergent — treat as settled
- **Commerce state should drive ad spend** — prior study: 5 of 5 companies. This document reached it twice independently (Pacvue's retail-aware activation, Rithum's catalogue-as-allocator). **`NEXUS_ADS_RETAIL_GUARD_APPLY` being absent is now the single best-supported finding across both studies.**
- **Rules encode operator intent that a model cannot infer** — prior study §2.5; this document §3.5 (Perpetua's top complaint). Same conclusion from opposite directions.
- **Intraday optimisation runs on AMS** — prior study §2.4; confirmed here, with Perpetua adding that **SOV is the exception that AMS cannot supply**.

### Adopt from the prior study — better than my formulation
**"Automation bounds belong on the entity"** (Tier-1 #4) supersedes ADX.4's "pins."

> *A rule saying "never bid above €2" can be edited, bypassed, or fail to apply to entities created later. A `maxBid` column applies to every rule, every algorithm and every future feature — automatically. Safety by construction, not by rule correctness.*

That is strictly stronger. ADX.4 should ship `minBid` / `maxBid` / `targetAcos` as **columns on campaign/portfolio** and `minPrice` / `maxPrice` / cost floor on the product — not an exemption table consulted by the write gate. A column cannot be bypassed by a future engine that forgets to check.

### Adopt — Quartile's failure modes as ADX design constraints
1. **Automation must leave behind a structure a human could still run by hand.** (Nexus already honours this by suppressing at €0.02 rather than pausing.)
2. **Anything that creates entities needs a retirement path designed at the same time.** Directly relevant to ADX.10's bid ladder and any harvest automation.
3. **If automation makes the account too big to see, the tool owes you a way to see it.** This is the Control Console's actual mandate, stated better than ADX stated it.

---

# 4. Teikametrics

## 4.1 What it is

Mid-market algorithmic bidding, **$149+/mo** — the cheapest serious entry in this study. Platform lineage: Flywheel → **Flywheel 2.0** → now branded **ARI ("Artificial Retail Intelligence")**. Covers **Amazon, Walmart and TikTok Shop**. Absorbed Prestozon. Two tiers: **Essentials** (single brand, free trial) and **Managed Services** with human strategists.

Third company in this study with a managed-services tier. Pacvue needs dedicated staff, Rithum sells people, Teikametrics sells strategists. **Four of the six companies examined so far conclude that software alone does not run ads.** That recurrence is itself a finding.

## 4.2 The bidder — the most transparent mechanism documented so far

From their own help centre, which is unusually specific:

**Operator inputs:** `ACOS Limit`, `Bid Modifier`, "and other constraints."
**Cadence:** hourly ACOS adjustments on Amazon; bids adjusted multiple times per day.
**Model inputs:** seasonality, holidays, sales events, product category, product price, match type, **inventory status**, plus cross-seller marketplace data.
**Scope — the important part:** the bidder adjusts **bids on keywords and targets only.** It does *not* control campaign structure, product selection, or budget allocation.

That last point is the design decision worth noting. Where Quartile restructures accounts (and creates structural lock-in) and Perpetua builds campaigns autonomously, **Teikametrics deliberately confines its algorithm to one actuator.** Structure stays the operator's.

This is the same boundary ADX drew for different reasons: the rank engine owns placement and bid-for-rank; structural change stays gated. Independent arrival at the same line is worth something.

## 4.3 Features of note

- **Cross-marketplace keyword harvesting** — harvest winners on one marketplace, apply them "everywhere the seller's products appear." We have Amazon and eBay ads with entirely separate rule sets (`EbayAdsRule` vs `AutomationRule`); the prior desktop study already flagged that split as worth converging.
- **Predictive inputs include organic ranking trends and inventory levels** — commerce state as a bidding input, not merely a gate. Fourth independent occurrence of that finding.
- **Generative AI edits listing content using campaign performance data.** An ads → listings feedback loop. Nexus owns both halves natively and does not connect them in this direction at all.
- Full-funnel AMC audiences "without SQL skills."

## 4.4 What to take

### ① `ACOS Limit` and `Bid Modifier` as operator constraints on an algorithm

This is the same conclusion as the desktop study's Tier-1 #4, reached from the opposite direction: Teikametrics runs a genuinely proprietary model, and still exposes **two operator-set bounds it may not cross**. The model is opaque; the *constraints* are not.

Confirms the ADX.4 revision — bounds as entity columns — and adds that the bound belongs to *the entity*, while the algorithm remains free inside it.

### ② The single-actuator boundary

Confine the automatic loop to bids and placement. Structure, product selection and budget stay with the operator or behind approval. Teikametrics ships this as a product decision; Quartile's failure modes show the cost of not doing it.

### ③ Ads performance → listing content *(speculative, later)*

Their generative-AI listing editor consumes campaign data. We own the PIM and the ads data in one database — search terms that convert are direct evidence for title and bullet content. Not ADX scope, but it belongs in the backlog: this is a loop only a platform owning both halves can close, and there are exactly two such platforms (Rithum and Nexus).

## 4.5 What to refuse

- **Cross-seller benchmarking data.** Their model uses aggregate data from other sellers — an advantage a single-tenant system structurally cannot have. Don't try to synthesise it.
- **TikTok Shop / Walmart breadth.** Not our channels.
- **The managed-services tier**, for the same reason as Rithum's.

## 4.6 Verdict

The most *architecturally* useful entry so far, precisely because it is the least ambitious. Teikametrics does one thing — bids — inside operator-set bounds, at hourly cadence, and refuses to touch structure. That is a coherent product, and it is very close to what the ADX rank engine already is.

Its existence is also mild evidence that our €150/day account does not need ML: their measured result is 10–20% ACOS improvement for sellers at $5–15k/month, i.e. an order of magnitude above us, and the prior desktop study already concluded rules-first at this volume.

---
