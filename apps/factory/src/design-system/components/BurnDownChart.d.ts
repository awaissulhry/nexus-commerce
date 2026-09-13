export interface BurnDownPoint {
    day: number;
    /** Cumulative actual, in the display unit. null after today. */
    actual: number | null;
    expected: number;
    /** Cumulative projection. null before today. */
    forecast: number | null;
}
export interface BurnDownChartProps {
    data: BurnDownPoint[];
    /** Drawn as a horizontal threshold rule. Omit when the plan has no cap. */
    capValue?: number | null;
    capLabel?: string;
    /** Formats every value — axis ticks, tooltip rows and the cap label. */
    format: (v: number) => string;
    height?: number;
    /** Marks "today" with a faint vertical rule, so the actual/forecast handover is legible. */
    todayDay?: number | null;
    className?: string;
}
export declare function BurnDownChart({ data, capValue, capLabel, format, height, todayDay, className, }: BurnDownChartProps): import("react/jsx-runtime").JSX.Element;
