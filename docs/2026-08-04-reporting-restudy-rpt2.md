# Reporting re-study — what the page actually needs to beat the field

**Date:** 2026-08-04 · **Status:** RESEARCH + PROPOSAL, AWAITING GATE
**Scope:** `/marketing/ads/reporting` · **Companion to:** `2026-08-04-ads-reporting-rpt.md`
**Benchmarked against the ten named:** Perpetua · Teikametrics · Intentwise · Scale Insights · BidX · M19 · Quartile · Pacvue · Skai · Stackline

> The earlier studies (`2026-08-04-competitor-deep-dives.md`, `~/Desktop/COMMERCE-PLATFORM-RESEARCH`)
> examined these companies as **optimisation** products. This one examines them as **reporting**
> products, which is a different surface and mostly a different feature set.

---

## 1. What each one actually ships for reporting

| | Reporting surface |
|---|---|
| **Stackline Beacon** | ⭐ The deepest by far. **13 analytics modules**: Sales · **52-week AI forecasting down to SKU** · **Scenario Planning** · Growth Recommendations · ⭐ **Attribution waterfall** (sales impact per business lever) · Ad Analytics + incrementality · Content Analytics · Organic Traffic · Ratings & Reviews sentiment · Pricing · Promotion ROI · Operations (fees, disputes, chargebacks) · Catalog insights. Plus ⭐ **AI Presentations** — data straight to an executive-ready deck. |
| **Pacvue** | ⭐ **Report Builder**: drag tables, charts and KPI cards onto a canvas, bind to AMC data **or custom SQL**, snap-to-grid, **version history**, scheduled refresh, **PDF / share link**. **DaaS** — 100+ retailers into your warehouse. **MCP** for agent-native access. |
| **Intentwise** | Analytics-first. ⭐ **Pre-aggregated** for fast loads · ⭐ **branded client dashboards on your own URL** · report library · **embed into Looker / PowerBI** · ⭐ **warehouse sync** (Snowflake, Redshift, Databricks, Azure Synapse) · SQP joined to ads + retail in one query · AMC Explore with pre-built templates · **AI Gateway (MCP)** · anomaly detection as a product. |
| **Skai** | Centralised reporting + media-planning hub. Template **or custom layout**, slice-and-dice in place, export. ⭐ **Custom Metrics** — define metrics the publisher does not provide and report on them alongside the rest. Retail Insights normalises KPIs across 100+ retailers. Framing: move from *"did this work?"* to *"what should we change right now?"* |
| **Perpetua** | **Total Sales Analytics** — ⭐ Total ACoS, **attributed vs organic sales**, total sales in one view · Market Intelligence Reporting · Retail Intelligence · Digital Shelf Insights · hourly SOV across 100k+ terms against named competitors. |
| **Scale Insights** | Ads Insights — customisable across keywords, search terms, campaigns and ASINs with historical filters. ⭐ **Sales Insights: correlations between pricing, ad activity and ORGANIC sales.** Multi-account unified dashboard. Restock forecasting. |
| **M19** | **Account 360** and **Product 360** · DSP full-funnel reporting · Keyword Tracker with **share of voice** · ⭐ **Product Timeline Events** — external factors annotated onto the performance timeline. |
| **Teikametrics** | Cross-marketplace reporting (Amazon, Walmart, TikTok Shop); operator-set `ACOS Limit` / `Bid Modifier` bounds surfaced in-product. Reporting is not how it sells. |
| **Quartile** | Thin published reporting; SKU Intelligence dashboard. Analysis is delivered by a **dedicated account team**, not self-service. |
| **BidX** | ⭐ **Wasted Ad Spend Analyzer** — the entire diagnostic collapsed into a **single € figure**. Plus a PPC audit and a TACoS calculator. |

---

## 2. The honest scorecard: us vs them, today

### 2.1 Where we are already ahead — and nobody else is close

These are not vanity items; each one is a defect class the others ship with.

| # | What we have | Who else has it |
|---|---|---|
| 1 | **Per-market freshness everywhere** — the library, the runner, the export manifest and the scheduled email all state how stale each market is | **Nobody.** Every competitor shows one "as of". That is exactly what hid Italy running 8 days behind Germany here. |
| 2 | **Idle vs broken as distinct states** — "no rows because all campaigns are paused" never renders as failure | **Nobody.** |
| 3 | **Null is never zero** — an undefined ACOS renders "—", exports as an empty cell, and sorts last | Amazon's own export writes `"12.5000%"` strings and `0.00000` placeholders. |
| 4 | **A self-describing export** — every XLSX carries filters, units per column, actual-vs-requested window and per-market freshness on its own sheet | **Nobody.** |
| 5 | **Import with per-row arithmetic** — read / merged / new / unchanged / conflicting, plus an error file naming field and value | Nobody in this list imports console exports at all. |
| 6 | **One metric registry, enforced in SQL** — grid, totals and export cannot disagree | Most have drift between screen and export. |
| 7 | **Profit-native** — real Amazon fees + COGS | Perpetua explicitly cannot see margin. |
| 8 | **Stale-data warning inside the delivered email** | **Nobody.** |

**The strategic read:** our unoccupied ground is *trustworthiness of the number*. Every competitor optimises for breadth; none of them can tell you when their own figure is stale, partial, or undefined. That is worth defending and extending, not trading away.

### 2.2 Where we are genuinely behind

