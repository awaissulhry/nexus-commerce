/**
 * Canonical data formatters — one definition for the platform (consolidates the
 * duplicated ads `format.ts`). Money is cents-based (Amazon convention); the
 * locale is fixed (`en-IE` / `en-GB`) so SSR and client render identically.
 */
/** cents → "€1,284.00" */
export declare const eur: (cents: number | null | undefined) => string;
/** cents → "€1,284" (no decimals — dense tiles/bars) */
export declare const eur0: (cents: number | null | undefined) => string;
/** Amazon reports store cost in micros (1e6). micros → "€" */
export declare const eurMicros: (micros: number | bigint | null | undefined) => string;
/** rounded integer with grouping → "1,284" */
export declare const num: (n: number | null | undefined) => string;
/** ratio → "14.9%" (input is a fraction, e.g. 0.149) */
export declare const pct: (v: number | null | undefined, dp?: number) => string;
/** multiplier → "2.40×" */
export declare const x2: (v: number | null | undefined) => string;
/** ISO/Date → "22 Jun 2026" */
export declare const formatDate: (value: string | Date | null | undefined) => string;
