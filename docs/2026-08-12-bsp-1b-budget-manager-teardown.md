# BSP.1b — retiring the Budget Manager overlap

*Written by BSP.1 as a plan, not executed. The standing rule is **retire only once the replacement
is live and verified**, and the operator has not yet used the new editor. This is the map for
whoever runs BSP.1b, after that.*

**Nothing in `/marketing/ads/budget-manager` was edited by BSP.1.** The rail's outbound link to it
is deliberate and stays until this plan is executed.

---

## 0 · What BSP.1 actually replaced

| Budget Manager surface | BSP.1's replacement | same endpoint? |
|---|---|---|
| Month nav `‹ August 2026 ›` (`:365-368`) | the band's month stepper, but URL-backed (`?month=`) | yes |
| The per-market plan grid (`:329-330`) | the pinned band's four chips + summary | yes |
| `SettingsModal` (`:105`) — cap · autoPacing · stopOverSpend | the `plan:` rail's cap field + two toggles | `POST /plans`, same idempotency |
| `MoreDrawer` (`:165`) — per-campaign min/max | `CampaignLimitsModal` | `GET /campaigns`, `POST /campaign-limit` |
| `Sparkline` (`:72`) in the grid cells | `BurnDownChart` — actual vs expected vs cap vs forecast | same `daily[]` |
| `FaqDrawer` (`:248`) | the rail's inline sentences | — |
| *(nothing)* | the enforcement preview | `GET /enforcement` — rendered nowhere before |

Everything above reads the same deployed endpoints, so the two surfaces cannot disagree about data
— only about which one an operator is looking at. That is the whole reason to retire one.

---

## 1 · What must be deleted, and what must not

`/marketing/ads/budget-manager` is **1,795 lines across 7 files**, and only one of them overlaps.

### Delete from `BudgetManagerClient.tsx` (415 lines)

| lines | what | why it can go |
|---|---|---|
| `:72-103` | `Sparkline`, `StatusControl` | only the plan grid uses them |
| `:105-164` | `SettingsModal` | superseded by the rail |
| `:165-237` | `MoreDrawer` | superseded by `CampaignLimitsModal` |
| `:238-264` | `FAQ` + `FaqDrawer` | its content is now inline sentences |
| `:329-330` | the `lastMonth` / `thisMonth` sparkline columns | superseded by the burn-down |
| `:365-368` | the month nav | superseded by `?month=` |
| `:406-408` | the three modal/drawer mounts | follow their components |

### 🔴 Must stay — these are not duplicates and never were

- **`ControlPlane.tsx` (422)** — a scenario → review → commit surface over the ad ontology that
  stages **bids as well as budgets**. Different verb, different grain. BSP.1 does not touch bids and
  `docs/2026-08-11-bs-budget-schedules-page.md` §D2 puts bids on tab 5.
- **`AllocationCanvas.tsx` (171)** — ControlPlane's canvas. ⚠ It uses **xyflow**, which the fleet
  programme deleted after it silently failed to measure nodes and killed every edge and `fitView`.
  Anything that touches this file must budget for that failure mode, and must **count the edges**
  rather than look at the canvas.
- **`BudgetPoolsDrawer.tsx` (342)** — cross-market **daily** pools, a different grain from a
  per-market **monthly** cap, as its own header comment argues. The study's §10 recommends rebuilding
  pools as *reallocation within an `AdBudgetPlan` cap* — that is a design decision, not a deletion.
- `control-plane.css` (121) and `allocation-canvas.css` (64) — owned by the two files above.
- Most of `budget-manager.css` (253): audit it, do not delete it wholesale. The `bm-*` classes used
  by ControlPlane and the pools drawer must survive.

**Net effect: `BudgetManagerClient.tsx` shrinks to a shell that mounts ControlPlane and the pools
drawer.** Roughly 415 → ~120 lines. The directory does not disappear.

---

## 2 · What the page becomes, and what it is called

After the cull it hosts exactly two things: **scenario staging over the ad ontology** and
**cross-market daily budget pools**. Neither is "budget management" in the sense an operator now
means, because the monthly cap moved.

**Proposed name: "Allocation".** `_shell/nav.ts:54` currently reads
`{ label: 'Budget Manager', route: 'budget-manager', Icon: BadgeDollarSign }` — one line, and the
only nav reference. Renaming the **label** without moving the **route** costs nothing and breaks no
link; moving the route needs a `next.config.js` redirect and is not worth it for one entry.

⚠ `nav.ts` is `§3` row 4 in the locks register — **claim it before editing**.

---

## 3 · The third surface, which nobody has claimed

**`/marketing/ads-console/automation/BudgetPacingTab.tsx`** — 85 lines, reading the same
`GET /budget-manager`, creating via `POST /plans` and deleting via `DELETE`. It is a straight
duplicate of what BSP.1 now does properly.

🔴 **Out of this programme's remit.** Locks §0 is explicit that `/marketing/ads-console/*` is
retired by the session that owns it, not by a Rules & Automation session. Flagging it so it is not
discovered later as a third place the monthly cap can be edited — **it can write plans today**, and
after BSP.1b it would be the only surface besides this page that can.

**Recommendation: raise it as its own item.** Two writable surfaces for one object is the condition
that produced the 41% broken audit chain in the first place.

---

## 4 · Sequencing, and the one hard precondition

1. **The operator uses the new editor on a real plan.** Not a demo — a real cap change they trust.
   Until then, Budget Manager is the working surface and this plan is theory.
2. Verify the four migrated capabilities on prod: cap, autoPacing, stopOverSpend, per-campaign
   limits. All four write through the same endpoints, so this is a UI check, not a data check.
3. Cull `BudgetManagerClient.tsx` per §1, in one commit, with the ControlPlane and pools mounts
   untouched.
4. Rename the nav label (claim `nav.ts` first).
5. Leave `ads-console` alone; raise §3 separately.

---

## 5 · What I found while building that changes the recommendation

- **The enforcement preview has no equivalent in Budget Manager at all.** `GET /enforcement` was
  deployed and rendered nowhere. That is not a migration, it is a capability the old page never had,
  and it strengthens the case for retiring rather than keeping both.
- 🔴 **The calendar was unusable in both surfaces, for the same reason.** `expectedPct` sums only the
  days present in `calendar`, so any partial calendar reads as near-zero planned spend. Budget
  Manager's `SettingsModal` never exposed the calendar at all, so nobody hit it. **BSP.1 is the first
  surface that can write one, and it materialises all 31 days on save.** If BSP.1b ever restores a
  calendar editor anywhere else, it must do the same or it will silently corrupt the pace line.
- **The forecast/expected model mismatch is in the shared service**, not in either page. It is
  disclosed on the burn-down. Retiring Budget Manager does not fix it and was never going to; fixing
  it means changing `ads-budget-manager.service.ts:147`, which writes to production every 30 minutes
  and belongs to a session that owns that service.
- **`stopOverSpend` never paused anything.** Both surfaces called it "Stop Over Spend" with no
  explanation; it floors bids to €0.02 via `suppressCampaignBids`. If any label anywhere still
  implies a pause, that is a defect worth fixing during the cull.
