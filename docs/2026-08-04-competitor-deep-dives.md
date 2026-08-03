# Competitor Deep Dives — one company at a time

**Date:** 2026-08-04 · **Companion to:** `2026-08-04-ads-market-research.md`
Each entry: what they are → architecture → full feature inventory → what to take (mapped to our code) → where we already lead → what to refuse.

Queue: **Pacvue** ✅ · **Rithum** ✅ · Perpetua · Teikametrics · Intentwise · Scale Insights · BidX · M19 · + leaders as found.

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
