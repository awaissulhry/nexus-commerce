/**
 * MC.9.4 — Brand Story document-level validator.
 *
 * Mirrors aplus-validation.service.ts but for the 4 Brand Story
 * module types. Catches what would fail Amazon's submission API:
 *   - missing top-level fields
 *   - empty document (Brand Story needs at least brand_header)
 *   - duplicate brand_header (canonical Amazon rejection — only one
 *     header allowed)
 *   - per-module required fields + max-length checks
 *
 * Module rule table mirrors apps/web/.../brand-story/_lib/modules.ts.
 * Same duplication trade-off as MC.8.8 — server can't trust the
 * client; consolidating into a shared package is bigger than this
 * commit warrants.
 */

interface FieldRule {
  key: string
  required?: boolean
  maxString?: number
  maxList?: number
}

interface ModuleRule {
  type: string
  fields: FieldRule[]
}

const MODULE_RULES: ModuleRule[] = [
  {
    type: 'brand_header',
    fields: [
      { key: 'logoAssetId', required: true },
      { key: 'headline', required: true, maxString: 200 },
      { key: 'description', maxString: 1500 },
    ],
  },
  {
    type: 'featured_asins',
    fields: [
      { key: 'asins', required: true, maxList: 4 },
      { key: 'description', maxString: 400 },
    ],
  },
  {
    type: 'story_focus',
    fields: [
      { key: 'imageAssetId', required: true },
      { key: 'headline', maxString: 200 },
      { key: 'body', maxString: 1500 },
    ],
  },
  {
    type: 'image_carousel',
    fields: [{ key: 'images', required: true, maxList: 4 }],
  },
]

const MODULE_RULE_BY_TYPE = new Map(MODULE_RULES.map((r) => [r.type, r]))

const MAX_MODULES = 4

export type IssueSeverity = 'blocking' | 'warning'

export interface ValidationIssue {
  severity: IssueSeverity
  code: string
  message: string
  moduleIndex?: number
}

export interface ValidationResult {
  ok: boolean
  blocking: ValidationIssue[]
  warnings: ValidationIssue[]
  summary: {
    moduleCount: number
    moduleCap: number
    hasBrandHeader: boolean
  }
}

interface InputModule {
  type: string
  payload: Record<string, unknown>
}

interface InputDocument {
  name: string
  brand: string
  marketplace: string
  locale: string
  modules: InputModule[]
}

export function validateBrandStoryDocument(
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
  if (!doc.brand?.trim())
    blocking.push({
      severity: 'blocking',
      code: 'missing_brand',
      message: 'Brand is required for Brand Story.',
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
      message: 'Brand Story must contain at least the brand_header module.',
    })
  if (doc.modules.length > MAX_MODULES)
    blocking.push({
      severity: 'blocking',
      code: 'too_many_modules',
      message: `Brand Story allows at most ${MAX_MODULES} modules; this document has ${doc.modules.length}.`,
    })

  // brand_header presence is required by Amazon. Multiple headers
  // is a hard reject.
  const headerCount = doc.modules.filter(
    (m) => m.type === 'brand_header',
  ).length
  if (headerCount === 0 && doc.modules.length > 0)
    blocking.push({
      severity: 'blocking',
      code: 'missing_brand_header',
      message: 'Brand Story must include the brand_header module.',
    })
  if (headerCount > 1)
    blocking.push({
      severity: 'blocking',
      code: 'multiple_brand_headers',
      message: `${headerCount} brand_header modules found — Amazon allows exactly one.`,
    })

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
      moduleCap: MAX_MODULES,
      hasBrandHeader: headerCount === 1,
    },
  }
}
