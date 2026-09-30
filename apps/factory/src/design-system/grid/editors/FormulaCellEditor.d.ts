import type { ICellEditorParams } from 'ag-grid-community';
import { type CommitKind, type FormulaCandidate } from './formulaEditing';
import { type FormulaFunctionDoc, type FormulaPreviewResponse } from './formulaPreview';
/**
 * 2026-09-26 (Owner: cell editor OPTION A) — what a cell carries besides its value. Each part shows an icon in the editor
 * only when it is present, so an ordinary cell opens as one clean line.
 */
export interface CellEditorContext {
    /** An AI draft waiting for this cell. `accept` / `reject` are the review's own verbs (they write through the drafts API). */
    aiDraft?: {
        value: string;
        accept: () => Promise<unknown>;
        reject: () => Promise<unknown>;
    } | null;
    /** Earlier values, read when the operator opens the list. Picking one fills the field; Enter saves it as usual. */
    history?: () => Promise<CellHistoryEntry[]>;
    /** The row shows another row's value (a child following its parent). Typing gives this row its own value. */
    inherited?: {
        from: string;
        value: string;
    } | null;
    /** The channel's length cap. The counter turns red past it; nothing is ever truncated. */
    maxLength?: number | null;
}
export interface CellHistoryEntry {
    value: string;
    when: string;
    who?: string | null;
}
export interface FormulaEditorParams extends ICellEditorParams {
    onValueChange?: (value: unknown) => void;
    initialValue?: unknown;
    candidates: FormulaCandidate[];
    preview: (expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>;
    functions?: FormulaFunctionDoc[];
    formulaExpr?: string | null;
    colIdOfRef?: (name: string) => string | null;
    commitKind?: CommitKind;
    multiline?: boolean;
    /** Draft handed over by an already-open option or structured editor. */
    initialText?: string;
    sourceLabel?: string;
    replaceFormula?: (value: unknown) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    /**
     * R-63 — `false` makes this the plain VALUE editor with formulas OFF: `=` is text, no preview, no suggestions. It is
     * the ONE text/number editor wherever no formula is available (a sheet built without formula wiring — the Variants
     * page — or a column/row the formula writer refuses), so text and number open the same editor on every surface.
     */
    formulas?: boolean;
    /** Option A — the selector opened this editor `under` its cell, so the cell keeps painting its saved value. */
    openedUnder?: boolean;
    /** Option A — the cell's AI draft, history, inheritance and length cap (`CellEditorContext`). */
    cellContext?: CellEditorContext | null;
}
export declare function FormulaGlyph({ title }: {
    title?: string;
}): import("react/jsx-runtime").JSX.Element;
/**
 * AG's popup keyboard handling runs before React's bubble handlers. Enter and Esc are always the editor's; Tab and the
 * arrows are its own while completions are open; and Tab is also its own on a FORMULA (Option A, 2026-09-26), so a broken
 * formula is refused the same way Enter refuses it instead of being committed by AG and failing on the cell.
 */
export declare function suppressFormulaKeys({ event, editing }: {
    event: KeyboardEvent;
    editing: boolean;
}): boolean;
/** The class that tells `grid.css` this cell's editor sits UNDER it, so its value stays painted (#769 is for `over`). */
export declare const CELL_EDITING_UNDER_CLASS = "nds-cell-editing-under";
/**
 * THE ONE TEXT/NUMBER CELL EDITOR (R-63), laid out as the Owner's OPTION A (2026-09-26, previewed in
 * `/design/grid-lab` and approved):
 *   - it opens UNDER the cell (`formulaCellEditorSelector` → `popupPosition: 'under'`), so the cell and the rest of the row
 *     stay in view — the row is what a formula refers to;
 *   - one compact line and no Cancel / Apply: Enter saves, Esc cancels, and the one key line stays (R-48);
 *   - `=` expands the formula help below the line: suggestions (every function and this row's fields), the signature, a
 *     live result, error marks, Insert field / Add text / Help, and click-a-cell to insert;
 *   - context icons only when they apply: an AI draft (use / dismiss), history, "follows the parent";
 *   - long text opens a taller box with a character counter, red past the channel's cap and never truncated;
 *   - Enter or Tab on a formula with an error says "Not saved" and keeps the draft — a broken formula is never written.
 * The state, keys, preview, suggestions, pick-a-cell and reference outlines are unchanged from the editor it replaces.
 */
export declare const FormulaCellEditor: import("react").ForwardRefExoticComponent<FormulaEditorParams & import("react").RefAttributes<unknown>>;
export interface FormulaWiring<TRow> {
    replaceFormula?: (rowId: string, fieldKey: string, value: unknown) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    /**
     * Why THIS cell cannot open its editor yet (its formula state is still loading, or its read failed), or null. Per
     * cell: one slow or failed formula read must not block the cells whose state is already known.
     */
    unavailableReason?: (rowId: string | undefined, fieldKey: string) => string | null;
    retry?: () => void;
    sourceLabel?: (fieldKey?: string) => string;
    canEditRow?: (row: TRow) => boolean;
    candidatesFor: (row: TRow, fieldKey?: string) => FormulaCandidate[];
    preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>;
    functions: () => FormulaFunctionDoc[];
    exprFor: (rowId: string, fieldKey: string) => string | null;
    /**
     * #780 — the SERVER'S reason this cell's formula produced nothing, or `null`. Read through the
     * same ref-backed wiring as `exprFor`, so a refusal landing after first paint repaints the mark
     * without rebuilding a hundred column definitions.
     */
    errorFor?: (rowId: string, fieldKey: string) => string | null;
    colIdOfRef: (name: string, fieldKey?: string) => string | null;
    /** Option A — the cell's AI draft, history and inheritance, shown as icons in the editor only when present. */
    contextFor?: (row: TRow, fieldKey: string) => CellEditorContext | null;
}
type FallbackEditor = {
    component: unknown;
    params?: Record<string, unknown>;
    popup?: boolean;
};
export declare function formulaCellEditorSelector<TRow>(wiring: FormulaWiring<TRow>, col: {
    key: string;
    kind?: string;
    formulaWritable?: boolean;
    maxLength?: number | null;
}, fallback: FallbackEditor | ((row: TRow | undefined) => FallbackEditor), rowIdOf: (row: TRow) => string): {
    cellEditorSelector: (p: {
        data?: TRow;
        eventKey?: string | null;
    }) => FallbackEditor;
};
/**
 * R-63 (A-42 step 1, 2026-09-24) — THE ONE TEXT/NUMBER EDITOR as an editor spec, formulas OFF: the value popup every
 * studio sheet already opens for text and number, without the `=` switch. Used by the selector when no formula is
 * available, and by `scalarValueEditor` for a sheet built without formula wiring (the Variants page).
 */
export declare function scalarValueEditorSpec(kind: 'text' | 'number'): {
    component: import("react").ForwardRefExoticComponent<FormulaEditorParams & import("react").RefAttributes<unknown>>;
    popup: boolean;
    popupPosition: "under";
    params: {
        formulas: boolean;
        commitKind: "number" | "text";
        candidates: never[];
        preview: () => Promise<FormulaPreviewResponse>;
        openedUnder: boolean;
    };
};
/**
 * The same editor as ColDef fields, for a builder with no formula wiring. `cellEditorPopup` is REQUIRED (an editor
 * that renders outside the cell without it is torn down when focus leaves the grid root), and `suppressKeyboardEvent`
 * gives Enter/Esc to the editor, as on every studio column.
 */
export declare function scalarValueEditor(kind: 'text' | 'number'): {
    cellEditor: import("react").ForwardRefExoticComponent<FormulaEditorParams & import("react").RefAttributes<unknown>>;
    cellEditorPopup: boolean;
    cellEditorPopupPosition: "under";
    cellEditorParams: {
        formulas: boolean;
        commitKind: "number" | "text";
        candidates: never[];
        preview: () => Promise<FormulaPreviewResponse>;
        openedUnder: boolean;
    };
    suppressKeyboardEvent: typeof suppressFormulaKeys;
};
export {};
