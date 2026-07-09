# eBay Flat-File Excellence (EFX) — research findings + phased proposal

**Date:** 2026-07-09 · **Status:** AWAITING APPROVAL — no code changes yet.
**Trigger:** operator listed the Arianne jacket + pants family (axes: Tipo di prodotto × Colour × Size) and hit: glitchy/overlapping variation-order tools, a Variation Theme column that doesn't drive anything, "missing columns" (Team Name), images unmanageable for a non-colour axis and for multiple parents, no image reuse across rows. Also wants the Follow/Buffer columns audited to zero-error standard.
**Research:** 4 parallel read-only agents (2026-07-09). All findings carry file:line evidence.

---

## A. Findings — Variation axes & theme (10 defects)

| # | Defect | Severity |
|---|--------|----------|
| D1 | "Variation order" modal seeds from `GET /api/ebay/cockpit/variation-matrix` — **endpoint doesn't exist (only PATCH is registered; GET is `/variation-cells`)** → 404 → saved axis order never loads back; every reopen resets to scan order. `VariationValueOrderModal.tsx:179` vs `ebay-cockpit.routes.ts:564,406` | HIGH |
| D2 | `variation_theme` column is **push-dead**: push derives the axis SET only from `aspect_*` columns with >1 distinct value (`ebay-variation-push.service.ts:456-473`); theme/`_variationAxes` never consulted for the set. Operator's typed theme has zero effect on which axes eBay gets | HIGH |
| D3 | Two divergent value-order stores: modal writes `_axisValueOrder` (synonym-keyed), cockpit card writes `_axisSortOrder` (raw-name-keyed); push merge prefers the former → **cockpit value-order edits silently ignored once the modal has saved** (`push:373-378,568`) | HIGH |
| D4 | Theme separator chaos: create splits on `,`; cockpit + buildFlatRow on `[/,|]`; themeAxes.ts on `[,/]`; **none accept `;`** — "a;b;c" becomes ONE axis name | MED |
| D5 | Create-time `extractVariantAttributes` is exact-name (no synonyms): theme "colour" + rows `aspect_Colore` → empty `categoryAttributes.variations` → cockpit matrix and push disagree (`ebay-flat-file-create.logic.ts:99-100,212-224`) | MED |
| D6 | Editing theme after creation updates only `Product.variationTheme` — never recomputes `variationAxes`/children variations → declaredAxes drift (`ebay-flat-file.routes.ts:660-670`) | MED |
| D7 | Single-value axes silently vanish from modal + push + eBay, no warning (`variationValueOrder.pure.ts:110-113`, `push:470-473`) | MED |
| D8 | Fingerprint dedup can drop/rename the operator's custom axis (the AIREON "Team Name" vs "Tipo di prodotto" case; 0c1bf6f2 fixed coverage-pick but operator's chosen name can still lose ties) (`push:141-166`) | MED |
| D9 | Modal persists axis order only when >1 axis (`VariationValueOrderModal.tsx:221`) | LOW |
| D10 | Cockpit card never writes `_axisValueOrder` (pairs with D3) | LOW/MED |

Also: **four** copies of the axis-synonym table (`variationValueOrder.pure.ts`, `ebay-variation-push.service.ts`, `EbayPanel.tsx`, comment in `ebay-columns.ts`) and 2 copies of STANDARD_SIZE_ORDER_MAP; three overlapping axis-editing surfaces (flat-file modal, cockpit VariationsMatrixCard, images EbayPanel) — the operator's "three glitchy tools".

## B. Findings — Columns / "Team Name"

