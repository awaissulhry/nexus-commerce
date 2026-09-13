import { type ReactNode } from 'react';
export interface HoverCardProps {
    /** single-line hint. Takes precedence over `rows`. */
    text?: string;
    /** key/value rows, rendered as a small definition list */
    rows?: Array<[string, string]>;
    /** preferred side; flips automatically when that side has no room */
    placement?: 'above' | 'below';
    /** ms before a COLD hover shows. A hover within 350ms of the last hide is "warm" and shows at once. */
    delay?: number;
    /**
     * Checked at hover time — return true to suppress. The DS must not know about any app's
     * interaction state, so a caller that has one (a column drag, a resize) passes it in here.
     */
    shouldSuppress?: () => boolean;
    children: ReactNode;
    className?: string;
}
export declare function HoverCard({ text, rows, placement, delay, shouldSuppress, children, className, }: HoverCardProps): import("react/jsx-runtime").JSX.Element;
