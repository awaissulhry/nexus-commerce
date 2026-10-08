# Several case sizes per SKU (Owner 2026-10-08)

The Owner asked: a SKU may have several case sizes (for example 12 / case and 6 / case), not only one. Everything must
stay wired end to end and update in real time. The Step 3 and Step 4 tables were never released, so the migrations
`20261008v_case_packs` and `20261008w_fba_send` were rewritten in place (the private test databases were moved by hand).

## Data (done — commit "foundation")
- `ProductPackage` — one row per SKU: `fbaPrepOwner`, `fbaLabelOwner` only (AMAZON | SELLER | null).
- `ProductCaseSize` — one row per case size: `productId`, `unitsPerCase` (unique per SKU: the units NAME the size),
  `caseLengthCm`, `caseWidthCm`, `caseHeightCm` (Decimal 6,1), `caseWeightKg` (Decimal 6,2). Compound unique name
  `productId_unitsPerCase` (with workspaceId; use `workspaceKey({ productId, unitsPerCase })`).
- `StockCaseCount` — one row per (StockLevel, case size): `stockLevelId`, `caseSizeId` (FK → ProductCaseSize, ON DELETE
  CASCADE), `cases`. Compound unique name `stockLevelId_caseSizeId`. Removing a size removes its counts (cases → loose).
- `FbaInboundPlanLine.caseCounts` (Json, default `[]`) = `CaseCount[]` (`{ unitsPerCase, cases }`, biggest first).
  The old `cases` / `unitsPerCase` columns are gone.

## The rule (done — `@nexus/shared/stock-cases`)
- `CaseCount = { unitsPerCase, cases }`, `CaseChange = { unitsPerCase, change }`. Lists are biggest size first.
- A sale takes loose units first, then opens the SMALLEST case (big cases stay sealed): `sealedCases(stored, quantity)`.
- `countsFor(sizes, stored)` — every size of a SKU with its stored count (0 where none).
- `caseSplit({ quantity, reserved, cases })` → `{ sealed, loose, freeSealed, freeLoose }` (free = the clamp at quantity − reserved).
- `casesAfterMove({ cases, quantityAfter, casesChange? })` → `{ cases, opened } | { refused }`.
- `withCounts(base, typed)` — typed sizes absolute, the others kept. `caseCountProblem({ cases, quantity, sizes, locationType })`.
- `sizeProblem`, `sizesProblem` (≤ `MAX_CASE_SIZES` = 5, no units twice), `ownersProblem`, `amazonBoxWarning`.
- Words: `CASE_COPY.sizes([12, 6])` = `12 · 6 / case`; `CASE_COPY.split(sealed, loose)` = `4 + 3` (one size) or
  `2×12 + 1×6 + 3` (several); `CASE_COPY.cases(sealed)`; `noSizeOf(n)`; `tooManySizes`; `sameSize(n)`.

## Send to FBA (done — `@nexus/shared/fba-send`)
- `FbaBoxSku.caseSizes: FbaCaseSize[]` (`{ unitsPerCase, case: dims | null }`) replaces `unitsPerCase` + `case`.
- `FbaSendSku.freeSealed: CaseCount[]` (per size). `FbaSendLine.cases: CaseCount[]`. `FbaPlanLineView.cases: CaseCount[]`.
- `lineUnits(line)` (no second argument), `lineCases(line)`. `planBoxes` makes one case-box entry per SKU and size.
- Copy: `FBA_SEND_COPY.free(free, freeSealed[])`, `problem.overFreeCases(sku, unitsPerCase, asked, free, from)`,
  `problem.noCaseSize(sku, unitsPerCase)`, `problem.noCaseDimensions(sku, unitsPerCase)`.

## Real time (done — `packages/events/catalog.ts`)
`inventory.cases_changed` = `{ productId, locationId | null, counts: [{ unitsPerCase, before, after }], sizes: number[],
reason: 'count' | 'case-pack' }`. A count publishes ONE event with every size that changed; a case-pack change publishes
`counts: []` and the sizes after. The web maps it to the `inventory.stock_changed` invalidation (unchanged).

## The wire (to build)
1. Matrix read: `MatrixRowRead.pack: MatrixCasePack | null` = `{ sizes: MatrixCaseSize[] (biggest first), fbaPrepOwner,
   fbaLabelOwner }`. `null` = no owners row and no sizes.
2. `PUT /api/stock/case-packs` body `{ productIds (1..200), sizes?, fbaPrepOwner?, fbaLabelOwner?, openSealedCases? }`.
   - `sizes` absent = each SKU keeps its sizes. Present = each SKU's list becomes exactly this list, matched by
     `unitsPerCase`: a size with the same units keeps its sealed counts (its case size / weight are updated); a size
     not in the list is removed and its sealed cases open (409 `SEALED_CASES` unless `openSealedCases`); a new units
     value is added. `sizesProblem` refuses the list (every product answers `{ ok: false, error }`, nothing written).
   - An owner absent = keep; `null` = clear.
   - 200 `{ ok, results: [{ productId, ok, noop?, opened?: [{ locationCode, unitsPerCase, cases }], error? }], warning }`.
   - 409 `{ ok: false, code: 'SEALED_CASES', error, sealed: [{ productId, sku, locationCode, unitsPerCase, cases }] }`.
3. Stock editor read: per product `caseSizes: number[]` (biggest first; [] = none) replaces `unitsPerCase`; per level
   `cases: CaseCount[]` (every size of the SKU, clamped by the units, biggest first; [] = none) replaces `cases: number`.
4. Stock editor write: a cell change `cases?: CaseCount[]` (absolute per named size; sizes not named keep theirs)
   replaces `cases?: number`. Same refusal codes as before.
5. Send to FBA draft / create / drawer: the shared types above. Claude's create-plan tool takes
   `cases: [{ unitsPerCase, cases }]`.

## Screens (to build)
- Matrix Case column: `12 / case`, `12 · 6 / case`, blank, `Mixed` (parent, variants differ). Sort value = biggest size.
- Case pop-up: one row per size (Units per case · L × W × H cm · Weight kg · remove), "Add case size" (max 5), Prep by,
  Labels by. Parent whose variants differ: the sizes show "Mixed" with "Replace for all variants" (starts from the first
  variant's list); untouched = each variant keeps its own. Removing a size with sealed cases → the existing
  "Save · open N cases" confirm.
- Stock editor: per warehouse, one Cases column per case size of the family (biggest first). One size in the family →
  one column "Cases" exactly as today ("4 + 3"). Several → columns headed `12 / case`, `6 / case`; a cell shows that
  size's sealed count (editable when the row has that size, else locked "—"); the row's loose units show as "+ N" in its
  smallest own size column. A typed count is checked with the whole level (`withCounts` + `caseCountProblem`).
- Send to FBA dialog: the Cases cell has one stepper per case size of the SKU (one size → as today; several → each
  stepper labelled with its size), max = that size's free sealed cases. Plans drawer lines show the cases per size.
