# WP2 — Channel sheet save and settle: report

Branch `claude/ultra-code-subagents-product-sheet-neormx-wp2`, based on `25725970`. The orchestrator removes this file when merging.

## Outcomes

| id | outcome | commit | test | notes |
|---|---|---|---|---|
| A03 | fixed | 751ef212 | `channelWrite.vitest.test.ts` "one operation across listing-alias bands (audit A03)"; `sheetWriter.batch.vitest.test.ts` "a record shared by several rows (audit A03)"; `apps/api/.../bulk-save-alias-chain.vitest.test.ts` | Checked against the real server first: the bulk-save route on PGlite gives `[200, 409 {"error":"Title changed. Reload before saving it."}]` for two bands with the same tokens. A different Master field on the second band gives `409 VERSION_CONFLICT versionOf=product`. With the tokens the first unit answered, the second unit is stored. The #220 fake server only covered a no-op followed by a change. The new web fake follows the real contract. The fix is a new, optional `SheetWriter` option, `sharedRecordOf`, and `channelSharedRecord` sets it for the channel sheet. Only one row per call writes a given shared record. The same edit on another band is settled with that row's answer. A different edit waits for the next call, which carries the new versions. Before: 5 bands gave 4 refused. After: 5 saved, with 1 unit in 1 call. Mirrored in Factory, with CHANGELOG lines in both. |
| A02 | fixed | 955ad7bb | `savedCellPatch.vitest.test.ts` "an answer with a recalculated dependent formula / a dependent formula refused / a failed recalculation pass" | An answer with `recalculated[]` or `recalcError` now reads the sheet once. Before, it gave `{patched}`; now it gives `{read: 'a dependent formula was recalculated'}`. |
| A01 | fixed | 26c6c993 | `saveSettle.vitest.test.ts` "audit A01 …" | All 7 other quiet reads now go through `guardedRead`: formula onSettled, Refresh progress, the media editor, the Shopify review, and the two formula dialogs. A save that starts or settles while a read is on the wire drops that read (a settled save now moves `writeSeq` too), and the dropped read becomes the follow-up read. A source guard allows only 2 direct `refresh` calls: the guard and the follow-up read. |
| A07 | fixed | 26c6c993 | `saveSettle.vitest.test.ts` "audit A07 …" | The errors branch now reports `{read: 'the answer refused a cell'}` (before, `onStored` was never called). The adapter owes the read whenever `storedSome(result)` is true and reads readiness again. `onSettled` now settles the owed read after a refused save as well. The read is taken once the sheet is idle, which is once the refused cell has been dealt with. |
| A10 | fixed | 26c6c993 | `saveSettle.vitest.test.ts` "audit A10 …" | `FollowUpRead` keeps retrying while the read is owed. The first 40 retries run every 1.5 s, then the wait doubles up to 30 s. A busy sheet never fetches. |
| B05 | fixed | 26c6c993 | `saveSettle.vitest.test.ts` "audit B05 …" (source order: the adapter needs a grid) | `readinessForFamily` is now set after `await commitChannelRow`, when the save settles, instead of before it leaves. |
| A09 | fixed | 41dc1448 | `sheetRecovery.vitest.test.ts` "audit A09 …" | `recoverSheetRow` now calls `adoptReadContentVersions`. For every text the read found holding what was typed, each cell writing that content row (for example the title and its bullets) takes the read's token, by the `preserveContentVersions` snapshot rule. A content row that is also written by a cell the read shows different (or could not tell) keeps the old token. Content versions went from [4, 4] to [5, 5]. The product version is not copied onto the row: the writer already seeds it from the read (`resolveRead`), and commits send the writer's version. |
| B28 | partial | a9953c40 | `rowReuse.vitest.test.ts` "a quiet read keeps the rows it did not change" | **Renders:** `refresh` now keeps every unchanged server row as the same object (`keepUnchangedRows`), so the grid's `withRowIdentity` cache keeps its row. Measured on the recorded color-variant save, padded to 105 rows, the follow-up read now replaces 2 grid rows instead of 105. Reload still replaces every row. **Requests:** still bulk-save, 1 sheet read and readiness for the read cases. **Not done:** new in-place patches for unmapped or required first fills, clears and warned values. The ground truth has no recorded server result for any of them (its 2 read cases are an axis column and a variation-supplied listing-level value, and both are correct reads). The server's cell there depends on resolve-batch validation and status, plus the studio-sheet wrap, and a guessed patch that differs from the next read is exactly the stale display P2 forbids. The real fix is for bulk-save to return the saved rows' recomputed cells. That is API work (WP5/WP6), or a ground-truth recording on a copy of the database. |

