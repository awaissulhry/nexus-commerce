export interface DateRange {
    start: Date;
    end: Date;
}
export interface DateRangePickerProps {
    value: DateRange;
    onChange: (range: DateRange) => void;
    className?: string;
    /**
     * Override the preset rail. Omit it and you get `DEFAULT_PRESETS` — the eight the operator
     * picked as the platform default, matching the ads console's picker.
     *
     * A prop rather than a hardcoded list because the default DROPPED the three day-count presets
     * (`Last 7 / 30 / 90 days`) that shipped before it, and a surface that genuinely reasons in
     * rolling days should be able to say so instead of being told the platform no longer counts
     * that way.
     */
    presets?: ReadonlyArray<{
        label: string;
        get: () => DateRange;
    }>;
}
/**
 * The platform default, chosen by the operator 2026-08-25 from the ads console's picker: eight
 * presets, calendar-relative rather than rolling-day.
 *
 * This REPLACES the previous seven. `Last 7 / 30 / 90 days` are gone from the default — a rolling
 * window and a calendar period answer different questions, and mixing both in one rail made the
 * list read as two half-finished ideas. Anything that needs them passes `presets`.
 */
export declare const DEFAULT_PRESETS: ReadonlyArray<{
    label: string;
    get: () => DateRange;
}>;
export declare function DateRangePicker({ value, onChange, className, presets }: DateRangePickerProps): import("react/jsx-runtime").JSX.Element;
