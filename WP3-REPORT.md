# WP3 report — Master sheet, sheet controls, save status, formulas, render budget

Branch `claude/ultra-code-subagents-product-sheet-neormx-wp3`, based on `25725970`. The orchestrator's fix 6cb8d7f09
(a failed quiet read keeps the Master sheet) is kept: its guard in `reconcileQuiet.vitest.test.ts` is unchanged and green.
Test paths below are relative to `apps/web/src/app/products/[id]/edit/_studio/` unless they start with `apps/`.

## Findings

| id | outcome | commit | test | notes |
|---|---|---|---|---|
| A04 | **partial**: fixed on Master, not on channel sheets | c2761cbd | `sheet/master/masterSettle.vitest.test.ts` ("🔴 A04 — a refused cell elsewhere does not hold the read back") | Master: a reset owes one follow-up read (`FollowUpRead`, retried until it lands). That read no longer waits for "no unconfirmed cell anywhere", because the quiet read keeps what refused, unknown, waiting and saving cells show (`BUSY_STATES`). **Channel: not changed.** The channel quiet read (`sheet/channel/useChannelSheet.ts:148-157`) replaces every row. So its `FollowUpRead.idle` has to keep requiring `!tracker.hasUnconfirmedChanges` (`useChannelSheetAdapter.tsx:298`), or a refused cell's typed value would be overwritten. The fix belongs to WP2: merge busy cells into the channel refresh the way Master does, then drop that clause. An undo of an edit over an inherited value (A05) does paint the inherited cell back at once on both sheets. |
| A05 | fixed | 2d01c1e2 | `sheet/sheetUndo.vitest.test.ts` "undo keeps inheritance (audit A05, A08)" | Both value setters remember the cell they replaced (`rememberPriorCell`). An undo whose "before" was inherited now resets the cell (same intent as the menu's reset) and paints the inherited cell back, instead of pinning the value. |
| A06 | fixed | 35f79e84 | `formulaSaves.vitest.test.ts` "A06 …"; `apps/api/src/services/pim/mapping/cell-formula-set-audit.vitest.test.ts` "audit A06 …" | `PUT /pim/formulas/product/:id[/value]` now returns `versions: { product, channelListing }`, read after the save and after every dependent formula it re-evaluated, plus the `contentVersions` it moved. Both sheets adopt them (`adoptFormulaVersions`). **API change** in `cell-formula.service.ts` / `cell-formula.routes.ts` (WP6's `pim/mapping` folder): new answer fields only. |
| A08 | fixed | 2d01c1e2 | `sheet/sheetUndo.vitest.test.ts` (reset step, list reset); `sheet/sheetControl.wiring.vitest.test.ts` | Every reset (cell, selection, column, Delete → Reset) is one undo step through `useSheetUndo.operation`. Undo puts back each cell's own value, including every position of a reset list. Redo resets again, once per list. Limit: undoing a reset of a *formula* cell restores the formula's last value, not the formula itself. The server's audit row still allows a restore. |
| A11 | fixed | f51ee566 | `sheet/useSheetSaveStatus.vitest.test.ts` "countSaveStatus — audit A11" | Warnings are now counted over the same shown rows × columns as refusals. |
| B07 | fixed | 35f79e84 | `formulaSaves.vitest.test.ts` "B07 …" | After a formula save, Master calls `refreshReadinessSoon()` and the channel sheet calls `refreshReadinessSoonRef.current()`. |
| B17 | fixed | 8799d699 | `sheet/sheetReset.vitest.test.ts` "editorClears"; `sheet/sheetControl.wiring.vitest.test.ts` "B17 …" | Any editor commit of an empty value (a list's "Clear" row, an emptied text) goes through the Delete question when a clear would hide an inherited value. The cell is put back until the operator answers. Done in `useSheetControl.interceptClear`, not in the list editor (WP1), so every editor gets it. |
| B26 | fixed | f51ee566 | `sheet/useSheetSaveStatus.vitest.test.ts` "subscribeCoalesced — audit B26" | The recount runs once per burst of writer events (`queueMicrotask`), and the row key is computed once per row. |
| B27 | fixed | c2761cbd | `sheet/master/masterSettle.vitest.test.ts` | The channel sheet's P2 rule now applies to Master (`masterSettle.ts`). The attribute ColDefs are keyed on column content (`columnsKey`). The rule was derived from `studio-sheet.service.ts` (`layerFor`, `pinned`, `completenessFor`) and **not** recorded against a real server. The channel sheet has a recorded ground truth (`savedCellPatch.ground-truth.json`); Master should get one too (see "Found along the way"). |
| B29 | fixed (the formula part) | 35f79e84 | `formulaSaves.vitest.test.ts` "B29 …" | Batch reads skip rows the sheet read already seeded; they run for unseeded rows and on Retry. The function list is read once per session. The second `/api/connections` read in the nav rail is outside WP3 (see "Found along the way"). |
| B30 | fixed (client) | 35f79e84 | `formulaSaves.vitest.test.ts` "B30 …" | Removing a formula is known locally (`saveLocally(null)`) and triggers no read. The queue settle reads only after a save that wrote a value, and never re-reads the formula batches. A bulk reset removes formulas 4 at a time. There is still one DELETE per formula cell, because a bulk-removal endpoint would be a WP5 API change. |
| B32 | **partial**: measured −30% on the surface; the ≤ 60 whole-app budget is not proven | 8e91fb1c | `sheet/stableProps.vitest.test.ts` | `ProductSheetSurface` renders each part from stable props (`stableProps.ts`). `SheetToolbar` is memoised. The status line reads its parts from a small store. Master's empty-state params are memoised. The channel adapter still builds some grid props on every render (`sheetEmptyState(...)` at `useChannelSheetAdapter.tsx:965`), so on channel sheets the grid host still re-renders on status changes. |
| B34 | fixed | c2761cbd, 64052529 | `sheet/master/masterSettle.vitest.test.ts` ("B34 …", both sheets) | Master `readBack` / `readBackBatch` and channel `readScope` now ask for `cells=compact` and decode the answer. |
| B35 | fixed | 40969b0d | `sheet/useReferenceNames.vitest.test.ts` "the lookups that land together rebuild the columns once" | Name lookups that land together are applied in one update. A lookup still running after 1 s does not hold back names already in. The columns are renamed only when the columns or the names change. |

## Speed numbers (before → after)

| item | measure | before | after | how |
|---|---|---|---|---|
| B26 | recounts for a 105 × 5 paste on 60 columns | 631 (≈ 361 ms here; the audit measured 1.8 s) | 2 (< 1 ms) | real `SheetWriter` + `CellSaveTracker`, test above |
| B27 | requests per plain Master text edit | bulk-save + `GET /studio/sheet` + `GET /readiness` = 3 | bulk-save + readiness = 2 | `planMasterSettle` / `commitMasterRow` tests; a reset still reads once |
| B27 | attribute ColDef rebuilds per Master edit | 2 (sheet read, readiness answer) | 0 | adapter guard (deps no longer include `sheet` / `schemaColumns`) |
| B29 | formula calls on load, GALE eBay IT (5 aliases, 1 language) | 5 batch + 1 functions | 0 batch + 1 functions (0 for later sheets in the session) | `formulaBatchRequests` test; with 3 languages: 15 → 0 batch |
| B30 | requests to reset one formula cell | DELETE + 5 batch + GET sheet (often wasted) + bulk-save + GET sheet + readiness ≈ 10 | DELETE + bulk-save + 1 follow-up read + readiness = 4 | source guards; still above the budget of 2 (see notes) |
| B30 | DELETEs in flight, 105-row formula column reset | 105 at once | 4 at a time | guard |
| B32 | component renders under `ProductSheetSurface`, one edit (3 status changes) | 80 | 56 | scratch harness, below |
| B32 | grid host (`NexusGrid`) renders per edit | 3 | 0 | same harness |
| B34 | recovery read size | plain (~995 B/cell) | compact (~1/5) | the audit's per-cell figures |
| B35 | column sets after first paint (3 lookups 100 ms apart) | 2 rebuilds | 1 | test above (checked failing on the old hook: 3 sets vs 2) |

The B32 harness was not committed: it lives in the session scratchpad as `__renders.scratch.vitest.test.ts`. It renders
the real `ProductSheetSurface` in happy-dom and mocks only `NexusGrid` and the studio contracts. The fake adapter
rebuilds its model on every render the way the real adapters do. Renders are counted from React's commit tree with
DevTools' rule: PerformedWork, and a subtree whose child fibers were reused did not render. "Before" ran the committed
`ProductSheetSurface` through the same counter. This counts only the surface's subtree. The audit's 208 (a Master text
edit in the browser) also included the sheet re-read and two column rebuilds, which B27 removed. I did not run the
whole app in a browser, so the ≤ 60 renders per edit budget is **not measured** end to end.

## Commands run (final state)

- `npm ci && npm run build -w @nexus/shared && npm run build -w @nexus/events`: OK
- `npm run typecheck -w @nexus/web` (and `npx tsc --noEmit -p tsconfig.json` in `apps/web` after each change): clean
- `npm run typecheck -w @nexus/api`: clean
- `cd apps/web && npx vitest run src/design-system/grid 'src/app/products/[id]/edit/_studio'`: 308 files, 4175 passed,
  13 skipped (final run, on 64052529)
- `cd apps/api && DATABASE_URL=postgresql://postgres@127.0.0.1:5432/nexus_test npx vitest run
  src/services/pim/mapping/cell-formula-set-audit.vitest.test.ts cell-formula-channel-write… cell-formula-recalc…`:
  3 files, 45 passed. Redis `ECONNREFUSED` noise comes from an import; no test depends on it.
- `node scripts/ci/run-static-gates.mjs`: 59/60 on the first run. The failure was
  `migrations: expand/contract`: "Not a valid object name origin/main", because this clone had no `origin/main` ref.
  After `git fetch origin main`, `node scripts/check-migration-expand-contract.mjs` passes (0 new folders), so 60/60.

## Changes outside WP3's files (kept minimal)

- `sheet/master/columns.tsx` (valueSetter) and `sheet/channel/savedCellPatch.ts` (`optimisticCell`): one
  `rememberPriorCell(next, previous)` each (A05).
- `sheet/useSheetUndo.ts` (unowned): replays resets; `operation` passes a `record` function (A05/A08).
- `sheet/channel/useChannelSheetAdapter.tsx` (WP2): adopt formula versions (A06), readiness refresh on formula settle
  (B07), `control.interceptClear` in `onCellValueChanged` (B17), compact `readScope` (B34).
- `apps/api/src/services/pim/mapping/cell-formula.service.ts`, `apps/api/src/routes/cell-formula.routes.ts`: new answer
  fields `versions` and `contentVersions` (A06).
- New files: `sheet/master/masterSettle.ts`, `sheet/stableProps.ts`, `formulaSaves.vitest.test.ts`, and their tests.

## Found along the way (not fixed)

1. **Channel quiet read discards typed values in busy cells.** `sheet/channel/useChannelSheet.ts:148-157` (`refresh`)
   replaces every row. That is why the channel `FollowUpRead` cannot run while any cell is refused
   (`useChannelSheetAdapter.tsx:298`). This is the channel half of A04: with a refused cell anywhere, a channel reset
   stays visibly unapplied until Reload (FollowUpRead gives up after 40 × 1.5 s).
2. **Master settle has no recorded ground truth.** `sheet/master/masterSettle.ts` mirrors the server's fold. A recorded
   pair (sheet before/after real Master saves, like `savedCellPatch.ground-truth.json`) would pin it.
3. **The channel adapter builds grid props on every render.** `useChannelSheetAdapter.tsx:965` (`sheetEmptyState(...)`)
   and others defeat the grid-host stabilisation of B32 on channel sheets.
4. **`hasUnconfirmedChanges` copies the whole tracker on every call.**
   `apps/web/src/design-system/grid/editors/roundTrip.ts:130-132` spreads every tracker entry into an array on each
   call, and the idle checks call it on every settle and retry.
5. **B29 remainder.** The nav rail's second `/api/connections` read (audit: `AppNavRail.tsx:41-44, 79-90`) and
   `/sidebar/counts` are outside the sheet. Not verified here.
6. **B30 remainder.** A bulk formula-removal endpoint, or folding the removal into the reset's bulk-save units, would
   bring a formula reset down to one request. That is an API change for WP5.
