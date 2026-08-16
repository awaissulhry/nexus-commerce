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

## Still to come
U2 Placement · U3 Share of Voice · U4 Keyword Tracker · U5 Negative Targeting · U6 Budget Rules ·
U7 Keyword Harvest · U8 Budget Schedules · U9 Apply Rules · U10 tab bar. Each unit appends its own
table here.
