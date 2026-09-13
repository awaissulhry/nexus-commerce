/**
 * GDS — the sheet's editing helpers: the long-text editor, the validation states a cell can carry,
 * and header-matched paste. Pure where it can be (tested), AG-typed where it must be.
 */
import { type EditorBox, type EditorKind } from './editorBox';
/**
 * 🔴 `import type` ONLY for the line below, and it must stay that way. `renderers/longTextState.ts`
 * imports the length evaluator from this file, and that renderer is reachable from node tests; a
 * VALUE import from `ag-grid-community` here would drag AG's runtime into every one of them. This is
 * the same constraint that decides what is testable in this repo — nothing on the import path may
 * pull a runtime (or a `.tsx`) that the node environment cannot load.
 */
import type { CellClassRules, ColDef, ProcessDataFromClipboardParams } from 'ag-grid-community';
/** AG's large-text editor as a popup, capped: a description edits in a box, not a one-line input. */
export declare const longTextEditor: (opts?: {
    maxLength?: number;
    rows?: number;
    cols?: number;
}) => Pick<ColDef, "editable" | "cellEditor" | "cellEditorParams" | "cellEditorPopup">;
/**
 * Compute the box for THIS cell and publish it where CSS can reach it.
 *
 * 🔴 The properties go on `document.documentElement`, not on the popup: AG's editor popups are
 * parented to `document.body` (`NexusGrid`'s `popupParent`) and do not exist yet at this point in
 * the lifecycle — that is the whole reason this runs here. Exactly one cell editor is open at a
 * time (AG stops the previous before starting the next), so a single pair of properties is a
 * sufficient channel rather than a leak between editors. Stated because a reader will reasonably
 * wonder: this is a deliberate single-slot channel, not global state that accumulates.
 */
export declare function publishEditorBox(p: {
    eGridCell?: HTMLElement;
    column?: {
        getActualWidth(): number;
    };
}, kind: EditorKind): EditorBox;
export type CellValidity = 'error' | 'warn' | null;
export interface SheetValidation<T> {
    /** `null` = fine; `warn` = accepted but flagged (an off-list value a channel may reject); `error` = a channel will refuse. */
    validate: (value: unknown, data: T, colId: string) => {
        level: CellValidity;
        message?: string;
    };
}
/**
 * `cellClassRules` for a sheet column: `.nds-cell-is-invalid` / `.nds-cell-is-warned` (a corner
 * triangle + tint, never colour alone), `.nds-cell-is-inherited` when the value comes from the
 * parent, `.nds-cell-is-locked` when the column definition locks it. Pair with `validationTitle`
 * so the reason is on hover.
 */
export declare function sheetClassRules<T>(v: SheetValidation<T>, inherited?: (data: T, colId: string) => boolean): CellClassRules<T>;
/** Off-list handling the eBay flat file taught: WARN, never block — the operator can always type a value. */
export declare const selectValidation: <T>(options: readonly string[], mode?: "strict" | "open", required?: boolean) => SheetValidation<T>;
/**
 * `max: null` means UNCAPPED, and it has to be expressible.
 *
 * 🔴 Measured: 36 of 102 master columns declare `maxLength`; the other 66 were being validated
 * against a cap the caller invented with `?? 4000` — and a second call site invented `?? 2000` for
 * the same absent value, so one field could warn at one limit and truncate at another. A wire
 * field's ABSENCE is data: the server declaring no cap can only mean there is none. Filling it in
 * turns a silence into a fabricated rule, and the message even attributes it — "the channel cap" —
 * to a channel that never asked (BE-10).
 *
 * Required-ness is unaffected: an empty required field still errors whether or not a cap exists.
 */
/**
 * The caps a column declares, as the wire states them. `null` means UNCAPPED **in that unit** —
 * which is not the same as uncapped, and not a gap to fill with an invented number.
 */
