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

## Still to come
U5 Negative Targeting · U6 Budget Rules ·
U7 Keyword Harvest · U8 Budget Schedules · U9 Apply Rules · U10 tab bar. Each unit appends its own
table here.
