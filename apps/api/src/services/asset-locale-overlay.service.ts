/**
 * MC.6.3 — Locale-specific overlay URL builder.
 *
 * Cloudinary's `l_text:` transformation lets us paint localized
 * text strips ("FREE SHIPPING" / "SPEDIZIONE GRATUITA" / "ENVÍO
 * GRATIS") directly on top of a master asset at delivery time. No
 * extra storage cost; the overlay row just records the strings + the
 * positioning config.
 *
 * Build order (left → right) along the URL:
 *   1. base channel transforms (w_/h_/c_/quality)        — caller
 *   2. brand watermark overlay                            — caller
 *   3. locale text overlay                                — this file
 *   4. <publicId>.<ext>                                   — caller
 *
 * The locale picker uses BCP-47 prefix matching: a request for
 * `it-IT` will match an overlay row stored as `it` if no exact
 * match exists.
 */

export interface AssetLocaleOverlay {
  id: string
  locale: string
  text: string
  position: string
  color: string
  bgColor: string | null
  font: string
  offsetY: number
  offsetX: number
  enabled: boolean
}

const ALLOWED_GRAVITY = new Set([
  'north',
  'north_east',
  'east',
  'south_east',
  'south',
  'south_west',
  'west',
  'north_west',
  'center',
])

/**
 * Pick the most specific overlay for a target locale. Exact match
 * wins; primary-language match (`it` for `it-IT`) is the fallback;
 * null when nothing matches.
 */
export function pickOverlayForLocale(
  overlays: AssetLocaleOverlay[],
  locale: string,
): AssetLocaleOverlay | null {
  if (!locale || overlays.length === 0) return null
  const enabled = overlays.filter((o) => o.enabled)
  const exact = enabled.find(
    (o) => o.locale.toLowerCase() === locale.toLowerCase(),
  )
  if (exact) return exact
  const primary = locale.split('-')[0]?.toLowerCase()
  if (!primary) return null
  return (
    enabled.find((o) => o.locale.toLowerCase() === primary) ?? null
  )
}

/**
 * Build the Cloudinary `l_text:` token (without the trailing `/`)
 * for an overlay row. Returns null when the overlay is disabled or
 * the position token is invalid.
 *
 * Cloudinary expects URL-encoded text inside `l_text:font:text`.
 */
export function buildOverlayTokens(overlay: AssetLocaleOverlay): string[] | null {
  if (!overlay.enabled) return null
  if (!ALLOWED_GRAVITY.has(overlay.position)) return null
  if (!overlay.text.trim()) return null

  const safeText = encodeURIComponent(overlay.text)
    // Cloudinary disallows raw commas/slashes inside the text token
    // even after encodeURIComponent leaves some intact.
    .replace(/,/g, '%2C')
    .replace(/\//g, '%2F')

  const tokens = [
    `l_text:${overlay.font}:${safeText}`,
    `co_${overlay.color}`,
    `g_${overlay.position}`,
  ]
  if (overlay.offsetY) tokens.push(`y_${overlay.offsetY}`)
  if (overlay.offsetX) tokens.push(`x_${overlay.offsetX}`)
  if (overlay.bgColor) tokens.push(`b_${overlay.bgColor}_60`)
  return tokens
}

/**
 * Splice an overlay token group into a Cloudinary upload URL just
 * before the `<publicId>` segment.
 *
 * Caller passes the URL as built by the channel-variants service
 * (already includes width/height/crop/quality tokens). This function
 * inserts the overlay tokens after those but before the public id so
 * the overlay paints on top of the resized base.
 */
export function applyOverlayToUrl(
  baseUrl: string,
  overlay: AssetLocaleOverlay | null,
): string {
  if (!overlay) return baseUrl
  const tokens = buildOverlayTokens(overlay)
  if (!tokens) return baseUrl
  // Cloudinary URL shape: https://res.cloudinary.com/<cloud>/image/upload/<transforms>/<publicId>
  const marker = '/upload/'
  const idx = baseUrl.indexOf(marker)
  if (idx < 0) return baseUrl
  const head = baseUrl.slice(0, idx + marker.length)
  const tail = baseUrl.slice(idx + marker.length)
  return `${head}${tokens.join(',')}/${tail}`
}
