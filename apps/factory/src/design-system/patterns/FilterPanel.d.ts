import { type ReactNode } from 'react';
export interface FilterPanelProps {
    title?: ReactNode;
    /** preset buttons row */
    presets?: ReactNode;
    /** the field grid — compose `FilterField` children */
    children: ReactNode;
    onReset?: () => void;
    onApply?: () => void;
    /** Label for the reset button (default "Reset"; pass "Clear" to match the Ad Manager). */
    resetLabel?: string;
    /** Disable the reset button (e.g. when no filters are active). */
    resetDisabled?: boolean;
    /** extra left-aligned footer slot (e.g. "Save to library") */
    footerExtra?: ReactNode;
    defaultOpen?: boolean;
}
/**
 * Collapsible filter panel (H10 `.h10-am-fpanel`): header + presets + a
 * responsive 6-col field grid + reset/apply footer. Compose with `FilterField`.
 */
export declare function FilterPanel({ title, presets, children, onReset, onApply, resetLabel, resetDisabled, footerExtra, defaultOpen }: FilterPanelProps): import("react/jsx-runtime").JSX.Element;
export declare function FilterField({ label, wide, children }: {
    label: ReactNode;
    wide?: boolean;
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
