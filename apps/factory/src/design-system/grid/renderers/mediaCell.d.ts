/**
 * GDS / PES.2 — what a MEDIA cell is showing, as pure functions.
 *
 * `renderers/cells.tsx` has twenty-three renderers and not one of them shows a picture. The Amazon
 * Colour × Slot matrix and the eBay bucket × position grid are grids whose CELL IS AN IMAGE, so
 * PES.7 asked for this as substrate rather than building a private one.
 *
 * ## Three constraints from PES.7's spike, and they shape the whole design
 *
 * 1. **A picture cell must have a VALUE.** AG repaints a cell when its value changes; a renderer
 *    that draws from `cellRendererParams` alone is invisible to change detection, and the repaint
 *    that appears to fix it — churning the params object — is the column-model re-run trap. So the
 *    image lives in the cell's value and this module describes that value.
 * 2. **Handlers arrive by ref or context**, never in rebuilt `cellRendererParams`. Nothing in this
 *    file takes a callback for that reason.
 * 3. **`cellSelection` is OFF on a media matrix** — AG opens a range on the same mousedown as a
 *    tile drag and `stopPropagation` cannot stop it. That is a grid option, not a cell concern, so
 *    it is `MEDIA_MATRIX_GRID_OPTIONS` rather than anything here.
 *
 * Pure — no React, no AG — so the state rules are tested in the node suite like the rest.
 */
import type { CellProvenance } from './provenance';
/** What a media cell can be doing. Ordered by what an operator must act on first. */
export type MediaCellState = 'empty' | 'refused' | 'warned' | 'pending' | 'locked' | 'ready';
export interface MediaCellValue {
    /** The image. `null` is a genuinely empty slot — the common case on a sparse matrix. */
    src: string | null;
    alt?: string;
    /** Images behind this cell when it stands for a set; the tile shows "+N". */
    count?: number;
    /**
     * Where the picture came from, in the SAME vocabulary the text cells use
     * (`renderers/provenance.ts`). A media matrix inherits exactly as an attribute does — a market
     * showing the master's image, an alias showing the channel's — and having two vocabularies for
     * one idea is the fork the substrate exists to prevent.
     */
    provenance?: CellProvenance;
    /** Names the layer the picture came from, for the tooltip: a SKU, "Amazon · IT", "master". */
    inheritedFrom?: string | null;
    /** Synced from a channel, or not applicable to this slot — no drop target, no editor. */
    locked?: boolean;
    /** Edited and not yet on the server. */
    pending?: boolean;
    /** The channel's own answer for this image. */
    publish?: 'live' | 'queued' | 'failed' | null;
    /** A channel rule this image bends but does not break (too small, wrong ratio). */
    warn?: string | null;
    /** The server refused it. A RESULT, shown on the tile, never a toast. */
    refused?: string | null;
}
/**
 * The one state a tile is in.
 *
 * Precedence is deliberate and is about what the operator must deal with FIRST: a refusal outranks
 * everything because the picture on screen is not the picture on the server; a warning outranks a
 * pending save because it survives the save; `locked` outranks `ready` because it changes what the
 * tile will accept. `empty` is checked before `locked` — an empty locked slot reads as "nothing
 * here", which is the truth, rather than as a locked picture that failed to load.
 *
 * ⚠ ONE CONSEQUENCE, KNOWN RATHER THAN DISCOVERED (PES.7, ruling #80): because `empty` is resolved
 * before `warned`, **a `warn` on a cell with no `src` is unreachable** — the tile reads `empty` and
 * the warning is dropped. That is right for what this was written for: a warning is a judgement
 * about a PICTURE ("too small", "wrong ratio"), and there is no picture to judge. A warning about
 * the ABSENCE of one ("this required slot is empty") is a statement about the matrix, not about the
 * tile, and PES.7 surfaces it as a contradiction count at matrix level — the better home, since one
 * missing image is only a problem in the context of what the row is supposed to have.
 *
 * A `refused` on an src-less cell IS reachable and deliberate: an upload that failed leaves nothing
 * behind, and the tile must still say the attempt failed rather than read as an untouched slot.
 *
 * So: do not add a per-tile "required and empty" warning here expecting it to render. Ask the
 * matrix. If a future surface genuinely needs it, the precedence is what changes — not the caller.
 */
export declare function mediaCellState(value: MediaCellValue | null | undefined): MediaCellState;
/** The classes a tile wears. The state carries the meaning; provenance tints on top of it. */
export declare function mediaCellClasses(value: MediaCellValue | null | undefined): string[];
/**
 * What the tile says on hover.
 *
 * One sentence, chosen by the same precedence as the state — an operator hovering a refused tile
 * needs the refusal, not the provenance. Empty returns `''` so the browser shows no tooltip at all
 * rather than an empty bubble.
 */
export declare function mediaCellTitle(value: MediaCellValue | null | undefined, provenanceSentence?: string): string;
/**
 * Can this tile take a drop?
 *
 * A locked tile cannot, and neither can one whose write the server refused — dropping onto a
 * refusal would stack a second unsaved change on a cell that has not reconciled the first.
 */
export declare function mediaCellAcceptsDrop(value: MediaCellValue | null | undefined): boolean;
/**
 * The rendition width to ask the CDN for.
 *
 * 🔴 Always larger than the box, never smaller, and always BOUNDED. A bare original is what made a
 * 165px tile pull a 2250×2250 file (measured: 1.6MB against 18KB for the sized rendition — 87×),
 * and a media MATRIX multiplies that by rows × columns. `dpr` covers retina without asking for the
 * original; the cap stops a huge tile asking for something absurd.
 */
export declare function mediaRenditionWidth(boxPx: number, dpr?: number): number;
