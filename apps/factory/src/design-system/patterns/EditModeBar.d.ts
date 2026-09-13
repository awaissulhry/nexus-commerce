import type { ReactNode } from 'react';
export interface EditModeBarProps {
    /** custom message; defaults to "N unsaved change(s)" from `count` */
    message?: ReactNode;
    count?: number;
    onDiscard?: () => void;
    onApply?: () => void;
    applyLabel?: ReactNode;
    busy?: boolean;
}
/** Sticky discard/apply bar for unsaved edits (H10 `.h10-am-editbar`). */
export declare function EditModeBar({ message, count, onDiscard, onApply, applyLabel, busy }: EditModeBarProps): import("react/jsx-runtime").JSX.Element;
