# Rules & Automation — the PARKED sections register

**What this is.** The eleven RA pages are being reduced to Helium 10's shape — each rule-type tab is
one rules grid plus the builder (study + plan: `docs/2026-08-16-ra-h10-reference-study.md`). The
sections that leave a page are **not deleted**. Each one stays at its current path, unmounted, with
a `⛔ PARKED` header comment naming what it is, why it left, and where it is headed. This file is the
index of every parked section, so that "the code is saved for Suggestions / Analytics / Reporting"
is a checkable claim rather than an intention.

**Operator decision D7 (2026-08-16):** park **in place**, no file moves. Moving files would rewrite
imports across a working tree several sessions share; leaving them put costs nothing and makes a
re-mount a single import. Parked files still compile and are still covered by the pre-push build —
they are unreachable, not broken.

**Rules for anyone touching a parked file**
- Do not "clean it up" — it is inventory, not dead weight. Its endpoints stay live.
- Re-mounting one on its target page is a normal unit of work: import it, delete its PARKED header,
  strike its row here.
- If a parked section is ever genuinely retired, say so in this table (with the date and who
  decided) rather than deleting the row.

---

## U1 — Bid (2026-08-16, commit on `main`)

Route `/marketing/ads/rules-automation/bid` now renders `bid/BidRulesClient.tsx`: page header · tab
bar · `_shared/RulesGrid` (`tabKey="bid"`). Everything below was unmounted in one step.

| file | what it is | candidate home |
|---|---|---|
| `bid/BidClient.tsx` (1,103) | the whole 15-block page: filter bar + `ScopeNotes` · resolution sentence · census strip · notes · targets/campaigns grid (`?view=`) · the section seam | **Analytics** — a measurement surface |
| `bid/BidBidderBand.tsx` (57) | who owns each live campaign's bids | Analytics, or the Ad Manager campaign row |
| `bid/BidBounds.tsx` (182) | "Bounds — the band, at four grains" (min/max coverage) | Analytics; the *editable* band already lives on Apply Rules (AR.S1) |
| `bid/BidActivity.tsx` (206) | "Activity — the last 30 days of bid writes in this scope", with delivery truth | **Change Log / Analytics** — an audit surface |
| `bid/BidStagedTray.tsx` (114) | docked grace-window tray for staged writes | **Suggestions** — a staged write awaiting its window *is* a pending suggestion |
| `bid/BidTargetDrawer.tsx` (404) | per-target drawer: history, why this bid, who decided | Analytics › Targets, or the Ad Manager target row |
| `bid/BidGoalDialog.tsx` (111) | per-campaign bidder/goal dialog (`PUT /campaigns/:id/goal`) | **Apply Rules** — H10 sets Bid Algorithm + Target ACoS there (D6) |
| `bid/BidEditing.tsx` (201) | the grid's three bulk bid verbs + their preview/refusal copy | Analytics or Bulk Operations |
| `bid/BidSpark.tsx` (131) | inline bid sparkline | travels with the grid or the drawer |
| `bid/BidSections.tsx` (50) | the seam that mounted Bounds · Activity · Staged tray | travels with its three sections |
| `bid/BidRules.tsx` (24) | the interim governance table (Rule · May it act? · Where · Caps · Executions) via `_shared/TabRules` | **superseded** by `_shared/RulesGrid.tsx`. Kept only so the governance columns survive if Automations wants them |

Not parked (still live, still imported): `bid/types.ts`, `bid/bidState.ts` (+ its test),
`bid/slot-contract.ts` — types and vocabulary the parked files import.

**Prod verification, 2026-08-16** (D8: one click-through + one commit per unit). The page renders
H10's shape with no horizontal overflow (card 1602 in a 1728 main); the grid loaded **18 bid rules**
and the tab badge read 18 — badge and grid share `ruleBelongsToTab`, so they cannot disagree.
Created a real rule through `/builder/bid` → grid and badge both went **18 → 19**, proving the
builder SLUG (`bid`) is matched, not just the engine action types. Its Automation toggle wrote for
real (`actions[0].control` = `automate` on the server after the click, and it survived a redeploy).
Deleted it from the grid's bulk Delete → gone from the server (51 rules, back to baseline) and from
the UI (18 rows). Search, Open and History all work; the market picker writes `?market=`.

**Three things the click-through corrected before this unit closed** (each its own commit):
① Criteria printed "—" on 18 of 18 rows and Frequency printed a fabricated "Daily · 12:00 AM" —
the grid read only the BUILDER rule shape, while every live bid rule is an ENGINE rule (flat
`conditions`, no `schedule`, mode in `autonomyLevel`). Both cells now read what the row stores.
② `targetAcos` is stored as `0.3` on most rules and as **30** on AIREON, which rendered "3000%";
and a CTR floor of 0.002 rounded to "0%". ③ A rule created in the builder is stored
**`enabled: false`** — armed-looking but never evaluated — so the row now carries an "off" chip.

🔴 **What the "off" chip immediately surfaced:** **7 of the 18 bid rules are disabled entirely** —
Aggressive growth · Bid down on profit breach · Bid optimization (profit-native) · Cut bids on high
ACOS · New-to-brand optimizer · Rank control — Top +100% (IT) · Top-of-Search rank defender. Of the
11 that are enabled, 5 are AUTO and 6 PROPOSE. Nothing was changed about them; the grid just says so
now. **Operator decision, not this unit's:** whether any of those seven should be on.

**Endpoints that lost their only UI in U1** (all still served; nothing was retired):
`/bid-grid`, `/bid-grid/cursor`, `/bid-policies`, `/campaigns/:id/guardrails` (read), `/changes`,
`/write-refusals`, `/ad-targets/bulk-bid`, `/campaigns/:id/goal`, `/staged-writes`,
`/queued-mutations/:id/cancel`. `/automation-rules` is now read by `RulesGrid`.

---

## U2 — Placement (2026-08-17/18, commits `adaff0950` · `d5779c9c1` · `a9ad3975b`)

Route `/marketing/ads/rules-automation/placement` now renders `placement/PlacementRulesClient.tsx`:
page header · tab bar · `_shared/RulesGrid` (`tabKey="placement"`).

🔴 **This tab GAINED a rules grid rather than trading one.** PLC.0 removed the old
`RuleListTab liveType="placement"` and never replaced it, so the eight placement rules had had no
home on their own tab since — reachable only through Automations.

