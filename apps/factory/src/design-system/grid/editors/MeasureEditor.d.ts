export interface MeasureEditorParams {
    unitOptions?: string[];
    label?: string;
    value?: unknown;
    column: {
        getActualWidth(): number;
    };
    stopEditing: (cancel?: boolean) => void;
    onValueChange?: (value: unknown) => void;
    eGridCell?: HTMLElement;
}
export declare const MeasureEditor: import("react").ForwardRefExoticComponent<MeasureEditorParams & import("react").RefAttributes<unknown>>;
