# Competitor Deep Dives — one company at a time

**Date:** 2026-08-04 · **Companion to:** `2026-08-04-ads-market-research.md`
Each entry: what they are → architecture → full feature inventory → what to take (mapped to our code) → where we already lead → what to refuse.

Queue: **Pacvue** ✅ · Rithum (ex-ChannelAdvisor) · Perpetua · Teikametrics · Intentwise · Scale Insights · BidX · M19 · + leaders as found.

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
