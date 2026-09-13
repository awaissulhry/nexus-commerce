/**
 * VP.5 — `ProjectionCell`: one variant row × one channel coordinate, on the Variants page.
 *
 * Spec `docs/2026-09-11-variants-page-spec.md` §3.3, canvas artboard 1:
 *
 *     [checkbox 15px] [7px dot] Listed                              B0DXYZ1234
 *
 * The tick is INCLUSION on that coordinate; the dot and the word are the projection state; the
 * mono detail on the right is the channel's own id, or a count. Tones come from
 * `projection.ts` → `readinessMeta()`; this file draws, it does not decide.
 *
 * ## The value is a BOOLEAN, and that is the whole design
 *
 * AG's fill handle copies a cell's VALUE down a column. If the value were the whole projection
 * object, dragging "Listed · B0DXYZ1234" down twenty rows would stamp one variant's ASIN and one
 * variant's state onto nineteen others. So:
 *
 *   - `params.value` is `boolean | null | undefined` — the include flag, and nothing else. That is
 *     what fills, and filling it means exactly what the operator intends.
 *   - everything else is read from the ROW through the `facts` callback, so it is never carried by
 *     a fill and never copied between rows.
 *   - `null` / `undefined` means *no checkbox on this row*: that is the PARENT row, which shows the
 *     channel's parent identity and a note rather than an inclusion tick (§3.3).
 *
 * Two things the COLUMN owner must do, because a renderer cannot:
 *
 *   1. `valueSetter` must MUTATE `params.data` and return `true`, or AG discards the filled value
 *      (`reference_ag_value_setter_must_mutate_params_data`).
 *   2. `cellRendererParams` must be a STABLE object — an inline literal re-runs the whole column
 *      model on every render (`reference_ag_react_inline_options_rerun_column_model`).
 *
 * ## Why the held checkbox is not `disabled`
 *
 * "Not set up" cannot be ticked. A `disabled` input takes no focus, no click and renders no
 * `title`, so the reason would be written where nobody can read it — the defect
 * `scripts/check-silent-disabled.mjs` exists for. This one is HELD: `aria-disabled`, focusable,
 * carrying the reason, and its click is cancelled so nothing toggles.
 */
import { type ReactNode } from 'react';
import type { ICellRendererParams } from 'ag-grid-community';
import { type ProjectionState } from './projection';
/** What one row says about one coordinate, beyond the include flag the VALUE carries. */
export interface ProjectionFacts {
    /** `null` renders no dot and no word — the parent row, which shows `detail` + `note` instead. */
    state?: ProjectionState | null;
    /** Right-aligned, mono: an ASIN, an eBay item id, a product id, a count. */
    detail?: ReactNode;
    /** A muted note after the word — the parent row's "1 listing". */
    note?: ReactNode;
    /**
     * Holds the checkbox with this sentence as the reason, whatever the state says. For a read-only
     * grid, or a coordinate the operator may not change. Never a silent hold.
     */
    heldReason?: string | null;
    /**
     * An include/exclude that has been optimistically painted and has NOT landed yet (VP.4's ask).
     * Marks the cell `aria-busy` and holds the tick, so a second click cannot race the first write
     * — the operator sees their change and cannot double-send it.
     */
    busy?: boolean;
    /**
     * This row's accessible name for the tick, when the row knows it better than the column does
     * ("Include GALE-JACKET-BLK-XXS on eBay · IT"). Wins over the column's `label`.
     */
    includedLabel?: string;
    /**
     * Hover explanation for the whole cell. NOT defaulted to the state's own sentence: the word is
     * already in the cell, and a title on every row × every channel is the hover noise the DS spent
     * a pass removing. Pass one where a row has something the word does not say.
     */
    title?: string;
}
export interface ProjectionCellParams {
    /**
     * Reads this row's facts for THIS column. Defined once per column, outside render — an inline
     * object here re-runs the column model on every parent render.
     */
    facts: (params: ICellRendererParams) => ProjectionFacts | null | undefined;
    /**
     * Called when the operator toggles inclusion. Omit for a read-only column: the tick then still
     * shows the state but refuses the change, and says so.
     */
    onToggle?: (next: boolean, params: ICellRendererParams) => void;
    /**
     * The checkbox's accessible name — a tick with no name is a control a screen reader cannot
     * describe, and there are one of these per channel per row. Default names the column.
     */
    label?: (params: ICellRendererParams) => string;
    /** The sentence a read-only column gives when its tick is pressed. */
    readOnlyReason?: string;
}
type Props = ICellRendererParams & ProjectionCellParams;
export declare const ProjectionCell: import("react").NamedExoticComponent<Props>;
export {};
