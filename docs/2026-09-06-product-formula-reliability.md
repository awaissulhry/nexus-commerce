# Product formula reliability and bulk editing — 2026-09-06

Follow-up: [September 7 quality verification](2026-09-07-product-formula-quality.md) adds durable recovery/history, transactional receipts, exact comparisons, enhanced readable controls and real PostgreSQL/browser Apply/Undo checks. Its results supersede the recovery and current-dialog-only limitations below.

Implemented the approved follow-up to the formula review. All work remains local, uncommitted and unpushed; the existing dirty workspace was preserved.

## Behavior

- Dependency evaluation uses full product/scope/channel/marketplace/locale identities and topological order. Successfully normalized results feed downstream cells. Cycles and upstream failures retain the last valid values with visible errors. Parent changes also recalculate formulas on variants that can inherit those fields. Channel-only edits stay within their marketplace; shared writes from a channel recalculate the shared sources.
- A valid expression and its materialized value commit in the ordinary product writer’s transaction. Replacing a formula with a literal removes the expression in that same transaction, including same-value replacements. Version conflicts cannot leave a new expression paired with an old value. Invalid expressions retain their error and the previous stored value.
- Preview uses the same evaluator, options, routing and ordinary writer validation as save. Formula metadata loads all rows, rejects incomplete metadata states and ignores stale reads. Saves serialize within each product and refresh the sheet once after the batch settles; refused drafts are retained.
- The sheet’s More menu offers **Apply formula to selected products…**. Select a writable field, choose **Apply values once** (default) or **Keep linked with formulas**, preview each product’s before/after values and apply the ready rows. Progress and per-product outcomes remain visible. Unknown transport outcomes ask for verification instead of claiming the old value was kept.
- One-time operations can read the field they replace, for example Brand with `=upper($brand)`. Linked formulas reject that circular reference. Preview fingerprints and calculation checks refuse stale operations.
- **Undo applied changes** restores prior values and formula metadata, including a previously errored formula’s last valid value. It refuses to overwrite newer product changes. Operation snapshots and progress are persisted in BulkOperation. The dialog runs one apply operation (in small batches) before requiring undo or close for another.
- Grid, drawer and bulk forms share completion, primary semantic text for source guidance, Insert field, Add text, abortable preview and retry behavior. Add text handles quotes and escapes. References continue to use named fields in the same product row, preserving their meaning after sorting or copying.
- Shared Modal now traps/restores focus, honors nested Escape handling, carries its originating dark theme and wraps footer actions. Shared changes are mirrored to Factory; formula grid adapters remain Web-only. Catalogs, changelogs and DS-GAPS document the additions.

## Verification

- Web: all 249 suites pass. The final full run passed 3,416 tests with 13 live tests skipped during local API availability; a separate rerun passed all 13 live tests. An earlier full run passed all 3,429 together.
- API: 12 focused suites, 102 tests pass. Covers dependency order, coordinate isolation, inherited variant updates, cycles, invalid values, atomic value/expression writes, literal replacement, stale previews, one-time self transforms, partial batches, uncertain outcomes and undo preserving newer edits.
- Web, API and Factory TypeScript checks pass.
- Web and Factory generated token checks pass. Web token guard passes. Raw-primitive and CSS-shadow ratchets, DS conformance and DS-GAPS append-only checks pass. `git diff --check` passes. Shared Modal source is byte-identical in Web and Factory.
- Browser: real eBay title/reference/text previews and bulk before/after preview; Brand self-transform in once mode and circular-reference refusal in linked mode; readable light/dark bulk layouts; Tab containment; 360px catalog form text building and save; grid formula reopening, literal replacement and Escape cancellation. Product data was only previewed and cancelled. Save/replacement UI tests used catalog sample rows; backend mutations used automated test fixtures.

## Existing guards and verification limits

Factory token guard started with 320 pre-existing violations in legacy shared styles; the modal text migration removes two, leaving 318. The fork guard reports a pre-existing export-order difference for SourceIndicator in components/index.ts. The token-resolution diagnostic still reports existing runtime-token definitions (grid metrics and tooltip positioning) as missing. None of these are introduced by the formula changes.

This is not a blanket WCAG AAA certification. Light/dark presentation and a narrow form were visually checked, but a full screen-reader and device matrix was not run. Bulk Apply/Undo were tested with automated fixtures; no live product bulk operation was performed. Undo is offered in the current dialog; persisted recovery records are not yet exposed as a separate formula-history screen. A lost apply response can leave an uncertain result requiring a reload and inspection.
