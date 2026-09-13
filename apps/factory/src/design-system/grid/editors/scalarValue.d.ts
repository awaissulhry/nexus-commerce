import type { ColDef } from 'ag-grid-community';
export interface ScalarColumnLike {
    kind: string;
    shape?: string;
    options?: string[];
    optionLabels?: Record<string, string>;
}
export declare const BOOLEAN_OPTIONS: {
    value: string;
    label: string;
}[];
/** Decode only declared scalar types. Unknown input stays visible for validation. */
export declare function parseScalarValue(col: ScalarColumnLike, raw: unknown): unknown;
/** Codes win over labels; ambiguous labels must not silently select an arbitrary option. */
export declare function optionCode(col: Pick<ScalarColumnLike, 'options' | 'optionLabels'>, raw: string): string;
export declare function booleanLabel(raw: unknown): string;
/** Used by both sheet builders and by custom editors through AG's parseValue callback. */
export declare function scalarColumnDef<T>(col: ScalarColumnLike): Partial<ColDef<T>>;
export declare const SHEET_NUMBER_EDITOR_PARAMS: {
    min: undefined;
    max: undefined;
    precision: undefined;
    step: string;
    showStepperButtons: boolean;
};
