// MC.8.3 — A+ module spec registry.
//
// One entry per Amazon A+ module type. The builder reads this to:
//   (a) populate the left-rail palette (groups + ordering),
//   (b) render each module's preview in the canvas,
//   (c) drive the right-rail property panel (which fields, what type),
//   (d) run client-side validation before sending to /aplus-modules
//       PATCH (server re-validates before /createContentDocument
//       submission lands in MC.8.9).
//
// 17 module types total: 8 standard + 9 premium (Brand Registry tier).
// Per the engagement plan, MC.8.3 wires the builder shell + 3 anchor
// modules to prove the pattern; MC.8.4 (8 standard) and MC.8.5 (9
// premium) fill in the rest by adding entries to this file + the
// matching ModuleEditor / ModuleRender components.

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'asset_id'
  | 'asin'
  | 'list_text'
  | 'list_image'
  | 'list_qa'

export interface FieldSpec {
  /** Key inside the module's payload JSON. */
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  /** Max characters (text/textarea) or max items (lists). Amazon's
   *  module spec drives these — getting them wrong fails the
   *  /createContentDocument call. */
  max?: number
  /** Operator-facing hint surfaced under the field. */
  hint?: string
}

export type ModuleTier = 'standard' | 'premium'

export interface ModuleSpec {
  /** Stable identifier persisted as APlusModule.type. */
  id: string
  /** Operator-facing label. */
  label: string
  tier: ModuleTier
  /** Palette grouping ("Hero", "Comparison", "Gallery", "Story", ...) */
  group: string
  /** One-line description shown under the palette tile. */
  description: string
  /** Property-panel field schema. The builder validates required +
   *  max length before save. */
  fields: FieldSpec[]
  /** Whether this commit's ModuleRender supports this type. When
   *  false the canvas falls back to a "Preview ships with MC.8.4/8.5"
   *  placeholder. Lets the palette show every module immediately
   *  while the renderers fill in over the next two commits. */
  rendererImplemented: boolean
}

