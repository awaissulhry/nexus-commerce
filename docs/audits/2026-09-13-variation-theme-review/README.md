**Variation Theme review — 13 September 2026**

**Verdict: changes are needed before quality sign-off.** The new column has a useful UI foundation, but shared rules, coordinate isolation, effective values, validation, and publishing do not yet form one consistent contract. Passing the existing tests does not establish that the feature is correct end to end.

This review examined the current working tree, including its pre-existing uncommitted changes. Application source and catalog data were not changed. Only this audit directory was added. No marketplace publication, deployment, or commit was performed.

**Confirmed findings, in recommended repair order**

1. **P1 — Shared rules are stored but do not reach the sheet or its effective projection.**

   `studio-sheet.service.ts:1667` calls `buildVariationThemeCells` without its `rule` argument. The builder defaults that input to null (`variation-theme-facts.ts:307`). The only production caller of `getVariationRule` is the mapping-page view service; neither the sheet nor projection reads it. Even when a rule is injected into the pure eBay resolver, its mapping affects the source label but does not affect the delivered axes: a rule named “Only size” produces “Follows rule Only size” alongside both Colore and Taglia. See `variation-rules.service.ts:652` and `:697` and the `ebayRule` probe.

   **Change:** resolve the category/channel rule once per actual account, market, category, and alias context; apply its ordered included mappings, not just its label. Feed that result to the sheet, projection, readiness, and relevant publishing paths. Test a saved rule through a fresh sheet read and payload construction.

2. **P1 — The sheet and projection give contradictory answers for the same listing.**

   Read-only local requests on GALE-JACKET produced the following. Each sheet/projection pair has the same listing version.

   | Coordinate | Version | Information sheet | Projection endpoint |
   |---|---:|---|---|
   | Amazon IT | 87 | COLOR/SIZE, Colore / Taglia, 0 collisions | null theme, both targets null, 20 colliding variants |
   | Amazon DE | 13 | COLOR/SIZE, Farbe / Größe, 0 collisions | null theme, both targets null, 20 colliding variants |
   | Shopify GLOBAL | 4 | Color · Size, derived | both targets null |

   `getProjectionRead` uses `readStoredMapping` at `family-projection.service.ts:1283` and the raw stored theme at `:1583`; the sheet uses the new resolver. This changes the facts used by mapping controls, validation, and plans. The legacy Amazon mapper also refuses an absent stored theme (`amazon-mapper.service.ts:95`), so a derived label alone does not prove publisher acceptance.

   **Change:** expose one effective projection plus separate stored-override facts. All consumers should agree on the effective theme, bindings, included variants, and collisions. Keep “derived,” “saved in Nexus,” and provider verification as distinct facts.

3. **P1 — An eBay coordinate edit can change other markets and fail to change its own effective set.**

   `writeProjectionMapping` updates `Product.variationTheme` at `family-projection.service.ts:1836`, while the listing update changes `_axisNameLabels` but preserves `_variationAxes` (`:1831`). Readers prefer a nonempty coordinate `_variationAxes` over the product theme. The probe removes Size on one coordinate: the product theme becomes Color, but that coordinate retains `[Color, Size]`. Other coordinates that use the shared product fallback now see Color. Reset similarly preserves that shared product theme, so it need not return to a rule or derivation.

   **Change:** write the complete set/order/name override to the addressed listing; do not mutate the shared product theme through a coordinate edit. Define an explicit empty override separately from inheritance. Test two markets and two aliases together, including resetting one of them.

4. **P1 — API validation does not enforce the editor’s live-listing and schema restrictions.**

   Reset returns before collision and live-lock validation (`family-projection.service.ts:1727`). The lock compares only canonical axis keys (`:1778`), not the theme code or target names. There is no validation of `input.theme` against the theme enum. Target validation is skipped when a non-freeform coordinate has no target options (`:1756`). Isolated execution of the actual write body accepted all of these: reset on a live Amazon listing; COLOR/SIZE → SIZE/COLOR with unchanged mappings on a live listing; `NOT_A_THEME`; and `invented_attribute` when schema targets are unavailable. Positive controls confirm that an ordinary live axis removal and an invalid target against a populated option list are refused.

   Explicit Amazon mapping targets also bypass schema binding in `amazon-publish.adapter.ts:495`, so the publisher is not a complete second validation layer.

   **Change:** build and validate the proposed effective projection before every mutation, including reset. Check enum membership, selected-theme bindings, missing schema state, collisions, live theme/target changes, and channel-specific ordering. Use the same decision for the cell, dock, API, and plan.

