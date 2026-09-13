export interface SpinnerProps {
    /** diameter in px (default 16) */
    size?: number;
    className?: string;
}
/** Indeterminate ring spinner (H10 `@keyframes h10spin`). */
export declare function Spinner({ size, className }: SpinnerProps): import("react/jsx-runtime").JSX.Element;
