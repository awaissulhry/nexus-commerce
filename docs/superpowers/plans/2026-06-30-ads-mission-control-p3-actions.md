# Ads Mission Control — P3.1: Actions from the Canvas (gated, no new backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **STATUS: DESIGN — not yet approved to build. This is the first WRITE arc; do not implement until the owner green-lights.**

**Goal:** Take real, *gated* actions on canvas objects — single (from the inspector) or **bulk** (multi-select) — for the safe campaign-level levers (daily budget, status, placement bid %, target ACoS / bid automation), with **dry-run → diff preview → blast-radius → confirm → apply**, reusing the existing write-gated endpoints. No new backend.

**Architecture:** Multi-select on the canvas builds a client-side scope (campaign ids — that *is* the "scope resolver" for v1; portfolio/market select cascades to their campaign descendants already in the graph). A pure `stageActions` module computes the change set + blast-radius (N campaigns, Σ daily-budget Δ). A diff-preview modal shows exactly what will change; on confirm we fan out the **existing** `PATCH /advertising/campaigns/:id[...]` calls (each independently write-gated on the backend — sandbox returns dry-run, live requires the per-campaign allowlist). Per-result success/denied feedback. Nothing auto-applies.

**Tech Stack:** Next.js/React, `@xyflow/react` (multi-select), vitest (pure stage/diff/blast-radius), existing DS, existing gated endpoints. No new deps, no schema/route changes.

## Global Constraints
- Light H10, image-free; **no new backend / no schema / no new routes** (P3.1 reuses existing gated PATCH endpoints). No new deps.
- **Safety (hard):** every apply goes through the existing `checkAdsWriteGate` server-side (sandbox → dry-run; live → only `Campaign.liveBidWritesEnabled` campaigns). UI is **dry-run/SUGGEST by default**; no auto-apply; explicit confirm on a diff preview; **blast-radius shown** (entity count + total budget Δ) before confirm; honor [[project_fba_fbm_flip_incident]] — never pause/flip without explicit confirm.
- Verify: `tsc` clean; pure modules unit-tested; screenshot in **sandbox** (dev :3000) showing the diff preview WITHOUT applying live; confirm "would-apply" envelopes, never mutate prod during verification (route-block or assert sandbox).
- Commit per task with `git commit <paths>`.

## Confirmed existing endpoints (from Ad Manager grid `CampaignsGrid.tsx:858–1008`, all backend write-gated)
- `PATCH /api/advertising/campaigns/:id` body `{ status, applyImmediately, reason }` (ENABLED|PAUSED|ARCHIVED)
- `PATCH /api/advertising/campaigns/:id` body `{ dailyBudget, applyImmediately, reason }`
- `PATCH /api/advertising/campaigns/:id` body `{ biddingStrategy, applyImmediately, reason }`
- `PATCH /api/advertising/campaigns/:id/automation` body `{ targetAcos (fraction), bidAutomation }`
- `PATCH /api/advertising/campaigns/:id/placements` body `{ adjustments: [{ placement, percentage }] }` (placement ∈ PLACEMENT_TOP|PLACEMENT_PRODUCT_PAGE|PLACEMENT_REST_OF_SEARCH)
- `patchJson` returns true iff `r.ok && j.ok !== false` — reuse this contract.

## File Structure
- Create: `_canvas/actions.ts` — action types + `stageActions()` (pure: selection × action → per-campaign change set + blast-radius) + `toPatch()` (change → endpoint+body).
- Create: `_canvas/actions.vitest.test.ts`.
- Modify: `_canvas/OpsCanvas.tsx` — multi-select (shift/cmd-click adds to a Set; marquee later), expose `selectedIds`.
- Modify: `autopilot/MissionControlClient.tsx` — selection set state; **bulk action bar** when ≥1 selected; inspector single-object actions; diff-preview modal; apply fan-out with per-result status; dry-run toggle (default ON).
- Modify: `autopilot/mission-control.css` — action bar + diff modal styles.

## Tasks (summary — full TDD code on approval)
1. **Pure action model (TDD):** `stageActions(campaignObjs, action)` → `{ changes: PerCampaignChange[], blastRadius: { count, budgetDeltaEur } }`; `toPatch(change)` → `{ url, body }`. Unit-test budget ±%/set math, status, placement, target-ACoS, and blast-radius sum. (Only campaigns are actionable; market/portfolio selection expands to descendant campaigns already in the graph.)
2. **Canvas multi-select:** OpsCanvas shift/cmd-click toggles a `selectedIds` Set (visual ring on all selected); single click still selects-one for the inspector. Lift `selectedIds` to MissionControlClient.
3. **Bulk action bar + inspector actions:** when selection non-empty, show a bar (Budget ±%/Set, Status, Placement, Target-ACoS) + count; inspector gets the same actions for the single selected object. Each opens a small param popover and **stages** (does not apply).
4. **Diff preview + apply:** a modal lists every staged change (campaign → before→after) + **blast-radius** (N campaigns · Σ budget Δ) + a **Dry-run** toggle (default ON) + the live/sandbox mode banner; Confirm fans out the existing PATCHes via `patchJson`, shows "M of N applied · K denied" (denied = gate-blocked), records nothing client-side beyond a toast. **No apply without Confirm.**
5. **Verify (sandbox):** `tsc` + vitest; dev :3000; stage a budget change on 2 campaigns → open diff → confirm with the endpoints route-blocked (never mutate prod) → assert the fan-out fired the right payloads; screenshot the action bar + diff modal. Then owner sign-off before any live use.

## Out of scope (later phases)
- `scope-resolver` BACKEND + **dynamic** query scopes ("all campaigns ACoS>X") → **P3.2**.
- Ad-group / target / keyword level actions; negatives/harvest → **P3.2/P3.3**.
- Composed **Agents** (the Composer), AI Strategist, learning loop → P4+.
- The canvas **kill-switch** wiring (`pause_all_campaigns`) → its own gated, double-confirm task.

## Self-Review
- Coverage: actions (1,3), scope via multi-select (2), gated apply + diff + blast-radius (4), verify (5). Safety constraints explicit + reuse the proven gate. Net-new backend correctly deferred to P3.2.
- No placeholders in the task intents; full TDD code to be filled in at build time (post-approval), endpoints already grounded above.
- Types: `PerCampaignChange`/`stageActions`/`toPatch` defined in Task 1, consumed in Tasks 3–4.
