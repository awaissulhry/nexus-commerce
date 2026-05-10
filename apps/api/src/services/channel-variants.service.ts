/**
 * MC.6.1 — per-channel variant URL builder.
 *
 * Cloudinary's URL transformations let us serve any size/crop/format
 * on the fly without physically storing N copies of every asset.
 * That's the cheap path: we keep one master in Cloudinary + build
 * variant URLs by injecting transformation strings.
 *
 * Structure:
 *   https://res.cloudinary.com/<cloud>/image/upload/<transforms>/<publicId>
 *
 * <transforms> can be a CSV ("w_1500,h_1500,c_fit,q_auto"). We use
 * c_fit (preserve aspect) for non-square targets, c_fill (crop to
 * fit) for square targets and the OG card. q_auto + f_auto let
 * Cloudinary pick the best format/quality per request.
 *
 * Channels are intentionally hardcoded — these are spec-driven (e.g.
 * Amazon's 1500px hero requirement, OG's 1200×630). Future channels
 * land here.
 *
 * MC.13.2 — quality/format defaults are now sourced from
 * cdn-delivery-profile.service.ts so operators can dial workspace-wide
 * bandwidth (eco/balanced/hd/lossless) without editing this file.
 */

import {
  defaultProfile,
  profileTokens,
  type DeliveryProfileId,
} from './cdn-delivery-profile.service.js'

export interface ChannelVariantSpec {
  /** Channel identifier ('AMAZON_HERO', 'EBAY_ZOOM', etc.) */
  id: string
  /** Operator-facing label ("Amazon hero (zoom)") */
  label: string
  /** Channel grouping for the UI ("Amazon", "eBay", "Shopify", ...) */
  channel: string
  width: number
  height: number
  /** Cloudinary crop mode. 'fit' preserves aspect; 'fill' crops to box. */
  cropMode: 'fit' | 'fill' | 'pad'
  /** Padding background when cropMode='pad' (Amazon white-bg requirement). */
  background?: string
  /** Optional commentary surfaced in the detail drawer. */
  notes?: string
  /** MC.7.4 — 'image' (default) or 'video'. Routes the URL through
   *  Cloudinary's /image/upload/ or /video/upload/ segment and
   *  filters specs to the matching asset type. */
  mediaType?: 'image' | 'video'
}

export const CHANNEL_VARIANTS: ChannelVariantSpec[] = [
  // Amazon — hero must be ≥1000px on long edge; we serve 2400 master
  // + 1500 standard + 500 thumbnail. Pad mode + white background
  // matches Amazon's product-on-white requirement.
  {
    id: 'AMAZON_ZOOM',
    label: 'Amazon zoom',
    channel: 'Amazon',
    width: 2400,
    height: 2400,
    cropMode: 'pad',
    background: 'white',
    notes: 'Zoom-enabled hero; meets the ≥2000px recommendation.',
  },
  {
    id: 'AMAZON_STANDARD',
    label: 'Amazon standard',
    channel: 'Amazon',
    width: 1500,
    height: 1500,
    cropMode: 'pad',
    background: 'white',
    notes: 'Standard listing image.',
  },
  {
    id: 'AMAZON_THUMB',
    label: 'Amazon thumbnail',
    channel: 'Amazon',
    width: 500,
    height: 500,
    cropMode: 'pad',
    background: 'white',
  },

  // eBay — 1600 zoom-enabled, 1000 standard, 500 thumb.
  {
    id: 'EBAY_ZOOM',
    label: 'eBay zoom',
    channel: 'eBay',
    width: 1600,
    height: 1600,
    cropMode: 'fit',
  },
  {
    id: 'EBAY_STANDARD',
    label: 'eBay standard',
    channel: 'eBay',
    width: 1000,
    height: 1000,
    cropMode: 'fit',
  },
  {
    id: 'EBAY_THUMB',
    label: 'eBay thumbnail',
    channel: 'eBay',
    width: 500,
    height: 500,
    cropMode: 'fit',
  },

  // Shopify — 1200 product page, 800 collection grid, 400 cart.
  {
    id: 'SHOPIFY_PRODUCT',
    label: 'Shopify product page',
    channel: 'Shopify',
    width: 1200,
    height: 1200,
    cropMode: 'fit',
  },
  {
    id: 'SHOPIFY_GRID',
    label: 'Shopify collection grid',
    channel: 'Shopify',
    width: 800,
    height: 800,
    cropMode: 'fit',
  },
  {
    id: 'SHOPIFY_CART',
    label: 'Shopify cart',
    channel: 'Shopify',
    width: 400,
    height: 400,
    cropMode: 'fit',
  },

  // Instagram — feed square + story portrait.
  {
    id: 'INSTAGRAM_FEED',
    label: 'Instagram feed',
    channel: 'Instagram',
    width: 1080,
    height: 1080,
    cropMode: 'fill',
  },
  {
    id: 'INSTAGRAM_STORY',
    label: 'Instagram story',
    channel: 'Instagram',
    width: 1080,
    height: 1920,
    cropMode: 'fill',
  },
  {
    id: 'INSTAGRAM_PORTRAIT',
    label: 'Instagram portrait',
    channel: 'Instagram',
    width: 1080,
    height: 1350,
    cropMode: 'fill',
  },

  // Open Graph — social sharing card. 1200×630 is the canonical
  // landscape for Twitter/Facebook/LinkedIn previews.
  {
    id: 'SOCIAL_OG',
    label: 'Open Graph card',
    channel: 'Social',
    width: 1200,
    height: 630,
    cropMode: 'fill',
    notes:
      'Used by Twitter / Facebook / LinkedIn / Telegram link previews.',
  },

  // ── MC.7.4 — Video presets ─────────────────────────────────
  {
    id: 'AMAZON_VIDEO_HERO',
    label: 'Amazon promo video',
    channel: 'Amazon',
    width: 1920,
    height: 1080,
    cropMode: 'fit',
    mediaType: 'video',
    notes: 'Amazon Brand Story / A+ Premium 16:9 promo video.',
  },
  {
    id: 'EBAY_VIDEO',
    label: 'eBay listing video',
    channel: 'eBay',
    width: 1280,
    height: 720,
    cropMode: 'fit',
    mediaType: 'video',
    notes: 'eBay Vault video listing (max 150MB; 720p baseline).',
  },
  {
    id: 'SHOPIFY_VIDEO',
    label: 'Shopify product video',
    channel: 'Shopify',
    width: 1920,
    height: 1080,
    cropMode: 'fit',
    mediaType: 'video',
  },
  {
    id: 'INSTAGRAM_REEL',
    label: 'Instagram Reel',
    channel: 'Instagram',
    width: 1080,
    height: 1920,
    cropMode: 'fill',
    mediaType: 'video',
    notes: '9:16 vertical Reel / Story video.',
  },
  {
    id: 'INSTAGRAM_VIDEO_FEED',
    label: 'Instagram feed video',
    channel: 'Instagram',
    width: 1080,
    height: 1080,
    cropMode: 'fill',
    mediaType: 'video',
    notes: 'Square in-feed video.',
  },
  {
    id: 'SOCIAL_VIDEO_OG',
    label: 'Open Graph video',
    channel: 'Social',
    width: 1280,
    height: 720,
    cropMode: 'fill',
    mediaType: 'video',
    notes: 'Twitter / LinkedIn link-preview video card.',
  },
]