| file | what it is | candidate home |
|---|---|---|
| `placement/PlacementClient.tsx` (1,178) | the whole 14-block page: own scope bar · resolution + freshness · census cells (inverted · compounding · unmanaged · decorative) · lane split · "the hour" · campaign×lane grid + inline lane editor + row refusal alert | **Analytics** (lane split, census); the grid + editor with the write surfaces |
| `placement/PlacementScopeBar.tsx` (200) | the page's own scope bar — one of the seven page-local forks of the scope spine | travels with the client; `AdsFilterBar` + `buildScopeFilters` supersede it |
| `placement/PlcInspector.tsx` (208) | per-campaign inspector rail (`?row=`): three lanes, owner, change ledger | Analytics › Campaigns, or the Ad Manager campaign row |
| `placement/PlcBulkPanel.tsx` (393) | "Set across scope…" preview-then-confirm bulk multiplier write (`?bulk=1`) | **Bulk Operations** |

**Prod verification, 2026-08-18.** Grid, tab badge and server all agree at **8 placement rules**;
"+ Rule" → `/builder/placement`, each name → `?ruleId=`; all 8 toggles correctly disabled (every
placement rule is an engine rule) and **all 8 carry the "off" chip — not one placement rule is
enabled**. No horizontal overflow. The Bid tab was re-checked for regression from the shared CSS
change: unchanged at 18 rows.

**One defect the click-through caught** (`d5779c9c1` + `a9ad3975b`): four rank rules carry the whole
ASIN title in their name ("Hold top rank ≥ 60% — XAVIA MOSS Giacca Moto con Cappuccio Removibile
– …"), which rendered **1,227px wide inside a 360px cell — an 881px spill straight through the
Criteria column**. The Bid tab could never have shown it: its names are short. Fixed the way the
schedules grid already does it (the table is `table-layout: auto`, so the cap must live on the
content, not the cell), scoped to a new `h10-rg-namew` so the class shared with Budget Pacing's
schedules section is untouched. The first cap (340px, copied from that grid) then left the name
137px — Open · History hold 148px in the same flex line whether visible or not — so the cap is
480px, leaving 277px of name. Measured after: 0 collisions, 0 spill, every name titled.

**Endpoints that lost their only UI in U2** (all still served; nothing retired): `/placements`,
`/placements/cursor`, `/placements/preview`, `PATCH /placements/:id/lane` (the PLC.3 write path),
`/bid-history`, `/campaigns/:id/pins`.

---

## U3 — Share of Voice (2026-08-18, commits `f10124cce` · `ccc6cd80e`)

Route `/marketing/ads/rules-automation/share-of-voice` now renders
`share-of-voice/SovRulesClient.tsx`: page header · tab bar · `_shared/RulesGrid`
(`tabKey="share-of-voice"`), with H10's own SOV empty-state wording ("Create a rule to generate
campaign suggestions").

🔴 **The tab could not have held a rule before this.** `RULE_TAB_ACTION_TYPES` had no
`share-of-voice` entry, and `ruleBelongsToTab` returns false for any tab absent from that map — so
grid AND badge were empty **by construction**, the same defect the old `SovTrackerTab
liveType="sov"` shipped for months. The entry was added with an **empty engine list on purpose**
(SOV-driven bidding is expressed as `bid_*` actions, which are the Bid tab's — filing them here too
would double-count one rule on two tabs); the existing derivation then adds the builder slug `sov`.

| file | what it is | candidate home |
|---|---|---|
| `share-of-voice/ShareOfVoiceClient.tsx` (1,261) | the whole 14-block market-share report: one-market gate · filter bar · reach · three-feed freshness band · the rejection reckoning · override banner · summary strip · coverage note · signal chips · the query grid with saved views, share-weeks/ad-window segments, brand toggle, watchlist | **Analytics › Coverage** — it already owns SOV-flavoured columns |
| `share-of-voice/SovRowDrawer.tsx` (166) | per-query drawer (`?row=query@market`) incl. the parser-week flag | travels with the query grid |
| `share-of-voice/SovSavedViews.tsx` (148) | saved views for the query grid | travels with the query grid |
| `share-of-voice/sovExport.ts` (195) | CSV builder + filename | **Reporting** |

**⚖️ D4 decided by measurement, operator may overturn.** H10's grid carries a sixth column, "SOV
Reports", naming the SOV *report object* the rule reads (created under Reporting, max 20 per
account, the rule breaks when it is deleted). We have no such object — our share is SQP-derived per
market and a rule's market already lives in its scope — so the column would restate the scope on
every row, which is the decorative-column class this programme exists to remove. **Not rendered.**
Real SOV report objects would be a build, not a column.

**Prod verification, 2026-08-18** — the slug fix proven end to end: created a rule in `/builder/sov`
→ it appeared on the tab it was created from, grid **0 → 1** and badge **0 → 1** (impossible before
this unit); Criteria read "Share of Voice < 20 → Set €0.55" (the U1 unit fix holding); bulk Delete
removed it — server back to 51 rules with no leftovers. No horizontal overflow.

**One defect the click-through caught** (`ccc6cd80e`): after the delete the grid read "Showing 0 SOV
Rules" while the **tab badge still read 1**. The counts provider refreshes on `ads.rule.changed` and
the builder emits it on save, but this grid never did — so its own deletes and toggles went
unannounced. Badge and grid share the membership predicate; sharing a predicate is not sharing a
fetch. Now emitted after the write settles, once per logical operation (the bulk path passes
`silent` and emits once after its loop, not once per row).

**Endpoints that lost their only UI in U3** (still served): `/share-of-voice-page`,
`/share-of-voice-page/row`.

---

## U4 — Keyword Tracker (2026-08-18, commit `92818c79e`)

Route `/marketing/ads/rules-automation/keyword-tracker` now renders
`keyword-tracker/KeywordTrackerRulesClient.tsx`: page header · tab bar · `_shared/RulesGrid`
(`tabKey="keyword-tracker"`), with H10's own KT empty state ("Create a Keyword Tracker Rule to
generate campaign suggestions").

🔴 Same mandatory map entry as U3 — `RULE_TAB_ACTION_TYPES` gains `keyword-tracker`, empty engine
list (rank-driven bidding is `bid_*` / `raise_bids_for_rank_defense`, the Bid and Placement tabs';
the derivation adds the builder slug). The page also **drops its one-market gate**: that existed
because every number on the rank report is a per-marketplace quantity with no honest sum, and a
rule list has no such number.

