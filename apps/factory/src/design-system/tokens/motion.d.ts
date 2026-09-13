/**
 * Motion tokens. H10 transitions are fast + intentional (.12–.18s ease). Mirror
 * the app's existing fast/base/slow scale (lib/theme/index.ts DURATION_MS) so JS
 * and CSS stay in sync; the H10-specific micro-durations are named separately.
 */
export declare const duration: {
    readonly micro: "120ms";
    readonly label: "140ms";
    readonly control: "150ms";
    readonly panel: "180ms";
};
export declare const easing: {
    /** H10 uses the CSS default `ease` almost everywhere. */
    readonly standard: "ease";
    /** smooth decel for entrances (matches the app's `out` easing). */
    readonly out: "cubic-bezier(0.16, 1, 0.3, 1)";
};
/** Numeric ms for JS-driven transitions (e.g. unmount-after-fade). */
export declare const durationMs: {
    readonly micro: 120;
    readonly label: 140;
    readonly control: 150;
    readonly panel: 180;
};
