import type { ICellEditorParams } from 'ag-grid-community';
export interface SaleCellEditorParams extends ICellEditorParams {
    /** AG 36's reactive contract — the ONLY way an editor's value reaches the grid. */
    onValueChange?: (value: unknown) => void;
    /** The coordinate's currency, for the price field's label. */
    currency?: string;
}
export declare const SaleCellEditor: import("react").ForwardRefExoticComponent<SaleCellEditorParams & import("react").RefAttributes<unknown>>;