export const MODULE_SPECS: ModuleSpec[] = [
  // ── Standard tier ─────────────────────────────────────────

  {
    id: 'image_header_with_text',
    label: 'Image header with text',
    tier: 'standard',
    group: 'Hero',
    description: '1464×600 hero image with overlay headline + subhead.',
    fields: [
      { key: 'imageAssetId', label: 'Header image', kind: 'asset_id', required: true, hint: 'Cloudinary or DAM asset id; ideal 1464×600' },
      { key: 'headline', label: 'Headline', kind: 'text', required: true, max: 80 },
      { key: 'subhead', label: 'Sub-headline', kind: 'text', max: 200 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'standard_image_text',
    label: 'Standard image + text',
    tier: 'standard',
    group: 'Story',
    description: 'Image left/right with rich body text.',
    fields: [
      { key: 'imageAssetId', label: 'Image', kind: 'asset_id', required: true },
      { key: 'headline', label: 'Headline', kind: 'text', max: 200 },
      { key: 'body', label: 'Body', kind: 'textarea', max: 1000 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'single_image_sidebar',
    label: 'Single image with sidebar',
    tier: 'standard',
    group: 'Story',
    description: 'Large image with a feature-list sidebar.',
    fields: [
      { key: 'imageAssetId', label: 'Image', kind: 'asset_id', required: true },
      { key: 'sidebarHeadline', label: 'Sidebar headline', kind: 'text', max: 200 },
      { key: 'sidebarItems', label: 'Sidebar items', kind: 'list_text', max: 6 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'multiple_image_text_panels',
    label: 'Multiple image + text panels',
    tier: 'standard',
    group: 'Story',
    description: '3 or 4 panels each with image + headline + body.',
    fields: [
      { key: 'panels', label: 'Panels', kind: 'list_image', max: 4 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'comparison_chart_3col',
    label: 'Comparison chart (3-column)',
    tier: 'standard',
    group: 'Comparison',
    description: 'Compare three ASINs side-by-side with attribute rows.',
    fields: [
      { key: 'asins', label: 'ASINs', kind: 'list_text', max: 3 },
      { key: 'attributes', label: 'Attribute rows', kind: 'list_text', max: 8 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'comparison_chart_4col',
    label: 'Comparison chart (4-column)',
    tier: 'standard',
    group: 'Comparison',
    description: 'Compare four ASINs side-by-side with attribute rows.',
    fields: [
      { key: 'asins', label: 'ASINs', kind: 'list_text', max: 4 },
      { key: 'attributes', label: 'Attribute rows', kind: 'list_text', max: 8 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'image_gallery_4',
    label: 'Image gallery (4)',
    tier: 'standard',
    group: 'Gallery',
    description: '4-image grid with optional captions.',
    fields: [
      { key: 'images', label: 'Images', kind: 'list_image', max: 4, required: true },
    ],
    rendererImplemented: true,
  },
  {
    id: 'bulleted_list_with_images',
    label: 'Bulleted list with images',
    tier: 'standard',
    group: 'Story',
    description: 'Up to 6 bullet items each with a small image.',
    fields: [
      { key: 'items', label: 'Items', kind: 'list_image', max: 6 },
    ],
    rendererImplemented: true,
  },
  {
    id: 'faq',
    label: 'FAQ',
    tier: 'standard',
    group: 'Story',
    description: 'Question + answer pairs (up to 8).',
    fields: [
      { key: 'items', label: 'Q&A pairs', kind: 'list_qa', max: 8, required: true },
    ],
    rendererImplemented: true,
  },

  // ── Premium tier (Brand Registry) ─────────────────────────

  {
    id: 'premium_video',
    label: 'Premium video',
    tier: 'premium',
    group: 'Hero',
    description: 'Inline video with poster + autoplay-on-scroll.',
    fields: [
      { key: 'videoAssetId', label: 'Video asset', kind: 'asset_id', required: true },
      { key: 'posterAssetId', label: 'Poster image', kind: 'asset_id' },
      { key: 'headline', label: 'Headline', kind: 'text', max: 200 },
    ],
    rendererImplemented: false,
  },
  {
    id: 'premium_comparison_chart_8col',
    label: 'Premium comparison (8-column)',
    tier: 'premium',
    group: 'Comparison',
    description: 'Eight-product side-by-side with attribute rows.',
    fields: [
      { key: 'asins', label: 'ASINs', kind: 'list_text', max: 8 },
      { key: 'attributes', label: 'Attribute rows', kind: 'list_text', max: 12 },
    ],
    rendererImplemented: false,
  },
  {
    id: 'premium_image_text_image',
    label: 'Premium image + text + image',
    tier: 'premium',
    group: 'Story',
    description: 'Two large hero images bracketing a body text block.',
    fields: [
      { key: 'leftAssetId', label: 'Left image', kind: 'asset_id', required: true },
      { key: 'rightAssetId', label: 'Right image', kind: 'asset_id', required: true },
      { key: 'body', label: 'Body', kind: 'textarea', max: 1500 },
    ],
    rendererImplemented: false,
  },
  {
    id: 'premium_dynamic_carousel',
    label: 'Premium dynamic carousel',
    tier: 'premium',
    group: 'Gallery',
    description: 'Auto-advancing carousel of up to 8 slides.',
    fields: [
      { key: 'slides', label: 'Slides', kind: 'list_image', max: 8 },
    ],
    rendererImplemented: false,
  },
  {
    id: 'premium_qa',
    label: 'Premium Q&A',
    tier: 'premium',
    group: 'Story',
    description: 'Q&A with attribution (e.g., from a customer or expert).',
    fields: [
      { key: 'items', label: 'Q&A pairs', kind: 'list_qa', max: 6 },
    ],
    rendererImplemented: false,
  },
  {
    id: 'premium_image_hotspots',
    label: 'Premium image hotspots',
    tier: 'premium',
    group: 'Story',
    description: 'Hero image with clickable feature callouts.',
    fields: [
      { key: 'imageAssetId', label: 'Hero image', kind: 'asset_id', required: true },
      { key: 'hotspots', label: 'Hotspots', kind: 'list_text', max: 6 },
    ],
    rendererImplemented: false,
  },
  {
    id: 'premium_text_overlay',
    label: 'Premium text overlay',
    tier: 'premium',
    group: 'Hero',
    description: 'Full-bleed image with overlay text on a tinted band.',
    fields: [
      { key: 'imageAssetId', label: 'Background image', kind: 'asset_id', required: true },
      { key: 'headline', label: 'Headline', kind: 'text', max: 80 },
      { key: 'body', label: 'Body', kind: 'textarea', max: 400 },
    ],
    rendererImplemented: false,
  },
  {
    id: 'premium_brand_story',
    label: 'Premium brand story',
    tier: 'premium',
    group: 'Story',
    description: 'Multi-image scrolling brand narrative module.',
    fields: [
      { key: 'sections', label: 'Sections', kind: 'list_image', max: 5 },
    ],
    rendererImplemented: false,
  },
]

export function getModuleSpec(type: string): ModuleSpec | null {
  return MODULE_SPECS.find((m) => m.id === type) ?? null
}

// MC.8.3 — payload validation (client-side; server re-validates at
// submission). Returns a list of human-readable issues; empty array
// means the module is valid against its spec.
export function validateModulePayload(
  spec: ModuleSpec,
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