- Aspect columns ARE already dynamic (eBay Taxonomy `get_item_aspects_for_category` → `GET /ebay/flat-file/category-schema` → `buildCategoryColumns`, 24h caches). The static part is only the fixed scaffolding in `ebay-columns.ts`.
- **"Team Name" was never a grid column.** It's a leftover Amazon aspect on AIREON (`Team Name = {Giacca, Pantaloni}`) that shadowed the real `Tipo di prodotto` axis; it surfaced only as the push error "Missing variation aspects: Team Name" with **no column to fix it in** (not in eBay's category schema). Commit 0c1bf6f2 (2026-07-09) stops it blocking the group; the underlying hole (hidden row data with no column) remains.
- **Only ONE category schema loads at a time** (`EbayFlatFileClient.tsx:688,917`): a multi-category sheet (jacket + pants categories) shows only one category's aspect columns.
- **Schema-fetch failure ⇒ ALL Item Specifics columns disappear** while row data persists (`categoryColumns=null`) — the literal "columns went missing" symptom. No DB fallback (though `ebay-schema-sync.service.ts` already persists CategorySchema rows).
- Orphan `aspect_*` row data not in the current schema is invisible in grid + AspectsPanel yet still round-trips to eBay (`buildFlatRow:1824-1845` / `packSharedFields:1930-1940`).
- No required-aspect preflight (only the variation-axis coverage check at `push:612-641`); required-aspect misses become eBay 25xx at publish.
- Feature-gap columns (push reads or eBay supports, grid can't edit): `merchant_location_key` (push reads it at `:1069`, no column), parts **compatibility/fitment** (absent entirely — high value for motorcycle gear), video, images capped at 6 (eBay allows 24), best_offer_* stored but never sent (`push:1134-1152`), quantityLimitPerBuyer hardcoded 10.
- Only the ACTIVE market's column group renders — switching markets hides columns, easily mistaken for loss.

## C. Findings — Images

**eBay platform constraints (verified against official docs):**
- Images can vary by **exactly ONE aspect** per listing — but **any aspect qualifies**, not just Colour. `aspectsImageVariesBy` (Inventory) / single `VariationSpecificName` (Trading). So "jackets vs pants get different image sets" IS achievable by making the image axis = Tipo di prodotto.
- Varying by Colour **and** Tipo di prodotto simultaneously is **impossible on eBay** — platform limit, must be surfaced honestly in UI.
- Omitting the vary-aspect ⇒ one shared gallery (our shared-gallery mode). Trading limit 12 pics/variation set.

**Gaps found:**
1. Axis picker: modal dropdown only shows axes present in children's `variantAttributes` (`images-workspace.routes.ts:211-218`) — a custom axis living only in `aspect_*`/categoryAttributes never appears, forcing colour. Dropdown also hidden when only 1 axis.
2. Explicit operator pick can be **silently demoted**: if fingerprint dedup removes the chosen axis, `pictureAxisOverride` no longer matches and push falls back to colour (`push:508-512`). Resolved axis is never shown back to the operator.
3. Multi-family: `EbayFlatFileImageModal` already stacks a `FamilySection` per parent with Save All/Publish All — but families derive from `initialRows` (SSR snapshot) not `latestRowsRef` (`EbayFlatFileClient.tsx:1590-1600`), sections all eager-load (N fetches), Publish All loops N single publishes (bulk endpoint exists but drops activeAxis+marketplace, `bulk-image-publish.routes.ts:120`), no per-family status overview.
4. Image reuse blocked **by design**: `assign` removes a URL from every other bucket (modal:229-230); cell drags are moves not copies; only all-or-nothing Default/SHARED inheritance. Server + eBay fully tolerate duplicate URLs — the block is purely the modal invariant.
5. Cap mismatches: modal allows 24/bucket, rep-set path slices to 6, group cover 12, curated overrides not clamped at all (can exceed eBay's 12).

## D. Findings — Follow/Buffer audit (invariants intact; 4 confirmed defects + 5 suspicious)

Invariants A–E (never write pool / FBA untouchable / no version bump / pin writes 3 columns+enqueue / buffer = pool−buffer incl. cascade + live push clamp) — **all INTACT on live paths**. Residual defects:

| # | Defect |
|---|--------|
| FB1 | **Garbage in Amazon `follow` column force-pins Following rows**: content save writes `followMasterQuantity:false` for any qty row whose follow ≠ exactly 'Follow'/'Pinned' (`amazon/flat-file.service.ts:2598-2602`); `commitCells` doesn't validate enum/selectionOnly on paste/fill (`FlatFileGrid.tsx:1317-1329`). Sibling of the fixed force-pin bug. eBay unaffected |
| FB2 | Follow/buffer applied to rows whose **content save FAILED** (capture never filtered against error SKUs; pin then snapshots stale DB qty) — both clients |
| FB3 | Drift detector baseline wrong: uses gross `totalStock−buffer` vs cascade's reserved-adjusted available ⇒ permanent false INVENTORY_MISMATCH for reserved stock; also doesn't exclude FBA (`sync-drift-detection.job.ts:172-176`) |
| FB4 | Amazon inline buffer edit on a Pinned row silently dropped (capture requires follow==='Follow', `AmazonFlatFileClient.tsx:3685`); eBay + bulk path store it — inconsistent |
| FB-S1 | New/unpublished rows: typed follow/buffer silently dropped (no `_productId`/listing) — no warning |
| FB-S2 | eBay `_shared`/`_readonly` membership rows not excluded from follow/buffer capture (push filter has the exclusion, capture doesn't) |
| FB-S3 | Client FBA regex vs server isFbaListing can disagree (server fail-closed wins — cosmetic counts only) |
| FB-S4 | Concurrent bulk buffer + bulk follow can interleave (follow snapshot holds pre-buffer stockBuffer) — self-heals on next cascade |
| FB-S5 | eBay content save writes qty unconditionally for Following rows; corrected only when the follow cell is valid |
| FB-E | Legacy payload builders (amazon/ebay/shopify-sync.service) compute from totalStock and drop buffer — inert today, regression hazard; Shopify live-push clamp unverified |

---

## Proposed phases (each: implement → verify on prod face-to-face → commit+push → next)

- **Phase 1 — Follow/Buffer hardening (both editors).** FB1 (server treats non-enum follow as no-signal, never force-pin + grid enum/number enforcement in commitCells), FB2 (skip apply for failed-save rows), FB3 (drift baseline = reserved-adjusted available + exclude FBA), FB4 (Amazon/eBay parity for pinned-row buffer), FB-S1 (toast when intent dropped), FB-S2 (exclude shared/readonly rows), FB-E (regression tests: live push subtracts buffer; buffer-correct or retire dead builders). Optional: FB-S4 fresh stockBuffer read inside the follow tx.
- **Phase 2 — One source of truth for variation axes.** D1 (modal seeds from the real endpoint), D2 (theme/`_variationAxes` become authoritative for the axis SET: declared axes seed variesBy.specifications, values filled synonym-aware from aspect columns, stray non-declared aspects suppressed — kills the Team Name class at the root), D8 (operator-declared/picked axes exempt from fingerprint dedup), D4 (one shared parser `[,/|;]` everywhere), D5+D6 (synonym-aware create; theme save recomputes variationAxes + children variations), D7 (warn, don't silently drop single-valued axes), D9/D10 along the way.
- **Phase 3 — ONE ordering tool.** Collapse the three overlapping surfaces: shared axis+value ordering component used by the flat-file "Variation order" modal and the cockpit VariationsMatrixCard (and feeding the images axis picker); one shared axis-synonym + size-order module (4 copies → 1); one store (`_variationAxes` + `_axisValueOrder`, retire `_axisSortOrder`).
- **Phase 4 — Dynamic columns that can never go missing.** Union aspect manifest across ALL categories in the sheet (mirror Amazon's `mergeManifestsIntoUnion`, tag applicable/requiredForCategories); orphan-aspect "ghost columns" (any `aspect_*` on rows with no schema column becomes visible + editable, flagged); DB-backed schema fallback via existing CategorySchema sync (columns survive eBay API outages); required-aspect preflight pointing at the exact column; market-switch clarity.
- **Phase 5 — Images: axis of my choice + honest feedback.** Axis picker always visible incl. custom axes (union availableAxes from variantAttributes + aspect/variation keys) + explicit "one shared gallery" option; operator pick survives dedup end-to-end; publish result shows the RESOLVED axis (never silently colour); clamp caps (12 variation / 24 group) consistently; UI copy states eBay's one-axis limit.
- **Phase 6 — Images: multi-family drawer.** Families from live grid rows; collapsed list with per-family status + lazy workspace load; Publish All via the bulk endpoint extended with per-product activeAxis+marketplace; per-family axis persisted (existing PATCH axis endpoint).
- **Phase 7 — Image reuse.** Same URL allowed in multiple buckets (drop the single-bucket invariant; keep in-bucket dedup); copy-vs-move drag modifier; "copy to values…" / "duplicate bucket" actions (reuse copy-scope pattern). No backend change needed.
- **Phase 8 — Live E2E sweep on the Arianne family.** Full walkthrough on prod: 3-axis theme of operator's choice, order axes+values, images vary by Tipo di prodotto, multi-parent drawer, reuse, columns complete across both categories, zero feed/publish errors; regression scripts kept in apps/api/scripts.
- **Phase 9 (backlog, separate approval)** — new capability columns: compatibility/fitment, video, images 7-24, merchant_location_key, wire best_offer_* into the offer body, per-market content fields.

**Constraints honored:** flat-file editors untouchable without approval (this doc IS the approval request); design-system components only; ship live with guards; verify on prod; commit+push per verified unit; FBA + pool invariants never weakened. Subagent/implementation work runs on Opus 4.8 per operator directive.
