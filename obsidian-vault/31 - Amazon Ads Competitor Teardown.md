# Amazon Ads Competitor Teardown

→ [[00 - Nexus Commerce MOC]] | [[30 - Amazon Ads Platform Audit]] | [[32 - Amazon Ads Import-Export & Sync Spec]]

Research date: 2026-07-28. 18 platforms. Focus is on **structure and operation**, not feature checklists.

---

## 0. Roster corrections

| Assumption | Reality |
|---|---|
| "Back View" | **Pacvue.** |
| Helium 10 Adtomic | **Discontinued as a standalone.** Replaced 26 Feb 2025 by "Helium 10 Ads **powered by Pacvue**." Adtomic and Pacvue are now the same engine — treat them as one competitor. |
| ChannelAdvisor / Rithum | CommerceHub + ChannelAdvisor merger. Advertising is a **module plus managed service**, not a self-serve PPC cockpit — and self-service access is *withheld* on accounts Rithum manages. Not really a peer product. |
| Flywheel Digital | Ascential's **agency**, bought by Omnicom for $835M. Services, not a buyable cockpit. Distinct from Teikametrics' product named "Flywheel". |
| Downstream Impact | Acquired by **Jungle Scout** (Mar 2021), not Amazon. Became Cobalt's ad engine. |
| Perpetua | Absorbed **Sellics** (2022). |

Also found and worth watching: **Adbrew** — the closest structural analogue to what we're building.

---

## 1. Information architecture — the important finding

Amazon's own hierarchy is Portfolio → Campaign → Ad Group → Target. Every serious platform adds **a user-defined grouping dimension orthogonal to it**:

