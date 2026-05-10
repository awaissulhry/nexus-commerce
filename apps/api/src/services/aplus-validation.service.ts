/**
 * MC.8.8 — A+ Content document-level validator.
 *
 * Runs server-side before submission to Amazon. Catches the
 * structural issues that would fail /createContentDocument:
 *   - empty document
 *   - too many modules (Amazon caps at 5 per A+ document for
 *     standard tier; 7 for premium; spec-driven)
 *   - missing required field per known module type
 *   - oversized text fields per known module type
 *   - duplicate hero (Amazon allows at most 1 image_header_with_text)
 *
 * The per-field checks duplicate a thin slice of the client-side
 * spec at apps/web/src/app/marketing/aplus/_lib/modules.ts. Keeping
 * the two in lockstep is a cost — but the server can never trust
 * the client to validate, and pulling the spec into a shared
 * package is bigger work than this commit warrants. MC.8-followup
 * consolidates.
 */

interface FieldRule {
  key: string
  required?: boolean
  maxString?: number
  maxList?: number
}

interface ModuleRule {
  type: string
  /// 'standard' or 'premium' — drives the document-level cap.
  tier: 'standard' | 'premium'
  fields: FieldRule[]
}

const MODULE_RULES: ModuleRule[] = [
  {
    type: 'image_header_with_text',
    tier: 'standard',
    fields: [
      { key: 'imageAssetId', required: true },
      { key: 'headline', required: true, maxString: 80 },
      { key: 'subhead', maxString: 200 },
    ],
  },
  {
    type: 'standard_image_text',
    tier: 'standard',
    fields: [
      { key: 'imageAssetId', required: true },
      { key: 'headline', maxString: 200 },
      { key: 'body', maxString: 1000 },
    ],
  },
  {
    type: 'single_image_sidebar',
    tier: 'standard',
    fields: [
      { key: 'imageAssetId', required: true },
      { key: 'sidebarHeadline', maxString: 200 },
      { key: 'sidebarItems', maxList: 6 },
    ],
  },
  {
    type: 'multiple_image_text_panels',
    tier: 'standard',
    fields: [{ key: 'panels', maxList: 4 }],
  },
  {
    type: 'comparison_chart_3col',
    tier: 'standard',
    fields: [
      { key: 'asins', maxList: 3 },
      { key: 'attributes', maxList: 8 },
    ],
  },
  {
    type: 'comparison_chart_4col',
    tier: 'standard',
    fields: [
      { key: 'asins', maxList: 4 },
      { key: 'attributes', maxList: 8 },
    ],
  },
  {
    type: 'image_gallery_4',
    tier: 'standard',
    fields: [{ key: 'images', required: true, maxList: 4 }],
  },
  {
    type: 'bulleted_list_with_images',
    tier: 'standard',
    fields: [{ key: 'items', maxList: 6 }],
  },
  {
    type: 'faq',
    tier: 'standard',
    fields: [{ key: 'items', required: true, maxList: 8 }],
  },
  {
    type: 'premium_video',
    tier: 'premium',
    fields: [
      { key: 'videoAssetId', required: true },
      { key: 'headline', maxString: 200 },
    ],
  },
  {
    type: 'premium_comparison_chart_8col',
    tier: 'premium',
    fields: [
      { key: 'asins', maxList: 8 },
      { key: 'attributes', maxList: 12 },
    ],
  },
  {
    type: 'premium_image_text_image',
    tier: 'premium',
    fields: [
      { key: 'leftAssetId', required: true },
      { key: 'rightAssetId', required: true },
      { key: 'body', maxString: 1500 },
    ],
  },
  {
    type: 'premium_dynamic_carousel',
    tier: 'premium',
    fields: [{ key: 'slides', maxList: 8 }],
  },
  {
    type: 'premium_qa',
    tier: 'premium',
    fields: [{ key: 'items', maxList: 6 }],
  },
  {
    type: 'premium_image_hotspots',
    tier: 'premium',
    fields: [
      { key: 'imageAssetId', required: true },
      { key: 'hotspots', maxList: 6 },
    ],
  },
  {
    type: 'premium_text_overlay',
    tier: 'premium',
    fields: [
      { key: 'imageAssetId', required: true },
      { key: 'headline', maxString: 80 },
      { key: 'body', maxString: 400 },
    ],
  },
  {
    type: 'premium_brand_story',
    tier: 'premium',
    fields: [{ key: 'sections', maxList: 5 }],
  },
]

const MODULE_RULE_BY_TYPE = new Map(MODULE_RULES.map((r) => [r.type, r]))

