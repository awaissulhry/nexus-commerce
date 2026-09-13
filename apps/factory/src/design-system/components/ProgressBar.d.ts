export interface ProgressBarProps {
    /** Accessible name describing the operation being measured. */
    ariaLabel?: string;
    /** 0–100 (ignored when `indeterminate`) */
    value?: number;
    indeterminate?: boolean;
    /** track height in px (default 7) */
    height?: number;
    className?: string;
}
/** Progress track + fill (H10 `.h10-util` look). */
export declare function ProgressBar({ ariaLabel, value, indeterminate, height, className }: ProgressBarProps): import("react/jsx-runtime").JSX.Element;
