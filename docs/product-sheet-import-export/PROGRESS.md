# PSIE — progress (newest at top)

## 2026-09-26 (late) — CI round 2 + main moved again (#18 "fast bulk saves")
- CI failed ONE gate: `grid kit` (a new use of the retiring `components/DataGrid`). The change table now uses the DS grid's
  `DataGrid` (`design-system/grid/datagrid`, AG Grid, same props); widths moved to `Column.width`; long SKUs wrap.
- `main` gained #18, which added the system-wide pending-readiness mechanism (`markReadinessPending`, `rebuildPendingFamily`,
  the readiness-pending drain). The import now uses it: families are marked pending in the SAME transaction as the values
  and rebuilt right after the commit; the drain finishes any a restart interrupts. `produceReadinessForProducts` honours
  `deferReadiness` too. One conflict (`readiness-index.service.ts`) resolved keeping both sides.
- Checked on main 71888bd6d: API `tsc` clean; 50/50 static gates; API 46 files / 550 passed (31 opt-in skips) + #18's race
  suites on a real server 2/2 and 6/6; bench GALE 40 cells — save 3.7 s, total 6.9 s (first, cold run), 714 readiness rows
  pending at DONE → 0 after the rebuild (5.1 s), Undo 40/40, 0 channel updates.
- Published as a merge commit on the pushed branch (no force-push).

## 2026-09-26 (evening) — rebased onto main c5597f776 (Prisma 7, three-process API #4) and opened as a pull request
- Rebase: no conflicts. `main` still runs catalog imports inside the API process with the route's 30 s recovery timer; the sheet import
  follows the same pattern (its recoverer is on that timer).
- The pre-commit gate moved the export's one database read out of the route into `sheet-transfer/sheet-export.service.ts`.
- Private copy migrated with the 13 migrations `main` added since 2026-09-23 (local copy only).
- Checks on the rebased branch: API `tsc` clean · web / factory / shared `typecheck` clean · API 44 files / 542 passed (29 opt-in skips)
  · web 15 files / 185 passed.
- Timing on the rebased branch (fresh copies, load ~9): GALE 40 cells — save 4.8 s cold, **1.6 s** warm; total 8.3 s cold, **3.9 s** warm;
  readiness rebuilt 4–7 s after the save; Undo 40/40; 0 channel updates.
- Pull request opened WITHOUT auto-merge: merging it deploys the API and the web; the Owner merges.

## 2026-09-26 (afternoon) — readiness after the save (the Owner chose B)
- `readiness-index.service.ts` `deferReadiness(families, work)`: inside it, `produceReadiness` only notes the family root. Used ONLY by
  the sheet import's save transactions; every other writer keeps readiness in its own transaction (test: outside it, a refresh still
  requires the transaction).
- `sheet-import.service.ts`: the save notes families → the job goes DONE with `readiness: pending` → `refreshSheetReadiness` rebuilds each
  family once → `done` / `failed` (jsonb_set, so a concurrent Undo link is never overwritten). `recoverSheetImports` reruns a rebuild
  still `pending` after 60 s (a restart right after a save). The page shows "Updating readiness…" and reloads the sheet when it lands.
- **Measured (fresh copy, load 8.9):** GALE 40 cells — save **2.1 s** (was 9.3 s this morning, 75 s on the old engine), total **4.7 s**
  (was 85 s); readiness rebuilt 4.6 s after the save; index rows newer than the save (proof it ran); Undo 40/40; 0 channel updates.
- Tests: API 43 files / 540 passed (+ 2 new deferred-readiness tests); API and web type-checks clean. Servers :8093 / :3003 restarted.

## 2026-09-26 — screens built and checked in a real browser (local servers :8093 / :3003, private copy `nexus_psie_test`)
- **Export dialog:** Products (This product · Whole family · Selected rows) · What to include (Shared details + one card per channel
  market, listings and aliases counted, language named) · Columns (All · Only on screen) · Download. "Table on screen (CSV)" kept as a
  small button. Defaults: whole family, Shared, the channel on screen, all columns.
- **Import dialog:** drop → file row ("Nexus file · 3 products · 2 listings · Shared, Amazon · IT") → 4 numbers → problems banner with
  "Download the list" → one table (SKU · Where · Column · Now · New · Status; long values start at the difference) → "Apply 5 changes,
  skip 1 problem" → progress → "5 records saved in Nexus … Nothing was sent to the channels." → Undo · Publish… · Import another file · Done.
- **Seen working in the browser:** the summary; a too-long Amazon title as a problem with tab/row/column; Apply; the sheet refreshing
  itself; Undo's own check; `#shared` on a variant name; "Changed in Nexus after your export (now …)" for a real conflict; "Nothing to
  change" for a file already applied; Publish… opening the normal dialog (it stops on the missing local key — nothing sent); a closed
  dialog keeping an unfinished check; light and dark; a 390 px frame (no page overflow).
