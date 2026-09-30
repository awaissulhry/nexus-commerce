# WP6 report — channel truth and one verdict for every path

Branch `claude/ultra-code-subagents-product-sheet-neormx-wp6`, based on `25725970`. Findings A20–A32.

## Outcome per finding

| id | outcome | commit | test | notes |
|---|---|---|---|---|
| A20 | fixed | 4467421b | `pim/studio-sheet-verdict.vitest.test.ts` "A20 — …" | The cell carries `mapped.blocking` (publishVerdict). Readiness pushes an error only for a blocking finding, and a warn otherwise. The red "!" in CascadeCell reads `blocking` (web edit outside WP6, minimal: `channel/types.ts` + `CascadeCell.tsx`). |
| A21 | fixed | 4467421b | same file, "A21 — …" | `showEbayListingLevel` returns the cells now showing the listing's value. Those rows' issues for the field are re-judged on the listing's value, and completeness is recomputed. With no value anywhere the variation still reports it: an eBay aspect column is `per_variant`, so the parent row never judges it (see "Found along the way" 3). |
| A22 | fixed | 72eae67e | `products/ebay-listing-level-write.vitest.test.ts` "A22 …" (PGlite, profiles off and on); `pim/ebay-listing-level.vitest.test.ts`, `pim/studio-publication-plan.vitest.test.ts` "A22 …" | A clear (not a reset) stores an explicit blank on the parent and every variation (SET null instead of INHERIT), which stops their mapping. "Holds another value" now counts only rows that store the value (`storesOwnValue`, by provenance), in the sheet and in the review. |
| A23 | not changed (blocked) | — | — | See "A23" below. The fix needs WP5's content-write region of `bulk-edit.service.ts` (~:813, which diverts every localizable change to `applyContentBulk`) or the content writer. The P1(d) precedence itself is intended and pinned by a P1 test. |
| A24 | fixed | be583ac4 | `pim/studio-publication-plan.vitest.test.ts` "eBay family: a variation's listing fields are not sent and not judged" | On an eBay family, a variation's cell is judged only for what a variation sends: price, quantity and item specifics (the listing-level ones via reporterOf). A field the catalogue does not describe is still judged. |
| A25 | partial | 12baf814 | `pim/catalog-transfer-listing-level.vitest.test.ts` | The import review now warns: a variation SET of a listing-level aspect is stored but not what eBay receives; a parent CLEAR/INHERIT leaves variation copies that eBay then sends. It does not yet move the value to the parent or clear the family: that needs the bulk save's listing-level routing shared with `catalog-transfer.service.ts` apply (outside WP6). The loader also reads only listings of rows in the file, so the parent-clear warning cannot name the copies. |
| A26 | fixed | 87a1abd6 | `pim/one-verdict.vitest.test.ts` rows "(a) … Shopify", "(e) … Shopify" | One classifier, `shopifyFinding` / `shopifyValueFinding` (validate-channel-value.ts), serves the bulk save's Shopify branch and the import. Choices, limits, format and required are stored and warned. Only the type is refused. Applicability, `field.reason` and currency refusals are unchanged. |
| A27 | fixed | 87a1abd6 | `one-verdict` row "(d)" | `validateChannelValue(…, { write: true })`: a new write of 2+ values to a single-value field is 'type', in the editor's words ("takes ONE value — a list was sent"). A stored legacy list stays 'count'. A one-member list is not refused on import (a channel file can legitimately carry `["x"]`). |
| A28 | fixed | 87a1abd6 | `one-verdict` row "(e) … eBay" | `channelImportVerdict` adds the resolver's own required finding (`requiredFinding`, moved to validate-channel-value.ts and shared) on an import CLEAR. |
| A29 | fixed | 7113c202 | `pim/studio-publication-plan.vitest.test.ts` "A29 …"; `pim/information-validation-verdict.vitest.test.ts` "an Other item specific over 65 …" | The review runs the stored-specific check for single listings. The save warns for `other_specific_*` columns in informationChangeErrors (no bulk-edit change) with the same sentence (`ebayAspectLengthProblem`). |
| A30 | fixed | 7113c202 | `pim/studio-publication-plan.vitest.test.ts` "A30 …" | readPublicationFacts reads `pushExclusionsCache` per category, as the builder does, and skips excluded columns and stored specifics. |
| A31 | fixed | 204cd9a1 | `pim/mapping/cell-formula-save-verdict.vitest.test.ts` | The route returns the bulk PATCH's `warnings`, and setCellFormula/preview report them in place of the formula's own value and list checks. The formula's own check is now `validateChannelValue` (same sentences, `Label: message`). "May refuse it at publish" is said only where publish blocks off-list. |
| A32 | fixed | 3dbaf011 | `apps/web/…/sheet/AttributeShapeInput.vitest.test.ts` | `textLimitFor` instead of the cap. Count "n / cap" with the list editor's `nds-slotlist-count(.over)` and `aria-invalid`. No new classes. |

