/**
 * MX.G — the eight Matrix cell RENDERERS. They DRAW; `matrixCells.ts` beside this file DECIDES.
 *
 * 🔴 Named `MatrixCellViews.tsx`, not the mandate's `MatrixCells.tsx`, for a measured reason: this
 * filesystem is case-insensitive, and `tsc` resolved `./MatrixCells` to `matrixCells.ts` — TS1149
 * "differs from already included file name only in casing" (2026-09-13, first typecheck of this
 * file). Two modules whose names differ only by case cannot coexist here; the repo's own precedent
 * is `mediaCell.ts` + `MediaCellView.tsx`, and this follows it.
 *
 * Design `docs/2026-09-13-matrix-page-design.md` §3.4, Appendix A. Every word, tone, class and
 * tooltip a cell carries is read from the pure module — a renderer that wrote `sync.kind === …`
 * would have forked the vocabulary (`reference_two_column_builders_drift`). What lives here is
 * only the arrangement of glyph, word and mark inside a 36px cell.
 *
 * ## The one params shape
 *
 * `MatrixCellParams` is what `matrixColumnDef` hands every renderer, ONCE per column, as a STABLE
 * `cellRendererParams` object (`reference_ag_react_inline_options_rerun_column_model`). `facts`
 * reads the row's `MatrixCells` for this coordinate at PAINT time — so a new `MatrixRead` repaints
 * the cell without rebuilding the column model, and the cell's VALUE stays the one scalar a fill
 * may carry (`ProjectionCell` established the pattern and the reason: a value that was the whole
 * cell object would let the fill handle stamp one variant's ASIN onto nineteen others).
 *
 * ## Marks are the sheet's own
 *
 * 🔗 inherited · ✎ pinned · ƒ formula are `ProvenanceMark` — the same glyphs, the same classes,
 * the same tokens the Information sheet draws — never a second set. The three the Matrix adds are
 * characters, by the rule `provenanceMark.tsx` records for `ƒ` (every member of this vocabulary is
 * an unboxed glyph): ⚠ for a guard or pool the cell cannot back, ⇄ for a report that disagrees with
 * Nexus, ⏸ for a held push. Each is a DIFFERENT SHAPE, not a differently-coloured one — identity is
 * the glyph, never the colour (`reference_tag_identity_is_glyph_not_colour`).
 *
 * ## `ListingStateCell` is `ProjectionCell` with the tick ABSENT — a prop, not a fork
 *
 * `ProjectionCell` renders no checkbox when its VALUE is `null` (its own header: "the parent row,
 * which shows the channel's parent identity"). The Matrix's `Listing` cell is exactly that
 * rendering on every row — inclusion stays on the Variants page (design Revision) — so this file
 * passes `value: null` and maps `ListingCell` onto `ProjectionFacts`. One cell definition on both
 * pages, which is what the four added words in `projection.ts` were for.
 */
import { type ComponentType } from 'react';
import type { ICellRendererParams } from 'ag-grid-community';
import type { FulfilmentMethod, MatrixCellKind, MatrixCells, MatrixCoordinate, MatrixCopy } from '../matrix/contract';
/** What `matrixColumnDef` hands every Matrix renderer — one STABLE object per column. */
export interface MatrixCellParams {
    kind: MatrixCellKind;
    coordinate: MatrixCoordinate;
    /** This row's cells for this coordinate, read at paint time. */
    facts: (params: ICellRendererParams) => MatrixCells | null;
    /** `syncState` click — jump to Needs attention for this listing. */
    onJump?: (params: ICellRendererParams) => void;
    /** `fulfilment` never writes inline: the select's choice opens the one-row preflight. Consumed by the column's setter. */
    onPickFulfilment?: (method: FulfilmentMethod, params: ICellRendererParams) => void;
    /** The copy table. The engine default is Appendix A verbatim; the app may pass its own `MATRIX_COPY`. */
    copy?: MatrixCopy;
    /** The clock `Sent <ago>` is measured against. Injectable so a screenshot compares to itself. */
    now?: () => number;
}
export type MatrixCellProps = ICellRendererParams & MatrixCellParams;
export declare const ListingStateCell: import("react").NamedExoticComponent<MatrixCellProps>;
export declare const FulfilmentCell: import("react").NamedExoticComponent<MatrixCellProps>;
export declare const SyncModeCell: import("react").NamedExoticComponent<MatrixCellProps>;
export declare const SyncQtyCell: import("react").NamedExoticComponent<MatrixCellProps>;
export declare const SyncBufferCell: import("react").NamedExoticComponent<MatrixCellProps>;
export declare const SyncStateCell: import("react").NamedExoticComponent<MatrixCellProps>;
export declare const PriceCell: import("react").NamedExoticComponent<MatrixCellProps>;
export declare const SaleCell: import("react").NamedExoticComponent<MatrixCellProps>;
/** ONE renderer per kind — the table `matrixColumnDef` reads. */
export declare const MATRIX_CELL_RENDERERS: Readonly<Record<MatrixCellKind, ComponentType<MatrixCellProps>>>;
