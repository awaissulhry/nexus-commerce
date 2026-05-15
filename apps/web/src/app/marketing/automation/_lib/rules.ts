// MC.11.1 / A4.2 — Marketing-content automation rule spec.
//
// Reuses the shared AutomationRule model (domain='marketing_content').
// AI actions (generate_content, fill_missing_content, ai_translate)
// are now live — executor dispatches to the internal bulk-generate
// service using ListingContentService directly.

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'number'
  | 'boolean'
  | 'multi_select'
  | 'asset_kind_select'
  | 'channel_select'

export interface FieldSpec {
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  options?: Array<{ value: string; label: string }>
  hint?: string
  defaultValue?: unknown
}

export type RuleCategory =
  | 'on_upload'
  | 'on_attach'
  | 'on_channel'
  | 'scheduled'
  | 'manual'

export interface TriggerSpec {
  id: string
  label: string
  category: RuleCategory
  description: string
  fields: FieldSpec[]
}

export interface ActionSpec {
  id: string
  label: string
  description: string
  /// True when the action calls into MC.4 AI integration. The
  /// executor emits status='deferred' for these until AI work
  /// resumes; the UI surfaces a "Deferred per MC-AI-DEFERRED.md"
  /// badge on rules using them.
  requiresAi: boolean
  fields: FieldSpec[]
}

export const TRIGGERS: TriggerSpec[] = [
  {
    id: 'asset_uploaded',
    label: 'Asset uploaded',
    category: 'on_upload',
    description: 'Fires every time a new DigitalAsset row is created.',
    fields: [
      {
        key: 'assetType',
        label: 'Limit to type',
        kind: 'asset_kind_select',
        defaultValue: 'image',
      },
      {
        key: 'minBytes',
        label: 'Skip if smaller than (bytes)',
        kind: 'number',
      },
      {
        key: 'folderId',
        label: 'Limit to folder (id)',
        kind: 'text',
      },
    ],
  },
  {
    id: 'asset_attached_to_product',
    label: 'Asset attached to product',
    category: 'on_attach',
    description: 'Fires when an AssetUsage row links an asset to a product.',
    fields: [
      {
        key: 'role',
        label: 'Limit to role',
        kind: 'select',
        options: [
          { value: '', label: 'Any role' },
          { value: 'main', label: 'Main' },
          { value: 'alt', label: 'Alt' },
          { value: 'lifestyle', label: 'Lifestyle' },
          { value: 'hero', label: 'Hero' },
        ],
      },
    ],
  },
  {
    id: 'channel_added_to_product',
    label: 'Channel added to product',
    category: 'on_channel',
    description: 'Fires when a product gets a new ChannelListing.',
    fields: [
      {
        key: 'channels',
        label: 'Channels',
        kind: 'multi_select',
        options: [
          { value: 'AMAZON', label: 'Amazon' },
          { value: 'EBAY', label: 'eBay' },
          { value: 'SHOPIFY', label: 'Shopify' },
        ],
      },
    ],
  },
  {
    id: 'schedule',
    label: 'On a schedule',
    category: 'scheduled',
    description: 'Fires on a cron-style schedule. Use for nightly sweeps + season switches.',
    fields: [
      {
        key: 'cron',
        label: 'Cron expression',
        kind: 'text',
        required: true,
        hint: 'Standard 5-field cron — e.g. "0 2 * * *" for 02:00 daily.',
      },
    ],
  },
  {
    id: 'manual',
    label: 'Manual trigger',
    category: 'manual',
    description:
      'Operator-fired only. Useful for "apply to selected assets" bulk operations.',
    fields: [],
  },
  {
    id: 'product_missing_content',
    label: 'Product has missing content',
    category: 'scheduled',
    description:
      'Fires on a schedule for every product where title, description, or bullet points are empty.',
    fields: [
      {
        key: 'cron',
        label: 'Cron expression',
        kind: 'text',
        required: true,
        hint: 'e.g. "0 3 * * *" for 03:00 daily.',
        defaultValue: '0 3 * * *',
      },
      {
        key: 'marketplace',
        label: 'Marketplace',
        kind: 'text',
        required: true,
        hint: 'e.g. IT, DE, FR',
        defaultValue: 'IT',
      },
    ],
  },
]

