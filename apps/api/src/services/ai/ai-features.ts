/**
 * AI-2.2 — canonical catalog of AI features that support a per-feature
 * model override.
 *
 * `key` is the stable id stored in AiFeatureModelPref.featureKey and
 * tagged on AiUsageLog.feature, so selection, resolution, and cost
 * analytics all line up on the same string. Array order is the display
 * order for the settings UI. KEEP KEYS STABLE — they are persisted in
 * the prefs table; renaming one orphans its saved override.
 */

export interface AiFeature {
  key: string
  label: string
  description: string
  /** When set, the feature can ONLY run on this provider (e.g. Gemini
   *  Vision for image analysis) — the picker locks it and global /
   *  per-feature provider selection does not apply. */
  lockedProvider?: 'gemini' | 'anthropic'
}

/** Sentinel featureKey that holds the global default (provider + model)
 *  applied to any feature without its own override. */
export const GLOBAL_FEATURE_KEY = '__global__'

export const AI_FEATURES: AiFeature[] = [
  {
    key: 'listing-content',
    label: 'Listing content',
    description: 'Titles, bullets, and descriptions (List Wizard + product copy).',
  },
  {
    key: 'translate',
    label: 'Translations',
    description: 'Master → DE/UK/FR/ES localisation of listing content.',
  },
  {
    key: 'alt-text',
    label: 'Image alt-text',
    description: 'Multilingual alt-text generated from product images (vision).',
  },
  {
    key: 'image-vision',
    label: 'Image quality analysis',
    description: 'Background / framing / text-overlay checks on master images (Gemini Vision).',
    lockedProvider: 'gemini',
  },
  {
    key: 'seo-regen',
    label: 'SEO regeneration',
    description: 'Search-optimised titles, keywords, and meta copy.',
  },
  {
    key: 'insights-brief',
    label: 'Insights brief',
    description: 'Executive narrative over sales / ads / inventory data.',
  },
  {
    key: 'ads-recommendations',
    label: 'Ad recommendations',
    description: 'PPC optimisation suggestions on the advertising console.',
  },
  {
    key: 'pim-mapping-suggest',
    label: 'PIM mapping suggestions',
    description: 'Suggested category / attribute field mappings.',
  },
  {
    key: 'pim-master-fill',
    label: 'Smart Auto-Fill',
    description: 'AI-filled master attributes from existing product data.',
  },
  {
    key: 'pim-ebay-value-map',
    label: 'eBay value mapping',
    description: 'Maps master attribute values to eBay aspect values.',
  },
  {
    key: 'flat-file-ai',
    label: 'Flat-file assist',
    description: 'AI help filling Amazon / eBay flat-file columns.',
  },
  {
    key: 'products-ai',
    label: 'Product bulk generate',
    description: 'Bulk AI content generation across selected products.',
  },
  {
    key: 'ebay-cockpit',
    label: 'eBay cockpit assistant',
    description: 'AI improvements inside the eBay listing cockpit.',
  },
  {
    key: 'wizard-product-types',
    label: 'Product-type ranking',
    description: 'AI ranking of candidate product types in the List Wizard (Gemini).',
    lockedProvider: 'gemini',
  },
]

const BY_KEY = new Map(AI_FEATURES.map((f) => [f.key, f]))

/** True for a catalog key (not the global sentinel). */
export function isKnownFeature(key: string): boolean {
  return BY_KEY.has(key)
}

/** The provider a feature is hard-locked to (Gemini-only vision / SDK
 *  paths), or null when it's free to run on any configured provider. */
export function lockedProviderFor(key: string): 'gemini' | 'anthropic' | null {
  return BY_KEY.get(key)?.lockedProvider ?? null
}
