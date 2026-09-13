/**
 * How the date READS. `value` and `onChange` are ISO (`yyyy-mm-dd`) whatever this is set to, so
 * the stored date cannot change meaning — only its presentation does.
 *
 * It exists because the component hard-coded `dd/mm/yyyy` while the ads console renders
 * `m/d/yyyy`, and "08/09" is two different days in those two formats. A page cannot mix them.
 */
export type DateFormat = 'dd/mm/yyyy' | 'mm/dd/yyyy' | 'yyyy-mm-dd';
export interface DateFieldProps {
    /** ISO date 'YYYY-MM-DD', or '' for unset */
    /** ISO `yyyy-mm-dd`. Unaffected by `format`. */
    value: string;
    /** Display format. Default `dd/mm/yyyy`, which is what this component always did. */
    format?: DateFormat;
    /** BCP-47 locale for the month/year heading. Default `en-GB`. */
    locale?: string;
    /**
     * id for the TRIGGER, so a `<label htmlFor>` reaches it. `Field` clones its single element
     * child with a generated id; a component that drops it leaves the label pointing at nothing,
     * which is worse than an unlabelled control because the markup looks correct.
     */
    id?: string;
    'aria-describedby'?: string;
    onChange: (value: string) => void;
    min?: string;
    max?: string;
    placeholder?: string;
    clearable?: boolean;
    clearLabel?: string;
    ariaLabel?: string;
    className?: string;
    disabled?: boolean;
}
/**
 * Single-date calendar field with ZERO native browser chrome — the
 * replacement for `<input type="date">` (banned by the Wave-1 conformance
 * ratchet). Same `.nds-dp-*` month-grid vocabulary as DateRangePicker,
 * single month, min/max support, optional clear row. Wave 1 gap-fill
 * (2026-07-04).
 */
export declare function DateField({ id, 'aria-describedby': describedBy, value, onChange, format, locale, min, max, placeholder, clearable, clearLabel, ariaLabel, className, disabled }: DateFieldProps): import("react/jsx-runtime").JSX.Element;