5. **P1 — The Amazon/Shopify/Etsy version guard has a race.**

   The transaction reads `version`, checks it, then updates with `where: { id: listing.id }` (`family-projection.service.ts:1847–1853`). It does not specify serializable isolation or an atomic version predicate. Another writer can commit between the read and update, allowing an old edit to overwrite newer data. The in-memory interleaving probe demonstrates the missing predicate; it is not a real concurrent database test. The equivalent eBay positive control rejects the intervening version change because its update includes the observed version.

   **Change:** use an atomic id-and-version update and check the affected row count, returning a named 409 on failure. Add a real two-writer database test on disposable local data.

6. **P1 — Some saved edits are misrepresented on readback.**

   For Shopify/Etsy, `resolveNamedAxes` iterates every family axis and sets `included: true`, even when an explicit whole-list override omits an axis (`variation-rules.service.ts:741`). A stored mapping containing only Color → Finish reads back Finish plus Size, with no drops. Separately, eBay’s resolver prioritizes a matching category aspect over `_axisNameLabels` (`:684`), so explicit target choices can be hidden by the displayed defaults. Both behaviors are reproduced by the probe.

   **Change:** distinguish absent override from an explicit mapping, including an empty mapping. Preserve deliberate omissions and explicit targets through save → reload → export → payload. Defaults should only fill inherited values.

7. **P1 — Shopify names and later ordering changes do not reliably reach its content publisher.**

   `shopifyAxisOrder` only reorders family keys and deliberately ignores target names (`shopify/content-workspace.service.ts:27`). It is used only when `_nexusContent` does not already exist (`:67–73`). Once a saved content document exists, its own axes win. `content-publisher.ts:251` builds published options from that document’s axes. Consequently, selecting Color → Finish in this column can display Finish while publication uses the family/content name; later sheet reordering does not update an existing document.

   **Change:** establish an explicit relationship between the column and the content document. Either project the selected names/order into publishing with stable value keys, or clearly show that the content document overrides the column and direct editing to the authoritative surface. Verify an already-initialized Shopify listing, not only a newly built draft.

8. **P2 — Mapping-page collision counts are estimates presented as measured outcomes.**

   `simulateVariationRule` treats dropping any family axis as a collision (`variation-rule-view.service.ts:301`) without reading child combinations. Red/S and Blue/M remain unique after dropping Size, but the actual simulation returns `wouldCollide: 1`. The page read also hardcodes `wouldCollide: 0` (`:236`). `familiesFor` filters `Product.productType` for every channel, including eBay category IDs, and does not require a listing on the selected coordinate; this also needs correction before its affected-family counts can be trusted.

   **Change:** count actual included child combinations under the proposed effective projection, scope the family cohort using channel category/listing data, and show “not evaluated” when that calculation has not run. Keep estimates explicitly labeled as estimates.

9. **P2 — Responsive presentation and instructional text contrast need work.**

   At 1440×900, the popup is 420×320. At 390×844, it is clamped to 161px at x=229, and the header, theme labels, and axis-row controls overflow or clip. The popup’s dimensions fit the viewport; its contents do not. See [narrow screenshot](editor-narrow.png). `AxesPanelEditor.tsx:1220` constrains width to the space right of the cell, but the layout is not usable at that width.

   In light mode, “Esc discards · ⏎ saves” is 11px with measured color `rgb(126,135,150)` on white: **3.62:1**. The CSS uses `--nds-text-3` for this and other small hints (`grid/theme/grid.css:1527`, `:1543`, `:1551`), contrary to DESIGN.md’s text-token guidance. Ordinary text needs 4.5:1 for WCAG AA and 7:1 for AAA. [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-enhanced)

   **Change:** use semantic text tokens that meet the required contrast, preserving Nexus density and typography. Add a usable narrow-host layout or make room for the editor through the shared grid behavior. Verify focus and all controls at narrow widths. This audit is not a WCAG certification.

10. **P2 — Factory mirrors and design-system documentation are incomplete.**

    The factory copy lacks `grid/editors/AxesPanelEditor.tsx`, `grid/renderers/variationTheme.tsx`, and the corresponding `sheetWriter.ts`, `sheetColumn.ts`, and `shapeColumn.ts` paths. Shared `grid.css` and `Listbox.tsx` are identical. The drift guard passes because it compares files present in both apps; it does not detect missing counterparts (`scripts/check-ds-fork-drift.mjs:64`). The editor/renderer are exported from the web grid barrels, and gaps are recorded in DS-GAPS, but the web/factory catalog READMEs and changelogs have no Variation Theme entry.

    **Change:** complete the required factory integration without overwriting unrelated work, document the controls, and add an explicit required-mirror check so a green drift result cannot hide missing new files.