| file | what it is | candidate home |
|---|---|---|
| `keyword-tracker/KeywordTrackerClient.tsx` (964) | the 11-block rank report: market gate · filter bar · resolution with share age + ToS impression share · the feed-health line (silent nights, green-and-dead runs, cliff date, market-volume Δ) · truncated-week banner · the term grid | **Analytics › Coverage** |
| `keyword-tracker/WatchlistPanel.tsx` (298) | the watchlist editor (create · import · edit tracked terms) | **the KT builder's Setup step** — H10 puts "+ Create New Keyword Tracker" exactly there |
| `keyword-tracker/TermDrawer.tsx` (256) | per-term drawer (`?kw=`): header · our ASINs · campaigns bidding it | travels with the term grid |
| `keyword-tracker/TermChart.tsx` (188) | the rank-history chart in the drawer | travels with the drawer |
| `keyword-tracker/BidAction.tsx` (433) | act-from-a-row: preview · propose · apply a bid change | **Suggestions** (propose) / Bulk Operations (apply) |
| `keyword-tracker/ChangeLog.tsx` (236) | per-term change log with undo | **Change Log** |
| `keyword-tracker/csv.ts` (107) | CSV for the term grid and change list | **Reporting** |

**Prod verification, 2026-08-18** — created a rule in `/builder/keyword-tracker` (86 campaigns via
Add All) → it appeared on the tab it was created from, grid and badge **0 → 1**; deleted it → server
back to **51 rules, no leftovers**, and **grid AND badge both read 0 without a page reload**, which
is the U3 badge-emit fix (`ccc6cd80e`) verified live: in U3 the same sequence left the badge at 1.

**Endpoints that lost their only UI in U4** (still served): `/keyword-tracker`,
`/keyword-tracker/term`, `/keyword-watchlists*`, `/keyword-actions/*`, `/changes.csv`.

---

## CS — one campaign selector for every builder (2026-08-18, commits `e781d4eab` + placeholder fix)

**Operator instruction:** *"use the shared component for the campaign selector that we built in the
dayparting and rank goal rule builder … I will simply make changes to one, and it will be
implemented on all the pages."*

There were **two** pickers, and the criteria builders had the worse one:

| | `_schedule/CampaignSection.tsx` | `RuleBuilder`'s private `CampaignPicker` |
|---|---|---|
| used by | schedules + rank goals | bid · budget · placement · sov · keyword-tracker |
| tabs | All Campaigns · **Portfolios** · Products | **none** |
| search | ranked (`searchOptions`) | plain substring |
| bulk | Add All + **per-portfolio Add** | Add All only |

The private copy is **DELETED** (126 lines); `RuleBuilder` renders `CampaignSection`. One file to
change from here — add a prop, never a fork. Two props absorb every difference: `defaultStatus`
(H10 opens criteria builders on **Enabled**, schedule builders on **All**) and the optional
`placements` field on the shared type, which the **Placement** rule's preview reads to show
current → proposed multipliers (dropping it would have made that preview silently read 0).

🔴 **The Products tab was a stub** — "Scope by product is coming soon" — on a control the operator
had been told does product selection. It is **real now, with no new endpoint**:
`/advertising/scope-options` already returns each product line WITH the campaigns it reaches (the
payload the eleven filter bars read). Search filters products by title/SKU (and says so — the
placeholder is tab-aware), the status filter still applies to the campaigns underneath, per-product
**Add** adds that product's campaigns, and **Add All** adds every campaign of the listed products,
deduped because one campaign can advertise several products.

**Prod verification, 2026-08-18.** Bid builder: the three tabs are there and it opens on Enabled;
Products lists 7 product lines with real sub-lines ("GALE-JACKET · 18 variations · 36 campaigns")
and one click on a product's Add added all **36** of its campaigns. Rank-goal builder re-checked for
regression: unchanged — own layout, own Portfolio-scope select, still opens on **All** — and it
gains the working Products tab, which is the point of sharing the component.

**Rank & Dayparting was not touched:** no file moved, and no import changed in
`_rank/RankGoalBuilder.tsx` or `_schedule/ScheduleBuilder.tsx`. The component stayed at its current
path deliberately — relocating it to `_shared/` would have meant editing the RD builder for no
functional gain. Say the word if you'd rather it lived in `_shared/`.

---

## U5 — Negative Targeting (2026-08-18, commits `5b22443a1` · `63a262fde`)

Route `/marketing/ads/rules-automation/negative-targeting` now renders
`negative-targeting/NegativeRulesClient.tsx`: page header · tab bar · `_shared/RulesGrid`
(`tabKey="negative-targeting"`). The tab also **gains a "+ Rule" button**, which it never had — its
own rules table only offered "Open in the builder" on rules that already existed.

No map entry needed (unlike U3/U4): `negative-targeting` already maps `add_negative_exact`,
`add_negative_phrase`, `harvest_and_negate` and `sync_negatives_across_campaigns`.

| file | what it is | candidate home |
|---|---|---|
| `negative-targeting/NegativeTargetingClient.tsx` (645) | the 16-block page: filter bar + portfolio blind-spot note · resolution · census (negatives · terms · blocking now · in a paused campaign · never confirmed at Amazon) · raw-match-type note · the negations/terms grid | **Analytics** |
| `negative-targeting/NegTermDrawer.tsx` (357) | per-term drawer (`?focus=`) | travels with the grid |
| `negative-targeting/NegRemoval.tsx` (376) | "Stop blocking this term" + the retirement path | **Suggestions** / Bulk Operations |
| `negative-targeting/NegAttention.tsx` (411) | contradictions, alerts, negations needing review | **Suggestions** — every row is a proposal |
| `negative-targeting/NegProtectedTerms.tsx` (621) | the protected-terms **editor** | **Control Room › Guardrails** — `ProtectedTermsPanel.tsx` already renders this list there |
| `negative-targeting/NegWastefulWords.tsx` (500) | the wasteful-words n-gram finder + negate-gram | **Suggestions** |
| `negative-targeting/NegRules.tsx` (422) | this page's own rules table | **superseded** by `_shared/RulesGrid` |
| `negative-targeting/NegRecord.tsx` (370) | every negation made, with actor and outcome | **Change Log / Analytics** |

⚠ **No protection was removed.** The whitelist, the converting-term guard and the write gate are
server-side and still armed; `NegProtectedTerms` was the *editor* for that list, and the same panel
already lives on Control Room › Guardrails. Every negatives endpoint is still served.

**Prod verification, 2026-08-18.** 7 rules; grid = badge = server. Criteria and Frequency read
correctly on every row.

**Two honesty defects the click-through caught** (`63a262fde`), both about telling the truth *per
tab*:
① **A multi-action rule was summarised by `actions[0]` regardless of why it is listed.** Membership
is "ANY action belongs to this tab", so "Daily automation digest" (`bid_to_target_acos`,
`harvest_and_negate`, `alert_operator`) lists on Negative Targeting because of its SECOND action —
and the Criteria cell explained a **bid change on the negatives tab**. "Auto match-type migration"
likewise explained `promote_to_exact` there. The cell now summarises the action that matched the
tab, verified live: the digest reads **"harvest and negate" on Negative Targeting and "bid to
target ACoS" on Bid** — correct, because it does both.
② **Three of the twelve triggers were unmapped**, so `SEARCH_TERM_CONVERTING` rendered as a bare
lower-case "search term converting" beside neighbours reading "On wasted spend". All twelve are
mapped now ("On a converting term"), and an unmapped one falls back to "On <trigger>".

