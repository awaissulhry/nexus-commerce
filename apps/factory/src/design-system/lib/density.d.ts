/**
 * DS — the page's density, as a context.
 *
 * ONE vocabulary (compact / cozy / spacious — `tokens/grid.ts`) shared by the grid, the DS
 * `Thumbnail` and anything else that sizes itself to the row. A modal grid FOLLOWS its page: the
 * inventory editor opened from a Spacious products grid is Spacious, because it reads the same
 * context the page set. Nothing passes a density down by hand.
 *
 * The default is Spacious — the Owner's stated default for the products grid (2026-08-28) and
 * therefore the platform's. A page that wants Cozy or Compact says so on its provider.
 *
 * ## Why it lives in `lib/` and not in `grid/`
 *
 * 🔴 It used to be `grid/hooks/useGridDensity`, and `components/Thumbnail` imported it from there —
 * a COMPONENTS → GRID dependency, which is backwards and had a consequence nobody could see:
 * `apps/factory` mirrors `components/` but has no `grid/` folder at all, so factory's `Thumbnail`
 * imported a path that does not exist and **has never compiled**. The fork-drift guard could not
 * see it either, because the two files were byte-identical — they were identically broken.
 *
 * `lib/` is the layer both sides already reach (PES.7 put `cdn-image.ts` here for the same reason),
 * so the dependency inverts by moving one file rather than by threading a prop through every
 * consumer — which would have cost `Thumbnail` the "a modal's thumbs follow the page with nothing
 * passed" behaviour its own documentation calls a feature.
 *
 * `grid/hooks/useGridDensity` re-exports this, so every existing importer and the grid barrel are
 * unchanged.
 */
import { type ReactNode } from 'react';
import { type GridDensityName } from '../tokens/grid';
export declare const DEFAULT_GRID_DENSITY: GridDensityName;
export declare function GridDensityProvider({ value, children }: {
    value: GridDensityName;
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
/** The density in force here. */
export declare function useGridDensity(): GridDensityName;
/** The density in force here, and its numbers. */
export declare function useGridDensityTier(): {
    rowText: 28;
    rowMedia: 52;
    rowMediaLine: 36;
    header: 28;
    thumb: 32;
    cellPadX: 10;
    density: "compact" | "cozy" | "spacious";
} | {
    rowText: 43;
    rowMedia: 68;
    rowMediaLine: 44;
    header: 38;
    thumb: 40;
    cellPadX: 14;
    density: "compact" | "cozy" | "spacious";
} | {
    rowText: 49;
    rowMedia: 85;
    rowMediaLine: 60;
    header: 46;
    thumb: 56;
    cellPadX: 14;
    density: "compact" | "cozy" | "spacious";
};
