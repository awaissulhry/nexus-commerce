/**
 * GDS — THE ONE SIZING FUNCTION for every popup cell editor.
 *
 * Owner's decision, `docs/2026-09-03-cell-editor-approach.md` (Phase 1):
 *
 *   width  = clamp(cellWidth, contentWidth, min(cap, roomToRight))
 *   height = clamp(cellHeight, contentHeight, heightCap)   — internal scroll beyond the cap
 *   the top-left is pinned to the cell and never slides
 *   the origin cell stays visible and outlined as "editing"
 *
 * ## Why the width term is the whole fix
 *
 * AG hardcodes `keepWithinBounds: true` and `alignSide: 'left'` when it creates a cell-editor popup
 * (`ag-grid-community/dist/package/main.esm.mjs:10475–10485`) — there is no option and no hook, only
 * `getPopupPosition()` returning `'over' | 'under'`. So a popup wider than the room to its right is
 * slid sideways by the grid, and MEASURED on 2026-09-03 that is exactly what happened: the long-text
 * editor is a fixed 488×158 whatever the content and landed **−202px** from `product_description`;
 * the formula editor's 380px floor landed **−79px** at the right edge. The select never displaced,
 * and it is the only editor already sized `clamp(cell width, content, cap)`.
 *
 * 🔴 **This does not fight AG's clamp — it makes the clamp a NO-OP.** By capping width at the room
 * actually available, the popup always fits, so `keepWithinBounds` never has anything to correct and
 * the top-left stays where AG put it: on the cell. Measured both ways: with room made before opening
 * the popup is flush (Δ=0); without it AG pins the right edge to the viewport (popup right = 1600
 * exactly). AG also re-clamps continuously as the grid scrolls, so a popup that fits stays flush.
 *
 * ## Why not "width belongs to the cell"
 *
 * That was this lane's first proposal and the Owner amended it: a 2,000-character description would
 * then be edited in a 160px column, which Excel, Google Sheets and Airtable all refuse to do. They
 * pin the top-left to the cell and grow RIGHT while there is room, then wrap and grow DOWN. The rule
 * above is the generalisation of the select's — the one editor that already behaves.
 *
 * ## Vertical is the cheap axis
 *
 * The viewport is ~1000px tall with 35px rows, so downward room is abundant; horizontal room is
 * scarce and is the only axis on which editors ever collide. Height therefore follows content up to
 * a cap and then scrolls internally, while width is the term that must respect the room.
 */
/**
 * Per-kind limits. `width`/`height` are the CAPS — "no editor wider than its cap" is one assertion,
 * not four. `preferred` is what the editor asks for when nothing else dictates a width.
 *
 * 🔴 `preferred` EXISTS BECAUSE ITS ABSENCE WAS A REGRESSION, caught on screen and not in a test.
 * With `contentWidth` merely optional, every editor opened at exactly its cell — 110px for a
 * `product_description` you are about to type 2,000 characters into, and a 268-option country list
 * capped at 110px where it used to have 320. Δ was 0 and the geometry was "correct"; the editors
 * were unusable. That is the Owner's amendment in reverse: *"a 2,000-character description edited in
 * a 160px column is what none of them do."* An editor asks for a comfortable measure and lets the
 * ROOM take it away — it does not start at the cell and wait to be given more.
 */
