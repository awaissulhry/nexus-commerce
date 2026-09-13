/**
 * GDS / PES.2 — `MediaCell`: an AG cell whose content is a PICTURE.
 *
 * Built to PES.7's three spike conditions (hub ruling #12), and each one shows up in the code:
 *
 *   1. **The picture comes from the cell VALUE** (`p.value`), so AG's change detection sees it and
 *      repaints on its own. A renderer drawing from `cellRendererParams` is invisible to AG, and
 *      the "fix" of churning that params object re-runs the whole column model.
 *   2. **Handlers come from CONTEXT** (`MediaCellHandlers`), never from rebuilt params. The host
 *      mounts one provider around its grid; the identity of `cellRendererParams` never changes.
 *   3. **`cellSelection` is off on a media matrix** — see `MEDIA_MATRIX_GRID_OPTIONS`. AG opens a
 *      range on the same mousedown that starts a tile drag, and `stopPropagation` does not stop it.
 *
 * And one trap from the same ruling that dictates the markup: **`position: absolute` inside an AG
 * cell ESCAPES the cell.** So the badge, the count and the publish mark are normal flex children,
 * not overlays. Nothing here is absolutely positioned.
 *
 * Sizing goes through `cdnFit` (ruling #28). A bare original in a 165px tile measured 1.6MB against
 * 18KB sized — and a matrix multiplies that by rows × columns.
 */
import { type PointerEvent as ReactPointerEvent } from 'react';
import type { ICellRendererParams } from 'ag-grid-community';
/**
 * What a media matrix does with its tiles. Supplied ONCE by the host through a provider, so the
 * cell renderer's params never change identity.
 *
 * Every handler is optional: a read-only matrix passes none and the tiles are inert, which is the
 * honest rendering of a surface that cannot be edited.
 */
export interface MediaCellHandlers {
    /** Pointer-drag is the PRIMARY model (ruling #12). The host owns the drag session. */
    onTilePointerDown?: (rowId: string, colId: string, e: ReactPointerEvent<HTMLElement>) => void;
    /** HTML5 is kept for desktop FILE drops only, not for tile-to-tile movement. */
    onFileDrop?: (rowId: string, colId: string, files: FileList) => void;
    onOpen?: (rowId: string, colId: string) => void;
    /** Tile box in px. Stable — it is layout, not a handler, and it decides the rendition asked for. */
    size?: number;
}
export declare function MediaCellProvider({ value, children }: {
    value: MediaCellHandlers;
    children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare const MediaCell: import("react").NamedExoticComponent<ICellRendererParams<any, any, any>>;
/**
 * Grid options a MEDIA MATRIX must use.
 *
 * 🔴 `cellSelection: false` is not a preference. AG begins a cell range on the same mousedown that
 * starts a tile drag, and `stopPropagation` on the tile does not prevent it — measured in PES.7's
 * spike. A matrix that leaves cell selection on gets a drag that paints a blue range instead of
 * moving a picture.
 *
 * Spread it like `SHEET_GRID_OPTIONS`: one stable object, so the option-identity guard is satisfied.
 */
export declare const MEDIA_MATRIX_GRID_OPTIONS: {
    readonly cellSelection: false;
    readonly suppressCellFocus: false;
};