**Endpoints that lost their only UI in U5** (still served): `/negatives*`, `/keyword-protections*`,
`/negatives/wasteful-words`, `/negatives/negate-gram`, `/negatives/retire`, `/negatives/record`.

---

## U6 — Budget Rules (2026-08-18, commit `990e47ecf`)

Route `/marketing/ads/rules-automation/budget` now renders `budget/BudgetRulesClient.tsx`: page
header · tab bar · `_shared/RulesGrid` (`tabKey="budget"`). No map entry needed —
`adjust_ad_budget` was already mapped. The tab keeps the label "Budget Rules" until **U10** applies
D1's rename to "Budget" (the label lives in `RULES_TABS`; that is U10's one-array edit).

| file | what it is | candidate home |
|---|---|---|
| `budget/BudgetClient.tsx` (1,051) | the 14-block page: filter bar + `ScopeNotes` · resolution + newest budget change · census · the €1-floor ratchet warning · truncation/write-status notes · the campaigns/rules grid (`?view=`) with "Restore N to baseline" and "Transfer…" · transfer dialog · footer | **Budget Manager** (levels + pacing); census → Analytics |
| `budget/BudGuardrails.tsx` (155) | "Guardrails & the baseline" — per-campaign min/max bounds and the captured baselines Restore reads | **Control Room › Guardrails** |
| `budget/BudgetSections.tsx` (37) | the seam that mounted the guardrails card | travels with it |

⚠ **The €1-floor ratchet warning left with the census — and is NOT silenced.** The same condition
is stated on Budget Pacing & Schedules and on Control Room › Activity (checked before parking), and
the compounding rules now appear on THIS grid with their Automation toggle reading `auto`, which is
the more actionable framing. The budget write gate is server-side and untouched.

**Prod verification, 2026-08-18.** 6 rules; grid = badge = server. Criteria read correctly
("ACoS ≥ 40%, campaign spend ≥ €50 → adjust budget"; "ROAS ≥ 5, budget used ≥ 90% → adjust budget").

🔴 **Two facts the grid surfaced at a glance, both operator business, not this unit's:**
- **The two compounding budget rules are visible as AUTO, account-wide, and live**: "Campaign ACOS
  rebalance (cut + scale)" (1,301 executions, cap 6/day, **last ran 2026-08-18 01:00**) and "Trim
  budget on weak ACOS" (1,318 executions, cap 8/day, last ran 08-09). This is the ratchet the memory
  has flagged repeatedly — now legible from the tab that owns it.
- **A duplicate rule name**: "Trim budget on weak ACOS" exists **twice** — one AUTO/enabled with
  1,318 executions, one disabled. Two rules with one name, one of them armed, is a hazard when
  reading a change log. Nothing was changed about either.

**Endpoints that lost their only UI in U6** (still served): `/budget-grid`, `/budget-grid/cursor`,
`/budget-baselines/restore`, `/budget-baselines/capture`, `/budget-transfer`,
`/campaigns/:id/guardrails` (write).

---

## U7 — Keyword Harvest (2026-08-18, commits `0156e8eca` · `9f12c41db` · `e21d43fb3`)

Route `/marketing/ads/rules-automation/keyword-harvest` now renders
`keyword-harvest/KeywordHarvestRulesClient.tsx`: page header · tab bar · the pill
**[ Rules View | Ad Group View ]** · one card. Those are the three things the operator named for
this page — Rules, Ad Group View, and the builder behind "+ Rule". The pill writes `?view=ad-groups`
(H10's does not change the URL; ours does, because every other view state in this section is
linkable).

### The Ad Group View — new UI (`HvAdGroupView.tsx`, D3)
Columns: **Ad Group · Type · Campaign · Reads terms · Harvest Rule · Creates · Negates**, with
Campaign / Harvest Rule / Reads-terms filters and search. Built off the mapping the harvest builder
already stores (`actions[0].mappings`) — no new endpoint.

Two deliberate departures from H10's bundle column list, because inventing a column is worse than
omitting one:
- **"Of Target" is not reproduced** — its semantics were never recoverable (the recording never
  loaded this grid; the bundle gives only the label).
- **"Keyword BPE" renders P/E/ASIN, not B/P/E** — our builder's positive match types cannot create
  a Broad target, so a B badge would describe a capability we do not have.

| file | what it is | candidate home |
|---|---|---|
| `keyword-harvest/KeywordHarvestClient.tsx` (875) | the 18-block page: multi-market header · filter bar · [Candidates \| Harvested] segment · live criteria bar · census lede + strip · candidates grid + promote queue | **Suggestions** (a candidate IS a suggestion); census → Analytics |
| `keyword-harvest/HvThresholds.tsx` (259) | the five harvest criteria as live controls over the stored policy | **the rule builder** — criteria belong in the rule, which is H10's shape |
| `keyword-harvest/HvCohort.tsx` (329) | the harvested cohort — "did the last batch work" | **Analytics** |
| `keyword-harvest/HvDestination.tsx` (259) | "Where these would go" | travels with the candidates grid |
| `keyword-harvest/HvPromote.tsx` (277) | the promote dialog — preview then write | **Suggestions** |
| `keyword-harvest/HvActors.tsx` (403) | the governance panel behind harvesting | **Automations › Engines** |
| `keyword-harvest/HvQueue.tsx` (103) | "Pending — the harvest slice of the one inbox" | **Suggestions** |
| `keyword-harvest/HvRepairs.tsx` (34) | the repairs marker (renders null by design) | delete when its subject resolves |

**Prod verification, 2026-08-18.** Rules View: 5 rules, and the badge finally agrees with the grid —
this is the tab whose badge said 5 over a grid of 0 for months. Ad Group View: with only the five
engine rules it renders the honest empty state naming the reason; then a real rule was built with
two mapped ad groups and **the rows appeared immediately** with the rule linking back to the builder.
Test rule deleted (51 rules, no leftovers).

**Two defects the click-through caught:**
① (`9f12c41db`) The empty-state sentence rendered as one **1,311px line inside its own 420px box**
and ran off the card: `.h10-am-grid td` sets `white-space: nowrap` — right for a data cell, wrong
for a paragraph — and the empty state renders inside a `td`. Scoped wrap added; real cells keep
their nowrap.
② (`e21d43fb3`) 🔴 **An ad group can be BOTH source and destination.** The builder's mapping row
carries `look` and `types` independently — its own table shows them as two columns. The first cut
collapsed them into one Source/Destination role and suppressed `creates` whenever `look` was set:
on the test rule (both groups read-from AND creating Phrase + Exact) it showed Role "Source" and
Creates "—", **hiding targets the rule really creates**. Now mirrors the builder: "Reads terms" is
its own column and Creates always tells the truth — verified live reading `Yes` + `P E`.

