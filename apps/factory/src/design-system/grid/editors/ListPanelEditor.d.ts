import { type OptionListItem } from '../../components';
export interface ListPanelEditorParams {
    /** Closed list → `OptionList`; absent/empty → free-text chips. */
    options?: OptionListItem[];
    /** `cardinality.max`; `null` = unbounded. */
    maxItems?: number | null;
    label?: string;
    value?: unknown;
    column: {
        getActualWidth(): number;
    };
    stopEditing: (cancel?: boolean) => void;
    onValueChange?: (value: unknown) => void;
    eGridCell?: HTMLElement;
}
export declare const ListPanelEditor: import("react").ForwardRefExoticComponent<ListPanelEditorParams & import("react").RefAttributes<unknown>>;