export declare const EDITOR_CAPS: {
    /** Long text: a comfortable reading measure, not the old 488×158 constant. */
    readonly longtext: {
        readonly width: 560;
        readonly height: 320;
        readonly preferred: 560;
        readonly preferredHeight: 158;
    };
    /** The formula editor carries completions and a preview line BELOW itself, hence the taller cap.
     *  `preferred` is the old 380 floor, kept as the ASK it always should have been. */
    readonly formula: {
        readonly width: 560;
        readonly height: 360;
        readonly preferred: 380;
        readonly preferredHeight: 48;
    };
    /** The DS popover's existing maximum — select already obeyed this and keeps it, cap and ask. */
    readonly select: {
        readonly width: 320;
        readonly height: 320;
        readonly preferred: 320;
        readonly preferredHeight: 240;
    };
    /** AM.1 (2026-09-05): the chip-list panel — the select family's `OptionList` or a chip input, inside the popup. */
    readonly list: {
        readonly width: 360;
        readonly height: 360;
        readonly preferred: 320;
        readonly preferredHeight: 280;
    };
    /** value + unit on ONE line: a number field and a unit list side by side. */
    readonly measure: {
        readonly width: 360;
        readonly height: 220;
        readonly preferred: 300;
        readonly preferredHeight: 56;
    };
    /**
     * VT.2 (2026-09-13) — the variation-theme panel: a source row, a grouped theme list, one row per
     * axis with its target control, a lock banner and a footer, stacked.
     *
     * 🔴 **420, and it is a measurement rather than a preference.** The canvas
     * (`docs/2026-09-13-variation-theme-column-design.md` §3.5, artboards 2–4) draws the panel at
     * exactly 420 on all three scopes, and the widest line in it is an axis row —
     * `grip · tick · 72px label · arrow · mono target · (channelName)` — which at the DS's own
     * 12.5–13px type needs ~400 before the target starts truncating. `list`'s 360 cap was tried first
     * and clipped `(Größe)` off the Amazon·DE rows.
     *
     * It is a SEPARATE kind rather than a raised `list` cap because `list` is the chip-panel's
     * measurement and widening it would move three other editors that were sized on their own content.
     */
    readonly axes: {
        readonly width: 420;
        readonly height: 420;
        readonly preferred: 420;
        readonly preferredHeight: 320;
    };
};
export type EditorKind = keyof typeof EDITOR_CAPS;
/**
 * 🔴 NOT a floor on the width — a threshold for REPORTING. Two tests caught the difference and it
 * matters: a floor that raises the width above `roomToRight` puts the editor back over the viewport
 * edge, AG clamps it, and the defect returns through the fix. So the width is never floored; the box
 * always fits by construction, and `usable` says whether what fits is big enough to type in.
 *
 * `roomToRight` can be a few pixels when a column is scrolled half out of view. There the honest
 * answer is neither "widen it and be displaced" nor "render a 12px editor and call it fine" — it is
 * to SAY SO, so the gate abstains instead of recording a pass it did not take, and so a later phase
 * can scroll the column into room (the Excel/Sheets answer) with a condition to trigger on.
 */
export declare const MIN_EDITOR_WIDTH = 120;
export interface EditorBoxInput {
    /** The cell's own box — the floor for width and height. */
    cellWidth: number;
    cellHeight: number;
    /**
     * What the content would like, if the caller has measured it. Absent ⇒ the kind's `preferred`
     * width is the ask — NOT the cell's own width, which was the regression above.
     */
    contentWidth?: number;
    contentHeight?: number;
    /** Distance from the cell's LEFT edge to the right edge of the window. The scarce resource. */
    roomToRight: number;
    kind: EditorKind;
}
export interface EditorBox {
    width: number;
    height: number;
    /** The content is taller than the cap, so the editor scrolls internally rather than growing. */
    scrolls: boolean;
    /**
     * Is the box that fits big enough to edit in? `false` means the column is scrolled so far right
     * that obeying the room leaves less than `MIN_EDITOR_WIDTH`. The box still FITS — that is an
     * invariant of this function, not an outcome it reports — but the gate ABSTAINS here rather than
     * recording a pass it did not take.
     */
    usable: boolean;
}
export declare function editorBox(input: EditorBoxInput): EditorBox;
/**
 * The room to the right of a cell, from the cell's own box and the window.
 *
 * 🔴 Measured from the cell's LEFT edge, because that is where AG pins the popup — measuring from
 * its right edge would answer a question nobody asked and would let a wide column open an editor
 * that starts on the cell and ends off screen.
 */
export declare function roomToRightOf(cellLeft: number, viewportWidth: number): number;
