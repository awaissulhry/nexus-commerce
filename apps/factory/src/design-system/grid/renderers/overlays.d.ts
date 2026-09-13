/**
 * GDS — the grid's loading and empty overlays, as AG overlay components.
 *
 *   loadingOverlayComponent={GridLoadingOverlay}
 *   noRowsOverlayComponent={GridNoRowsOverlay}
 *   noRowsOverlayComponentParams={{ title, message, action }}
 *
 * The skeleton draws rows at the CURRENT density (it reads the same context the grid does), so a
 * loading Spacious grid is the height of a loaded one and nothing jumps when the data lands.
 */
import { type ReactNode } from 'react';
export interface GridLoadingOverlayParams {
    /** Skeleton rows to draw (default 6). */
    rows?: number;
    /** Draw a thumbnail block in the first cell (media rows). */
    media?: boolean;
    /** Match the host's row kind, including a thumbnail on a single-line product row. */
    rowKind?: 'text' | 'media' | 'media-line';
}
export declare const GridLoadingOverlay: import("react").NamedExoticComponent<GridLoadingOverlayParams>;
export interface GridNoRowsOverlayParams {
    title?: ReactNode;
    message?: ReactNode;
    /** A call to action — `{ label, onClick }` or your own node. */
    action?: {
        label: ReactNode;
        onClick: () => void;
    } | ReactNode;
}
export declare const GridNoRowsOverlay: import("react").NamedExoticComponent<GridNoRowsOverlayParams>;
