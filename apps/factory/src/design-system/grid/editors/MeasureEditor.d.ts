import { type EditorStop, type GridCancel } from './selectPanelModel';
export interface MeasureEditorParams {
    unitOptions?: string[];
    label?: string;
    value?: unknown;
    column: {
        getActualWidth(): number;
    };
    stopEditing: EditorStop;
    api: GridCancel;
    onValueChange?: (value: unknown) => void;
    eGridCell?: HTMLElement;
    eventKey?: string | null;
}
/**
 * Where Tab from the number lands in the unit list: its search field when it has one (more than 8 units), the list
 * itself otherwise. It always focused the list, so with a search field typed letters went nowhere (audit B22).
 */
export declare function unitsEntry(units: HTMLElement): HTMLElement;
export declare const MeasureEditor: import("react").ForwardRefExoticComponent<MeasureEditorParams & import("react").RefAttributes<unknown>>;
