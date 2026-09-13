import { type CellShape } from './shapeFormat';
export declare function ListChipValue({ value, shown, labelOf }: {
    value: unknown;
    shown?: number;
    labelOf?: (item: string) => string;
}): import("react/jsx-runtime").JSX.Element | null;
export declare function MeasureCellValue({ value }: {
    value: unknown;
}): import("react/jsx-runtime").JSX.Element | null;
/** The dispatcher both renderers call; a scalar falls through to its string. */
export declare function ShapeValue({ shape, value, optionLabels }: {
    shape: CellShape | undefined;
    value: unknown;
    optionLabels?: Record<string, string>;
}): import("react/jsx-runtime").JSX.Element;
