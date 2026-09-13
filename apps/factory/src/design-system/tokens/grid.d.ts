/**
 * GDS — grid component tokens (tier 3, `--nds-grid-*`).
 *
 * ONE table for every number and colour the AG-Grid-based design-system grid draws. `theme.ts`
 * (the AG Theming API params) and the engine stylesheet consume the CSS custom properties emitted
 * from `gridVars`; TypeScript consumers that must hand AG a NUMBER (`rowHeight`, `headerHeight`,
 * column widths) read the same values from `gridDensity` / `gridGeometry` — so the row height a
 * page passes and the row height the spec prints can never disagree.
 *
 * Every colour DERIVES FROM A SEMANTIC TOKEN (`--nds-surface-*`, `--nds-border-*`, `--nds-text-*`,
 * `--nds-primary`, the status hues). None binds a ramp step. The previous theme bound
 * `--nds-white` / `--nds-grey-25` / `--nds-grey-150` / `--nds-grey-200` directly — measured
 * 2026-08-28, none of those flip, so a dark grid was dark text on a white ground.
 *
 * 🔴 Deriving is NOT enough on its own. A custom property whose value is `var(X)` resolves in the
 * scope where it is DECLARED: `--nds-grid-bg: var(--nds-surface)` on `:root` computes to the LIGHT
 * surface there and inherits that literal into `.dark`, where redefining `--nds-surface` never
 * reaches it. So every colour alias below is ALSO emitted into the `.dark` block (`gridVarsDark`,
 * the same `var(X)` form) — `scripts/check-dark-alias-scope.mjs` fails the push otherwise, and it
 * did, on this file's first run.
 *
 * Numbers are MEASUREMENTS, not preferences — taken off /products/next and the inventory editor at
 * baseline `2b0e43fc4` (docs/2026-08-28-grid-design-system-gds.md §4). Row heights are integers
 * because AG virtualises off a fixed row height and a fraction accumulates down a list.
 *
 * Byte-identical in apps/web and apps/factory (the fork-drift guard holds new shared files equal).
 */
export interface GridCssVar {
    section?: string;
    name: string;
    value: string;
}
/**
 * Density tiers — the ONE vocabulary (Q3, decided 2026-08-28). `rowText` is a plain one-line row;
 * `rowMedia` is a row whose identity cell carries a thumbnail (photo · title · sub-line). Header
 * height is the same in every kind. Spacious is the default on /products/next (Owner).
 *
 * `rowMediaLine` is a THIRD row KIND, not a fourth density tier (DS.1 + PES.2, 2026-09-02,
 * hub ruling #195): a one-line row carrying a thumbnail but NO stack — the studio sheet's
 * identity cell, where SKU and Name are already their own columns. `rowMedia`'s extra height
 * buys the photo · title · sub-line stack; a cell with no stack should not pay for it.
 * It is a KIND rather than a tier because density is an operator preference applied across
 * every grid — making 36 a tier would silently give the ads console a thumbnail row when an
 * operator picks "compact" — whereas height driven by cell CONTENT is a property of the row.
 * Derived as `thumb + 4` (2px above and below) so the rule cannot drift from the thumb it has
 * to contain: at compact that is 32 + 4 = 36, which is the studio's measured requirement.
 *
 * 🔴 DO NOT drop `rowMediaLine` back toward `rowText` (28) to reclaim vertical space. Two things
 * break, and NEITHER reports the row height as the cause:
 *   1. The thumbnail clips — and NOTHING currently prevents it. `grid.css` carries
 *      `min(--nds-grid-thumb-compact, calc(--ag-row-height - 4px))`, which LOOKS like a cap and is
 *      inert: measured 2026-09-02 (DS.1 and UX.1 independently), `--ag-row-height` computes to
 *      **42px while the rows render at 28px**, because `NexusGrid` passes `rowHeight` as a grid
 *      OPTION and AG applies it inline without ever feeding that variable. So it evaluates
 *      `min(32px, 38px)` = 32px and passes the value straight through. An AG geometry variable is a
 *      theme INPUT, not a readback of what the grid rendered. Do not rely on that line.
 *   2. PES.1's collapsing header stops arming, and the symptom appears in PES.1's code, not here.
 *      Measured (UX.1, 2026-09-02): `H = innerHeight - 267` and arming needs a scroll range
 *      `R >= 48`. At 28px rows the header arms only on viewports <= 894px tall — so it works on a
 *      laptop and silently does not on an external monitor, with no message and nothing to click.
 *      At 36 it is armed to 1031px and the whole class disappears.
 * A change here is a change to two other lanes' features. Re-measure both before touching it.
 *
 *   tier      rowText  rowMedia  rowMediaLine  header  thumb  cellPadX
 *   compact     28       52           36         28     32      10   (engine xs; DS grid `xs` 5/9 padding)
 *   cozy        43       68           44         38     40      14   (engine md)
 *   spacious    49       85           60         46     56      14   (engine lg)
 */
