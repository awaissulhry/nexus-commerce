/**
 * GDS — what a `shape: 'list'` or `shape: 'measure'` column CARRIES on the grid, defined once
 * (AM.1 §A.3: "everything in the table is engine-owned, spread by BOTH builders").
 *
 * The editor, the formatter (copy/export/filter text), the parser (paste), the filter value and the
 * change-equality all follow the shape here; a builder spreads `shapeColumnDef(col, read)` and hands
 * `shapeEditorSpec(col)` to the formula selector as the non-formula fallback. `cellDataType: false`
 * stops AG inferring a number type from a `{ value, unit }` object and coercing it.
 */
import type { ColDef } from 'ag-grid-community';
import { type CellShape } from '../renderers/shapeFormat';
export { parseShape } from './shapeValue';
export interface ShapedColumnLike {
    key: string;
    label?: string;
    /**
     * `'axes'` (VT.2, 2026-09-13) is the variation-theme projection. It is widened HERE rather than in
     * `renderers/shapeFormat.ts`'s `CellShape` on purpose: `isShaped()`, `isEmptyShape()` and
     * `shapeValidation()` are the list/measure family's rules and an `axes` cell is none of those —
     * adding a member to that union would put a third shape inside three functions that would then
     * have to decide what to do with it. The ROUTING fact is `kind: 'variationTheme'` (contract §1),
     * and `shape` only says which family the cell belongs to.
     */
    shape?: CellShape | 'axes';
    /** The routing fact for the variation-theme column. Never the column KEY — see `variationThemeColumnDef`. */
    kind?: string;
    options?: string[];
    optionLabels?: Record<string, string>;
    cardinality?: {
        min: number;
        max: number | null;
    };
    unitOptions?: string[];
}
export declare function shapeEditorSpec(col: ShapedColumnLike): {
    component: unknown;
    params: Record<string, unknown>;
    popup: true;
} | null;
/**
 * VT.2 — the `Variation theme` column, defined ONCE and spread by BOTH sheet builders.
 *
 * `reference_two_column_builders_drift` is the whole reason this is a function and not two blocks of
 * ColDef: master's builder and the channel's builder assembled their columns separately once before,
 * and the channel silently lacked six things master had. So everything about this column that could
 * differ between the two sheets lives here — the renderer, the editor, the popup flag, the copy /
 * export / filter text, the change equality, the editability, the fill-handle refusal and the
 * tooltip — and each builder contributes exactly one line.
 *
 * What each builder still owns: the base `def` it spreads FIRST (its own class rules, its own
 * provenance reader, its own row identity). This fragment is spread LAST so the pieces above cannot
 * be overridden by a scalar default the builder set for every other column.
 */
export declare function variationThemeColumnDef<T>(col: ShapedColumnLike & {
    width?: number;
}, read: (row: T) => unknown, 
/**
 * 🔴 The builder's OWN composed `cellClassRules`, handed in so this fragment can EXTEND them
 * instead of replacing them — and it has to extend them, because of a mechanism measured on the
 * real sheet (Amazon·IT, clean signed-in Playwright context, its own browser build):
 *
 * the cell drew `nds-cell-prov-inherited` — the glyph — over a **transparent** background. The
 * glyph is the renderer's, read from the cell's VALUE (`source.kind`); the tint is the builder's
 * `provenanceClassRules`, read from the cell WRAPPER, which for this column says
 * `layer: 'master', pinned: false` on every scope. **A `cellClassRules` entry whose predicate is
 * false actively REMOVES the class**, so a `cellClass` string carrying `nds-cell-is-inherited`
 * was added and then taken away again in the same paint — which is why the first fix looked
 * right in a lab that had no such rule and did nothing on the sheet that did.
 *
 * So the provenance keys are overridden HERE, from `variationThemeProvenanceMember` — the same
 * function the renderer calls — and everything else the builder composed (validation, the
 * round-trip `saving`/`saved`/`refused` states, the chip hit) is spread through untouched.
 * Omitting the argument keeps the old behaviour for any caller that has none.
 */
baseClassRules?: Record<string, (params: {
    data?: T;
}) => boolean>): Partial<ColDef<T>>;
export declare function shapeColumnDef<T>(col: ShapedColumnLike, read: (row: T) => unknown): Partial<ColDef<T>>;
