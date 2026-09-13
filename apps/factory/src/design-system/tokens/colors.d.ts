/**
 * Color tokens — the canonical H10 palette.
 *
 * Three tiers (see ../docs/TOKENS.md):
 *   palette   → raw ramps (primitive). Not consumed directly by components.
 *   color     → semantic roles (text/surface/border/primary/status). Use THESE.
 *   badge     → component tokens for the program/targeting chips.
 *
 * Values are the curated canon distilled from the ~251 hex literals in the ads
 * stylesheets (most are near-duplicate drift — see ../studies/01-color-drift.md).
 * Frequencies in comments are occurrences across the four ads CSS files.
 *
 * Kept in sync with ../styles/tokens.css (same values as CSS vars). JS consumers
 * that need a real color (e.g. Recharts) import from here; CSS uses var(--nds-*).
 * TODO(Phase 7): generate tokens.css from this file to remove the hand-sync.
 */
export declare const palette: {
    readonly white: "#ffffff";
    /** Brand blue. 600 is THE primary (383×). */
    readonly blue: {
        readonly 50: "#eef5ff";
        readonly 100: "#e7f0fd";
        readonly 200: "#cfe0fb";
        readonly 600: "#1f6fde";
        readonly 700: "#1a60c4";
        readonly 800: "#134da3";
        readonly 900: "#0a4ba8";
    };
    /** Cool slate neutral ramp — text, surfaces, borders. */
    readonly grey: {
        readonly 25: "#f7f9fb";
        readonly 50: "#f4f6f9";
        readonly 75: "#f1f4f8";
        readonly 100: "#eef1f5";
        readonly 150: "#e6e9ee";
        readonly 200: "#d8dde4";
        readonly 300: "#c2c9d3";
        readonly 400: "#aeb6c2";
        readonly 450: "#98a2b3";
        readonly 500: "#8a93a1";
        readonly 600: "#5b6573";
        readonly 700: "#3a4452";
        readonly 800: "#2b3440";
        readonly 900: "#1c2530";
    };
    /** Rail surface is a hair cooler than canvas (measured off H10). */
    readonly railBg: "#f1f3f5";
    readonly railBorder: "#e3e7ec";
    readonly green: {
        readonly soft: "#dcfce7";
        readonly 500: "#1e9e62";
        readonly 600: "#15a34a";
        readonly 700: "#15803d";
    };
    readonly red: {
        readonly soft: "#fde8e8";
        readonly 500: "#e5484d";
        readonly 600: "#d4493f";
        readonly 700: "#c0392b";
    };
    readonly amber: {
        readonly soft: "#fdf3d3";
        readonly 600: "#b87503";
        readonly 700: "#c2410c";
        readonly text: "#9a6700";
    };
    /** Manual targeting + Sponsored-Products chip. */
    readonly purple: {
        readonly bg: "#f3e8ff";
        readonly 600: "#7400bc";
        readonly 700: "#6d28d9";
    };
    /** Sponsored Display chip. */
    readonly cyan: {
        readonly bg: "#e0f2fe";
        readonly 700: "#0e7490";
    };
    /** Amazon brand mark. */
    readonly amazon: "#232f3e";
};
export declare const color: {
    readonly text: "#1c2530";
    readonly text2: "#5b6573";
    readonly text3: "#8a93a1";
    readonly textStrong: "#3a4452";
    readonly textDisabled: "#aeb6c2";
    readonly textInverse: "#ffffff";
    readonly textLink: "#1f6fde";
    readonly bg: "#f4f6f9";
    readonly surface: "#ffffff";
    readonly surfaceRaised: "#f7f9fb";
    readonly surfaceSunken: "#eef1f5";
    readonly surfaceHover: "#f1f4f8";
    readonly washPrimary: "#eef5ff";
    readonly railBg: "#f1f3f5";
    readonly border: "#d8dde4";
    readonly borderSubtle: "#e6e9ee";
    readonly borderStrong: "#c2c9d3";
    readonly railBorder: "#e3e7ec";
    readonly primary: "#1f6fde";
    readonly primaryHover: "#1a60c4";
    readonly primaryDark: "#134da3";
    readonly primarySoft: "#e7f0fd";
    readonly primaryGhostBorder: "#cfe0fb";
    readonly successSoft: "#dcfce7";
    readonly success: "#15a34a";
    readonly successStrong: "#15803d";
    readonly live: "#1e9e62";
    readonly dangerSoft: "#fde8e8";
    readonly danger: "#e5484d";
    readonly dangerStrong: "#c0392b";
    readonly warningSoft: "#fdf3d3";
    readonly warning: "#b87503";
    readonly warningStrong: "#c2410c";
    readonly infoSoft: "#e7f0fd";
    readonly info: "#1f6fde";
    readonly amazon: "#232f3e";
};
/** Status-pill triples (text / bg), as used by .h10-pill. */
export declare const pill: {
    readonly ok: {
        readonly fg: "#0a4ba8";
        readonly bg: "#d2e6fc";
    };
    readonly warn: {
        readonly fg: "#9a6700";
        readonly bg: "#fdf3d3";
    };
    readonly arch: {
        readonly fg: "#6b7480";
        readonly bg: "#eef1f5";
    };
};
export declare const badge: {
    readonly sp: {
        readonly fg: "#6d28d9";
        readonly bg: "#f3e8ff";
    };
    readonly sd: {
        readonly fg: "#0e7490";
        readonly bg: "#e0f2fe";
    };
    readonly sb: {
        readonly fg: "#c2410c";
        readonly bg: "#fef3c7";
    };
    readonly targetingAuto: "#134da3";
    readonly targetingManual: "#7400bc";
};
/**
 * Tag swatches — the closed set the tag colour picker offers.
 *
 * PERSISTED: the chosen string is stored on the tag, so a value here is data and not styling —
 * re-snapping one onto a nearer ramp step would orphan every tag already carrying the old value.
 * They live here rather than as literals in primitives/ColorSwatchPicker.tsx so the picker and
 * anything rendering an already-saved tag read ONE definition, and so the DS token-guard — which
 * forbids raw hex anywhere outside the token tier — has a legitimate home to point at.
 *
 * Seven sit on the ramp; the rest are identity-only hues with no ramp counterpart, pinned at
 * their measured values the way teal / violet / slate are above.
 *
 * 🔴 MEASURED, not chosen by eye. A swatch is a graphical mark, so the bar is WCAG 1.4.11's 3:1 —
 * and it must clear it on BOTH surfaces, light (#ffffff) and dark (#18263b), because the same hex
 * is the dot in both themes. The eight added 2026-08-28 all do:
 *   Orange 3.56/4.28 · Lime 3.09/4.93 · Emerald 3.77/4.04 · Indigo 4.47/3.41
 *   Violet 4.23/3.60 · Fuchsia 4.71/3.23 · Rose 3.67/4.15 · Stone 4.62/3.29
 *
 * 🔴 KNOWN DEFECT in the original eight, measured the same way: Purple (1.79), Teal (2.84),
 * Pink (2.52) and Grey (2.58) FAIL 3:1 on the dark surface. They are left as they are because
 * changing a hex changes nothing already saved (a tag stores its own value) but does change a
 * palette operators recognise — a call to make deliberately, not a silent edit. Identity no
 * longer rests on colour alone regardless: every tag can carry a glyph (`Tag.icon`).
 */
