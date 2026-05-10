// MC.11.2 — starter rule presets.
//
// Curated trigger+action combinations the operator can apply with
// one click. AI presets save normally; the executor logs
// status='deferred' until MC.4 ships (per the engagement
// directive).

export interface RulePreset {
  id: string
  category: 'on_upload' | 'on_attach' | 'on_channel' | 'scheduled'
  /// True when the action is AI-driven (status='deferred' until MC.4).
  requiresAi: boolean
  name: string
  description: string
  trigger: string
  triggerConfig: Record<string, unknown>
  action: string
  actionConfig: Record<string, unknown>
  /// True when the operator must edit a placeholder field before
  /// enabling — typically a brand label.
  needsEdit?: boolean
}

export const RULE_PRESETS: RulePreset[] = [
  {
    id: 'auto_resize_on_upload',
    category: 'on_upload',
    requiresAi: false,
    name: 'Auto-resize on upload',
    description:
      'Every uploaded image gets per-channel variant URLs ready for Amazon, eBay, and Shopify.',
    trigger: 'asset_uploaded',
    triggerConfig: { assetType: 'image' },
    action: 'resize_for_channels',
    actionConfig: { channels: ['AMAZON', 'EBAY', 'SHOPIFY'] },
  },
  {
    id: 'auto_alt_on_upload',
    category: 'on_upload',
    requiresAi: true,
    name: 'Auto alt-text (AI)',
    description:
      'Every uploaded image gets vision-model alt text in Italian, fed by the brand glossary.',
    trigger: 'asset_uploaded',
    triggerConfig: { assetType: 'image' },
    action: 'auto_alt_text',
    actionConfig: { locale: 'it-IT' },
  },
  {
    id: 'auto_tag_on_upload',
    category: 'on_upload',
    requiresAi: true,
    name: 'Auto-tag (AI)',
    description:
      'Vision model classifies uploads + attaches up to 5 AssetTag rows.',
    trigger: 'asset_uploaded',
    triggerConfig: { assetType: 'image' },
    action: 'auto_tag',
    actionConfig: { maxTags: 5 },
  },
  {
    id: 'auto_watermark_master',
    category: 'on_upload',
    requiresAi: false,
    name: 'Auto-watermark uploads',
    description:
      'Apply your brand watermark template to every new asset for a brand. Edit the brand field after applying.',
    trigger: 'asset_uploaded',
    triggerConfig: { assetType: 'image' },
    action: 'apply_watermark',
    actionConfig: { brand: '' },
    needsEdit: true,
  },
  {
    id: 'auto_resize_on_marketplace',
    category: 'on_channel',
    requiresAi: false,
    name: 'Auto-resize for new marketplace',
    description:
      'When a marketplace is added to a product, generate that marketplace\'s required image sizes.',
    trigger: 'channel_added_to_product',
    triggerConfig: {
      channels: ['AMAZON', 'EBAY', 'SHOPIFY'],
    },
    action: 'auto_resize_per_marketplace',
    actionConfig: {},
  },
  {
    id: 'auto_translate_captions',
    category: 'on_upload',
    requiresAi: true,
    name: 'Auto-translate captions (AI)',
    description:
      'When a caption changes, translate it into every locale set on the document.',
    trigger: 'asset_uploaded',
    triggerConfig: {},
    action: 'translate_caption',
    actionConfig: {},
  },
  {
    id: 'auto_bg_removal_hero',
    category: 'on_attach',
    requiresAi: true,
    name: 'Auto background removal on hero (AI)',
    description:
      'When an image is attached as a product main, run background removal so the hero fits Amazon white-bg requirements.',
    trigger: 'asset_attached_to_product',
    triggerConfig: { role: 'main' },
    action: 'background_removal',
    actionConfig: { replaceWith: 'white' },
  },
  {
    id: 'nightly_consistency_check',
    category: 'scheduled',
    requiresAi: false,
    name: 'Nightly catalog sweep',
    description:
      'At 02:00 daily, tag any assets that have been added recently with "needs-review" so QA finds them.',
    trigger: 'schedule',
    triggerConfig: { cron: '0 2 * * *' },
    action: 'tag_with',
    actionConfig: { tagNames: 'needs-review' },
  },
]

export function presetById(id: string): RulePreset | null {
  return RULE_PRESETS.find((p) => p.id === id) ?? null
}
