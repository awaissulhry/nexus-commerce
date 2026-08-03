# Competitor Deep Dives — one company at a time

**Date:** 2026-08-04 · **Companion to:** `2026-08-04-ads-market-research.md`

> **Prior art:** `~/Desktop/COMMERCE-PLATFORM-RESEARCH` already covers **Pacvue, Rithum, Skai, Quartile,
> Stackline** (~90 files) — the enterprise commerce / retail-media tier — with a UI teardown per company.
> Its advertising research is complete only for Pacvue; the other four have index files only.
> **This document covers the ads-native optimisation tier that study never scoped** (Perpetua,
> Teikametrics, Intentwise, Scale Insights, BidX, M19), and §0 reconciles its conclusions with ADX.
Each entry: what they are → architecture → full feature inventory → what to take (mapped to our code) → where we already lead → what to refuse.

Queue: **Pacvue** ✅ · **Rithum** ✅ · **Perpetua** ✅ · **Teikametrics** ✅ · **Intentwise** ✅ · **BidX** ✅ · **Scale Insights** ✅ · **M19** ✅ — complete.

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

# 5. Intentwise

## 5.1 What it is

**Analytics-first**, with execution layered on top — the inverse of every other company here. 21 marketplaces, 4,000+ connected accounts. Three product layers:

| Layer | Products |
|---|---|
| **Foundation** (infrastructure) | **AI Gateway (MCP)** · Data Store · Data Pipelines |
| **Intelligence** (visibility) | Product 360 · **Intentwise Explore** (AMC) · AI diagnostics + anomaly detection · shopper intelligence · dashboards |
| **Optimize** (execution) | DSP · Walmart · Criteo · Instacart · Target Roundel · TikTok · AI automation · audience activation · performance orchestration |

Their framing: the platform connects **five signal types — advertising, pricing, retail, inventory, and competition.** Nexus has four of those natively. **Competition is the one we have nothing for**, which is the same gap Perpetua identified from the other direction.

## 5.2 ⭐ How Share of Voice actually works — the implementable spec

Intentwise documents their SOV mechanics publicly, and this is the most operationally useful page found in the entire study. Combined with Perpetua's §3.3, we now have a complete specification.

**Collection**
- **Scrape page 1 of Amazon search results** for selected keywords, **4× daily**
- **Rotate IP addresses across regions** for a representative national view
- (Perpetua runs the same idea **hourly** across 100k+ terms)

**Coverage — all three placement classes**
- Organic (non-sponsored) listings
- Sponsored Product ads
- Branded headline (Sponsored Brands) ads

**Formula**
```
SOV = (your brand's total appearances ÷ total appearances by all brands on page 1) × 100
```

**Dimensions:** brand (competitor comparison) · keyword · product/ASIN · time (daily/weekly/monthly) · **position metrics — best and average rank**. 13 months of history.

**Operational use:** benchmark against competitors, **spot gaps between organic and ad visibility**, track ranking shifts.

That last one is worth pausing on: separating organic from paid visibility per keyword tells you *which lever to pull*. High organic and low paid means stop buying what you already own. Low organic and low paid means the term is genuinely open. Our whole coverage goal is unmeasurable without that split.

## 5.3 The decision this forces — and it is not a small one

Every SOV product in this market is built on **scraping Amazon search results**. Amazon's ToS prohibits automated scraping of its pages. The vendors do it at scale and sell the output.

So ADX.8 has three honest options, and this should be an explicit operator decision rather than an engineering default:

| Option | What it means | Risk |
|---|---|---|
| **A. Build a collector** | Scrape page 1 for our keyword set on a schedule | ToS violation; IP blocking; the account is the asset at risk |
| **B. Buy the data** | DataHawk, Intentwise and others sell SOV feeds | Cost; external dependency; but the ToS exposure is theirs |
| **C. Approximate** | `topOfSearchImpressionShare` + SQP brand share + our own `KeywordRank` | Free, in-policy, already partly built — but tells us *our* share, never *who else is on the page* |