const CROP_TOKEN: Record<ChannelVariantSpec['cropMode'], string> = {
  fit: 'c_fit',
  fill: 'c_fill',
  pad: 'c_pad',
}

/**
 * Build the Cloudinary transformation URL for a single spec.
 *
 * Returns null when the asset isn't Cloudinary-backed — calling code
 * surfaces a "variants only available for cloudinary assets" notice.
 */
export function buildVariantUrl(
  spec: ChannelVariantSpec,
  asset: {
    storageProvider: string
    storageId: string | null
    url: string
    /** MC.7.4 — when present, must match the spec's mediaType. */
    type?: string
  },
  profile?: DeliveryProfileId,
): string | null {
  if (asset.storageProvider !== 'cloudinary' || !asset.storageId) return null
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  if (!cloudName) return null

  // Spec/asset media type must agree — image specs only render image
  // assets; video specs only render video assets.
  const specMedia = spec.mediaType ?? 'image'
  if (asset.type && asset.type !== specMedia) return null

  const transforms = [
    `w_${spec.width}`,
    `h_${spec.height}`,
    CROP_TOKEN[spec.cropMode],
    ...profileTokens(profile),
  ]
  if (spec.cropMode === 'pad' && spec.background) {
    transforms.push(`b_${spec.background}`)
  }

  const segment = specMedia === 'video' ? 'video' : 'image'
  return `https://res.cloudinary.com/${cloudName}/${segment}/upload/${transforms.join(',')}/${asset.storageId}`
}

export function buildAllVariants(
  asset: {
    storageProvider: string
    storageId: string | null
    url: string
    /** MC.7.4 — when present, filters specs to the matching mediaType. */
    type?: string
  },
  profile?: DeliveryProfileId,
): Array<{
  id: string
  channel: string
  label: string
  width: number
  height: number
  cropMode: ChannelVariantSpec['cropMode']
  mediaType: 'image' | 'video'
  url: string | null
  notes: string | null
}> {
  const resolved = profile ?? defaultProfile()
  return CHANNEL_VARIANTS.filter((spec) => {
    // MC.7.4 — when the asset declares a type, hide specs that don't
    // match. When asset.type is missing (legacy callers), fall through
    // to the historical behavior of returning all specs.
    if (!asset.type) return true
    return (spec.mediaType ?? 'image') === asset.type
  }).map((spec) => ({
    id: spec.id,
    channel: spec.channel,
    label: spec.label,
    width: spec.width,
    height: spec.height,
    cropMode: spec.cropMode,
    mediaType: spec.mediaType ?? 'image',
    url: buildVariantUrl(spec, asset, resolved),
    notes: spec.notes ?? null,
  }))
}