**Endpoints that lost their only UI in U7** (still served): `/keyword-harvest`,
`/keyword-harvest/cursor`, `/harvest-cohort`, `/harvest-destination`, `/harvest-promote`,
`/harvest-policy`, `/suggestions`.

---

## U8 — Budget Pacing & Schedules (2026-08-18, commit `503854cbe`)

Route `/marketing/ads/rules-automation/budget-schedules` now renders
`budget-schedules/BudgetSchedulesTabClient.tsx`: page header · tab bar · the two parts H10 has —
the **Hourly Campaign Performance** card over the **schedules grid** — and nothing else.

### 🔴 The hourly card was a CONSTANT, and the data was there all along
`SchedulesSection` rendered *"Hourly data is not available for this marketplace."* unconditionally,
never called an endpoint, and its two metric pickers changed nothing — the stale-constant class the
RA notes have carried since this tab was built. Measured on prod 2026-08-18:
`GET /advertising/budget-schedules/hourly-performance` answers **200 with `hasData: true`** and 24
hourly buckets (spend · sales · orders · clicks · impressions · acos, Europe/Rome). H10's own
account genuinely has no hourly data and shows that sentence honestly; **ours has it, so the
sentence was false.**

`HourlyPerformanceCard.tsx` draws Metric 1 as bars and Metric 2 as a line (inline SVG — 24 points
does not justify a chart dependency), names any picked metric the endpoint does not return instead
of plotting zero for it, and still shows the original sentence when `hasData` is false. Verified on
prod: switching Metric 1 Spend → Orders repainted the chart (footer "Orders 6 peak · ACoS 377%
peak"; per-bar tooltip "12AM · Orders 1 · ACoS 377%"). The shape is immediately useful — spend low
overnight, climbing from 09:00, and **ACoS at 377% in the midnight hour**.

⚠ **This tab is not a rules grid**, so it does not mount `_shared/RulesGrid` and has no count badge:
a budget schedule is a `BudgetSchedule` row, not an `AutomationRule`, and a rule count here would be
counting the wrong objects. That is why `RULE_TAB_ACTION_TYPES` still has **no** `budget-schedules`
entry — unlike U3/U4, whose tabs really do list rules.

✅ **D5 answered by the code, not by a build.** The schedule builder already offers both of H10's
types — "Campaign Budget" (hourly) and "Budget Multiplier" (daily) — in
`_schedule/scheduleConfig.ts`. **Auto-Refill** is the one piece of H10's budget-schedule feature we
do not have; it is builder/executor work, not a column, so H10's "Auto Refill" column is not
rendered (a column that could only ever print "—" is the decorative class this programme removes).

| file | what it is | candidate home |
|---|---|---|
| `budget-schedules/BudgetSchedulesClient.tsx` (444) | the page shell: filter bar + weeks window · pinned pacing band · six collapsible cards (Binding now · Hour of day · Schedules · Events · Ceilings & precedence · Change log — four never built) | **Budget Manager** |
| `budget-schedules/PacingBand.tsx` (199) | month cap · MTD spend · pace · month stepper | **Budget Manager** |
| `budget-schedules/BindingSection.tsx` (261) | "Binding now" — campaigns at/over the budget in force | Budget Manager / Analytics |
| `budget-schedules/CampaignBindingRail.tsx` (177) · `InspectorRail.tsx` (93) | the rail and its binding body | travel with their sections |
| `budget-schedules/PlanEditor.tsx` (316) · `CalendarEditor.tsx` (121) · `EnforcementPreview.tsx` (148) | the month-plan editor, its calendar and its preview | **Budget Manager** |
| `budget-schedules/CampaignLimitsModal.tsx` (185) | per-campaign min/max limits | **Control Room › Guardrails** |
| `budget-schedules/SectionShell.tsx` (174) · `planMath.ts` · `usePlanWrites.ts` · `scopeReach.ts` · `urlState.ts` | the section shell and the page's own helpers | travel with the shell |

**Kept and improved, not parked:** `SchedulesSection.tsx` — it already rendered H10's grid
(Budget Schedule Name · Type · Days · Start · End · Exclude Start · Exclude End, with delete and
"+ Schedule"); U8 replaced its fake chart with the real card. 0 schedules exist, so it shows
"No budget schedules yet".

**Endpoints that lost their only UI in U8** (still served): `/budget-manager*`, `/budget-binding`,
`/budget-manager/plans*`, `/budget-manager/campaign-limit`.

---

## U9 — Apply Rules (2026-08-18, commit `88e805543`) — additive, nothing parked

This page was already the closest to H10, so U9 **parks nothing**: it adds the selection toolbar
H10 has. `apply-rules/ArBulkVerbs.tsx` renders **[Automation] [Target ACoS] [Min/Max Bid]** on the
CAMPAIGN grain (the verbs write campaign fields; an aggregate row is not a campaign).

### D6, answered by the operator 2026-08-18 — with the measurements that framed it
- **Grains stay** (all four). H10 has campaigns only; this page keeps Portfolios / Product lines /
  Markets as a **documented departure** from H10, because "all four grains equally easy" is the
  operator's own standing law and H10 parity would cost a capability H10 does not have.
- **No Bid Rule / Budget Rule columns.** Measured: **0 of 51 rules are campaign- or
  portfolio-scoped** (43 account-wide, 8 market), so either column would print the same value on all
  220 rows. The existing **Automations** column already carries the truthful version
  (Managed / Off-limits + bound count).
- **No "+ Assign Rule."** `scopeCampaignId` is **single-valued**: assigning a rule to a second
  campaign MOVES it off the first, and with 0 rules campaign-bound today the first use would
  silently unbind whatever it touched next. It waits for additive `scope*Ids` columns.

### The three verbs, each on an endpoint another surface already proves
| verb | endpoint | note |
|---|---|---|
| Automation | `PATCH /campaigns/:id/live-writes { enabled }` | the **write gate** — what this page's Automations column shows. Deliberately NOT `bidAutomation`, which is the Ad Manager's bid-algorithm switch; setting that from a column showing the gate would be a lie. |
| Target ACoS | `PATCH /campaigns/:id/automation { targetAcos }` | 🔴 a **FRACTION**. `CampaignsGrid` and the Details tab both divide by 100, and `PUT /goal` refuses the whole-number form (the AIREON 30-vs-0.3 trap). |
| Min/Max Bid | `PATCH /campaigns/:id/guardrails { minBidCents, maxBidCents }` | AR.S1's route. **Only what was typed is sent** — a blank bound is left alone, never sent as `null`, which would clear it on every selected campaign. |

Each verb reports per-campaign outcomes and names refusals (a refusal at the gate is the gate
working, not a failure), and emits `ads.guardrail.changed` once after the loop, never per row.

**Prod verification, 2026-08-18.** Checkboxes on 100 campaign rows; selecting one shows "Selected 1
Campaign" with the three verbs, exactly H10's toolbar, and the four grains still present.
End-to-end write tested on `DE_Auto_Close`: Target ACoS 35% → server stored `targetAcosPct: 35`
(confirming the fraction convention round-trips), then **restored to `null`**, verified with 0
campaigns account-wide carrying a target ACoS — the exact prior state.

---

## U10 — the tab bar (2026-08-18, commit `2f7beee87`) — nothing parked

**D1 built.** Order is now H10's, frame-verified: Apply Rules · Bid · Keyword Harvest · Negative
Targeting · Budget · Dayparting Schedules · Budget Schedules · Placement · Share of Voice · Keyword
Tracker, with `automations` keeping 2nd place (D2).

Labels: `budget` "Budget Rules" → **"Budget"**; `budget-schedules` "Budget Pacing & Schedules" →
**"Budget Schedules"**. `dayparting` **keeps "Rank & Dayparting Schedules"** — the operator's
explicit exception, since 100% of the live rows are rank-goal schedules. Both relabelled tabs keep
their `key` and route, so no URL, deep link or `RULE_TAB_ACTION_TYPES` entry moved.

🔴 **The four-cluster `group` field, its render and `.h10-rt-sep` are deleted.** The hairline keyed
off `group` changing, which only reads as grouping while the array is sorted BY group; under H10's
order the clusters interleave and it would have painted **eight stray dividers**. H10's own bar has
none.

**Prod verification, 2026-08-18.** The bar reads in H10's order with both relabels and RD's name
intact; **0 separators**; no page overflow. All eleven routes return 200.

---

## U11 — H10's five rule columns on Apply Rules (2026-08-19, commits `f6d2c2e7b` · `6c2409dd3`) — additive, nothing parked

Operator, 2026-08-19: *"On the Apply Rules page, I'm seeing on h10: Bid Rule · Target ACoS ·
Min/Max Bid · Bid Automation · Budget Rule. A lot of it is actually missing here, and we must build
them as well. And if I'm not wrong, we also built them on the Ads Manager page. To make sure it is
exactly the same and there are no inconsistencies in the design and the UI, we can simply use
shared components."*

So: **one** definition — `ads/_shared/RuleColumnCells.tsx` — imported by both grids. Each cell takes
PRIMITIVES rather than a row, because the two grids carry different row types (`Camp` vs
`CampaignRow`); passing values means neither has to adopt the other's shape.

### What each column may HONESTLY show — measured on prod 2026-08-19, BEFORE building

| Column | Source | What prod actually holds |
|---|---|---|
| Bid Rule | `/advertising/bid-grid?view=campaigns` → `bidder` / `bidderName` | **schedule 32 · none 45 · manual 6**; names like "Rank plan — GALE EXACT DE" |
| Target ACoS | guardrail grid `targetAcosPct` (AR) / campaigns `targetAcos` (AM) | set on **0 of 220** — "—" is the honest reading of *nobody has set one* |
| Min/Max Bid | `minBidCents` / `maxBidCents` | set on **82 of 220** |
| Bid Automation | `bidAutomation` | **false on all 220** — real field, uniform value |
| Budget Rule | `/advertising/budget-grid` → `reachedByRuleIds`, `lastMovedByKind` | reach is **6 on every campaign** (all six budget rules are account-wide); `lastMovedByKind === 'rule'` on **1 of 86** |

Two consequences of those measurements, both of which shaped the cells:

- 🔴 **`/advertising/campaigns` returns no `bidAlgorithm`**, so the Ad Manager's own Bid Rule cell
  falls through to its default and prints **"Target ACOS" on 100 of 100 rows** (verified in the
  deployed DOM). Apply Rules' Bid Rule therefore reads the **bid owner** from the bid grid instead —
  the same question answered with a field that exists. Its own picker STAYS — see the ⛔ note below.
- **Budget Rule leads with what varies.** A column printing "6" on all 220 would be decorative — the
  class this whole programme removes — so the cell shows whether a rule has actually *moved* this
  budget, and carries the reach as context ("— 6 can").

### 🔴 One fabricated reading on the Ad Manager, fixed in passing

`targetAcos` rendered as `(c.targetAcos ?? 0.3) * 100` → a confident **"30.00%" on every row**, a
fallback wearing a setting's clothes. Now "—". *Verified: `30.00%` occurs **0** times in the
deployed DOM.*

⚠ **Correction, same day.** The first version of this section also claimed the Ad Manager's
`minMaxBid` "read a key the payload does not contain and printed None on all 220". **That was
wrong, and it was mine.** The Ad Manager *derived* `minMaxBid` client-side from
`minBidCents`/`maxBidCents` at fetch time (ADX G2), so its cell and its editor were both showing
real bands. The dead-key defect was in **Apply Rules'** old grid — `apps/web/.../apply-rules/types.ts`
documents it there, correctly. Swapping the Ad Manager's Min/Max cell onto the shared component was
therefore like-for-like, not a bug fix. It still reads **82 real bands vs 18 None** in the first 100
rows, as it did before.

### U11b — the two stragglers, and H10's order (`6c2409dd3`)

U11 shipped the three *missing* columns through the shared set but left Apply Rules' two
*pre-existing* ones rendering locally. Measured: for the same campaign and the same field, Apply
Rules said **"not set"** where the Ad Manager said **"None"** — precisely the drift the shared set
exists to prevent. Both are now shared:

- **Min · Max bid** → `<MinMaxBidCell>`. Only the READING is shared; the pencil stays this page's,
  because the Ad Manager opens its own editor. The dead `.h10-ar-bounds b` rule went with it.
- **Target ACoS** → `<TargetAcosCell>`. 🔴 The guardrail grid returns a **PERCENTAGE**
  (`targetAcosPct`); the cell takes the **FRACTION** the campaigns payload stores. Converted at the
  call site rather than leaning on the cell's *"> 1 means already a percentage"* guard — that guard
  exists for the one prod rule storing `30` where the rest store `0.3`, and a real 0.5% target would
  trip it into 50%.
- **Reordered into H10's block**: Bid Rule · Target ACoS · Min/Max Bid · Bid Automation · Budget
  Rule. This grid passes no `storageKey`, so column order is pure array order and nothing persisted
  needed migrating. The page's own governance columns (Automations = the write gate, Bidding
  strategy) now follow the block — and the gate is deliberately **not** adjacent to Bid Automation,
  because the two look alike and mean different things.