**Additional corrections worth including**

- Compute `addableAxes` after applying the channel limit. It currently runs first (`variation-rules.service.ts:777`): four Shopify family axes yield one dropped axis but an empty addable list in the probe.
- Use the `no-theme` state when a cached Amazon schema was read successfully and declares no themes; the cell currently reports unavailable for an empty enum.
- Make unbound readiness severity match the actual publisher refusal. The resolver currently emits a warning, while the Amazon adapter refuses the child submission (`variation-rules.service.ts:899`; `amazon-publish.adapter.ts:315`).
- Normalize the displayed English vocabulary: the local shared sheet says “Color”; Amazon editor axis labels say “Colour.” This is lower priority than data correctness.
- Keep the existing “Nexus draft autosave” explanation. It correctly distinguishes a local save from confirmed provider delivery.

**What was verified**

| Check | Result and scope |
|---|---|
| Focused web tests | 7 files, 202 tests passed: variationTheme, AxesPanelEditor, themeChangePlan, themePlanAsk, variations, variationMappingFilter |
| Focused API tests | 11 files, 185 tests passed: variation-rules, variation-theme-segments, variation-rule-store, variation-rule-view, shared-variation-values, variation-ebay-precedence, family-variation-axes, family-projection, theme-change, variation-mapping-filter |
| API database target | Test config reported 127.0.0.1 / nexus_development. No production override enabled. |
| Type checks | API and web passed |
| Tokens | Generated CSS consistency passed; initial sandbox socket refusal was rerun successfully with escalation |
| Static UI guards | AG Grid import boundary, raw-primitives ratchet, and dark-alias scope exited 0. The raw-primitives report still lists historical controls elsewhere; this is not a clean-control inventory. |
| DS drift | No new differences among existing counterparts; 156 shared files, 8 baseline differences. Missing files found separately as above. |
| Local HTTP reads | One 160px axes column on shared, Amazon IT/DE, eBay IT, Shopify GLOBAL, and Etsy GLOBAL sheets. All checked child rows had null theme values. |
| Locale labels | Amazon IT displayed Colore / Taglia; DE displayed Farbe / Größe |
| Browser | Signed-in GALE-JACKET Amazon IT: Enter opened editor, Escape closed it; source/schema date/lock reason visible; light and dark inspected; 390px clipping reproduced. Appearance and viewport restored. No save submitted. |
| Browser console sample | No error/warning entries returned in the inspected sample; this does not cover every UI state. |
| Isolated probes | Real resolver imports and source-extracted production write/simulation bodies with in-memory dependencies; no database or provider writes. Three positive controls refused as expected. |

**Limits and follow-up acceptance**

The Etsy GLOBAL sheet read succeeded, but the projection request without a resolved Etsy account returned `WORKSPACE_SCOPE_MISMATCH` (400). A correctly resolved Etsy account/market and its publishing flow remain unverified. No real save→database→provider round trip, multi-account/alias write, or full screen-reader interaction was performed in this audit. Live theme-change execution and alias splitting remain held capabilities in the implementation; this review did not enable them.

Single local sheet requests took 134ms shared, 362ms Amazon IT, 315ms Amazon DE, 148ms eBay IT, 14,569ms Shopify, and 116ms Etsy. These are individual samples, not a performance benchmark. Shopify’s slow first sheet request needs investigation; the evidence does not attribute that delay to this column.

Before sign-off, require one acceptance matrix spanning shared rules, category rules, coordinate overrides, alias/account isolation, reset, no-op, reorder, removal, invalid/unavailable schemas, real collisions/non-collisions, stale saves, and live-listing restrictions. Each permitted edit should be checked against a fresh sheet read, projection read, readiness result, and the payload used by its actual publisher. Run provider verification only on deliberately chosen test listings with that action authorized.

**Reproduction artifacts**

- [Isolated probe](probe.mts) → [results](probe-results.json). Run from the repository root: `node --import tsx docs/audits/2026-09-13-variation-theme-review/probe.mts`.
- [Read-only local API script](read-local.mjs) → [results](local-read-results.json). Run with the local API on 8091; it uses existing GALE-JACKET coordinate IDs and only GET requests.
- [Light editor](editor-light.png), [dark editor](editor-dark.png), [narrow editor](editor-narrow.png).
- [Source hashes and validation record](manifest.json) identify the reviewed files and verification commands.
