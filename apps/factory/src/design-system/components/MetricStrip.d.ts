import type { ReactNode } from 'react';
export interface Metric {
    label: ReactNode;
    value: ReactNode;
    /** optional change indicator */
    delta?: {
        value: ReactNode;
        positive?: boolean;
    };
    /**
     * Descriptive sub-line under the value — what the number counts ("live & selling", "no
     * available units"). NOT a delta: `delta` is a movement and is coloured up/down, this is a
     * definition and is muted. A tile whose number needs explaining had nowhere to put it, so
     * every strip that needed one was hand-rolled instead of using this component.
     */
    hint?: ReactNode;
    /**
     * Colour for a small leading dot on the label — the tile's status key.
     *
     * A raw colour rather than a tone name on purpose: callers key these off their own status
     * tokens (`--nds-success`, `--nds-danger`), and a fixed tone list cannot express "this tile is
     * the primary one".
     */
    accent?: string;
    /**
     * Makes the tile a real `<button>`. Metric tiles are very often filters — click "Out of stock"
     * to see the out-of-stock rows — and there was no way to say so, so pages wrapped a `<div>` in
     * `role="button"` + `tabIndex` + a hand-written `onKeyDown` and still shipped no pressed state.
     */
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
