# Cell editing in the Product Edit Studio — the approach (reviewed 2026-09-03 22:50)

**Status:** the Owner's decision, handed to session `nexus-commerce-b0` as its "go". Reviews that session's own corrected recommendation (16:24) against the industry standard (Excel, Google Sheets, Airtable) and amends one rule.

## What is already fixed (b0, 11:32, gated)
The editor that "sometimes did not open" was geometric, not a race: AG's fill handle (6 px, bottom-right of a SELECTED cell) swallows the second click of a double-click aimed at the end of the text — the first click selects the cell and creates the obstacle. Worse, those corner double-clicks fired fill-down PATCHes onto sibling rows (176 calls in the probe, all aborted at the network layer; on a lane's machine they would have landed on production). Fix in the engine: capture-phase `dblclick` on the grid wrapper → `startEditingCell`; drag-to-fill untouched; 720 gestures, 0 misses; gated in the pre-push suite. **Double-click ALWAYS edits; it never fills.** That ruling stands.

## The remaining defects (b0, measured)
1. Popup editors DISPLACE: AG anchors a popup at the cell's top-left and slides it sideways to stay in the window. The long-text editor is a fixed 488×158 whatever the content (−202 px on `product_description`); the formula editor has a 380 px floor (−79 px at the right edge). The select never displaces because it is the only editor sized `clamp(cell width, content, 320)`.
2. Blanking: `.ag-cell-popup-editing .nds-cell-value { visibility: hidden }` also hides the cell under an `under` popup — the Status cell reads as an empty blue box while its list is open.

## The industry standard, stated so the rule can be checked against it
Excel and Google Sheets edit IN the cell: the editor's top-left is pinned to the cell and never slides left; it grows to the RIGHT over neighbours while there is room, then wraps and grows DOWN; the cell being edited is always the one you are looking at, outlined; long content also lives in a formula bar above the grid. Airtable's expanded long-text editor is anchored to its cell, grows within the viewport to a comfortable cap, and never hides the origin. The constant across all three: **anchor fixed at the cell; width uses the room to the right; height follows the content; the origin stays visible.**

## The rule (b0's, amended in one place)
b0 proposed "width belongs to the cell, height belongs to the content". That over-corrects: a 2,000-character description would edit in a 160 px column, which no spreadsheet does. The generalisation of the select's rule — the one editor that already behaves — is:

> **width = clamp(cellWidth, contentWidth, min(cap, roomToRight))** · **height = clamp(cell height, content, heightCap)** with internal scroll beyond the cap · **the top-left is pinned to the cell and never slides** (the width term makes AG's clamp a no-op) · **the origin cell stays visible and outlined as "editing"** (no blanking under an `under` popup; an `over` popup starts exactly on the cell's box so nothing else is hidden).

Applied to all three editors through ONE sizing function in the engine: long text (drops the 488×158 constant), formula (drops the 380 floor; its completions and preview line sit below the editor as a panel that follows the same rule), select (unchanged — it already obeys). Inline editing for number and yes/no stays inline.

## Gate invariants (assertable; b0's, kept)
Flush with the cell's left edge whenever there is room; origin cell readable and outlined when there is not; no editor wider than its cap; no editor's right edge beyond the viewport; measured at 1728, 1440 and 1280, at the rightmost visible column, for every editor kind. Fails the pre-push gate on a single miss.

## Phases
- **Phase 1 (go now):** the sizing function + the blanking scope + the gate. No new components.
- **Phase 2 (design first, then build):** a cell/formula bar above the grid showing the active cell's full content and formula, editable — the Excel/Sheets standard that removes most of the reason a popup ever needs to be large. b0 proposes a DS long-text editor as its Phase 2; the bar covers that need and more. The Owner decides after seeing the design.
