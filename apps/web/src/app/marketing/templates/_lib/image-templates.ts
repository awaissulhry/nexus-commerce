// MC.11.4 — Image-composition template library.
//
// Each template is a Cloudinary URL recipe — a base size/crop +
// optional overlays (logo / text / colour band). Renders by
// appending the recipe to a Cloudinary upload URL.
//
// Templates are curated TS today (motorcycle-gear-flavored). A
// follow-up commit promotes the config to a Prisma ImageTemplate
// model so operators can author their own — matching the same
// pattern as A+ Content templates (MC.8.7).

export type TemplateCategory =
  | 'product_on_white'
  | 'lifestyle'
  | 'hero_overlay'
  | 'comparison'
  | 'social'

export interface ImageTemplate {
  id: string
  name: string
  category: TemplateCategory
  description: string
  /// Cloudinary transformation string applied to the base asset.
  /// Includes size, crop, fill colour. Composition-friendly:
  /// `c_pad,b_white,w_2000,h_2000,c_lpad`
  baseTransform: string
  /// Sample asset URL for the catalog preview tile. The previewer
  /// applies the template's transform on top of this URL.
  sampleAssetUrl: string
  /// Operator-facing notes about when to use the template.
  bestFor: string
}

// A canonical Cloudinary public_id that exists on every Cloudinary
// account by default — used as the preview anchor when no asset
// URL is paste-tested. Cloud-name agnostic.
const SAMPLE = 'https://res.cloudinary.com/demo/image/upload/sample.jpg'

export const IMAGE_TEMPLATES: ImageTemplate[] = [
  {
    id: 'product_on_white_amazon',
    name: 'Product on white — Amazon hero',
    category: 'product_on_white',
    description:
      '2000×2000 with white background pad. Meets Amazon main-image specs.',
    baseTransform: 'c_pad,b_white,w_2000,h_2000,q_auto,f_auto',
    sampleAssetUrl: SAMPLE,
    bestFor: 'Amazon hero (main image). Replaces non-white backgrounds.',
  },
  {
    id: 'product_on_white_1500',
    name: 'Product on white — 1500',
    category: 'product_on_white',
    description: '1500×1500 with white pad. Cheaper for non-hero slots.',
    baseTransform: 'c_pad,b_white,w_1500,h_1500,q_auto,f_auto',
    sampleAssetUrl: SAMPLE,
    bestFor: 'Amazon listing alt slots, eBay zoom variants.',
  },
  {
    id: 'square_lifestyle_1080',
    name: 'Square lifestyle 1080',
    category: 'lifestyle',
    description:
      '1080×1080 fill crop — Instagram feed, Pinterest pin.',
    baseTransform: 'c_fill,g_auto,w_1080,h_1080,q_auto,f_auto',
    sampleAssetUrl: SAMPLE,
    bestFor: 'Instagram feed, Pinterest pins. Auto-gravity centres on subject.',
  },
  {
    id: 'instagram_story_1080x1920',
    name: 'Instagram story',
    category: 'social',
    description: '1080×1920 portrait fill — Instagram + TikTok stories.',
    baseTransform: 'c_fill,g_auto,w_1080,h_1920,q_auto,f_auto',
    sampleAssetUrl: SAMPLE,
    bestFor: 'Stories, Reels covers, TikTok thumbnails.',
  },
  {
    id: 'og_card_1200x630',
    name: 'Open Graph card',
    category: 'social',
    description:
      '1200×630 fill — link preview cards on Twitter / Facebook / LinkedIn.',
    baseTransform: 'c_fill,g_auto,w_1200,h_630,q_auto,f_auto',
    sampleAssetUrl: SAMPLE,
    bestFor: 'Site link previews, email banners, blog hero.',
  },
  {
    id: 'hero_overlay_band',
    name: 'Hero with text band',
    category: 'hero_overlay',
    description:
      '1464×600 hero with a tinted bottom band — A+ Content header style.',
    baseTransform:
      'c_fill,w_1464,h_600,g_auto,q_auto,f_auto/l_text:Arial_42_bold:Headline%20here,co_white,g_south_west,x_60,y_50',
    sampleAssetUrl: SAMPLE,
    bestFor: 'A+ Content hero headers, banner slots.',
  },
  {
    id: 'comparison_strip_1500x500',
    name: 'Comparison strip 1500×500',
    category: 'comparison',
    description:
      '1500×500 fill with auto-gravity — feeds A+ Content comparison rows.',
    baseTransform: 'c_fill,g_auto,w_1500,h_500,q_auto,f_auto',
    sampleAssetUrl: SAMPLE,
    bestFor: 'A+ Content comparison strips, before/after layouts.',
  },
]

export function getImageTemplate(id: string): ImageTemplate | null {
  return IMAGE_TEMPLATES.find((t) => t.id === id) ?? null
}

// Apply a template to a Cloudinary base URL. Returns null if the
// URL isn't Cloudinary-shaped (the recipes use Cloudinary
// transformations). The output URL serves the composed image
// on-demand without storing a copy.
export function applyImageTemplate(
  baseUrl: string,
  template: ImageTemplate,
): string | null {
  const idx = baseUrl.indexOf('/image/upload/')
  if (idx < 0) return null
  const head = baseUrl.slice(0, idx + '/image/upload/'.length)
  const tail = baseUrl.slice(idx + '/image/upload/'.length)
  return `${head}${template.baseTransform}/${tail}`
}
