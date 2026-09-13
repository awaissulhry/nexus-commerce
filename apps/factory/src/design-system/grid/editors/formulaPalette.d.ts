/**
 * Contrast against the GRID ROW grounds, measured on the master sheet 2026-09-02 — white
 * `rgb(255,255,255)` for an even row and `rgb(238,241,245)` for the odd stripe. Worst of the two.
 *
 * 🔴 These are NOT `colors.ts`'s numbers, and the difference is why they are here. That file
 * measures against the PAGE grounds (#ffffff and #18263b). The grid's odd row is a light grey
 * stripe the DS never measured against, and on it **Lime drops to 2.73 — below the 3:1 an outline
 * owes** — as do Green (2.91) and Amber (2.81), which is why none of the three is in the cycle.
 * Lime passes `colors.ts`'s own check at 3.09/4.93; it fails HERE. A palette is only accessible
 * against the ground it is actually drawn on.
 *
 * ⚠ Red is deliberately absent although it passes (3.32): red is the `unknownRefs` colour, and a
 * valid reference wearing the error hue is the one confusion this feature cannot afford. Blue
 * passes best of all (4.56) and is also absent: it is the grid's selection and focus colour, so an
 * outline in it would read as "this cell is selected".
 */
export declare const CYCLE_MEASURED_CONTRAST: Readonly<Record<string, number>>;
export interface RefColour {
    name: string;
    hex: string;
}
export declare const REF_CYCLE: readonly RefColour[];
/**
 * Assign a colour to every distinct reference in a formula, in first-appearance order.
 *
 * 🔴 Keyed by NAME, not by occurrence: `$brand + " " + $brand` is ONE source cell and must be one
 * colour, or the outline on that cell could only match half its mentions. Comparison is
 * case-insensitive because `$BRAND` and `$brand` resolve to the same attribute.
 *
 * More distinct references than swatches wraps rather than running out. Two references sharing a
 * hue is a real ambiguity, and `distinctRefCount` lets the caller say so rather than pretending.
 */
export declare function assignRefColours(refNames: readonly string[]): Map<string, RefColour>;
/** Does this formula have more distinct references than the cycle can colour uniquely? */
export declare const refColoursWrap: (refNames: readonly string[]) => boolean;
/** The colour for one reference, or `null` when it has none (an unknown ref is red, not a hue). */
export declare function colourFor(refName: string, assigned: ReadonlyMap<string, RefColour>): RefColour | null;
