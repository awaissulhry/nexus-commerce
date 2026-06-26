# Advertising

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

Amazon Ads cockpit with heavy PPC automation — keyword-paste-to-campaigns, search term harvesting, target-ACOS bidding, and dayparting. Built on SP-API Amazon Ads endpoints.

---

## Campaign Types

| Type | Code | Description |
|------|------|-------------|
| Sponsored Products | `SP` | Product-level ads |
| Sponsored Brands | `SB` | Brand banner ads |
| Sponsored Display | `SD` | Display retargeting |
| DSP | `DSP` | Demand-Side Platform |

---

## Data Models

| Model | Purpose |
|-------|---------|
| `Campaign` | Ad campaign (Amazon/eBay/Shopify/external) |
| `AdGroup` | Ad group within campaign |
| `AdTarget` | Keyword or ASIN target with bid |
| `AdProductAd` | Product ad creative |
| `AmazonAdsHourlyPerformance` | Hourly impressions/clicks/spend |
| `AmazonAdsDailyPerformance` | Daily ACOS/ROAS metrics |
| `AmazonAdsSearchTerm` | Search term performance report |
| `CampaignMetric` | Generic campaign metrics |
| `AdsRuleSuggestion` | AI-generated rule suggestions |

---

## Advertising Routes (`advertising.routes.ts` — 395.5 KB)

⚠️ **grep trap:** File contains a `€` character. Plain `grep` skips it as binary — use `grep -a`. A duplicate Fastify route = boot crash (not a 4xx).

---

## Ad Cockpit (AX-series, 12 phases)

One Amazon-grade ad cockpit — `AX.1 ✅` (one surface).

**Reference:** H10 pixel-match (Helium 10 parity for `/ads/campaigns/[id]`):
- Campaign Details section ✅ done 2026-06-18
- `[id]` dir currently untracked WIP

---

## Campaign Detail Page

`/marketing/ads/campaigns/[id]`

Sections:
- Campaign Details (H10 pixel-match complete)
- Ad Groups
- Keywords / Targets
- Search Terms
- Performance metrics

---

## Ads Console Fidelity (AF-series)

All shipped 2026-05-30/31:

| Phase | Fix |
|-------|-----|
| AF.1 | NaN `bidCents` root fix |
| AF.1d | Duplicate campaign merge (338 → 169; marketplace short-code vs Amazon ID split) |
| AF.1e | Search-term scoping |
| AF.2 | Display fixes |
| AF.3 | Reconcile/targets |
| AF.4 | Scroll fixes |
| AF.5/6 | Ad group inline-bid + enable/pause toggles (new PRODUCT_AD push path) |
| AF.7 | Fleet keyword/target bid resync (real SP-API v3 list bids) |
| AF.8 | `useColumnResize` |
| AF.9 | Funnel cleanup |

**KEY:** Resolve campaigns by `externalCampaignId` ALONE — not by name.

---

## Suggestions Cockpit (S-series)

`/marketing/ads/suggestions` — review cockpit (S.1–S.6 shipped 2026-06-24):
- AI-generated bid/keyword suggestions
- Review interface for accepting/rejecting
- `AdsRuleSuggestion` model
- New reusable DS `Tag` primitive
- `AdsDataGrid` with `groupBy` / `onRowClick` / `keyboardNav` props
- **Gotcha:** Ads routes need a local `ToastProvider` — not provided by app shell

---

## Automation Rules

| Job | Purpose |
|-----|---------|
| `budget-enforcement.job.ts` | Enforce daily budget caps |
| `dayparting.job.ts` | Adjust bids by time-of-day |
| `rank-defense.job.ts` | Defend organic rank with bid boosts |
| `ads-automation-rules.job.ts` | Execute if-then automation conditions |
| `keyword-resync.job.ts` | Resync bids via SP-API v3 |

---

## Bidding Strategy

| Strategy | Code |
|----------|------|
| Legacy for Sales | `LEGACY_FOR_SALES` |
| Auto for Sales | `AUTO_FOR_SALES` |
| Manual | `MANUAL` |

**No-pause rule:** NEVER pause campaigns. Suppress via ~€0.02 bids instead. Pausing disrupts Amazon's algorithm + causes delivery delays.

---

## Ad Sync Cron Flow

```
ads-sync.job.ts (cron)
    │
    ▼
Amazon Ads SP-API
    ├─► Campaigns
    ├─► Ad Groups
    ├─► Keywords/Targets
    └─► Performance data
          │
          ▼
     Upserted in Postgres
          │
          ▼
     campaign-reconciliation.job.ts
     (dedup 338 → 169)
```

---

## Advertising Backend (AD-series)

5-wave engagement 2026-05-16 — the original backend infrastructure:
- Plan at `/Users/awais/.claude/plans/here-is-the-blueprint-humming-beaver.md`
- Sandbox-first approach
- Reuses MC-series substrate

## Unified Marketing OS (UM-series)

14 phases — cross-channel campaign platform:
- 1 channel-agnostic `Campaign` across Amazon/eBay/Shopify/external
- All EU markets
- Ads + promos + content + outreach
- Live automation with guardrails
- Plan: `melodic-strolling-jellyfish.md`

---

## Key ACOS Formula

```
ACOS = Ad Spend / Ad Revenue × 100
Target ACOS drives bid adjustments
Rank Defense: bid boost when organic rank drops below threshold
Dayparting: lower bids during low-conversion hours
```

---

## Related Notes

- [[04 - API Layer (Fastify)]] — `advertising.routes.ts` (grep -a for €)
- [[06 - Background Jobs & Workers]] — ads cron jobs
- [[27 - Bidding Engine Microservice]] — bid optimization
- [[11 - Amazon SP-API Integration]] — Amazon Ads API
- [[05 - Database Schema]] — Campaign, AdGroup, AdTarget models
