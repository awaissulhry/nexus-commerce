# CFI — progress

## 2026-09-25 ~05:00 — UI checked in a real browser; last fixes in; the Owner said "push it all to production"

- Real-browser check (L6; API + web from the worktree on `nexus_cfi_ui_test`, disposable user, Playwright, light/dark/390 px/keyboard):
  flows a–h work (DE file review 1.3 s; MOSS DE link confirm; GALE DE deletes ticked per file SKU; AIRMESH "Save the ready records";
  wrong File type 1.3 s instead of > 8 min; REGAL root eBay file; product drawer with `.xlsm`). Screen defects 2–7 fixed by L5
  (honest blank-policy sentence, "some records need correction" wording, marketplace follows the file, full-width choices, button
  words, record labels, locale numbers).
- The "stuck at Checking your complete file" jobs were the harness deleting its user mid-job — NOT CFI (reproduced on the pre-CFI
  code 4984103d1 too). It exposed two PRE-EXISTING defects, fixed: the recovery timer ran without a business profile (so since 09-16
  an import interrupted by a restart/deploy was never recovered) → now per business; a job whose user lost access could not write
  FAILED → now written under the business with a null actor.
- Final: API `tsc` 0 · web `tsc` 0 · import area 397 passed / 14 skipped / 0 failed · web 151/151. Commits on `cfi/build`:
  `ce2e3d9f1` (server), `124c31d43` (web), fix commit (recovery + marketplace), docs.

## 2026-09-25 ~03:40 — built, reviewed twice, proven on all 89 files (local copies); UI browser check running

