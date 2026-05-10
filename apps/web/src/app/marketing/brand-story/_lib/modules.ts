// MC.9.2 — Brand Story module spec registry.
//
// Tighter than A+ Content's 17 — Brand Story has exactly 4 module
// types per Amazon's spec. Same FieldSpec shape as the A+ registry
// at apps/web/.../marketing/aplus/_lib/modules.ts so the editor
// renders both surfaces from the same FieldEditor primitives.

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'asset_id'
  | 'asin'
  | 'list_text'
  | 'list_image'

export interface FieldSpec {
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  max?: number
  hint?: string
}

export interface BrandStoryModuleSpec {
  id: string
  label: string
  description: string
  fields: FieldSpec[]
  /// True when the canvas has a real preview component for this
  /// module type (set false to fall back to the placeholder card).
  /// All 4 are implemented in MC.9.2.
  rendererImplemented: boolean
}

export const BRAND_STORY_MODULE_SPECS: BrandStoryModuleSpec[] = [
  {
    id: 'brand_header',
    label: 'Brand header',
    description:
      'Brand logo + headline + intro paragraph. Renders at the top of the Brand Story panel.',
    fields: [
      { key: 'logoAssetId', label: 'Brand logo', kind: 'asset_id', required: true, hint: 'Square logo recommended; minimum 600×600.' },
      { key: 'headline', label: 'Headline', kind: 'text', required: true, max: 200 },
      { key: 'description', label: 'Brand intro', kind: 'textarea', max: 1500 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'featured_asins',
    label: 'Featured ASINs',
    description:
      'Showcase up to 4 products from your brand. Pulled into the Brand Story panel as a clickable grid.',
    fields: [
      { key: 'asins', label: 'ASINs', kind: 'list_text', max: 4, required: true, hint: 'Up to 4 ASINs from your brand.' },
      { key: 'description', label: 'Caption', kind: 'textarea', max: 400 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'story_focus',
    label: 'Story focus',
    description:
      'Single image + body text — used for the brand narrative (origin story, mission, team).',
    fields: [
      { key: 'imageAssetId', label: 'Image', kind: 'asset_id', required: true },
      { key: 'headline', label: 'Headline', kind: 'text', max: 200 },
      { key: 'body', label: 'Body', kind: 'textarea', max: 1500 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'image_carousel',
    label: 'Image carousel',
    description:
      '4-image rotating carousel. Useful for lifestyle imagery + factory shots.',
    fields: [
      { key: 'images', label: 'Images', kind: 'list_image', max: 4, required: true },
    ],
    rendererImplemented: true,
  },
]

export function getBrandStoryModuleSpec(
  type: string,
): BrandStoryModuleSpec | null {
  return BRAND_STORY_MODULE_SPECS.find((m) => m.id === type) ?? null
}

export function validateBrandStoryModulePayload(
  spec: BrandStoryModuleSpec,
  payload: Record<string, unknown>,
): string[] {
  const issues: string[] = []
  for (const field of spec.fields) {
    const value = payload[field.key]
    const isEmpty =
      value === null ||
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    if (field.required && isEmpty) {
      issues.push(`${field.label} is required`)
      continue
    }
    if (typeof value === 'string' && field.max && value.length > field.max) {
      issues.push(
        `${field.label} is over the ${field.max}-character limit (${value.length})`,
      )
    }
    if (Array.isArray(value) && field.max && value.length > field.max) {
      issues.push(
        `${field.label} has more than ${field.max} items (${value.length})`,
      )
    }
  }
  return issues
}
