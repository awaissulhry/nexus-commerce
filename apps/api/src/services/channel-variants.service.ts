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
 */

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
  asset: { storageProvider: string; storageId: string | null; url: string },
): string | null {
  if (asset.storageProvider !== 'cloudinary' || !asset.storageId) return null
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  if (!cloudName) return null

  const transforms = [
    `w_${spec.width}`,
    `h_${spec.height}`,
    CROP_TOKEN[spec.cropMode],
    'q_auto',
    'f_auto',
  ]
  if (spec.cropMode === 'pad' && spec.background) {
    transforms.push(`b_${spec.background}`)
  }

  return `https://res.cloudinary.com/${cloudName}/image/upload/${transforms.join(',')}/${asset.storageId}`
}

export function buildAllVariants(
  asset: { storageProvider: string; storageId: string | null; url: string },
): Array<{
  id: string
  channel: string
  label: string
  width: number
  height: number
  cropMode: ChannelVariantSpec['cropMode']
  url: string | null
  notes: string | null
}> {
  return CHANNEL_VARIANTS.map((spec) => ({
    id: spec.id,
    channel: spec.channel,
    label: spec.label,
    width: spec.width,
    height: spec.height,
    cropMode: spec.cropMode,
    url: buildVariantUrl(spec, asset),
    notes: spec.notes ?? null,
  }))
}
