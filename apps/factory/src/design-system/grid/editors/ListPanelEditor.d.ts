import { type OptionListItem } from '../../components';
import { type EditorStop } from './selectPanelModel';
export interface ListPanelEditorParams {
    /** Closed list → `OptionList`; absent/empty → free-text chips. */
    options?: OptionListItem[];
    /** The channel leaves this list open (`mode: 'open'`): a typed value is offered as `Add "…"`. */
    allowCustom?: boolean;
    /** `cardinality.max`; `null` = unbounded. */
    maxItems?: number | null;
    label?: string;
    value?: unknown;
    column: {
        getActualWidth(): number;
    };
    stopEditing: EditorStop;
    onValueChange?: (value: unknown) => void;
    eGridCell?: HTMLElement;
    eventKey?: string | null;
}
export declare const ListPanelEditor: import("react").ForwardRefExoticComponent<ListPanelEditorParams & import("react").RefAttributes<unknown>>;