### The trap this unit nearly walked into

The three new cells close over `bidOwners` / `budgetOwners`, which arrive from **separate fetches
after the first render**. Omitting them from the `useMemo` deps would have kept the empty maps the
memo was built with and printed "—" forever — the data layer loading and the render layer never
noticing. Both are in the deps array, with a comment saying why.

**Prod verification, 2026-08-19.** Apply Rules: Bid Rule varies (**76 None · 6 manual · named plans
on the rest**, incl. "Rank plan — GALE EXACT DE" and "Campaign ACOS rebalance"), Bid Automation 0 of
100 on, Budget Rule "— 6 can" on 85 rows. Ad Manager: Target ACoS "—" ×100, Min/Max 82 bands vs 18
None, no horizontal page overflow. Nothing parked — every column is additive.

### ⛔ DECIDED 2026-08-19 — the Ad Manager's Bid Rule picker STAYS. Do not remove it.

The Ad Manager's own **"Bid Rule"** column is the head of its Adtomic cluster and is a
**bid-algorithm picker** (Target ACOS / Max Impressions / Max Orders), documented in the source as
*UI-only until Amazon exposes a per-campaign bid-algorithm field*; its editor writes local state and
toasts "(local — Amazon field pending)". It is a **different control** that happens to share H10's
label, not a drifted copy of Apply Rules' column.