- Review round 1 (1 HIGH, 3 MEDIUM, 3 LOW) and round 2 (6/7 fixed + 1 new MEDIUM: one tick confirmed an alias's delete too) — all
  fixed by the owning lanes with tests that fail when reverted. Contract now: delete confirmations name the FILE's SKU only; an
  ASIN-only match never records a seller SKU; a delete ends only the listing that holds the file's seller SKU; price CAS on the
  reviewed version + reviewed sale window.
- Final checks (main session, after every lane's mutation run had ended): API `tsc` 0 · web `tsc` 0 · import-area vitest 27 files,
  388 passed, 14 skipped, 0 failed · web 142/142 · whole API suite 11,677 passed / 4 failed — all 4 in `database-target.vitest.test.ts`
  + `variation-quality.vitest.test.ts`, which assert the database is named `nexus_development` (the worktree uses a test copy on
  purpose): environmental, not a regression.
- Lanes' mutation checks (sha256-restored): L1 25, L2 51, L3 33, L4 24, L5 24 — all caught.
- **Proof 3 (final code, fresh copy `nexus_cfi_proof3_test`, FINAL + eBay applied) — `records/proof/2026-09-25-proof-3-final.md`:**
  89 files · ledger clean on all (273,125 cell decisions, 0 unaccounted/duplicated/dangling) · round trip 45,083 / 45,083 equal ·
  prices 1,047 / 1,047 · eBay custom specifics 1,266 / 1,266 · blank-clears: 2 cleared, 93,316 already empty · no listing ended
  unasked · 0 outbound queue rows · control caught. FINAL + eBay: 37,126 changes; 859 refusals, all with a reason: 518 unadopted eBay
  `-ALT` shells (this copy; production adopted GALE's on 09-15), 170 local shipping-template check (needs a live Amazon read), 50
  local APPAREL schema, 41 AIREON eBay Item ID older than eBay, 48 MISANO link proposals (Owner confirms), MISANO file data (a SKU twice;
  5 products under two seller SKUs).
- Targeted runs: MOSS DE with the confirmed link `MOSS-JACKET → IT-MOSS-JACKET` → COMPLETED, 0 refused, seller SKU stored, no
  duplicate parent. GALE DE NEW TEMPLATE with 2 confirmed deletes → exactly those 2 DE listings ENDED (`channelFact ABSENT`), 17 stay
  pending with evidence.

## 2026-09-25 ~01:45 — wave 1 + L5 built; proof 1 run; review fixes in progress

- All lanes built (L1 door, L2 Amazon, L3 eBay, L4 planner/apply/door, L5 web) in `/private/tmp/cfi-build`. Checked by the main session:
  API `tsc` 0 · import-area vitest 27 files, 364 passed, 14 skipped, 0 failed · web `tsc` 0 · web tests 139/139. Lanes' mutation checks:
  L1 16/16, L2 33/33, L3 27/27, L4 21/21, L5 14/14 (+ 1/1 by main).
- Proof 1 (`records/proof/2026-09-25-proof-1.md`, DB `nexus_cfi_proof_test`, FINAL + eBay applied): 89 files; ledger clean on ALL (0
  unaccounted / duplicated / dangling); round trip 45,083 / 46,315 equal, 0 different (1,232 = eBay custom specifics, not in the
  product-sheet export → now read back from the listing); prices 1,047 / 1,047; blank-clears: 2 values cleared, 93,316 already empty;
  0 outbound queue rows created. Remaining refusals explained (unadopted eBay shells 518, local shipping-template check 170, local APPAREL
  schema 50, MISANO two seller SKUs per ASIN 225, AIREON eBay Item ID older than eBay 41, MISANO link proposals 48).
- Independent review: 1 HIGH (a confirmed Amazon delete could end the PRIMARY listing when the seller SKU belongs to an alias / second
  offer), 3 MEDIUM (price CAS on a fresh version; eBay duplicate first row applied under readyOnly; delete confirmation carried into
  later re-checks), 3 LOW. All sent back to the owning lanes with tests.

## 2026-09-25 ~00:30 — BUILDING (R-CFI-1: Q1 a, Q2 a, "go ahead")

- Worktree `/private/tmp/cfi-build` (branch `cfi/build` from `pes/phase-0` 4984103d1); packages installed; `packages/shared` +
  `packages/events` built; baseline `tsc` 0 errors; import-area vitest 19 files / 255 passed / 3 skipped.
- Test database `nexus_cfi_test` (fresh copy of `nexus_development`; cached Amazon schemas marked fresh on the copy only).
- Contract: `BUILD.md` (§1 shared fields — added to `packages/shared/catalog-transfer.ts` in the worktree and built; §4 decisions D1–D8).
- Wave 1 running in parallel: L1 door (CFI-1), L2 Amazon reader, L3 eBay reader, L4 planner/apply/price door. Wave 2: L5 web, then
  CFI-9 corpus proof, mutation checks, commit, merge into `pes/phase-0`.

## 2026-09-24 ~23:45 — §6 measured; plan waits for the Owner

- **Done (measure only, no product code, no production read or write):** §0 written (`PLAN.md`); all 89 corpus files classified
  (`records/2026-09-24-corpus.md`); every file run through the existing import paths on a PRIVATE copy of the local database;
  14 staged previews; 16 eBay files through the product-sheet drawer; round trips A (product sheet, 955/955 + a caught control) and
  B (flat-file native export: the import is invisible there). Predictions were written first; score in `records/2026-09-24-results.md` §6.
- **Waiting:** the Owner's ruling on amendment CFI-A1 (`PLAN.md` §4), questions Q1 (record actions) and Q2 (prices).
- **Left in place, local only:** the database copy `nexus_cfi_20260924` on the local Docker postgres (2.1 GB; its cached Amazon
  schemas were marked fresh, on the copy only). Drop it with
  `docker exec da8f355df40b dropdb -U postgres nexus_cfi_20260924` when the lane closes.
- **Not committed:** `docs/channel-file-import/{PLAN,PROGRESS}.md`, `records/**`, and the claim row in `docs/pes-claims.md`.
- **Tools to re-run any measurement:** `records/tools/` (`run.mjs` guards the database by name and blanks production keys).
