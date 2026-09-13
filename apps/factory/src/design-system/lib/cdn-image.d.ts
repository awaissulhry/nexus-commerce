/**
 * CDN image sizing — ask the CDN for the size the box actually is.
 *
 * EXTRACTED from `components/Thumbnail.tsx` (PES.7, 2026-09-01), where these were module-private.
 * Nothing about the behaviour changed; Thumbnail imports them from here and its output is
 * byte-identical. The extraction happened because a second surface needed the same rule: the
 * Product Edit Studio's master gallery renders 165px tiles, and a bare Cloudinary URL there served
 * twenty-four 2250×2250 originals — measured stuck at 24/24 still downloading. Thumbnail itself is
 * density-sized (32/40/56px) and could not be reused at that size, so the choice was to fork this
 * logic or lift it. Shared means EXACTLY the same, so it is lifted
 * (feedback_shared_components_no_copy_props).
 *
 * Both transforms are no-ops on a URL they do not recognise, so any host passes through untouched.
 */
/** A square, cropped rendition at `px` — for a fixed-size box (a grid thumb, a gallery tile). */
export declare const cdnSquare: (url: string, px: number) => string;
/** A width-bounded rendition that keeps its aspect ratio — for a preview or a contained tile. */
export declare const cdnFit: (url: string, px: number) => string;
