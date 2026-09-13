/**
 * GDS — the two non-scalar cell SHAPES (AM.1 §A.3 rows 3–4, Owner-approved 2026-09-05), as pure rules.
 *
 * A `shape: 'list'` cell holds `string[]` (an unbounded or >10-member list — `recommended_browse_nodes`,
 * `supplier_declared_dg_hz_regulation`, eBay MULTI aspects); a `shape: 'measure'` cell holds
 * `{ value, unit }` (`item_weight`, eBay `packageWeight`). Before this module the sheet stringified
 * both (measured 2026-09-05: the list cell showed its first element and opened a SINGLE-select
 * listbox, so a pick would have written one string over an array).
 *
 * Everything here is what both column builders and both renderers call, so the two scopes cannot
 * read the same array two ways. Pure `.ts`, node-tested; the React cells and the popup editors that
 * use these rules live in `shapeCells.tsx` and `editors/ListPanelEditor.tsx` / `MeasureEditor.tsx`.
 */
import type { SheetValidation } from '../editors/sheet';
/**
 * `'axes'` — VT.2 (2026-09-13), the variation-theme projection (`docs/vt1-contracts.md` §1).
 *
 * 🔴 It is a NAME in this union and nothing else: every function in this file that branches on a
 * shape (`isShaped`, `isEmptyShape`, `shapeValidation`, `shapeTooltipLine`) tests for `list` or
 * `measure` explicitly, so `axes` falls through each of them unchanged — which is correct, because an
 * axes cell is neither an array nor a `{value, unit}` and its rules live in
 * `editors/shapeColumn.ts`'s `variationThemeColumnDef`. `isShaped()` deliberately stays FALSE for it:
 * that predicate decides the closed-list chevron, and a projection is not a dropdown.
 *
 * It is declared here rather than only in the consumers because the sheet mirrors' `shape` field
 * flows into these signatures through three call sites whose narrowing does not survive the
 * callbacks they sit in.
 */
export type CellShape = 'scalar' | 'list' | 'measure' | 'axes';
export interface MeasureValue {
    value: number | null;
    unit: string | null;
}
/** The column fields the shape rules read — a subset of both sheets' `SheetColumn` mirrors. */
export interface ShapeColumnLike {
    shape?: CellShape;
    /** list only; `max: null` = unbounded */
    cardinality?: {
        min: number;
        max: number | null;
    };
    /** measure only: the channel's closed unit list */
    unitOptions?: string[];
    /** list: the per-ITEM character cap */
    maxLength?: number | null;
    capFrom?: string | null;
    requiredBy: string[];
    /** closed list: code → the channel's label (#669 — the cell shows what the dropdown offered) */
    optionLabels?: Record<string, string>;
}
/** The label a closed-list item shows; a code with no label shows as itself, never blank. */
export declare function listLabelOf(col: {
    optionLabels?: Record<string, string>;
}): (item: string) => string;
export declare function unitSymbol(unit: string | null | undefined): string;
/** The list a cell holds. A legacy scalar reads as a one-item list (read-compat, never written back as such). */
export declare function asList(v: unknown): string[];
export declare function isMeasure(v: unknown): v is MeasureValue;
/** The measure a cell holds. A bare number is a value without a unit; `"1.2 kg"` parses (read-compat). */
export declare function asMeasure(v: unknown): MeasureValue;
/**
 * 🔴 `shape` is NEVER tested for truthiness: the contract sets `shape: 'scalar'` EXPLICITLY on every ordinary
 * column (169 of 192 on master), so `!col.shape` is false for a plain select — measured 2026-09-05 as every
 * channel select losing its class and chevron. Ask this, not `!shape`.
 */
export declare function isShaped(col: {
    shape?: string | null;
} | null | undefined): boolean;
export declare function isEmptyShape(shape: CellShape | undefined, v: unknown): boolean;
export declare function formatMeasure(v: unknown): string;
/** The on-screen separator. Visible — `reference_composed_string_invisible_separator`: a bare space or `\n` collapses. */
export declare const LIST_SEPARATOR = " \u00B7 ";
export declare function formatList(v: unknown, sep?: string): string;
/** "count + first values" for the chip cell (§A.3): the first `shown` items and how many more there are. */
export declare function listSummary(v: unknown, shown?: number): {
    shown: string[];
    more: number;
    total: number;
};
/** The tooltip's line for a shaped cell — the FULL list, or the measure with its unit spelled out. */
export declare function shapeTooltipLine(col: ShapeColumnLike, v: unknown): string | undefined;
/**
 * Readiness per shape (§A.3): a list is required ⇒ at least `max(min, 1)` values, never more than
 * `max`, no item over the per-item cap; a measure is complete only with BOTH a value and a unit, and
 * warns on a unit the channel does not list. Messages follow `lengthValidation`'s form
 * (`n of cap …`) and carry `capFrom` (§9.3a: a cap must name whose cap it is).
 */
export declare function shapeValidation<T>(col: ShapeColumnLike, required: boolean): SheetValidation<T>;