- **Fixed from the browser checks:** squeezed table columns; values cut before the difference; a schema-date note shown as a warning;
  the save timer counting from the upload; Undo refusing a variant's name ("Name cannot be empty"); problem rows showing "—" for Now;
  Undo wording; a running save lost on a page reload (now picked up again, with a toast when it ends).
- **Removed:** `ProductTransferDrawer` (+ css, `productTransferSelection` + test) — nothing uses it; its presence-vocabulary baseline
  line removed (the guard's remaining failures exist on a clean `origin/main` too: 86 → 84 findings, 3 → 2 new).
- **Tests:** API 43 files / 540 passed (29 opt-in skips) + the opt-in race/end-to-end copy suites run one at a time (8/8, 3/3, sync 3
  files passed). Web transfer models 17/17. DS 50 + 23. API `tsc` clean; web scoped `tsc` clean.
- **Final timing** (fresh copy): GALE 40 cells — total 12.7 s (was 85 s), save 9.3 s (was 75 s), Undo 40/40.
- **Clean-up:** temporary files and test databases removed; the disposable local user deleted. Servers :8093 / :3003 left running.

## 2026-09-26 — server engine built and measured (local, private DB copies)
**Measured** (`apps/api/scripts/psie-bench.mts`, fresh `CREATE DATABASE … TEMPLATE nexus_psie_test` per run, machine load 7–11):

| Family | Changed cells in file | Old: read · check · save · total | New: read · check · save · total |
|---|---|---|---|
| GALE-JACKET (21 products, 130 listings) | 40 | 1.6 s · 6.6 s · 75 s · **85 s** (284 false problems, 5 failed) | 0.9 s · 0.3 s · 7.4 s · **12.2 s** (0 problems, 0 failed) |
| VENTRA-JACKET (41 products, 136 listings) | 136 | not measured | 1.0 s · 0.8 s · 16 s · **20.5 s** (12 real problems: Amazon ES title > 200 chars) |

- Positive controls: every edited shared name read back from the DB; Undo put every value back (20/20, 41/41).
- D1 (a): 0 `CONTENT_UPDATE` rows queued by an import (was: one per following listing).
- Negative control: the file exactly as exported is refused with "This file changes nothing…".

**What changed (server):**
- `catalog-workbook.ts` — `changesOnly` reader (only changed cells, `#clear` / `#shared`, `expected` per cell); `style: 'sheet'` writer (no action columns, 8 plain instructions).
- `catalog-editor-workbook.ts` — `changesOnly` option, `kinds` + `exportId` on the parse result, readable tab names (`sheetTabNames`).
- `catalog-transfer-plan.ts` — the Shopify contract gets the store (metafields), read from the SAVED schema only; not saved → standard fields + a note.
- `catalog-transfer-export.ts` — `sheet` flag: a listing without an account is skipped with a note; undeclared stored values exported read-only (`undeclaredListingValues`).
- `catalog-transfer-jobs.ts` — the per-record save extracted to `applyTransferRecord` (old runner unchanged); `ignoreParent` dependencies.
- `catalog-transfer.service.ts` `applyTransferTarget` — options `queueOutbound`, `readCacheIds`.
- `master-content.service.ts`, `content-write.ts`, `translation-write.ts` — `queueOutbound: false` (default unchanged).
- `readiness-index.service.ts` + `lib/database-context.ts` — a whole-family readiness producer covers the scoped ones in one transaction.
- NEW `services/pim/sheet-transfer/sheet-import.service.ts` (engine), `routes/sheet-transfer.routes.ts` (7 routes), manifest line for the export, recovery on the 30 s timer.
- Found and fixed on the way: a changes-only save refused every listing of an unchanged variant whose parent the job changed (embedded parent in the dependency snapshot) → `ignoreParent`.

**Tests:** 35 existing files near the change: 449/450 → the 1 was the recovery list (updated). New `sheet-transfer.vitest.test.ts` 17 tests. API `tsc` clean.
**DS (sub-agent):** `FileRow`, `JobProgress`, `downloadBlob`/`downloadResponse`, `formatBytes`/`formatElapsed` in web + factory, catalog, CHANGELOG, DS-GAPS; 50 web + 23 factory tests; DS guards exit 0.

## 2026-09-26 — approved, step 0 started
- The Owner approved the plan: D1 (a), D2 (a).
- Claim written at the top of `docs/pes-claims.md` (shared checkout).
- Worktree `/private/tmp/nexus-product-sheet-import-export`, branch `feat/product-sheet-import-export` from `origin/main` 4f2e860b8.
