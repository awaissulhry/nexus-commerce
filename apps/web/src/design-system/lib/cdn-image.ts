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

/** Cloudinary takes its transform as a path segment after `/image/upload/`. */
function withCloudinaryTransform(url: string, transform: string): string {
  if (!url.includes('res.cloudinary.com')) return url
  return url.replace(/\/image\/upload\//, `/image/upload/${transform}/`)
}

/**
 * Ask Amazon's CDN for a sized rendition. The size is a filename segment, not a query param:
 * `<id>.jpg` → `<id>._SL112_.jpg`. Any modifier block already present (`._AC_SX679_`) is REPLACED
 * rather than appended — Amazon honours the last one, and stacking them is how you get a 404.
 */
function withAmazonTransform(url: string, px: number): string {
  if (!/(?:m\.media-amazon|images-amazon|ssl-images-amazon)\.com/.test(url)) return url
  return url.replace(
    /(\._[A-Za-z0-9,]+_)?\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i,
    (_m, _mod, ext: string, qs: string | undefined) => `._SL${px}_.${ext}${qs ?? ''}`,
  )
}

/** Shopify CDN images support width/height query parameters; keep file versions intact. */
function withShopifyTransform(value: string, px: number, square: boolean): string {
  try {
    const url = new URL(value)
    if (url.hostname !== 'cdn.shopify.com' || !/\.(avif|gif|heic|jpe?g|png|webp)$/i.test(url.pathname)) return value
    url.searchParams.set('width', String(px))
    if (square) { url.searchParams.set('height', String(px)); url.searchParams.set('crop', 'center') }
    else { url.searchParams.delete('height'); url.searchParams.delete('crop') }
    return url.href
  } catch { return value }
}

/** A square, cropped rendition at `px` — for a fixed-size box (a grid thumb, a gallery tile). */
export const cdnSquare = (url: string, px: number): string =>
  withShopifyTransform(withAmazonTransform(withCloudinaryTransform(url, `w_${px},h_${px},c_fill,f_auto,q_auto,dpr_2.0`), px), px, true)

/** A width-bounded rendition that keeps its aspect ratio — for a preview or a contained tile. */
export const cdnFit = (url: string, px: number): string =>
  withShopifyTransform(withAmazonTransform(withCloudinaryTransform(url, `w_${px},c_fit,f_auto,q_auto`), px), px, false)
