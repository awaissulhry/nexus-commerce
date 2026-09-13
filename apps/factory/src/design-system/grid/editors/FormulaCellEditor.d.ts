import type { ICellEditorParams } from 'ag-grid-community';
import { type CommitKind, type FormulaCandidate } from './formulaEditing';
import { type FormulaFunctionDoc, type FormulaPreviewResponse } from './formulaPreview';
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
}
export declare function FormulaGlyph({ title }: {
    title?: string;
}): import("react/jsx-runtime").JSX.Element;
/** AG's popup keyboard handling runs before React's bubble handlers. */
export declare function suppressFormulaKeys({ event, editing }: {
    event: KeyboardEvent;
    editing: boolean;
}): boolean;
export declare const FormulaCellEditor: import("react").ForwardRefExoticComponent<FormulaEditorParams & import("react").RefAttributes<unknown>>;
export interface FormulaWiring<TRow> {
    replaceFormula?: (rowId: string, fieldKey: string, value: unknown) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    unavailableReason?: () => string | null;
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
}, fallback: FallbackEditor | ((row: TRow | undefined) => FallbackEditor), rowIdOf: (row: TRow) => string): {
    cellEditorSelector: (p: {
        data?: TRow;
        eventKey?: string | null;
    }) => FallbackEditor;
};
export {};
