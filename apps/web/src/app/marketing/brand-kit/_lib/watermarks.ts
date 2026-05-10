// MC.10.3 — Watermark template spec + Cloudinary URL builder.
//
// Cloudinary supports overlay (`l_<public_id>`) and text overlay
// (`l_text:<font>:<text>`) transformations. We map our template
// configs into the right transformation string + apply on top of
// the per-channel variant base.
//
// Type-specific config shapes:
//   corner_logo
//     { logoUrl, logoPublicId, position: 'NE'|'NW'|'SE'|'SW',
//       widthPct: 5..40, opacity: 0..100, paddingPx: 0..200 }
//   badge
//     { logoUrl, logoPublicId, position, widthPct, opacity }
//   overlay_band
//     { text, color, bgColor, position: 'top'|'bottom',
//       fontFamily, fontWeight, fontSize, opacity }
//   diagonal_text
//     { text, color, opacity, fontFamily, angle: 0..360 }

export type WatermarkType =
  | 'corner_logo'
  | 'badge'
  | 'overlay_band'
  | 'diagonal_text'

export interface WatermarkSpec {
  id: WatermarkType
  label: string
  description: string
}

export const WATERMARK_SPECS: WatermarkSpec[] = [
  {
    id: 'corner_logo',
    label: 'Corner logo',
    description: 'Brand logo placed in a chosen corner with padding + opacity.',
  },
  {
    id: 'badge',
    label: 'Centered badge',
    description: 'Logo overlay anchored to centre — useful for hero shots.',
  },
  {
    id: 'overlay_band',
    label: 'Text band',
    description: 'Coloured band with text across the top or bottom.',
  },
  {
    id: 'diagonal_text',
    label: 'Diagonal text',
    description: 'Repeating diagonal text mark — anti-piracy / draft watermark.',
  },
]

const POSITION_TO_GRAVITY: Record<string, string> = {
  NE: 'north_east',
  NW: 'north_west',
  SE: 'south_east',
  SW: 'south_west',
  top: 'north',
  bottom: 'south',
  center: 'center',
}

// Build a Cloudinary transformation string fragment for a watermark.
// The caller (channel-variants service or live preview) prepends
// the base size/crop transforms before this fragment.
export function buildWatermarkTransform(
  type: WatermarkType,
  config: Record<string, unknown>,
): string | null {
  if (type === 'corner_logo' || type === 'badge') {
    const logoPublicId =
      (config.logoPublicId as string | undefined) ??
      extractPublicId(config.logoUrl as string | undefined)
    if (!logoPublicId) return null
    const widthPct = clamp((config.widthPct as number) ?? 12, 1, 50)
    const opacity = clamp((config.opacity as number) ?? 80, 0, 100)
    const padding = clamp((config.paddingPx as number) ?? 24, 0, 200)
    const position =
      type === 'corner_logo'
        ? ((config.position as string | undefined) ?? 'SE')
        : 'center'
    const gravity = POSITION_TO_GRAVITY[position] ?? 'south_east'
    // Cloudinary public IDs containing `/` need to be encoded as `:`
    // inside the `l_` parameter. e.g. brand-logos/xavia-mark → l_brand-logos:xavia-mark.
    const encoded = logoPublicId.replace(/\//g, ':')
    const parts = [
      `l_${encoded}`,
      `w_${widthPct / 100}`,
      'fl_relative',
      `o_${opacity}`,
      `g_${gravity}`,
    ]
    if (gravity !== 'center') parts.push(`x_${padding}`, `y_${padding}`)
    return parts.join(',')
  }
  if (type === 'overlay_band') {
    const text = (config.text as string | undefined) ?? ''
    if (!text) return null
    const fontFamily =
      (config.fontFamily as string | undefined) ?? 'Arial'
    const fontWeight =
      (config.fontWeight as string | undefined) ?? 'bold'
    const fontSize = clamp((config.fontSize as number) ?? 36, 8, 200)
    const color =
      ((config.color as string | undefined) ?? '#FFFFFF').replace('#', '')
    const opacity = clamp((config.opacity as number) ?? 100, 0, 100)
    const position =
      (config.position as string | undefined) ?? 'bottom'
    const gravity = POSITION_TO_GRAVITY[position] ?? 'south'
    const encodedText = encodeURIComponent(text).replace(/%20/g, '_')
    return [
      `l_text:${fontFamily}_${fontSize}_${fontWeight}:${encodedText}`,
      `co_rgb:${color}`,
      `o_${opacity}`,
      `g_${gravity}`,
      'y_24',
    ].join(',')
  }
  if (type === 'diagonal_text') {
    const text = (config.text as string | undefined) ?? ''
    if (!text) return null
    const fontFamily =
      (config.fontFamily as string | undefined) ?? 'Arial'
    const fontSize = clamp((config.fontSize as number) ?? 60, 8, 200)
    const angle = clamp((config.angle as number) ?? 315, 0, 360)
    const color =
      ((config.color as string | undefined) ?? '#FFFFFF').replace('#', '')
    const opacity = clamp((config.opacity as number) ?? 30, 0, 100)
    const encodedText = encodeURIComponent(text).replace(/%20/g, '_')
    return [
      `l_text:${fontFamily}_${fontSize}_bold:${encodedText}`,
      `co_rgb:${color}`,
      `o_${opacity}`,
      `a_${angle}`,
      'g_center',
    ].join(',')
  }
  return null
}

// Apply a watermark to a Cloudinary base URL. The base URL must be a
// Cloudinary `image/upload/...` URL — anything else returns null.
export function applyWatermarkToUrl(
  baseUrl: string,
  type: WatermarkType,
  config: Record<string, unknown>,
): string | null {
  const transform = buildWatermarkTransform(type, config)
  if (!transform) return null
  // Find the upload/ segment and inject the transform after it.
  const idx = baseUrl.indexOf('/image/upload/')
  if (idx < 0) return null
  const head = baseUrl.slice(0, idx + '/image/upload/'.length)
  const tail = baseUrl.slice(idx + '/image/upload/'.length)
  return `${head}${transform}/${tail}`
}

function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo
  return Math.max(lo, Math.min(hi, value))
}

// Cloudinary URLs look like:
//   https://res.cloudinary.com/<cloud>/image/upload/[<transforms>/]<public_id>.<ext>?
// extract the public_id portion (without extension or query).
function extractPublicId(url: string | undefined): string | null {
  if (!url) return null
  const match = url.match(
    /\/image\/upload\/(?:[^/]+\/)*([^/.?]+)(?:\.[^.?]+)?/,
  )
  return match?.[1] ?? null
}
