# H — fixes from the lead's screenshot review (fix agent H, 2026-10-05; nothing committed)

Web files are under `apps/web/src/app/fleet/approvals/grid/`; API files are under `apps/api/src/`.

1. **Duplicate key:** `ApprovalDrawer.tsx` keys are now `plan:<id>` and `edit:<id>`. The plan drawers have no console error (checked in the browser).
2. **No-match empty state:** the search and the tiles now filter `rowData` on the page (`queueWords.rowMatchesSearch` and `searchText`; AG's quick filter is gone). The grid's own overlay says "No requests match." and has **Clear filters**. **DS fix:** that button could not be clicked, because AG sets `pointer-events: none` on `.ag-overlay`. `.nds-grid-noRows { pointer-events: auto }` is in `design-system/grid/theme/grid.css` and the identical Factory copy, with a CHANGELOG line.
3. **Desktop columns:** the order is ☐ · Status 140 · What 176 · Product 192 · Change (flex, min 176) · Why / result 232 · Asked by · Asked · Expires · Where (hidden; Customise lists it) · actions. What's second line shows where ("eBay IT", "Nexus"), or "Plan · N steps" / "2 of 6 done" for a plan. A row with one change line hides its label (`ChangeValue hideLabels`; screen readers and the tooltip keep it). Why / result wraps to 2 lines. In the Done view it also says who decided ("Rejected: … · by Ana"). `DEFAULT_PREFS` leaves Where out. Changed: `queueColumns.tsx`, `queueWords.ts`, `ApprovalsGrid.tsx`, `approvalsGrid.css`.
4. **Phone:** two columns. Request (flex) shows the status pill (no dot) and the title, with the SKU or the plan's progress below. Actions shows ONE verb and no ⋯; the drawer has every verb. At 390 px: card 274 px, columns 274 px.
5. **Ask AI:** the fleet pages scroll in `.flex-1.overflow-auto`, not in `.h10-main`, which already reserves this room (`shared-shell.css`). I copied that rule: `:root:has([data-nds-fab]) .aqg-page { padding-bottom: var(--nds-fab-reserve-block) }`. Control at 390 px: without it, the last row's Approve (y 756–784) sat under Ask AI (y 772–820); with it, Approve's bottom is at y 712.
6. **Search:** placeholder "Search SKU, product or kind". The field fills its slot (286 px at 1280; the text needs 167 of its 243 px).
7. **Plan steps:** `QueueDetail.items` covers only the first 50 steps and has "N. Title ·" baked into its label, so I did not use it. Each step of `GET …/:id/plan` now carries `changes` / `changeCount` from the grid's own resolver (`approval-target.stepChangesOf` → `approval-queue.service.withStepChanges`, wired in `routes/agent-fleet-approvals.routes.ts`). Hidden steps get none. `planWords.stepWhat` uses them: "AIREON-PANT-NERO-NEO-MEN-S · Base price: €154.00 → €149.00".
8. **Each fact once:** `drawerWords.whyView` returns nothing for a running plan (the progress bar shows the step count). `PlanSteps` no longer shows the plan's summary sentence (the kinds list says the same).
9. **Automate:** `queueWords.automateOffer` is false for a plan and for anything not asked by Claude. The drawer button uses it too.
10. **Listing SKU:** set-listing-stock and set-listing-price now name the listing's own SKU and product: the matrix change row's sku and rowId (also added to `productRefsOf`), not the family's parent. The label is just "Quantity" / "Buffer" / "Price" / "Sale price"; it adds the SKU or market only when the request spans several. The Matrix's own values stay whole ("Buffer 0 → Buffer 2"), because the grid hides a lone line's label. A sale reads "No sale → 89.00 (from …)". bulk-listing-stock had no reader; it now has one in the same pattern (its `cells`, listing target, EU group as written).
11. **Where = Nexus:** new contract field `QueueRow.nexusRecord` (`packages/shared/approval-queue.ts`; shared rebuilt). It comes from `approval-target.NEXUS_RECORD_TOOLS`: master prices (set-price, set-master-prices, bulk-price-change, schedule-price-change, set-tier-prices, set-price-bounds), own-warehouse stock (set-stock, transfer-stock, reconcile-stock-count, reserve-stock, receive-stock) and add-photo-from-url. A plan counts as Nexus when every kind in it does. The grid shows "Nexus"; the drawer shows "Nexus".
12. **Bulk sentence:** `approval-inbox.service` `kindTitle` gives "3 × Set master price", also in the blocked-reason kinds list. Pins updated in the bulk route test and in approval-undo.

| Check | Command | Result |
|---|---|---|
| Web typecheck | `npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile …/approvals-H-web.tsbuildinfo` | pass |
| Web tests | `npx vitest run src/app/fleet src/app/settings/ai src/app/_shared src/design-system/grid` | 146 files, 2129 pass |
| API typecheck | `npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile …/approvals-H-api.tsbuildinfo` | pass |
| API tests, flag unset / =1 | `env.sh` + `npx vitest run src/services/agent-fleet src/routes/approval-queue.routes… …bulk… …plan.vitest.test.ts` | 53 files, 613 pass / 53 files, 613 pass |
| Static gates | `node scripts/ci/run-static-gates.mjs` | 61/65, only the 4 known (output identical before and after the DS change) |
| DS fork drift | `node scripts/check-ds-fork-drift.mjs` | no new drift |
| Browser light 1280 + 390 | `THEME=light WIDTHS=1280,390 APPROVE=0 node approvals-check.mjs` | **105/105 PASS** (was 70/74) |
| Browser dark 1280 | `THEME=dark WIDTHS=1280 APPROVE=0 node approvals-check.mjs` | **59/59 PASS** (was 36/2) |

**Check script** (`$S/approvals-check.mjs`; the old copy is `approvals-check.before-H.mjs`). Moved: the phone columns are Request · actions, the phone ⋯ check became "the drawer carries Reject and Automate", and the status/what cells read `request` on a phone. Added: key columns without sideways scroll, Where hidden, What shows where, label-less single change, listing SKU and Buffer line, full search placeholder, empty state and Clear filters (search and tile), Done-view "who decided", bulk sentence title, plan steps formatted, each fact once, no Automate on plans or fleet rows, no console error per plan drawer, 1 verb and no ⋯ on a phone, and no Ask AI overlap at the page end. No bulk approve was confirmed and no rule was saved. The API was restarted twice through `$S/stop.sh api && $S/start-api.sh`.

**Not done, or worth a look:**
- A plan's Change cell still reads "Set master price → 6 changes +5 more". `changeCount` counts steps while the lines are kinds, so "+5 more" overstates. This is outside the list.
- Old rows with no `decidedBy` read "· by Someone" (the API's own fallback word).
- The drawer's Automate button opens the modal even for a kind capped at Ask me; the modal explains it, as before.