// Amazon's documented caps. Standard A+ docs allow up to 5 modules;
// premium A+ allows up to 7. Documents that mix standard + premium
// modules count as premium.
const STANDARD_MAX_MODULES = 5
const PREMIUM_MAX_MODULES = 7

export type IssueSeverity = 'blocking' | 'warning'

export interface ValidationIssue {
  severity: IssueSeverity
  code: string
  message: string
  /// Index into the modules array when the issue is per-module.
  moduleIndex?: number
}

export interface ValidationResult {
  ok: boolean
  blocking: ValidationIssue[]
  warnings: ValidationIssue[]
  /// Document-level summary for the UI banner.
  summary: {
    moduleCount: number
    tier: 'standard' | 'premium'
    moduleCap: number
  }
}

interface InputModule {
  type: string
  payload: Record<string, unknown>
}

interface InputDocument {
  name: string
  brand: string | null
  marketplace: string
  locale: string
  modules: InputModule[]
}

export function validateAplusDocument(
  doc: InputDocument,
): ValidationResult {
  const blocking: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (!doc.name?.trim())
    blocking.push({
      severity: 'blocking',
      code: 'missing_name',
      message: 'Document name is required.',
    })
  else if (doc.name.length > 200)
    warnings.push({
      severity: 'warning',
      code: 'long_name',
      message: 'Document name is over 200 characters; some Amazon UIs truncate.',
    })
  if (!doc.marketplace?.trim())
    blocking.push({
      severity: 'blocking',
      code: 'missing_marketplace',
      message: 'Marketplace is required.',
    })
  if (!doc.locale?.trim())
    blocking.push({
      severity: 'blocking',
      code: 'missing_locale',
      message: 'Locale is required.',
    })

  if (doc.modules.length === 0)
    blocking.push({
      severity: 'blocking',
      code: 'empty_document',
      message: 'A+ document must contain at least one module.',
    })

  // Document tier = max tier of any module. Standard if all modules
  // are standard; premium if any premium module is used.
  let tier: 'standard' | 'premium' = 'standard'
  for (const mod of doc.modules) {
    const rule = MODULE_RULE_BY_TYPE.get(mod.type)
    if (rule?.tier === 'premium') {
      tier = 'premium'
      break
    }
  }
  const moduleCap =
    tier === 'premium' ? PREMIUM_MAX_MODULES : STANDARD_MAX_MODULES
  if (doc.modules.length > moduleCap)
    blocking.push({
      severity: 'blocking',
      code: 'too_many_modules',
      message: `Amazon ${tier} A+ allows at most ${moduleCap} modules; this document has ${doc.modules.length}.`,
    })

  // Hero-module check — Amazon shows the first module above the
  // fold. More than one image_header_with_text in a single document
  // makes the fold cluttered + Amazon may reject it.
  const heroCount = doc.modules.filter(
    (m) => m.type === 'image_header_with_text',
  ).length
  if (heroCount > 1)
    warnings.push({
      severity: 'warning',
      code: 'multiple_heroes',
      message: `${heroCount} hero modules detected — convention is one per document.`,
    })

  // Per-module field validation.
  for (let i = 0; i < doc.modules.length; i++) {
    const mod = doc.modules[i]!
    const rule = MODULE_RULE_BY_TYPE.get(mod.type)
    if (!rule) {
      blocking.push({
        severity: 'blocking',
        code: 'unknown_module',
        message: `Unknown module type "${mod.type}" at position ${i + 1}.`,
        moduleIndex: i,
      })
      continue
    }
    const payload = mod.payload ?? {}
    for (const field of rule.fields) {
      const value = payload[field.key]
      const isEmpty =
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      if (field.required && isEmpty) {
        blocking.push({
          severity: 'blocking',
          code: 'missing_field',
          message: `Module ${i + 1} (${rule.type}) is missing required "${field.key}".`,
          moduleIndex: i,
        })
        continue
      }
      if (
        typeof value === 'string' &&
        field.maxString &&
        value.length > field.maxString
      ) {
        blocking.push({
          severity: 'blocking',
          code: 'string_too_long',
          message: `Module ${i + 1} (${rule.type}) field "${field.key}" is ${value.length} chars; max ${field.maxString}.`,
          moduleIndex: i,
        })
      }
      if (
        Array.isArray(value) &&
        field.maxList &&
        value.length > field.maxList
      ) {
        blocking.push({
          severity: 'blocking',
          code: 'list_too_long',
          message: `Module ${i + 1} (${rule.type}) field "${field.key}" has ${value.length} items; max ${field.maxList}.`,
          moduleIndex: i,
        })
      }
    }
  }

  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    summary: {
      moduleCount: doc.modules.length,
      tier,
      moduleCap,
    },
  }
}