| # | Gap | Who has it | Severity |
|---|---|---|---|
| **1** | **No visual layer at all** — we have grids, no charts, no KPI cards, no trend lines | Pacvue, Skai, Intentwise, Stackline, M19 | ⭐⭐⭐ **the biggest gap** |
| **2** | **No period comparison** — no vs-previous-period, no % change, no sparkline | All ten | ⭐⭐⭐ |
| **3** | **No total-sales context** — we report ads in isolation; no TACoS, no ad-vs-organic split | Perpetua, Scale Insights, Stackline | ⭐⭐⭐ |
| **4** | **No custom metrics** — our registry is fixed; an operator cannot define "contribution after ads" | Skai (explicitly), Pacvue (via SQL) | ⭐⭐ |
| **5** | **No dashboard/canvas** — cannot assemble a page of tiles for a recurring question | Pacvue, Skai, Intentwise | ⭐⭐ |
| **6** | **No single "wasted spend" number** | BidX — and the prior study reached this idea **three times independently** | ⭐⭐ |
| **7** | **No annotations** — nothing marks "price change here", "stock-out there" on a timeline | M19 Product Timeline Events | ⭐⭐ |
| **8** | **No share link / branded output** — a report cannot be handed to someone without an account | Intentwise, Pacvue | ⭐ |
| **9** | **No Google Sheet / BI connector** | Intentwise, Pacvue, DataHawk | ⭐ (RPT.8, planned) |
| **10** | **No MCP / agent access to reporting data** | Pacvue, Intentwise — the 2026 pattern | ⭐ |
| **11** | No forecasting, no scenario planning, no attribution waterfall | Stackline | — *(belongs to Analytics, not Reporting)* |
| **12** | No anomaly detection as a product surface | Intentwise, DataHawk | — *(Analytics)* |

**Note on 11–12:** under the operator's D2 decision — *Reporting = data, Analytics = meaning* — forecasting, attribution and anomalies belong next door on `/marketing/ads/analytics`. They are listed for completeness, not as Reporting scope.

---

## 3. What "better than all of them" actually requires

Beating this field is **not** a race to 13 modules. Stackline's breadth rests on a 1.2-billion-product crawl we will never own, and Quartile's answer to reporting depth is to sell you an account manager. The winning position is narrower and sharper:

> **Every number, exactly right, explained, and in your hands — in whatever form you need it.**

Three pillars follow.

### Pillar A — See it (closes gaps 1, 2, 3, 6)
The grid is correct but mute. A number without a trend and without a comparison cannot answer "is this good?".

- **Trend charts + KPI tiles** on every report, driven by the same query object as the grid.
- **Period comparison** — previous period / same period last year, with % change and direction, computed server-side so it obeys the same metric registry.
- **Total-sales context** — TACoS and ad-vs-organic split, joining the ads tables to `AmazonEconomicsDaily` and the orders data we already hold.
- **The wasted-spend number** — one € figure, computed from real margin rather than an ACOS estimate. We can compute this **better than BidX** because we have COGS.

### Pillar B — Shape it (closes gaps 4, 5, 7)
- **Custom metrics** — operator-defined formulas over the existing metric registry, stored and reusable, with the same null-safety rules.
- **A dashboard canvas** — arrange saved reports as tiles on a page; the saved-report unit already exists.
- **Annotations** — mark events on the timeline (price change, stock-out, launch). `/insights/notebook` is prior art.

### Pillar C — Move it (closes gaps 8, 9, 10)
- **Google Sheets live connection** (already planned as RPT.8).
- **Share link** — a read-only, expiring URL for one report run.
- **MCP endpoint** — expose the runner to an AI assistant. Our runner is already a clean query contract; this is a thin adapter, not a rebuild.

### And keep extending the moat (§2.1)
Every new surface inherits the freshness, idle-vs-broken and null-safety rules. That is the differentiator, and it is free to maintain only if it is never bypassed.

---

## 4. Proposed phases

RPT.8 and RPT.9 stay as planned. The re-study adds a second wave.

| # | Phase | Closes | Size |
|---|---|---|---|
| **RPT.8** | Google Sheets live connection | 9 | M |
| **RPT.9** | Pipeline health (absorbs legacy `reports` + `feeds`; fixes `rowCount` and `s3_download_400` at source) | — | M |
| **RPT.10** | **Charts + KPI tiles + period comparison** | 1, 2 | **L** |
| **RPT.11** | **Total-sales context** — TACoS, ad vs organic, and the single wasted-spend number | 3, 6 | **L** |
| **RPT.12** | **Custom metrics** | 4 | M |
| **RPT.13** | **Dashboard canvas** — tiles from saved reports | 5 | M |
| **RPT.14** | Annotations on the timeline | 7 | S |
| **RPT.15** | Share link (read-only, expiring) | 8 | S |
| **RPT.16** | MCP endpoint over the runner | 10 | S |

**Recommended order:** RPT.10 first. It is the largest single gap, every competitor has it, and it makes the six phases already built visibly worth having — right now the data is correct but silent.

---

## 5. What to refuse, again

- **Breadth for its own sake.** Stackline's 13 modules rest on a data asset we cannot replicate; chasing it produces shallow copies of all thirteen.
- **Scraped SOV.** Unchanged from the earlier study: the account is the asset at risk.
- **AMC / DSP reporting.** Still unprovisioned at Amazon; the code would be dead.
- **A managed-services tier.** Quartile's and Rithum's answer to reporting depth. The correct response is a system that explains itself.
- **A general BI tool.** We are not rebuilding Tableau. A small number of exact, well-wired reports beats a query surface nobody trusts.
