import { type ReactNode } from 'react';
import type { Size } from '../primitives/size';
export interface ModalProps {
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    subtitle?: ReactNode;
    /** footer slot, right-aligned (e.g. Cancel / Save buttons).
     *  A `<span className="grow" />` between children splits it: left group / right group. */
    footer?: ReactNode;
    /**
     * 440 (sm) / 560 (md) / 660 (lg) / 920 (xl) / 1040 (xxl, for table modals) /
     * `full` (a MEDIA surface: `min(1680px, 96vw)` × 94vh).
     *
     * `full` exists because the DS had no surface for inspecting a picture. A product photo is
     * checked for framing, background and text overlay at something near its own size, and `xxl`
     * caps at 1040px × 82vh — a 2250×2250 image arrives there smaller than the tile it was opened
     * from. Added by PES.7 for the Product Edit Studio's image viewer; additive, so every existing
     * consumer renders byte-for-byte as before.
     */
    size?: Size | 'xxl' | 'full';
    children?: ReactNode;
    /** Stronger text contrast and focus for editing; preserves each control’s Nexus size. */
    readable?: boolean;
    className?: string;
    /** Optional grid-cell anchor. On narrow screens uses the usual modal layout and focus contract. */
    anchor?: HTMLElement | null;
    /** accessible name when there is no visible `title` (a titled modal names itself) */
    'aria-label'?: string;
}
/**
 * Centered modal (H10 `.h10-modal` spec). Portaled to <body>; Esc + backdrop
 * click close; scrollable body between bordered header/footer.
 */
export declare function Modal({ open, onClose, title, subtitle, footer, size, children, readable, className, anchor, 'aria-label': ariaLabel }: ModalProps): import("react").ReactPortal | null;
