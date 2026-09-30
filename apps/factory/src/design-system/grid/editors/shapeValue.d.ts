import { type CellShape } from '../renderers/shapeFormat';
/** What separates the values of a list in text: a paste, a typed draft, a chip ("a | b", "a · b", one per line). */
export declare const LIST_SEPARATOR: RegExp;
/** A list's values in a text, by the paste's rule. */
export declare function splitListText(text: string): string[];
/** Decode displayed labels using this column's schema; preserve unparseable input for refusal. */
export declare function parseShape(shape: CellShape | undefined, raw: unknown, col?: {
    options?: string[];
    optionLabels?: Record<string, string>;
    unitOptions?: string[];
}): unknown;
/** The measure editor's value while the operator types: a number, or the typed text the server will refuse. */
export type MeasureDraft = {
    value: number | string | null;
    unit: string | null;
};
/**
 * The measure editor's number field, read as a paste reads the same text (`parseShape`): "1.5 kg", "12kg" and "9 OUNCE"
 * carry their unit, a bare number keeps the chosen one. Text that is still not a number is reported as typed, so the
 * server refuses it by name ("… is not a number"). It used to be reported as `value: null`, which saved as an empty weight
 * with no warning (audit B08, 2026-09-30).
 */
export declare function measureFromText(text: string, unit: string | null, unitOptions: string[]): MeasureDraft;