I had recorded it as an open question — rename it, or retire it. **The operator answered: neither.**

> *"I plan on building whatever is missing. Like the algorithm picker, I'll work on them later, so
> we must not make any changes or remove it from the view."*

So it is not debt and it is not a decorative column to sweep. It is a **placeholder for planned
work**, and the UI is the roadmap. The constant it prints is a real hazard *only* if someone
mistakes it for a reading, which the toast already prevents. Marked ⛔ KEEP in the source at both
ends (`CampaignsGrid.tsx` and `_shared/RuleColumnCells.tsx`) so a later reduction pass does not
"helpfully" delete it — the whole U0–U11 programme was about removing exactly this shape, which
makes it the one thing most likely to be removed by accident.

**The general rule this sets**, recorded in memory as `feedback_keep_placeholder_controls`: a
control that is UI-only *because the operator intends to back it later* is preserved. That is
different from a dead workaround, which [[feedback_workaround_sweep]] says to remove. When the two
look alike, ask — do not sweep.

---

## U11c — the same EDITORS, not just the same readings (2026-08-19, commits `e52275afd` · `5b052e99d`)

Operator, 2026-08-19: *"I said to make use of the same UI, like, for example, the modal that appears
when I click on the edit of the Min/Max/Bid column. It should be the same as on the Ad Manager, and
the same with others."*

U11 shared the **reading**. The **editing** was still forked, on the same field and the same
endpoint:

| | Ad Manager | Apply Rules (before) |
|---|---|---|
| shape | anchored **popover** under the cell | full-screen **modal** |
| title | "Min/Max Bid" | "Bid band — «campaign»" |
| control | radio None / Set a Min/Max Bid Range + two € inputs | "Floor (€)" / "Ceiling (€)" number fields |
| verb | **Apply** | **Save band** |
| pencil | `.h10-editpen`, revealed on row hover | `.h10-ar-edit`, always visible, blue chip on hover |
| endpoint | `PATCH /campaigns/:id/guardrails` | `PATCH /campaigns/:id/guardrails` — **already the same** |
| Target ACoS editor | anchored popover → `PATCH /automation` | **none at all** |

`RangePopover` and `ValuePopover` moved out of `CampaignsGrid.tsx` into
`ads/_shared/RuleColumnEditors.tsx`; `ArBoundsDialog` was **deleted**, and its `.h10-ar-bounds` /
`.h10-ar-edit` rules with it. Apply Rules gained the Target ACoS pencil it never had. **No CSS was
written for the move** — every class the popovers use (`h10-mmbid`, `h10-editpop`, `h10-bulk-inp`,
`h10-menu-back`, `h10-am-link`, `h10-am-btn`) was verified present in the *deployed* stylesheets
from the Apply Rules page before a line changed, because `marketing/ads/layout.tsx` loads `ads.css`
for the whole sub-tree. Both grids render `.h10-am-grid`, so the Ad Manager's hover-pencil selector
already matched Apply Rules too.

### What the move fixed

- 🔴 **Target ACoS opened pre-filled at 30.00.** `initial={((c.targetAcos ?? 0.3) * 100)}` — on a
  field set on **0 of 220**, that is every campaign. Open the pencil, press Apply without typing,
  and you have written a 30% target nobody chose. This is the editor half of the fabricated 30%
  removed from the display cell earlier the same day. `initial` is now `''` when unset and the
  fallback lives in the placeholder, where a fallback belongs.
- **Validation is now shared, which is a change for the Ad Manager.** Apply Rules' modal refused a
  bound below **€0.02** (the suppression floor — a €0.00 floor is not a floor) and refused
  floor > ceiling. The Ad Manager's popover validated nothing at all. The rule lives in the popover
  now, so both pages enforce it.
- **One unit for one field.** `RangePopover` takes CENTS, the unit `/guardrails` itself takes. The
  Ad Manager's client-derived euro pair (`Camp.minMaxBid`) existed only to feed this popover and its
  cell; both read the cents directly now, so the derived field is gone.
- 🔴 **Every mount takes a `key`.** Both popovers seed `useState` from props, so React reusing one
  instance across two rows would show the first row's values while writing to the second. Today the
  full-screen backdrop makes that unreachable by hand — exactly the kind of accident that stops
  being true later.

### U11c.1 — the popover was opening off the bottom of the screen (`5b052e99d`)

Verified straight after U11c deployed: opening the Min/Max Bid editor on a row in the lower half of
the page put the card's bottom at **~1055 in a 962px viewport**. `useClampedAnchor` renders at the
anchor, then measures and corrects — clamp x into the viewport, flip above the cell when there is no
room below. Measured rather than derived from the CSS width, because the card's height depends on
which radio is selected and whether a note or an error is showing. The deployed page now reports
`flippedUp: true` on the row that used to overflow. Anchoring is not placement.

⚠ **Correction to that commit's own message.** It also claimed a HORIZONTAL clip — *"x=1440 in a
1459px viewport, 233px of a 252px card cut off"*. **Wrong, and mine.** 1459 was the width of a
*screenshot*, which the capture scales down; the real viewport was **1728** (`devicePixelRatio` 2)
and the card ended at 1692, comfortably inside. The x clamp is therefore **defensive** — the column
does sit at the far right of both grids, so a narrower window would clip it — not a fix for anything
that was measured. Read viewport geometry from `document.documentElement.clientWidth`, never from a
screenshot's pixel dimensions. Recorded in memory under *browser probes lie*.

