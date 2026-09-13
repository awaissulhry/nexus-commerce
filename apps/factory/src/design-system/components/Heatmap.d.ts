export interface HeatmapProps {
    /**
     * Values as rows × cols. `null` means NO MEASUREMENT for that cell, which is not the same as a
     * measured zero and must not look like one: a null renders as a hatched cell rather than the
     * palest shade of the ramp. On a dayparting grid the difference is the whole point — "we hold
     * no data for Sunday 03:00" and "nothing was spent at Sunday 03:00" lead to opposite decisions.
     */
    data: Array<Array<number | null>>;
    rowLabels: string[];
    colLabels?: string[];
    /**
     * Full names for the tooltip, when `colLabels` is deliberately sparse.
     *
     * A 24-column axis can only carry a label every few columns before they collide, so callers
     * pass blanks for the rest — and the tooltip, built from the same array, then said
     * "Sun · : 4 days" for two cells out of three. On a grid whose entire question is WHICH HOUR,
     * that is the one thing it must not leave out. Defaults to `colLabels`, so a caller with a
     * fully-labelled axis passes nothing.
     */
    colTitles?: string[];
    format?: (v: number) => string;
    /** Shown in a cell's tooltip where the value is null. */
    emptyLabel?: string;
    className?: string;
}
/** Intensity heatmap (H10 dayparting): cell opacity scales with value/max. */
export declare function Heatmap({ data, rowLabels, colLabels, colTitles, format, emptyLabel, className }: HeatmapProps): import("react/jsx-runtime").JSX.Element;