**My recommendation: C now, B if C proves insufficient, and A not at all.** The asset at risk in option A is the selling account itself, and no coverage metric is worth that. Option C is weaker than what competitors have, and I would rather say so plainly than quietly build a scraper into an ads platform that also runs the listings.

Notably, our keyword set is *tens* of terms across a few families — not 100k. If B is ever needed, it is a small purchase, not an enterprise data contract.

## 5.4 Other features of note

- **AI Gateway (MCP)** — they expose their analytics to AI assistants over Model Context Protocol. A 2026 pattern worth noting for the backlog; Nexus already has an Ask-AI surface and MCP servers in the stack.
- **Anomaly detection** as a first-class product, not a rule. We have `ads-anomaly-guard` running (2,009 runs/14d) but it is not surfaced as an operator-facing product.
- **Editable rules** — earlier research placed Intentwise firmly in the "define your own rules for full control" camp, which is consistent with the analytics-first posture.

## 5.5 What to take

1. **The SOV specification** (§5.2) — formula, dimensions, organic/paid split, best-and-average position. Adopt the *model* even under option C, so the metric is comparable if we ever change data source.
2. **The organic-vs-paid visibility gap** as the headline diagnostic for the coverage goal.
3. **The three-layer separation** — Foundation / Intelligence / Optimize. Nexus's three consoles are an accident; Intentwise's three layers are a decision. Worth borrowing as an organising principle for the surviving console: data → visibility → execution.

## 5.6 What to refuse

- **Scraping.** See §5.3.
- **21-marketplace breadth**, DSP, and the retail-media network integrations.

## 5.7 Verdict

Intentwise contributes the **implementable definition of the metric our entire stated goal depends on**, and forces the one genuinely uncomfortable decision in this research: the industry measures page-one ownership by scraping, and we should not.

That means accepting a weaker measurement (option C) or buying it (option B) — and being explicit that our coverage numbers are not directly comparable to a Pacvue or Perpetua dashboard. Better to know that now than to discover it after building the ladder.

---

# 6. BidX

## 6.1 What it is

**German, rule-based, European-focused** — and therefore the most *geographically* relevant company in this study. Xavia sells Amazon IT primarily with DE/FR/ES; BidX is popular with exactly that seller. **€495/month.** English *and* German support, live training, 20+ webinars a year.

Products: BidX Platform · **BidX App** (mobile — the only one in this study) · Amazon DSP · AMC · **iMetrify** (measurement) · Seller Suite.

Coverage: SP, SB, SD, Amazon DSP, Walmart, plus external Google / Facebook / Instagram / TikTok.

## 6.2 The rules engine — the closest analogue to what we just repaired

BidX is plainly **"If X then Y"**: set conditions, take actions. The documented behaviours are the same primitives as our `automation-templates.ts` — promote high-performing keywords, reduce bids on poor performers, pause keywords with no sales, harvest negatives, allocate budget.

They also automate the **whole campaign lifecycle**: setup, structure, ongoing optimisation, DSP, AMC analytics. **Campaign Creator** claims 12× faster creation, with ChatGPT integration.

There is nothing here we do not already have — which is itself the finding. Our `AutomationRule` engine, once repaired and consolidated to 22 rules, is feature-comparable to a €495/month product. The gap was never capability; it was that ours had never executed successfully.

## 6.3 ⭐ The number that should recalibrate the whole programme

> **BidX is "worth the spend for brands above €10K monthly Amazon ad volume."**

Xavia runs **~€150/day ≈ €4.5k/month**.

We are **well below the threshold at which the closest European competitor believes paid PPC tooling pays for itself.** That is not an argument against automating — the account still needs to run unattended. It is an argument about *what kind* of automation is worth owning at this spend:

- Cheap to operate, not merely cheap to build
- Few levers, deeply understood, rather than many levers shallowly configured
- Failure modes that are obvious rather than statistical

It independently supports three decisions already taken: goals-first over 51 rules, the consolidation from 36 enabled rules to 22, and the prior desktop study's "rules first, ML only if volume justifies it — at €150/day it will not."

