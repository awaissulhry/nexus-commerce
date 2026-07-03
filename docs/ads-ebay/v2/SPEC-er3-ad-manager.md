# ER3.1 SPEC — Ad Manager polish (`/marketing/ads/ebay/campaigns`)
<!-- ER3 slot 1 (approved order). Delta-focused: the grid itself (AdsDataGrid,
     totals, filters, CSV dry-run import) is keep-list; this spec is the gap
     between v1 and the teardown verdicts + critique 2.4 + ER1/ER2 spillover.
     Gate: Owner approval before build. -->

## Deltas (10, ranked)

1. **Fix the duplicate Export button** (critique 2.4). v1 renders its own "Export Data" in `toolbarRight` while the grid's built-in "Export Data…" also renders. Wire the built-in `onExport` to the existing CSV export and delete the custom button. One button, grid idiom.

2. **Automation column** (H10 verdict: adapt — their Ad Manager carries Automate/Rules/Schedules control columns per row). One compact, non-metric column showing: rules-bound count (cog glyph + n, from `EbayAdsRule.scope.campaignIds` + applicable globals), the **Protected** pill when the ER1 policy says so, and a posture glyph when overridden (Off/Suggest/Auto). Click → the campaign's Automation tab. Data: additive `automation: { rules: n, protected: boolean, posture: string }` per row in `GET /ebay-ads/campaigns` (one policy + one rules query, joined in-memory).

3. **"Limited by budget" derived status** (Seller Hub verdict: adopt). CPC campaigns whose **yesterday ad fees ≥ 90% of daily budget** get an amber "Limited by budget" pill layered on the status cell (tooltip states the heuristic honestly: "spent ≥90% of daily budget yesterday — eBay caps delivery when budget runs out; consider raising it"). Status filter gains the option. Derived at payload-build time from existing campaign-grain facts; no schema change.

4. **DateRangePicker (D1)** replaces the preset `<select>` in `toolbarLeft` — same `{start,end}` state the detail pages use; the campaigns endpoint already accepts `startDate/endDate`.

5. **Filter Library** (H10 verdict: adopt — saveable, renameable filter presets). THE one shared-grid touch of ER3.1: `AdsDataGrid` gains an optional `filterPresetsKey?: string` prop — when set, the filter panel footer renders "Save preset" (name ≤60) + a preset chips row (apply / rename / delete), persisted in localStorage under that key. **Amazon grids pass nothing and render exactly as today** (additive prop, default off; Amazon Ad Manager before/after snapshot at the gate). eBay Ad Manager passes `filterPresetsKey="er3-ebay-campaigns"`.

6. **Status menu completes** (critique: Enable/Pause/End only, forcing navigation): add **Clone…** and **Budget…** items opening the existing CloneModal / a budget mini-modal (reuses the Details-tab semantics: current value + 15/day meter + guarded write). End keeps the ER1 consequence-stating modal (replaces this page's `window.confirm` — the last one under `ebay/`).

7. **Rate/Budget column made self-explanatory** (critique: `per-ad · dyn` vs `2%` vs `€30.00/day` unexplained): header ⓘ tip defining all three forms + cell tooltips ("rates live per ad — open the campaign's Ads tab"; "DYNAMIC follows eBay's suggestion under a cap"; CPC shows `money()` per C7). The `nexus` pill gets its tooltip ("created and managed by Nexus").

8. **Metric naming (D2/C8)**: "eBay ACOS" column → **ACOS** (the any-click nuance moves to the ⓘ tip) + a new **ROAS** column (from `mapMetrics`), both with pinned totals — parity with the detail tabs.

9. **OOS visibility** (Pacvue verdict: adapt-lite): the Ads count column's tooltip gains "N hidden — out of stock" from the ads' `hiddenReason` (additive `ads.hidden` count in the payload). A state you can see, not an error.

10. **Data Sync button** (header parity — Amazon shows it, eBay hides it): wire `AdsPageHeader.onDataSync` to the existing entity-sync manual trigger with the spinning state + toast ("entities synced · N campaigns"). Uses the cron-registry trigger endpoint that already exists for ops; if it turns out to require admin scope at build time, the button ships admin-gated (stated at the gate).

## Conformance & risks

C2 (one grid — presets land INSIDE AdsDataGrid, no bespoke table) · C6 D1 picker · C7 `money()` on budget cells · C8 ACOS/ROAS naming · C9 StatusPill everywhere in the status cell · C10 no new `eb-*` (preset chips reuse `.h10-am-btn sm` + `.h10-pill`) · C13 ER3.1 headers · C14 additive payload fields only. **Risk register**: #5 touches the shared grid — additive optional prop, Amazon snapshot-verified; #3 is a heuristic — labeled as such in its tooltip; #10 depends on the trigger endpoint's auth scope — verified at build.

## Out of scope (stays on the ER3/ER4 backlog)
Search-term insights rollup (Dashboard slot) · bulk staged-wizard actions (ER4 evaluation) · per-row trend popover (Teika verdict — Dashboard/ER4) · virtualization (ER4 perf pass).

## Verification script (build gate)
One Export button, exports the filtered view · automation column shows the rules count for a pack-bound campaign and the Protected pill toggled from the detail tab · a CPC campaign with yesterday-fees ≥ 90% of budget shows "Limited by budget" (or the heuristic verified against facts if none qualifies) · DateRangePicker drives the grid (range change re-fetches) · save/apply/rename/delete a filter preset; Amazon Ad Manager pixel-identical before/after · Clone + Budget from the status menu round-trip · ACOS/ROAS columns with totals · zero `window.confirm` remaining under `ebay/` · tsc + build + gauntlet green.
