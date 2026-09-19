import { type DateFormat } from './DateField';
export interface DateTimeFieldProps {
    /** ISO instant, or '' for unset. */
    value: string;
    onChange: (value: string) => void;
    /** ISO instant: earlier moments are not offered. */
    min?: string;
    /** ISO instant: later moments are not offered. */
    max?: string;
    /** Minutes between the offered times. Default 15. */
    stepMinutes?: 5 | 10 | 15 | 30 | 60;
    /** The time a newly chosen date starts at, `HH:MM`. Default `09:00`. */
    defaultTime?: string;
    format?: DateFormat;
    /** BCP-47 locale for the month heading and the zone name. Default `en-GB`. */
    locale?: string;
    /** id for the DATE trigger, so a `Field` label reaches it. The time list is named by `ariaLabel`. */
    id?: string;
    'aria-describedby'?: string;
    /** What the moment is, e.g. "Ends". Names the date and the time controls. */
    ariaLabel?: string;
    disabled?: boolean;
    className?: string;
}
/** The viewer's local calendar day of an instant, `yyyy-mm-dd`. */
export declare const localDay: (d: Date) => string;
/** The viewer's local time of day of an instant, `HH:MM`. */
export declare const localTime: (d: Date) => string;
/** A local day and time of day as an instant. */
export declare function combineLocal(date: string, time: string): Date;
/** The times offered on `day`: every step inside [min, max], plus the chosen time if it sits between steps. */
export declare function timeOptions(day: string, stepMinutes: number, min: Date | null, max: Date | null, chosen?: string): string[];
/** The instant for a chosen day and time (or `defaultTime`), kept inside [min, max]; '' without a day. */
export declare function momentValue(date: string, time: string, defaultTime: string, min: Date | null, max: Date | null): string;
/** "Europe/Rome (CEST)" — the zone the times are shown in. */
export declare function timeZoneWords(at?: Date, locale?: string): string;
export declare function DateTimeField({ value, onChange, min, max, stepMinutes, defaultTime, format, locale, id, 'aria-describedby': describedBy, ariaLabel, disabled, className, }: DateTimeFieldProps): import("react/jsx-runtime").JSX.Element;