## Commands run

- `npm ci`, then `npm run build -w @nexus/shared && npm run build -w @nexus/events`: OK.
- `cd apps/api && DATABASE_URL=postgresql://postgres@127.0.0.1:5432/nexus_test npx vitest run src/services/products/bulk-save-alias-chain.vitest.test.ts --maxWorkers=2`: 3 passed (PGlite).
- Each new web test was run against the unchanged code first:
  - A03: 4 of 4 channel tests failed. The 3 writer tests also failed with HEAD's `sheetWriter.ts` swapped back in.
  - A02: 3 failed.
  - A01: 4 failed.
  - A07: 1 failed.
  - A10: 1 failed.
  - B05: 1 failed.
  - A09: 1 failed.
  - B28: 3 failed.

  All of them pass after the fixes.
- `cd apps/web && npx vitest run src/design-system/grid 'src/app/products/[id]/edit/_studio'`: 306 files, 4131 passed, 13 skipped.
- `npm run typecheck -w @nexus/web` (`next typegen && tsc`): clean.
- `npx tsc --noEmit --incremental false -p apps/factory/tsconfig.json`: clean.
- The pre-push typecheck (all workspaces) passed on both pushes.
- `node scripts/ci/run-static-gates.mjs`: 60/60. The first run failed only on "migrations: expand/contract": this clone had no `origin/main` ref. I fetched it and re-ran with `NEXUS_MIGRATION_BASE=$(git merge-base HEAD origin/main)`.

## Files outside the package

- `apps/api/src/services/products/bulk-save-alias-chain.vitest.test.ts` is a new, test-only file. It pins the server contract A03 relies on. No API code changed.
- `apps/web/src/design-system/grid/editors/sheetWriter.batch.vitest.test.ts` (DS tests next to `sheetWriter.ts`) and both design-system `CHANGELOG.md` files.

## Found along the way (not fixed)

1. **A refused cell blocks every quiet read on the channel sheet, including Refresh progress.** `CellSaveTracker.hasUnconfirmedChanges` counts `refused` as unconfirmed (`apps/web/src/design-system/grid/editors/roundTrip.ts:130-131`). Every quiet read's `canApply` and `FollowUpRead`'s `idle` require it to be false (`useChannelSheetAdapter.tsx`, the `followUp` deps and `refreshProgress`). So while one refused cell stays on the sheet, "Refresh progress" does nothing and no owed read lands. Since A10 the owed read now lands once the refused cell is cleared. Before, it could be lost.
2. **`SheetWriter.destroy()` ignores `sharedRecordOf`.** It sends every queued cell as one `commitBatch` (`sheetWriter.ts`, `destroy`, the `commitBatch(requests)` line). A different edit to one product's shared record that was queued on a second alias band when the sheet unmounts goes out with the stale tokens and is refused, with no surface left to show it. This is rare, since it needs an unmount within the one call's round trip.
3. **Possible same-class conflict for eBay listing-level values (not verified).** A fill down a listing-level column (P1: the value is stored on the family's parent listing) sends one unit per variation of the same family and alias. If the server guards the parent listing's version for each of those units, units after the first would be refused, as in A03. I did not verify this against the server. `sharedRecordOf` could cover it with a `listing:<family parent listing>` key if it reproduces (`useChannelSheet.ts` `adoptFamilyListings` / `familyListingsOf`).
