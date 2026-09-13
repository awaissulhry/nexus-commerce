/**
 * Typography tokens — H10 type system.
 *
 * H10 is dense: a 10–18px hot zone with hero sizes (22/27) reserved for page
 * titles + counters. The font is the app's Inter (`var(--font-sans)`), rendered
 * with the heavier default smoothing (NOT `antialiased`) — captured as
 * `fontSmoothing` so the migration preserves H10's deliberately bolder text.
 */
export declare const fontFamily: {
    readonly sans: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
};
/** Deliberate: H10 sets `-webkit-font-smoothing: auto` to render text heavier
 *  than the app-wide `antialiased`. This is a design choice, not a bug. */
export declare const fontSmoothing: "auto";
/** px sizes seen across the ads stylesheets, named by role. */
export declare const fontSize: {
    readonly nano: "9px";
    readonly micro: "10px";
    readonly microPlus: "10.5px";
    readonly xs: "11px";
    readonly xsPlus: "11.5px";
    readonly sm: "12px";
    readonly smPlus: "12.5px";
    readonly base: "13px";
    readonly basePlus: "13.5px";
    readonly mdMinus: "14px";
    readonly md: "15px";
    readonly lg: "18px";
    readonly xl: "22px";
    readonly '2xl': "27px";
};
export declare const fontWeight: {
    readonly normal: 400;
    readonly medium: 500;
    readonly semibold: 600;
    readonly bold: 700;
    readonly extrabold: 800;
};
export declare const letterSpacing: {
    readonly tight: "-0.02em";
    readonly snug: "-0.01em";
    readonly wide: "0.03em";
    readonly wider: "0.04em";
};
export declare const lineHeight: {
    readonly tight: 1.2;
    readonly snug: 1.45;
    readonly normal: 1.5;
};