Every "fixed" test was run against the previous code (file swapped in from `git show HEAD:…`, then restored) and failed. The exception is the one-verdict table, whose rows call functions the fix introduced; its rows reproduce the per-path decisions quoted in A26–A28.

### A23 — proposed patch (not applied)
1. `studio-sheet.service.ts`: when the listing's own `platformAttributes` bag holds a non-blank value for the column's store and the content hit is not a pin, drop the content hit for routing and labelling, as `resolve-batch.service.ts:358` already does. The cell then routes `writeTarget: channelListing` with no `contentAddress`, and its source reads "this listing".
2. `bulk-edit.service.ts` (~:813, WP5): do not divert a change to `contentEdits` when it has `target: 'channel'`, no `contentAddress`, and a `platformAttributes` store. It then goes through the channel attribute writer, and reset (INHERIT) removes the bag entry.
Either half alone leaves the defect, so step 1 was not applied without step 2.

## The verdict table

Inputs: (a) off-list on a strict list; (b) off-list on an open list; (c) over-length; (d) a list on a single-value field; (e) an explicit clear of a required field.
Edit time: S = stored, W = stored with a warning, R = refused (that cell only). Publish time: B = block, w = warn, – = nothing.

**Before** (base `25725970`, from the reproductions):

| input | editor | Shopify editor | import (xlsx/sheet/CFI) | formula | readiness / cell mark | publish |
|---|---|---|---|---|---|---|
| (a) eBay strict | W | – | W | W, other wording ("may refuse it at publish") | **error / red "!"** | w |
| (a) Amazon strict | W | – | W | W, other wording | error | B |
| (a) Shopify choices | – | **R** | W | – | error | B |
| (b) eBay open | S | – | S | S | – | – |
| (c) eBay aspect 70 | W | – | W | W, **"The result is 70 characters; X accepts 65."** | error | B |
| (c) eBay title 92 on a variation | W | – | W | W, raw-length wording | error | **B (never sent)** |
| (c) "Other item specific" 70, single listing | **S (no warning)** | – | S | – | – | **– (eBay 21919308 at send)** |
| (d) Genere ["Uomo","Donna"] | R | – | **W ('count')** | W | error | B |
| (e) eBay Marca clear | W | – | **S (no word)** | W, "is required, and the formula resolved to nothing" | error | B |
| (e) Shopify required clear | – | **R** | W | – | error | B |

**After** (`pim/one-verdict.vitest.test.ts`, studio-sheet-verdict and publication-plan tests):

| input | editor | Shopify editor | import | formula | readiness / cell mark | publish |
|---|---|---|---|---|---|---|
| (a) eBay strict | W "Stagione contains an unaccepted value…" | – | W same | W, the save's sentence | warn / no red mark | w |
| (a) Amazon strict | W same | – | W same | W, the save's ("may refuse it at publish") | error | B |
| (a) Shopify choices | – | W "Choose one of these values: Rouge, Bleu." | W same | – | error | B |
| (b) eBay open | S | – | S | S | – | – |
| (c) eBay aspect 70 | W "Team name exceeds 65 characters (70)." | – | W same | W same | error | B |
| (c) eBay title 92 on a variation | W | – | W | W same | error on the parent only | not judged on a variation |
| (c) "Other item specific" 70 | W "Team name: eBay takes at most 65 characters per value; …" | – | S (see "Found along the way" 5) | – | – | B, same sentence |
| (d) Genere list | R "Genere takes ONE value — a list was sent" | – | R same | – | error | B ('count', stored legacy) |
| (e) eBay Marca clear | W "Field 'Marca' is required." | – | W same | W same | error | B |
| (e) Shopify required clear | – | W "Enter a value. Shopify needs this field." | W same | – | error | B |