export declare const gridDensity: {
    readonly compact: {
        readonly rowText: 28;
        readonly rowMedia: 52;
        readonly rowMediaLine: 36;
        readonly header: 28;
        readonly thumb: 32;
        readonly cellPadX: 10;
    };
    readonly cozy: {
        readonly rowText: 43;
        readonly rowMedia: 68;
        readonly rowMediaLine: 44;
        readonly header: 38;
        readonly thumb: 40;
        readonly cellPadX: 14;
    };
    readonly spacious: {
        readonly rowText: 49;
        readonly rowMedia: 85;
        readonly rowMediaLine: 60;
        readonly header: 46;
        readonly thumb: 56;
        readonly cellPadX: 14;
    };
};
export type GridDensityName = keyof typeof gridDensity;
export declare const GRID_DENSITIES: readonly ["compact", "cozy", "spacious"];
/** Geometry that does not vary with density. */
export declare const gridGeometry: {
    /** The column-group row above the header — a slim STRIP, not a second header (IE.4). */
    readonly stripH: 30;
    /** A full-width footer row under a family's variations ("Showing 10 of 40 · View all"). */
    readonly footerRowH: 48;
    /** The checkbox column; AG's default is 50, the DS grid measured 43. */
    readonly selectColW: 43;
    /** Identity column base width at compact (fits a 34-char SKU); grows by the thumb delta per tier. */
    readonly identityW: 320;
    /** Header partition: a 2px mark, 30% of the HEADER ROW's height (never of a spanning cell). */
    readonly partitionW: 2;
    readonly partitionRatio: 0.3;
    /** AG's checkbox, kept: it is what the Owner approved on screen and what AG keeps accessible. */
    readonly checkboxSize: 16;
};
/** Type — numbers the theme states in px; weights as CSS weights. */
export declare const gridType: {
    readonly headerSize: 11.5;
    readonly headerWeight: 700;
    readonly cellSize: 13;
    readonly cellWeight: 500;
    readonly stripSize: 11;
    readonly stripWeight: 700;
    readonly stripTracking: "0.05em";
};
/**
 * The emitted custom properties, in spec order. Consumed by `tokens/css-vars.ts` (spread into the
 * generated `tokens.css` / `tokens-global.css`) — never hand-written into a stylesheet.
 */
export declare const gridVars: ReadonlyArray<GridCssVar>;
/**
 * The `.dark` re-declarations: every entry whose value aliases a token (`var(--nds-…)`) or mixes
 * one (`color-mix(… var(--nds-…) …)`), restated verbatim so it resolves against the dark tier.
 * Dimensions, ratios and weights are theme-invariant and stay on `:root` only.
 */
export declare const gridVarsDark: ReadonlyArray<GridCssVar>;
/** Every emitted name — the theme test asserts each one is what the theme binds to. */
export declare const GRID_TOKEN_NAMES: ReadonlyArray<string>;
export declare const grid: {
    readonly density: {
        readonly compact: {
            readonly rowText: 28;
            readonly rowMedia: 52;
            readonly rowMediaLine: 36;
            readonly header: 28;
            readonly thumb: 32;
            readonly cellPadX: 10;
        };
        readonly cozy: {
            readonly rowText: 43;
            readonly rowMedia: 68;
            readonly rowMediaLine: 44;
            readonly header: 38;
            readonly thumb: 40;
            readonly cellPadX: 14;
        };
        readonly spacious: {
            readonly rowText: 49;
            readonly rowMedia: 85;
            readonly rowMediaLine: 60;
            readonly header: 46;
            readonly thumb: 56;
            readonly cellPadX: 14;
        };
    };
    readonly geometry: {
        /** The column-group row above the header — a slim STRIP, not a second header (IE.4). */
        readonly stripH: 30;
        /** A full-width footer row under a family's variations ("Showing 10 of 40 · View all"). */
        readonly footerRowH: 48;
        /** The checkbox column; AG's default is 50, the DS grid measured 43. */
        readonly selectColW: 43;
        /** Identity column base width at compact (fits a 34-char SKU); grows by the thumb delta per tier. */
        readonly identityW: 320;
        /** Header partition: a 2px mark, 30% of the HEADER ROW's height (never of a spanning cell). */
        readonly partitionW: 2;
        readonly partitionRatio: 0.3;
        /** AG's checkbox, kept: it is what the Owner approved on screen and what AG keeps accessible. */
        readonly checkboxSize: 16;
    };
    readonly type: {
        readonly headerSize: 11.5;
        readonly headerWeight: 700;
        readonly cellSize: 13;
        readonly cellWeight: 500;
        readonly stripSize: 11;
        readonly stripWeight: 700;
        readonly stripTracking: "0.05em";
    };
};