It also sets a fair yardstick for ADX. The question is not "does Nexus match Pacvue," it is **"does Nexus beat manual management at €4.5k/month spend"** — a much lower and more honest bar, and one nothing in the account currently clears, because the automation layer has never run.

## 6.4 The free tools — the best packaging idea in the study

BidX ships three free diagnostics as lead generation:
- **PPC audit**
- **Wasted Ad Spend Analyzer**
- **TACoS Calculator**

The middle one matters. "Wasted Ad Spend" is a **single euro figure that says how much you are losing right now** — the entire diagnostic collapsed into one number an operator can act on without expertise.

This converges exactly with the prior desktop study's Tier-2 recommendation — *"a counted problems board, lifecycle-shaped, every row priced in €"* — and with Pacvue's alerts board where every row carries a dollar value. **Three independent arrivals at the same idea.**

And we can compute it better than any of them: `ProductProfitDaily` + real Amazon fees + COGS means our "wasted spend" figure is actual margin lost, not an estimate from ACOS.

## 6.5 What to take

1. **A single "wasted ad spend" number**, computed from real margin, on the ads dashboard. Cheapest possible expression of "the tool owes you a way to see it" (Quartile's constraint).
2. **The €10k calibration** as a standing sanity check on every future ADX phase: would this be worth owning at €4.5k/month?
3. **Mobile check-in** *(backlog)* — BidX is alone in shipping an app. For an operator whose goal is "doesn't require my attention," the right mobile surface is not a console but a digest with a kill switch.

## 6.6 What to refuse

- **Full-lifecycle campaign automation** including structure creation — same refusal as Perpetua and Quartile.
- **External channels** (Google/Meta/TikTok) and Walmart.
- **ChatGPT campaign creation.** Prod AI is gated on a provider/billing issue anyway, and campaign structure is the one thing every failure mode in this study says to keep human.

## 6.7 Verdict

BidX contributes no capability we lack. What it contributes is a **price signal**: the closest European competitor sets its payback threshold at more than twice Xavia's entire ad spend.

The useful conclusion is not "so don't bother." It is that at this volume the winning system is **small, legible and cheap to run** — which is precisely the direction ADX has been moving since the approach review, and an argument against ever reinstating the 51-rule estate.

---

# 7 & 8. Scale Insights and M19 — the two poles

Taken together because they bracket the design space, and because where they *converge* is the finding.

---

## 7. Scale Insights — the deepest rule engine in the market

Tagline: **"Absurd Control."** Positioning is control, not intelligence.

**Pricing is the surprise.** Per automated ASIN: $78/mo for 5 ASINs up to $688 for 100 — **or a "1% Plan" charging 1% of ad spend for unlimited ASINs.** At Xavia's ~€4.5k/month that is **~€45/month.** Unlike BidX, this *is* priced for our volume.

### The 11 named algorithms

| Rule | What it does |
|---|---|
| **Dayparting** | Schedule activity at specific hours |
| **Status** | Pause/enable on performance thresholds |
| **Bidding** | Optimise keyword/target bids to goal |
| **Placement** | Adjust **Top of Search %** or **Product Page %** |
| **Import** | Harvest performing search terms into keywords |
| **Negative** | Add underperformers as negatives |
| **⭐ Whitelist** | **Prevents negation of specified keywords** |
| **⭐ Revive** | **Raises bids on keywords that used to perform but have no recent traffic** |
| **Negative Word** | Add non-performers as negative *phrase* |
| **⭐ Blacklist** | Auto-negate blacklisted terms |
| **Daily Budget** | Adjust budget by performance **and weekday** |

### The three ideas worth taking

**① Whitelist / Blacklist as keyword-level protection.** "Never negate this keyword" and "always negate that one." This is the entity-bounds principle applied to keywords — the same shape as `maxBid` on a campaign. **Any harvest-and-negate automation without a whitelist is dangerous**, and ours has none. Our `🌾 Auto harvest & negate` rule is enabled with cap 3 and nothing protects a brand term from being negated by it.

**② The Revive rule.** Raise bids on keywords that previously converted but have gone quiet. Genuinely novel, and directly a *coverage* mechanic: a term that stopped delivering is lost page-one presence, and nothing in our stack notices. It is the natural complement to the bid ladder.

**③ Preview + step-by-step calculation transparency.** Simulate a rule against real account data without committing, and show the arithmetic. This is their differentiator, and it is **exactly ADX.6's Foresight plus ADX.3's Attribution** — validated as the thing a control-positioned product leads with.

Also noted: they build **dayparting campaigns with 24 ad groups** to get hourly analysis. A structural workaround for not having AMS. We have AMS, so we skip it — and it is a reminder that our substrate is genuinely better than a €45/month tool's.

---

## 8. M19 — the purest algorithmic

Products: PPC Optimization · TACoS Management · Account 360 · Amazon DSP · DSP Reporting · **Top of Search Rankings Optimizer** · **Autopilot** (100% automated) · Product 360 · Keyword Tracker · Product Timeline Events.

### The four-stage model

1. **Keyword Exploration** — AI tests thousands of keywords for untapped ranking opportunities
2. **Daily Conversion Prediction** — a conversion prediction per ASIN×keyword pair, every day
3. **Bid Adaptation** — real-time adjustment against competition intensity
4. **Piloting** — feedback loop toward the operator's goals

### ⭐ What the operator still controls — the important part

Even here, at the algorithmic extreme, five dials remain:

- Business goals / ACoS targets
- Monthly budgets
- **Force product visibility** — override visibility regardless of economics
- **Competition tactics intensity** — how hard to fight back
- Performance targets

Two of those are **overrides**, not targets. *Force product visibility* is precisely our `allOut` flag. *Competition tactics intensity* is a dial we do not have — a single "how aggressive" setting rather than per-target parameters.

They also ship a named **Top of Search Rankings Optimizer** — a whole product for the goal this project started with.

---

## The convergence — the most important result in this research

| | Scale Insights | M19 |
|---|---|---|
| Model | 11 algorithms, 200+ parameters | Opaque ML, 4 stages |
| Operator sets | Everything | Five dials |
| Positioning | "Absurd Control" | "Save massive time" |

**Opposite poles. Both converge on the same two requirements:**

1. **The operator must be able to bound it.** Scale Insights via whitelists, blacklists and caps. M19 via ACoS target, budget cap, force-visibility and competition intensity. *Neither ships an unbounded optimiser.*
2. **The operator must be able to see why.** Scale Insights ships preview and step-by-step calculation. M19 ships Account 360, Keyword Tracker and Product Timeline Events.

**Bounds and provenance are not a rule-engine feature or an ML feature. They are the price of admission at both extremes.**

That is ADX.3 (attribution) and ADX.4 (bounds on the entity), independently required by the two most philosophically opposed products in the category. Combined with Teikametrics exposing `ACOS Limit` + `Bid Modifier` around a proprietary model, and the desktop study's Tier-1 #4, this is now **four independent arrivals** at the same conclusion.

The industry's own 2026 summary agrees, and states the residual honestly:

> The category shifted from rule builders to AI agents — "sellers approving rather than operating." But *"automation follows rules, AI learns patterns — neither sets the strategy."*

Which is the whole argument for the ADX ordering: fix the machine, bound it, make it explain itself — then decide the strategy yourself, because nothing on the market will do that part.

## What to take from both

1. **Whitelist / blacklist on keywords** (Scale Insights) — protection primitives. Our harvest-and-negate rule is live with no protection at all.
2. **A Revive mechanic** — recover lost page-one presence on terms that went quiet.
3. **Preview + calculation transparency** — confirmed as the control-product differentiator.
4. **A single "competition intensity" dial** (M19) — one operator control above the per-target parameters.
5. **Weekday-aware budget** (Scale Insights) — we have hour-of-day, not day-of-week.

## What to refuse

- 200+ parameters. Scale Insights' depth is its product; for us it is the 51-rule failure again.
- Autopilot / 100% automation with an opaque model.
- Algorithmic keyword exploration at our volume.

---
