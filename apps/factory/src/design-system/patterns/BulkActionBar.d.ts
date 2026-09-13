import type { ReactNode } from 'react';
export interface BulkActionBarProps {
    count: number;
    /** action buttons for the selection */
    children: ReactNode;
    onClear?: () => void;
    /** noun after the count (default "selected") */
    noun?: string;
    className?: string;
}
/**
 * Sticky bar for a selection (H10 `.h10-am-editbar`/bulk row). Renders nothing
 * when `count` is 0. Place at the bottom of a scroll container.
 */
export declare function BulkActionBar({ count, children, onClear, noun, className }: BulkActionBarProps): import("react/jsx-runtime").JSX.Element | null;
