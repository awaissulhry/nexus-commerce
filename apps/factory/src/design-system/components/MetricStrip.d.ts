import type { ReactNode } from 'react';
export interface Metric {
    label: ReactNode;
    value: ReactNode;
    /** optional change indicator */
    delta?: {
        value: ReactNode;
        positive?: boolean;
    };
    /** Descriptive sub-line under the value — what the number counts. Not a delta. */
    hint?: ReactNode;
    /** Colour for a small leading status dot on the label. */
    accent?: string;
    /** Makes the tile a real `<button>` — metric tiles are very often filters. */
    onClick?: () => void;
    /** Engaged — renders the tile selected and emits `aria-pressed`. Requires `onClick`. */
    active?: boolean;
}
export interface MetricStripProps {
    metrics: Metric[];
    className?: string;
}
/** Row of KPI tiles (H10 metric strip). Auto-fits to the container width. */
export declare function MetricStrip({ metrics, className }: MetricStripProps): import("react/jsx-runtime").JSX.Element;
