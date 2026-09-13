export type GridValueKind = 
/** whole units, thousands-separated */
'integer'
/** cents → `€1,234` (no decimals — the catalogue's convention) */
 | 'money'
/** cents → `€1,234.56` */
 | 'money2'
/** EUROS (a decimal already) → `€1,234.56` — the catalogue's `basePrice` */
 | 'eur'
/** a FRACTION (0.153) → `15.3%` */
 | 'percent'
/** a signed number → `+12` / `−4` */
 | 'delta'
/** an ISO string or Date → the DS date */
 | 'date'
/** as-is */
 | 'text';
export interface FormatOptions {
    /** How a measured ZERO is shown. `literal` prints it; `dash` draws the muted dash with a title. */
    zero?: 'literal' | 'dash';
    /** Decimal places for `percent` (default 1). */
    dp?: number;
}
export interface FormattedValue {
    text: string;
    /** Nothing was measured — draw the dash, no title. */
    empty: boolean;
    /** A measured zero shown as a dash — draw the dash WITH a title. */
    measuredZero: boolean;
}
export declare function formatGridValue(kind: GridValueKind, value: unknown, opts?: FormatOptions): FormattedValue;
/** The dash every empty cell draws. One character, one place. */
export declare const EMPTY_DASH = "\u2014";
/** An instant, in the viewer's locale. Returns the raw string unchanged if it will not parse. */
export declare function when(iso: string): string;
/**
 * How long ago, in words — "7 weeks ago".
 *
 * Uses `Intl.RelativeTimeFormat` rather than a hand-rolled ladder so the wording is the platform's
 * in every locale. Future instants read "in 3 minutes" rather than being clamped to "just now": a
 * timestamp ahead of the clock means clock skew or a bad row, and hiding that would make a broken
 * value look like a fresh one.
 */
export declare function ago(iso: string, now?: number): string;
