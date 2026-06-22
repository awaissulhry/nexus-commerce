# Study 03 — Ads / Campaigns (exemplar feature dossier)

**Route(s):** `/marketing/ads/*` (the H10 ad cockpit)
**Owner:** —  ·  **Date:** 2026-06-22  ·  **Status:** exemplar (shows the dossier
format; deepen per the "studies on each feature" track)

> This is the worked example for the per-feature studies the hub will accumulate.
> It maps a real feature onto the now-complete design system and sketches the
> upgrade/automation roadmap. Copy `_TEMPLATE.md` for the next feature.

## 1. What it does
The Amazon Ads operator cockpit — campaign management end to end: the Ad Manager
grid (campaigns → ad groups → search terms / targets), rules automation (bid /
budget / placement / SOV / rank / dayparting), AI product goals, suggestions, and
reporting/AMC. It is the visual reference the whole design system was extracted
from.

## 2. Data flow
- **Reads/writes:** `/api/advertising/*` (campaigns, ad groups, targets, search
  terms, rules). Backed by SP-API Ads ingestion (AD-series) with accuracy +
  self-heal passes (AF / AME series). Campaigns resolve by `externalCampaignId`.
- **State:** date-range + market are local, lifted via callbacks; grid selection
  is a `Set<string>`; tabs are URL-driven (`?tab=`); the sidebar polls pending
  suggestions; several surfaces are SSE-reactive.

## 3. Components used → design-system mapping
The cockpit's bespoke pieces now have canonical DS homes (the migration target):

| Cockpit element | DS component | Status |
|---|---|---|
| `AdsDataGrid` (44-col grid) | `components/DataGrid` | migrate |
| `FilterDropdown` / `H10Select` / `MultiSelect` | `components/MultiSelect` · `Combobox` · `Menu` | migrate |
| modal chrome (`.h10-modal-*`) | `components/Modal` · `Drawer` | migrate |
| `AdManagerGraph` / `DaypartingHeatmap` | `components/PerformanceGraph` · `Heatmap` | migrate |
| `AdsPageHeader` / `CampaignDetailHeader` / `AdsSidebar` | `patterns/PageHeader` · `DetailHeader` · `AppShell` | migrate |
| `RuleBuilder` / `AiGoalBuilder` | `patterns/Builder` | migrate (after `_rank` WIP commits) |
| filter accordion · bulk bar · customize-columns | `patterns/FilterPanel` · `BulkActionBar` · `ColumnCustomizer` | migrate |
| pills / program + targeting badges | `primitives/Pill` · `Badge` | migrate |
| `_shared/ads-ui/format.ts` | `lib/format.ts` | consolidate (dup) |

This mapping IS the Phase-9 migration checklist for `/marketing/ads`.

## 4. Cross-platform parity (Amazon · eBay · Shopify)
- **Amazon** — full Ads API (SP/SB/SD), the cockpit's home; richest surface.
- **eBay** — Promoted Listings (Standard/Advanced) — a different model (ad-rate %
  vs keyword bids); the grid/rules abstractions mostly transfer, the bid/target
  semantics don't 1:1.
- **Shopify** — no native marketplace ads; "advertising" = external (Google/Meta
  via the CE-series feeds). The cockpit's campaign abstraction could front
  external channels, but the data model differs most here.
- → A genuine cross-platform study (`04-…`) should compare the *campaign* and
  *bid/target* models per channel before any channel-agnostic ad surface.

## 5. Gaps & risks
- Accuracy was the historical pain (duplicate campaigns 338→169; per-product
  metrics 99.5% unattributed pre-PC.0; stale-market reconciliation). Largely
  closed by AF/AME, but the cockpit must keep deriving metrics to the
  authoritative campaign total.
- Bespoke UI = drift risk until migrated onto the DS (this dossier's §3).
- a11y: the cockpit predates the DS a11y pass (Phase 6) — migration inherits it.

## 6. Upgrade / automation roadmap
- **Automation (AX-series intent):** keyword-paste → campaigns, search-term
  harvesting, target-ACOS bid control, dayparting/rank schedules — much already
  built in rules-automation; the DS `Builder` standardizes the authoring UX.
- **Bidding engine:** `services/bidding-engine` (inventory-elasticity + token-bucket
  throttling) as the execution backend.
- **Surface:** roll the cockpit onto the DS so future automation ships on one
  consistent, a11y-clean substrate.

## 7. Open questions
- Channel-agnostic campaign model vs per-channel surfaces (ties to UM-series)?
- Which automations graduate from dry-run to live, and with what guardrails?