### Scope: what is NOT a fork, checked rather than assumed

- **Control Room › Guardrails** (`GuardrailGrid.tsx`) writes the same endpoint but through **inline
  editable boxes in the grid**, a bulk governance interaction, not a pencil-and-popover. Left alone.
- `bid/BidBounds.tsx`, `budget/BudGuardrails.tsx`, `bid/BidGoalDialog.tsx` are **PARKED** — not
  mounted, nothing rendering, no inconsistency visible.
- The Ad Manager's **Bid Rule** popover is its bid-*algorithm* picker (still local-only).
  Unchanged, and ⛔ **kept on purpose** — see the decision under U11.

---

## U11d — campaign name, status and bidding strategy, shared (2026-08-19, commits `a70eddfcb` · `6ba2dab90`)

Operator, 2026-08-19: *"I want it to be the same, exactly the same. I want you to use shared
components, not make copies of it, and make some slight differences in it. I want to maintain
proper consistencies across all the design systems and each and everything."*

U11 shared the readings, U11c shared the two rule editors. What was left had drifted in
**behaviour**, not just styling — the Ad Manager could change a campaign's status and bidding
strategy from the grid and Apply Rules could only read them.

`ads/_shared/CampaignRowCells.tsx` now owns all three, plus the label maps behind them:

| | Apply Rules before | Now (both pages) |
|---|---|---|
| Campaign name | dark `.h10-ar-nm`, plain "Open" text link, same tab | pacing bulb · A/M + SP hover cards · name in link blue · market chip · **Open** pill revealed on row hover, **new tab** |
| Status | read-only pill | pill + chevron → **Archive / Pause / Enable**, gated campaign PATCH |
| Bidding strategy | read-only text | label + hover pencil → the same three-strategy modal |

### 🔴 Why the editors still felt un-shared, and the rule that came out of it

U11c gave `RangePopover` / `ValuePopover` a **`note` prop** — and the two pages promptly passed
different sentences, which is exactly what the operator noticed. *A prop that lets one caller
reword the dialog is a fork with extra steps.* Both popovers now take a `kind` that selects title,
radio label, placeholder, floor **and** description together. There is no copy prop left to
diverge, and no `variant` prop either.

**Verified byte-for-byte on prod**, opening every dialog on both pages and diffing the rendered
text: Min/Max Bid, Target ACoS, Campaign Bidding Strategy and the status menu are **identical
strings** — same title, sub-title, radio labels, description and button verbs.

### The old reasoning that was half-right

Apply Rules' first column carried a source comment arguing that *"a blue name that does nothing
when clicked is a promise the page cannot keep"*, and opted out of the shared blue. Right about the
colour, wrong about the fix: the Ad Manager's name is **also** not a link — the promise is kept by
the **Open** pill beside it, which is the control H10 puts there. Diverging one grid to solve it
made the two pages behave differently on the row an operator looks at first.

### Found while sharing

`apply-rules/types.ts` said **"Up & down"** where the Ad Manager said **"Up and Down"** — the same
Amazon value, spelled two ways, on two pages read side by side. One map now (`STRAT_LABEL`).

### No CSS shipped

`AdsDataGrid` renders `<td className="nm fz">` inside `.h10-am-grid` — the Ad Manager's own table
markup — so `ads.css` already styled every one of these on both pages. Apply Rules had been
*fighting* that with `.h10-ar-nm` / `.h10-ar-open`; adopting the markup makes the fight
unnecessary rather than winning it. `.h10-ar-open` and the `.h10-ar-pill.st-*` variants are
deleted. Only `.h10-modal-err` is new — Apply Rules has no toast host, and a dialog that closes on
a refusal reads as a success.

### U11d.1 — and the regression the refactor caused (`6ba2dab90`)

Passing the Ad Manager's **Assign** link through the shared cell's `extra` slot rendered it BEFORE
the **Open** pill; it had always been Open first. Caught by reading the deployed link order on the
Ad Manager — *the page a component is extracted FROM must not change*, and that is worth checking
explicitly every time, because nothing else will catch it.

---

## The programme is complete

Eleven units, U0–U10, every one prod-verified before the next began, plus **U11** — additive
columns on Apply Rules rather than a reduction. **55 files parked, none deleted**, and Rank &
Dayparting was never touched.

**⛔ Kept on purpose, not open:** the Ad Manager's Bid Rule / bid-algorithm picker. The operator is
building the backing field later and asked that nothing be changed or removed from the view.

**Still open, deliberately:**
- **"+ Assign Rule"** (U9/D6) — waits for additive `scope*Ids` columns; single-valued scope would
  move a rule off its previous campaign.
- **Auto-Refill** (U8/D5) — the one piece of H10's budget-schedule feature we lack; builder/executor
  work, not a column.
- **D9** — SOV/KT builder Setup parity (H10 picks ASINs / Report·ASIN·Keyword; ours picks campaigns).
- **Operator business, surfaced by the new grids, changed by nobody:** 7 of 18 bid rules disabled ·
  all 8 placement rules disabled · 3 of 7 negative rules disabled · the two compounding budget rules
  live and AUTO · a **duplicate rule name** ("Trim budget on weak ACOS" twice, one armed) · ACoS at
  **377%** in the midnight hour.

## Where the parked code goes next
Suggestions · Analytics › Coverage · Reporting · Budget Manager · Control Room › Guardrails ·
Automations › Engines · Change Log. Each row above names its destination; re-mounting one is a
single import.
U8 Budget Schedules · U9 Apply Rules · U10 tab bar · U11 the five rule columns
(additive — nothing parked). Each unit appends its own table here.

---

## SG.6 (2026-08-21) — Automations › Queue

| Parked | Path | Why it left | Where the work went |
|---|---|---|---|
| `QueueView` (`?view=queue`) | `rules-automation/automations/QueueView.tsx` | **One inbox.** It rendered the same `/advertising/suggestions` endpoint as the Suggestions page with a third mental model: no per-family columns, no delivery truth (an apply returns at ENQUEUE — the write gate settles it minutes later, where this view never looked), no undo handle, no lifecycle. A decision made here could not be explained on any other surface. | `/marketing/ads/suggestions` — the rebuilt review queue (SG.0–SG.7). The Queue segment KEEPS its count and links out; only the deciding moved. |

The segment itself is deliberately **not** removed: "how much is waiting" belongs on the section's
front page, and the operator's standing rule is that ⛔ KEEP surfaces are a roadmap, not clutter.
Re-mounting `QueueView` is one import — but read the SG record first
(`docs/2026-08-21-sg-suggestions-rebuild.md`): every per-row verb it offers, the Suggestions page
now offers with the write's actual fate attached.