export declare const accountIdentity: readonly [{
    readonly name: "Blue";
    readonly hex: "#1f6fde";
}, {
    readonly name: "Teal";
    readonly hex: "#0f8b8d";
}, {
    readonly name: "Green";
    readonly hex: "#15a34a";
}, {
    readonly name: "Amber";
    readonly hex: "#b87503";
}, {
    readonly name: "Orange";
    readonly hex: "#c2410c";
}, {
    readonly name: "Red";
    readonly hex: "#d4493f";
}, {
    readonly name: "Purple";
    readonly hex: "#7c3aed";
}, {
    readonly name: "Slate";
    readonly hex: "#475569";
}];
export declare const chart: {
    readonly actual: "#1f6fde";
    readonly cap: "#b3261e";
    readonly reference: "#667080";
    readonly axis: "#8a93a1";
    readonly grid: "#eef1f5";
    readonly cursor: "#c2c9d3";
};
export declare const tagSwatches: readonly [{
    readonly name: "Blue";
    readonly hex: "#1f6fde";
}, {
    readonly name: "Green";
    readonly hex: "#15a34a";
}, {
    readonly name: "Emerald";
    readonly hex: "#059669";
}, {
    readonly name: "Lime";
    readonly hex: "#65a30d";
}, {
    readonly name: "Amber";
    readonly hex: "#b87503";
}, {
    readonly name: "Orange";
    readonly hex: "#ea580c";
}, {
    readonly name: "Red";
    readonly hex: "#e5484d";
}, {
    readonly name: "Rose";
    readonly hex: "#f43f5e";
}, {
    readonly name: "Pink";
    readonly hex: "#be185d";
}, {
    readonly name: "Fuchsia";
    readonly hex: "#c026d3";
}, {
    readonly name: "Purple";
    readonly hex: "#7400bc";
}, {
    readonly name: "Violet";
    readonly hex: "#8b5cf6";
}, {
    readonly name: "Indigo";
    readonly hex: "#6366f1";
}, {
    readonly name: "Teal";
    readonly hex: "#0e7490";
}, {
    readonly name: "Stone";
    readonly hex: "#8d6e63";
}, {
    readonly name: "Grey";
    readonly hex: "#5b6573";
}];
export type SemanticColor = keyof typeof color;