## Commands run
- `npm ci`; `npm run build -w @nexus/shared && npm run build -w @nexus/events`: ok.
- Postgres: `pgvector/pgvector:pg17` in Docker (the first pull hit Docker Hub 429; the retry succeeded); `npx tsx scripts/ci/prepare-test-database.mts --url postgresql://postgres@127.0.0.1:5432/nexus_test`: ready.
- `npm run typecheck -w @nexus/api`: pass. `npm run typecheck -w @nexus/web`: pass.
- Targeted: studio-sheet-*, studio-publication*, value-verdict, information-validation*, ebay-listing-level*, one-verdict, catalog-transfer*, mapping/cell-formula*, routes/cell-formula*, products/ebay-listing-level-write (profiles 0 and 1), services/shopify, routes/products-bulk*, channel-mapping: all pass.
- Web: `npx vitest run src/app/products/[id]/edit/_studio/sheet/channel/` (294 passed, 13 skipped); AttributeShapeInput (2 passed).
- Area suites `src/services/pim/ src/services/products/ src/routes/cell-formula src/services/channel-mapping/`, profiles OFF and ON: run fresh on the final code (`12baf814`).
  - OFF: 2823 passed, 10 failed, 32 skipped. The 10 failures are the five environment-bound files in "Found along the way" 2.
  - ON: 2692 passed, 70 failed, 103 skipped. Those 70 are the same 10, plus 60 in 13 files (autosave-readiness, classification-transaction, content-history, content-write, family-variation-axes, information-database, mapping/formula-database, mapping/review-activation, product-relationship, studio-channel-provenance, studio-publication-database, studio-sheet-language-issue, theme-change). Most fail with "Select a business profile." These suites are not written for profiles ON. Run on the base commit `25725970` in a scratch worktree with the same flags, these 13 files fail identically (60 failed, 19 passed, 71 skipped), so none of the 70 is caused by WP6. My new and changed suites pass on both profiles.
- `node scripts/ci/run-static-gates.mjs`: 59/60. The failing gate is "migrations: expand/contract", only because `origin/main` is not fetched in this checkout. `NEXUS_MIGRATION_BASE=25725970 node scripts/check-migration-expand-contract.mjs` passes (0 new folders).

## Found along the way (not fixed)
1. **A `git stash` entry was left in the shared checkout.** While editing I ran `git stash -- studio-sheet.service.ts ebay-listing-level.ts` by mistake; the root CLAUDE.md forbids stashing here. The session's permission guard refused both `git stash pop` and `git stash apply`, so I re-made the same edits by hand; they are in 4467421b. `stash@{0}` ("WIP on claude/ultra-code-subagents-product-sheet-neormx-wp6: 25725970") holds only my superseded copy of those two files. It can be dropped (`git stash drop stash@{0}`) after checking that no other session added a stash since.
2. Environment-bound failures in the pim area suite, on both profiles, in files that import nothing I changed: `variation-ebay-precedence`, `variation-mapping-filter`, `variation-rule-view` and `variation-quality` need the local `nexus_development` catalogue (e.g. `expect(name).toBe('nexus_development')`, `variation-quality.vitest.test.ts:114`). `workbook-parse.vitest.test.ts` "kills its own worker … heap" answers 'refused' instead of 'heap' on this machine (Node 22; the repo wants ≥ 24).
3. `packages/shared/master-sheet.ts:79` `columnApplies` returns false for `per_variant` columns on a parent row, and eBay item-specific columns are `per_variant`. So a listing-level aspect that is missing on the whole listing is reported by every variation row, not once by the listing's row (the alias summary counts N errors where publish shows 1).
4. `studio-sheet.service.ts` readiness: an off-list value can carry two 'warn' issues on one field. One comes from the readiness validators (`readiness.service.ts:166-177`) and one from the mapped finding, with different sentences. Harmless for the state, but the warning count doubles.
5. The import has no check for an "Other item specific" over 65 characters on a CFI custom specific (`catalog-transfer-plan.ts`, the `specific` branch builds a field with no `maxLength`). It stores silently and publish blocks. Add `maxLength: EBAY_ASPECT_VALUE_MAX` to that synthetic field.
6. `catalog-transfer.service.ts:111` loads only the listings of the file's own rows. An import on one family row cannot see its siblings' stored copies, which A25's full fix needs.
7. `cell-formula.service.ts` `checkOptions`: the formula's own off-list warning ("… is not in the list for X (…). Saved as it is.") still differs from the typed sentence when the writer returns no warnings at all. With the real writer the save's sentence replaces it.
