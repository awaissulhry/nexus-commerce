import type { ICellEditorParams } from 'ag-grid-community';
import { type ListboxPanelOption } from '../../components';
/** A `ListboxOption` that may be held (`heldReason`) and carry a `note` under its label (2026-10-04). */
export type SelectPanelOption = ListboxPanelOption;
export interface SelectPanelEditorParams extends ICellEditorParams {
    /**
     * AG 36's reactive contract — the ONLY way an editor's value reaches the grid. See `onCommit`.
     */
    onValueChange?: (value: unknown) => void;
    options: SelectPanelOption[];
    placeholder?: string;
    /** A "nothing selected" row. Absent ⇒ the list cannot be cleared from the editor. */
    emptyLabel?: string;
    /** The channel leaves this list open (`mode: 'open'`), so a typed value is offered as `Use "…"`. */
    allowCustom?: boolean;
}
export declare const SelectPanelEditor: import("react").ForwardRefExoticComponent<SelectPanelEditorParams & import("react").RefAttributes<unknown>>;
