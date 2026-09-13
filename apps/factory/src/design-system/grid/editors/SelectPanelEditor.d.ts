import type { ICellEditorParams } from 'ag-grid-community';
import { type ListboxOption } from '../../components';
export interface SelectPanelEditorParams extends ICellEditorParams {
    /**
     * AG 36's reactive contract — the ONLY way an editor's value reaches the grid. See `onCommit`.
     */
    onValueChange?: (value: unknown) => void;
    options: ListboxOption[];
    placeholder?: string;
    /** A "nothing selected" row. Absent ⇒ the list cannot be cleared from the editor. */
    emptyLabel?: string;
}
export declare const SelectPanelEditor: import("react").ForwardRefExoticComponent<SelectPanelEditorParams & import("react").RefAttributes<unknown>>;
