import { type CSSProperties, type RefObject } from 'react';
export interface PopoverPositionOptions {
    /**
     * `'anchor'` makes the trigger's width the panel's FLOOR — right for a select-like control. The
     * panel then grows to its longest label and is capped by `--nds-popover-max-w` (D18), so it is
     * `clamp(anchor, content, 320px)`, not a fixed copy of the trigger.
     * `'auto'` leaves width alone so the panel sizes to its content and its own CSS `min-width`;
     * right for a menu, whose trigger may be a 28px icon button.
     */
    width?: 'anchor' | 'auto';
    /** `'end'` aligns the panel's RIGHT edge to the anchor's, for a right-aligned menu */
    align?: 'start' | 'end';
    /** gap between anchor and panel */
    offset?: number;
}
/**
 * Fixed-position coordinates for a panel portaled to `<body>`.
 *
 * WHY PORTAL AT ALL: an absolutely-positioned panel is clipped by any ancestor that scrolls or
 * hides overflow. Measured 2026-08-25 — `.nds-modal` is `overflow: hidden` and `.nds-modal-b` is
 * `overflow-y: auto`, so every DS dropdown opened inside a DS Modal was cut off at the dialog
 * edge, and the same happened inside every grid. `HoverCard` already portals for exactly this
 * reason; this puts the other four on the same footing instead of a fifth bespoke fix.
 *
 * Flips above the anchor only when there is no room below AND genuine room above — never into a
 * worse position. Horizontally it stays tied to its anchor: left-aligned by default, right-aligned
 * to the anchor when left-aligning would overflow, and clamped to the viewport only when neither
 * fits (D18). Re-measures on scroll (capturing, so inner scroll containers count) and on resize.
 */
export declare function usePopoverPosition(open: boolean, anchorRef: RefObject<HTMLElement | null>, options?: PopoverPositionOptions): {
    popRef: RefObject<HTMLDivElement>;
    style: CSSProperties;
};