| Platform | Their layer |
|---|---|
| Pacvue | **Tags and sub-tags** |
| Teikametrics | **Groups** |
| Skai | **Portfolios** (their own, not Amazon's) |
| Sellerboard | **Smart Portfolios** |
| Trellis | optimisation algorithm as a **product attribute** |
| BidX | **SKU-level** target ACOS |

Four independent teams converged on the same idea, which is strong evidence it's correct. The reason: Amazon's portfolio is **one flat, mutually-exclusive grouping**, and real operators need many overlapping ones — brand × lifecycle stage × margin band × season. The dimension has to be multi-valued, and it has to be the join key for **budget pacing, rule scope and report rollup** simultaneously, or it degrades into a label.

**We already have the better version of this and may not have noticed.** `/advertising/by-product/*` is a SKU-centric view over campaign-centric data, and margins live at SKU level. Objectives attached to the SKU also survive campaign restructuring, which campaign-level targets do not.

---

## 2. Bulk workflows — where everyone is weak

| Platform | Bulksheet round-trip | Format | Amazon-native format? | Pre-apply diff | Per-row errors | Undo | Scheduled import |
|---|---|---|---|---|---|---|---|
| **Pacvue** | **Excel add-in, live two-way** | XLSX via add-in | Not documented | Approval queue | ? | **No** | No |
| **Perpetua** | **Yes — best documented** | **CSV**, proprietary | **No** | **No** (post-upload only) | **Yes** — Result/Errors/Warnings columns, partial success, upload history | **No** | No |
| Teikametrics | CSV for Groups | CSV | ? | ? | ? | No | No |
| **Skai** | Yes — bulksheets | Spreadsheet | ? | No | "Unclear error notifications" | No | No |
| Intentwise | Keyword/suggestion download | CSV | No | No | ? | No | No |
| Ad Badger | No | — | — | No | No | No | No |
| Sellerboard | No upload | CSV export | No | Recommendation column *is* the preview | N/A | No | No |
| SellerApp | Yes, w/ 60d metrics | Spreadsheet | No | No | ? | No | No |
| Adbrew | Bulk ops incl. **placement modifiers** | ? | ? | ? | ? | No | No |
| **Amazon native** | Yes | **.xlsx**, sheet per entity, `Operation` + ID columns | — | No | **Status + Download Report** | No | No |

Three things fall out of this table:

**Nobody ingests or emits Amazon's own bulksheet format.** Everyone uses a proprietary CSV. That is simultaneously a migration wedge — import a customer's existing bulksheet workflow on day one — and an answer to the exit-cost objection.

**Nobody shows a pre-apply diff.** Perpetua and Amazon both validate *after* upload. Not one platform shows "4,312 rows will change, here are the 118 that will fail and why, here is the projected spend delta" before commit. This is the difference between a tool an operator trusts at 3pm on Prime Day and one they don't.

**Nobody has undo.** Not one platform documents reversing an applied change set. Agencies explicitly ask for campaign snapshots and one-click rollback; competitive teardowns repeatedly note its absence at Pacvue, Quartile and Trellis. **We already have `/actions/:executionId/rollback` and `AdvertisingActionLog`.**

Constraints everyone inherits from Amazon's native bulksheets, worth knowing because they shape expectations: downloads include only entities with **non-zero impressions** in the window; only campaigns with impressions in the **last 60 days** are available; SP drafts unsupported; **no dayparting** in bulksheets at all — only campaign start/end dates.

---

## 3. Sync honesty — the recurring failure

| Platform | Marketing Stream | Published latency | Documented complaints |
|---|---|---|---|
| **Pacvue** | **Yes — 21 Jun 2022, first mover** | "Near real-time", no SLA | Slow large reports, load times. **No accuracy complaints found.** |
| **Perpetua** | Yes — Stream Reporting, hourly + DoW×hour heat map | **12h dashboard delay** (Core/Pro); hourly bid updates **Enterprise-only** | *"2-day delays"*, *"shows ads inactive while active in Amazon"*, bid misallocation |
| **Skai** | ? | Not published | *"Settings and new campaigns take several days to appear"* |
| **Quartile** | Yes — hourly bidding | Not published | Numbers **rounded to nearest 100** |
| Intentwise | Yes + dayparting rules | Not published | Roll Ups disabled above 200k keywords |
| CommerceIQ | Claimed real-time | Not published | **Data inaccuracy in recommendations** (7 reviews) |
| Teikametrics | Implied | Not published | Data inaccuracy (2 reviews) |
| **Ad Badger** | **No AMS** | — | **Praised: "no 1-week lag, syncs accurately from Seller Central"** |

The pattern is unmistakable: **the platform with the least real-time infrastructure has the best reputation for data accuracy.** Ad Badger has no Marketing Stream and users specifically praise its sync honesty. Perpetua and CommerceIQ have more sophisticated pipelines and worse reputations.

The reason is that none of them expose **data vintage**. Everyone inherits Amazon's 12h → 24h → restated-for-60-days pipeline, and not one platform shows an as-of timestamp, a restatement delta, or a reconciliation view against Seller Central. So users see numbers change and conclude the tool is wrong.

**A visible "provisional / stabilising / settled, last synced at T, restated N times" badge is a genuine differentiator, and Ad Badger's reviews prove users notice and reward sync honesty.** This is cheap to build and directly addresses the thing you asked for.

---

## 4. Automation

| Platform | Rule expression | Dry-run | Conflict detection | Dayparting |
|---|---|---|---|---|
| **Pacvue** | Conditions vs **campaign avg / profile avg / custom target / hard $**; AND-EITHER-OR; **min clicks/spend/impressions floors**; paired up-bid + down-bid | Approval queue | **Not documented** | Hourly bid ±, **bulk across campaigns** |
| Perpetua | Goal-level target ACoS + budget; engine does the rest | No | N/A | Bid multiplier schedules |
| Helium 10 Ads | Bid/Harvest/Negative rules, templates, **multi-criteria with precedence + reorder UI** | No | **Precedence** (closest anyone gets) | Inside Rules & Automations |
| Teikametrics | Goal-based + ACOS limits + **per-SKU min/max bid** | No | No | Bid Scheduler |
| Quartile | Rules at account/campaign/**ASIN** level | No | No | Hourly placement adjustment |

**Zero platforms let you run a proposed rule over the last 30 days and see what it would have done.** Combined with the absence of conflict detection, that is why rule engines get built and abandoned — operators discover conflicts by watching bids oscillate.

Two details from Pacvue worth copying exactly: **relative reference values** (compare against campaign average or profile average, not just an absolute number) and **significance floors** (minimum clicks / spend / impressions before a rule may fire). The floor is what most tools omit and every operator needs.

Also: Perpetua's own cheatsheet tells users to change target ACoS by no more than 10% relative, 5–6 days apart — **but the platform doesn't enforce it.** No platform implements change budgets, cooldowns or warmup as system constraints. They're documentation.

---

## 5. Pricing

| Platform | Model |
|---|---|
| Pacvue | Quote-only; ~$500/mo min **or 3–5% of spend, whichever greater**; 6–12mo terms. Their `/pricing` page 404s. |
| Perpetua | $250 / $550 / $1,100, Enterprise **2.0–2.5% of spend**; annual, **90-day cancellation notice** |
| Helium 10 Ads | $99 / $279 **+2% above $5K spend** / custom **+2% above $10K** |
| Teikametrics | $149–179, Advanced **+3% above $10k** |
| Skai | **~$114k/yr** for under $4M annual spend |
| Quartile | **$895–$9,995/mo** tiered, or $2k–$15k base **+ 0.5–5%**; ~$3k/mo spend minimum; 12–24mo contracts with escalators |

Percentage-of-spend is the most consistently cited grievance across every review source — it punishes the customer for succeeding. Flat-fee challengers lead with exactly that.

---

## 6. Patterns worth stealing — ranked

**Tier 1**

1. **Excel as a live two-way client, not an export target.** Pacvue's Excel add-in is patent-pending (US2020/0364757) precisely because it's the moat. Every serious Amazon operator already does bid math in a spreadsheet; the tool that stops fighting that wins the workflow. **Nobody has shipped a Google Sheets equivalent** — the clearest open lane in the report. Given you read data in Excel and Numbers, this is the pattern that matters most here.
2. **A multi-valued tag dimension that budgets, rules and reports all key off** (§1).
3. **The annotated round-trip spreadsheet.** Perpetua is the reference: download at a **chosen granularity** over a **chosen date range**, with **read-only context columns (spend, sales, ACoS, IDs) sitting beside editable columns** so the file is a *decision surface*, not a data dump. On upload it appends `Result` / `Errors` / `Warnings` columns, applies valid rows, leaves invalid rows unapplied, keeps upload history. Adobe's bulk flow adds the missing half: **email a link to the error file** for correction and re-upload.
4. **Break-even ACOS and break-even bid as columns at every level**, plus a filter-scoped P&L panel (Sellerboard). ACOS is a ratio with no decision rule attached; break-even bid *is* the decision. In the grid, not in a separate profit module.
5. **Recommendation as a column with bulk accept** (Sellerboard; Intentwise's Edit-bid modes — set absolute / adjust by % / set to average CPC / set to algorithmic recommendation). Recommendations on a separate screen get ignored; recommendations in the sortable grid get applied.

**Tier 2**

6. One **dayparting schedule as a reusable named object** applied to N campaigns across SP/SB/SD. Amazon native is increase-only, SP-only, one rule per campaign — a structural gift.
7. **Day-of-week × hour-of-day heat map that is directly actionable** into a bid-multiplier schedule (Perpetua). The heat map isn't the feature; acting on the cell you're looking at is.
8. **Cross-campaign roll-ups by keyword text / brand / match type** (Intentwise). The only honest answer to "what am I actually paying for this term across the whole account", which the campaign tree structurally hides.
9. **Rule grammar with relative reference values and significance floors** (§4).
10. **Rules as bulk-editable first-class objects with explicit precedence and a reorder UI** (Helium 10). Rules reach the hundreds; without this the engine is unmaintainable by month six.
11. **Named rule archetypes instead of a blank builder.** Cobalt ships six, SellerApp seven. Archetypes get adopted; blank canvases don't. Ship them with the underlying rule visible and editable so users graduate.
12. **Rank as an objective, not just efficiency** — launch and defence are position-driven and ACOS-only engines can't express them. We already have the rank controller.
13. **Retail-state guardrails as rule conditions** — inventory level, Buy Box, price change, BSR.
14. **Campaign Takeover** — adopt existing console-created campaigns rather than demanding a rebuild. Migration friction is the #1 reason these tools lose deals.

**Tier 3 — cheap wins**

15. **Export = exactly the visible, filtered, aggregated view** (Sellerboard). Trivial, disproportionately loved, kills a whole class of "why doesn't the export match the screen" tickets.
16. **CSV *and* JSON export of any table** (Ad Badger). One line of code; instantly makes you the tool technical customers script against.
17. Scheduled reports to **Slack/Teams**, not just email; **one-click branded PPTX** (CommerceIQ). The deliverable is a weekly business review, not a CSV.
18. **Natural-language filter bar** over the grid — Amazon's own `SP, Impressions > 1000` smart search cut bid-optimisation workflow time 26% in testing. It's a filter compiler, not an agent.
19. **Long data retention as an explicit feature.** Amazon caps search-term reports at 65 days; Helium 10 markets 2-year retention against that. Real and defensible.
20. **Publish an honest scale limit rather than degrading silently.** Intentwise disables Roll Ups above 200k keywords and says so. Every competitor instead collects "slow on large accounts" reviews.

---

## 7. Gap list — what nobody does well

Ranked by leverage. Items marked ✅ we already have in some form.

| # | Gap | Us |
|---|---|---|
| 1 | **Undo / rollback of an applied change set.** Nobody has it. | ✅ `/actions/:executionId/rollback` |
| 2 | **Pre-apply diff on bulk jobs.** Universal absence. | ✗ **build** |
| 3 | **Rule dry-run against history.** Zero platforms. | ◐ `/autopilot-plans/:id/backtest`, `/rank-controller/simulate` — extend to all rules |
| 4 | **Rule conflict detection.** Not one platform documents what happens when two rules touch the same target. | ✗ **build** |
| 5 | **Select-all-across-pages with inverse selection.** Perpetua caps at 100, Ad Badger at 500. Nobody offers "all 47,000 matching except these 12" — which is the actual mental model of bulk work. | ✗ **build** |
| 6 | **Per-entity change timeline with attribution** — click a keyword, see its bid history annotated with which rule or which human moved it and why. | ◐ `AdvertisingActionLog` + `CampaignBidHistory` exist; not surfaced |
| 7 | **Profit and control in the same product.** Sellerboard has break-even bids and no control; the ad platforms have control and treat COGS as a report column. **Nobody optimises to contribution margin as the objective function.** | ◐ `true-profit-rollup.service`, `/profit/by-campaign` — make it the objective |
| 8 | **Data-vintage / restatement model.** Everyone inherits Amazon's pipeline; nobody exposes as-of, restatement delta, or Seller Central reconciliation. | ✗ **build** (§3) |
| 9 | **Scheduled/recurring imports.** Scheduled exports exist; nobody polls a Sheet, S3 drop or SFTP as a nightly source of truth for bids and budgets — despite that being how large brands actually govern spend. | ✗ **build** |
| 10 | **Google Sheets integration: zero across the market.** Only Pacvue has Excel. | ✗ open lane |
| 11 | **Grid performance at real scale.** Recurring at every price point. A virtualised, server-side-aggregated grid fast at 500k rows is demoable advantage. | ◐ `AdsDataGrid` exists; needs proving at scale |
| 12 | **Cross-campaign cannibalisation / keyword de-dup.** Only Ad Badger and Intentwise touch it. Nobody shows "you are bidding on this term in 9 places, self-competing, at these 9 bids." | ✅ `/campaigns/:id/self-competition`, `/campaigns/:id/keyword-conflicts` |
| 13 | **Amazon-native bulksheet interoperability.** Essentially everyone uses proprietary CSV. | ◐ partial exporter; **finish it** |
| 14 | **Bulk parity for placement modifiers, negatives, SB and SD.** Perpetua explicitly cannot bulk-set placement multipliers, archive targets, or negate against broad/category targets. Bulk tooling across the board is Sponsored-Products-shaped. | ✗ **build** |
| 15 | **Change-freeze / cooldown / warmup as system constraints** rather than documentation. | ✗ **build** — cheap, and it protects the autopilot |
| 16 | **Customer-facing write API on the vendor's own entity model.** Reports get exposed; creating a rule, a tag or a change-set programmatically does not. | ◐ we have the API already |

**The short version:** of the 16 things nobody in this market does well, we already have 3 outright and 6 partially. The genuinely missing ones cluster almost entirely in **bulk pre-apply diff, data vintage, scheduled imports, and bulk parity beyond Sponsored Products** — which is exactly the scope of [[32 - Amazon Ads Import-Export & Sync Spec]].

---

## Related Notes

- [[30 - Amazon Ads Platform Audit]] · [[32 - Amazon Ads Import-Export & Sync Spec]] · [[20 - Advertising]]
