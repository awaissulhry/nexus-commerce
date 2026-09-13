import { type ReactNode } from 'react';
export interface DetailHeaderProps {
    backLabel?: ReactNode;
    onBack?: () => void;
    /**
     * Render the back control as the caller's own element — typically `<Link href>` — keeping the
     * DS's chrome and its chevron. Same idiom and same mechanism as `Button asChild`: pass the
     * element as `backLabel` and it is cloned with the class and the chevron injected before its
     * own children.
     *
     * It exists because a real anchor is the only back control that honours ⌘-click, middle-click
     * and "Open in new tab" — a `<button onClick={router.back}>` silently swallows all three.
     */
    backAsChild?: boolean;
    /** leading badge slot (e.g. a targeting chip) */
    badge?: ReactNode;
    title: ReactNode;
    /** An independently controlled related-view menu, placed beside the heading. */
    titleMenu?: ReactNode;
    /**
     * Identity that travels WITH the title — SKU, external id, a status pill. Not a subtitle: it
     * sits on the title's own line so a `dense` header stays one row.
     */
    meta?: ReactNode;
    /**
     * A state region between the title and the actions — an autosave indicator, a sync clock. Kept
     * apart from `actions` because it is not clickable and should not read as a control.
     */
    status?: ReactNode;
    actions?: ReactNode;
    /**
     * Page chrome rather than a section head: ONE row, the back link inline before the title, a
     * smaller title, a bottom hairline and no bottom margin.
     *
     * The default two-row form introduces a section inside a padded page. A page whose whole body is
     * a grid has no such padding to sit in, and its header is a band — that is this.
     */
    dense?: boolean;
    className?: string;
}
/**
 * Drill-in detail header (H10 `.h10-cd-hdr`): back link + badge + title + actions.
 *
 * Two forms from one component. Default = the section head it always was, DOM-identical when the
 * props below are omitted (verified: its only consumer is the DS catalog). `dense` = the one-row page band the Product Edit Studio's frame needs
 * (PES.1), where the back link, the identity, the live state and the actions share a single line.
 */
export declare function DetailHeader({ backLabel, onBack, backAsChild, badge, title, titleMenu, meta, status, actions, dense, className, }: DetailHeaderProps): import("react/jsx-runtime").JSX.Element;