export interface LengthCaps {
    characters: number | null;
    bytes: number | null;
    /** Which channel imposes it, for a mark that has to name its source. */
    capFrom?: string | null;
}
/** Read both caps off a column. Neither is preferred; both are kept. */
export declare function lengthCapOf(col: {
    maxLength?: number | null;
    maxBytes?: number | null;
    capFrom?: string | null;
}): LengthCaps;
/** The binding cap's reading. `null` when the column declares no cap in EITHER unit. */
export interface LengthReading {
    /** The value's length in the binding cap's unit. */
    n: number;
    cap: number;
    unit: 'characters' | 'bytes';
    capFrom: string | null;
    /** `n / cap`. > 1 is over. */
    ratio: number;
    over: boolean;
    /**
     * The OTHER declared cap, when the column declares one in both units.
     *
     * PES.5 measured all 91 cached schemas: `maxLength` and `maxUtf8ByteLength` are **independent**
     * Amazon properties — 1,061 fields declare both across 14 distinct ratios, so neither is derived
     * from the other. A message naming a single number is therefore wrong on some column whichever it
     * picks, so where both exist the message names both.
     */
    other: {
        cap: number;
        unit: 'characters' | 'bytes';
    } | null;
}
/**
 * 🔴 **THE one length evaluator. Every cap the wire declares is enforced, each in its own unit, and
 * the WORST verdict binds** (hub #382).
 *
 * I first wrote this as "a declared byte cap IS the cap" — pick one unit and count in it. That is
 * wrong, because **neither cap always binds**. Live, `age_range_description` is
 * `maxLength: 1998, maxBytes: 2000`:
 *
 *   • 1999 ASCII characters — over the CHARACTER cap, inside the byte cap. "Bytes win" misses it.
 *   • 1001 × 'é' — 1001 characters (inside), 2002 bytes (over). "Characters win" misses it.
 *
 * Which cap binds depends on the CONTENT, so any rule that picks a unit up front is wrong for some
 * input. My diagnosis was right — a byte count was being compared against a character cap — and my
 * first cure was wrong in a quieter way: it stopped comparing across units by discarding one of
 * them. **Also worth naming: I noticed this exact gap and filed it as a question for PES.5 instead
 * of as a defect. A constraint the wire declares and the client ignores is not a question.**
 *
 * `n > cap` is over, so a cap of 200 allows exactly 200 — AG.1 aligned the cell's mark to this, an
 * `>=`/`>` disagreement neither side knew about.
 *
 * Lives here, in a pure `.ts` with no imports of its own, so the validator and AG.1's
 * `longTextState` mark cannot reach different verdicts about one cell.
 */
export declare function evaluateLengthCaps(text: string, caps: LengthCaps): LengthReading | null;
export declare const lengthValidation: <T>(caps: LengthCaps, required?: boolean) => SheetValidation<T>;
/**
 * Header-matched paste ("smart paste"): when the first pasted row matches ≥2 column headers or ids
 * (case-insensitive), the block is re-ordered onto those columns by NAME rather than landing by
 * position — the way a sheet exported from Excel comes back. Otherwise the block pastes as-is.
 *
 * 🔴 A target column the paste does NOT name comes back as `null`, meaning "leave this cell alone".
 * It used to come back as `''`, which AG pasted — so a two-column block from Excel BLANKED every
 * other visible column to its right, on every pasted row. On a 102-column sheet that is a lot of
 * silent data loss from one ⌘V, and the test that covered this asserted the empty strings, so it
 * described the implementation instead of protecting the operator. `sheetPasteProcessor` turns each
 * `null` back into the cell's CURRENT value, which makes AG's own equality check skip it: no
 * valueSetter, no event, no write.
 */
export declare function matchPasteToHeaders<T>(data: string[][], columns: ReadonlyArray<Pick<ColDef<T>, 'colId' | 'field' | 'headerName'>>, targetColIds: readonly string[]): (string | null)[][];
/**
 * AG's `processDataFromClipboard` wired to `matchPasteToHeaders`. Pass as a stable reference.
 *
 * AG applies the returned block POSITIONALLY from the focused cell, so there is no way to tell it
 * "skip this column" — every target gets whatever the array holds. So a column the paste did not
 * name is filled with the value that is already in it: AG compares, finds no change, and does not
 * call the valueSetter at all. The paste therefore touches exactly the columns the operator's block
 * actually named, which is what they meant by pasting it.
 */
export declare function sheetPasteProcessor<T>(columns: ReadonlyArray<Pick<ColDef<T>, 'colId' | 'field' | 'headerName'>>): (params: ProcessDataFromClipboardParams<T>) => string[][] | null;