export const ACTIONS: ActionSpec[] = [
  {
    id: 'resize_for_channels',
    label: 'Resize for channels',
    description:
      'Generate per-channel variant URLs (Amazon / eBay / Shopify / Instagram). MC.6.1 service handles the Cloudinary URL build.',
    requiresAi: false,
    fields: [
      {
        key: 'channels',
        label: 'Channels to generate',
        kind: 'multi_select',
        options: [
          { value: 'AMAZON', label: 'Amazon (3 sizes)' },
          { value: 'EBAY', label: 'eBay (3 sizes)' },
          { value: 'SHOPIFY', label: 'Shopify (3 sizes)' },
          { value: 'INSTAGRAM', label: 'Instagram (3 formats)' },
          { value: 'SOCIAL', label: 'Social (OG card)' },
        ],
        defaultValue: ['AMAZON', 'EBAY', 'SHOPIFY'],
      },
    ],
  },
  {
    id: 'apply_watermark',
    label: 'Apply brand watermark',
    description:
      'Run an enabled watermark template (MC.10.3) over the asset on channel-variant URLs.',
    requiresAi: false,
    fields: [
      {
        key: 'brand',
        label: 'Brand',
        kind: 'text',
        required: true,
        hint: 'Must match a BrandKit row',
      },
      {
        key: 'watermarkId',
        label: 'Specific watermark id (optional)',
        kind: 'text',
        hint: 'Leave blank to apply every enabled template for the brand.',
      },
    ],
  },
  {
    id: 'auto_resize_per_marketplace',
    label: 'Resize for new marketplace',
    description:
      'When a marketplace is added, generate that marketplace\'s required sizes for the product\'s assets.',
    requiresAi: false,
    fields: [],
  },
  {
    id: 'tag_with',
    label: 'Add tags',
    description:
      'Attach AssetTag rows. Useful for "uploaded to seasonal/ folder" → tag with "Spring 2026".',
    requiresAi: false,
    fields: [
      {
        key: 'tagNames',
        label: 'Tag names (comma-separated)',
        kind: 'text',
        required: true,
      },
    ],
  },
  {
    id: 'auto_alt_text',
    label: 'Generate alt text (AI)',
    description:
      'Vision-model alt-text generation in target locale. Pulls TerminologyPreference glossary for brand voice.',
    requiresAi: true,
    fields: [
      {
        key: 'locale',
        label: 'Target locale',
        kind: 'text',
        defaultValue: 'it-IT',
      },
    ],
  },
  {
    id: 'auto_tag',
    label: 'Auto-tag (AI)',
    description:
      'Vision model classifies the image; resulting tags promoted to AssetTag.',
    requiresAi: true,
    fields: [
      {
        key: 'maxTags',
        label: 'Max tags to attach',
        kind: 'number',
        defaultValue: 5,
      },
    ],
  },
  {
    id: 'translate_caption',
    label: 'Translate caption (AI)',
    description:
      'Translate alt + caption to every locale set on the document.',
    requiresAi: true,
    fields: [],
  },
  {
    id: 'background_removal',
    label: 'Remove background (AI)',
    description:
      'Cloudinary AI / Remove.bg background removal. Creates a new variant with transparent background.',
    requiresAi: true,
    fields: [
      {
        key: 'replaceWith',
        label: 'Background fill',
        kind: 'select',
        options: [
          { value: 'transparent', label: 'Transparent (PNG)' },
          { value: 'white', label: 'White (Amazon-spec)' },
          { value: 'brand_color', label: 'Brand primary color' },
        ],
        defaultValue: 'transparent',
      },
    ],
  },

  // ── A4.2 — Product content AI actions ────────────────────────────────

  {
    id: 'generate_content',
    label: 'Generate content with Claude',
    description:
      'Run Claude over matched products and write title, bullet points, description, or keywords. Overwrites existing content.',
    requiresAi: true,
    fields: [
      {
        key: 'fields',
        label: 'Fields to generate',
        kind: 'multi_select',
        required: true,
        options: [
          { value: 'title', label: 'Title' },
          { value: 'bullets', label: 'Bullet points' },
          { value: 'description', label: 'Description' },
          { value: 'keywords', label: 'Keywords' },
        ],
        defaultValue: ['title', 'bullets', 'description'],
      },
      {
        key: 'marketplace',
        label: 'Marketplace',
        kind: 'text',
        required: true,
        hint: 'e.g. IT, DE, FR',
        defaultValue: 'IT',
      },
      {
        key: 'model',
        label: 'Model',
        kind: 'select',
        options: [
          { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast, cheap)' },
          { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (higher quality)' },
        ],
        defaultValue: 'claude-haiku-4-5-20251001',
      },
      {
        key: 'maxProducts',
        label: 'Max products per run',
        kind: 'number',
        defaultValue: 50,
        hint: 'Limit to avoid runaway costs. Max 50 per batch.',
      },
    ],
  },
  {
    id: 'fill_missing_content',
    label: 'Fill missing fields with Claude',
    description:
      'Like "Generate content" but skips products that already have the requested fields filled.',
    requiresAi: true,
    fields: [
      {
        key: 'fields',
        label: 'Fields to fill',
        kind: 'multi_select',
        required: true,
        options: [
          { value: 'title', label: 'Title' },
          { value: 'bullets', label: 'Bullet points' },
          { value: 'description', label: 'Description' },
          { value: 'keywords', label: 'Keywords' },
        ],
        defaultValue: ['bullets', 'description'],
      },
      {
        key: 'marketplace',
        label: 'Marketplace',
        kind: 'text',
        required: true,
        hint: 'e.g. IT, DE, FR',
        defaultValue: 'IT',
      },
      {
        key: 'model',
        label: 'Model',
        kind: 'select',
        options: [
          { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast, cheap)' },
          { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (higher quality)' },
        ],
        defaultValue: 'claude-haiku-4-5-20251001',
      },
      {
        key: 'maxProducts',
        label: 'Max products per run',
        kind: 'number',
        defaultValue: 50,
        hint: 'Max 50 per batch.',
      },
    ],
  },
  {
    id: 'ai_translate',
    label: 'Translate content with Claude',
    description:
      'Translate title, bullets, and description to a target locale using Claude. Writes to ProductTranslation rows.',
    requiresAi: true,
    fields: [
      {
        key: 'targetLocale',
        label: 'Target locale',
        kind: 'text',
        required: true,
        hint: 'Marketplace code — e.g. DE, FR, ES',
        defaultValue: 'DE',
      },
      {
        key: 'fields',
        label: 'Fields to translate',
        kind: 'multi_select',
        options: [
          { value: 'title', label: 'Title' },
          { value: 'bullets', label: 'Bullet points' },
          { value: 'description', label: 'Description' },
        ],
        defaultValue: ['title', 'bullets', 'description'],
      },
      {
        key: 'model',
        label: 'Model',
        kind: 'select',
        options: [
          { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast, cheap)' },
          { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (higher quality)' },
        ],
        defaultValue: 'claude-haiku-4-5-20251001',
      },
    ],
  },
]

export function getTriggerSpec(id: string): TriggerSpec | null {
  return TRIGGERS.find((t) => t.id === id) ?? null
}

export function getActionSpec(id: string): ActionSpec | null {
  return ACTIONS.find((a) => a.id === id) ?? null
}
