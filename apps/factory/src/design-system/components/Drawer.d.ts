import { type ReactNode } from 'react';
export interface DrawerProps {
    id?: string;
    /** Viewport coordinates supplied by the shell; no layout space is reserved. */
    inset?: {
        top: number;
        left: number;
    };
    side?: 'left' | 'right';
    backdrop?: 'dimmed' | 'transparent';
    closeLabel?: string;
    closeIcon?: ReactNode;
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    /** EFX P6 — optional smaller line under the title. */
    subtitle?: ReactNode;
    footer?: ReactNode;
    children?: ReactNode;
    className?: string;
    /**
     * EFX P6 — panel width override. number = px, string = any CSS length.
     * Defaults to the stylesheet's 420px; the panel never exceeds the viewport
     * (max-width: 100% stays in CSS).
     */
    width?: number | string;
    /**
     * A modal surface rendered INSIDE the panel, covering header, body and
     * footer. Drawers sit at z-61; the app's Modal/ConfirmDialog sits lower, so
     * a confirmation spawned from a drawer used to open BEHIND it (invisible
     * until the drawer was closed). Anything a drawer must confirm goes here
     * instead — one surface, nothing hidden, no separate pop-up.
     */
    overlay?: ReactNode;
    /**
     * PES.4.1 — which of the two drawers this is.
     *
     * `modal` (default, and what all 22 existing consumers get byte-for-byte) is
     * a slide-over: fixed to the viewport's right edge, backdrop, `aria-modal`,
     * focus trapped inside. The page behind it is inert on purpose.
     *
     * `dock` is the opposite contract, and the difference is not cosmetic. A
     * docked drawer is a SECOND pane of one workspace: it renders in the normal
     * flow so the surface beside it reflows instead of being covered, it takes
     * no backdrop and no `aria-modal`, it never traps focus, and it never steals
     * focus on open. That is what makes "expand the record without leaving the
     * sheet" true rather than a claim — the grid behind a dock is still
     * keyboard-navigable, still editable, still the thing the operator is doing.
     *
     * A dock is therefore laid out by its PARENT: put it in a flex row beside
     * the surface it annotates. It contributes its own width and full height.
     */
    /** `embedded` renders the editor in its parent's layout, without covering shell navigation. */
    mode?: 'modal' | 'dock' | 'embedded';
    /**
     * Dock only — a drag handle on the panel's leading edge. The width stays
     * CONTROLLED (`width` + `onWidthChange`) so the owner can persist it; this
     * component never remembers a size the operator chose.
     */
    resizable?: boolean;
    /** Dock resize floor, px. Default 360. */
    minWidth?: number;
    /** Dock resize ceiling, px. Default 900. */
    maxWidth?: number;
    /** Fires continuously while dragging (and on each arrow-key nudge), in px. */
    onWidthChange?: (width: number) => void;
}
/**
 * Right-side panel, in two modes.
 *
 *   modal (default)  slide-over portaled to <body>; backdrop, aria-modal, Esc
 *                    and backdrop close, focus trapped inside.
 *   dock (PES.4.1)   a second pane in the normal flow beside a live surface:
 *                    no portal, no backdrop, not aria-modal, no focus trap, no
 *                    focus steal, optional drag/arrow-key resize. Lay it out
 *                    yourself — put it in a flex row next to what it annotates.
 *
 * Both render the same header/body/footer/overlay DOM, so a drawer cannot look
 * like two different components depending on where it is standing.
 *
 * Everything below describes the modal mode, and still holds for it exactly.
 *
 * NAF.SB.AS-S2R / S2.e — keyboard and screen-reader access.
 *
 * Measured on production before this change: **a keyboard user needed 41 Tab
 * presses to reach an open drawer.** 63 focusable elements on the page, and
 * the first one inside the drawer was number 41 — because this component
 * portals to the end of `<body>`, moved focus nowhere on open, trapped
 * nothing, and left the whole page behind it in the tab order. The panel also
 * carried `role="dialog" aria-modal="true"` with no accessible name at all.
 *
 * All three are fixed here rather than in one feature component, because 22
 * files render this and a focus trap written inside a feature is a focus trap
 * that rots. Nothing about the visual result changes, and no prop was added:
 * a drawer that was reachable before is reachable now, in one Tab instead of
 * forty-one.
 */
export declare function Drawer({ id, inset, side, backdrop, closeLabel, closeIcon, open, onClose, title, subtitle, footer, children, className, width, overlay, mode, resizable, minWidth, maxWidth, onWidthChange, }: DrawerProps): import("react/jsx-runtime").JSX.Element | null;
