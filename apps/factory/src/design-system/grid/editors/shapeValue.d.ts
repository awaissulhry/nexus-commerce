import { type CellShape } from '../renderers/shapeFormat';
/** Decode displayed labels using this column's schema; preserve unparseable input for refusal. */
export declare function parseShape(shape: CellShape | undefined, raw: unknown, col?: {
    options?: string[];
    optionLabels?: Record<string, string>;
    unitOptions?: string[];
}): unknown;
