export interface ChartSeries {
    key: string;
    label: string;
    color: string;
    axis: 'left' | 'right';
    format?: (v: number) => string;
}
export interface PerformanceGraphProps {
    data: Array<Record<string, number | string>>;
    xKey: string;
    left: ChartSeries;
    right: ChartSeries;
    height?: number;
    className?: string;
}
/**
 * Dual-axis combo chart (H10 AdManagerGraph): two line series on independent
 * left/right axes, tokenized axes + grid, custom tooltip + legend. Recharts.
 */
export declare function PerformanceGraph({ data, xKey, left, right, height, className }: PerformanceGraphProps): import("react/jsx-runtime").JSX.Element;
