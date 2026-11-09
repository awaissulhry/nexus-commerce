import type { Issue } from '../../core/errors'
import type { LocalisedNames } from '../materials/rules'
import { ppeProblems, type PpeCategory, type ProductType, type StyleField } from '../styles/rules'

/**
 * Product types (B-W2b-221; feature PRD-008 "Product types (jacket, trousers, one-piece suit, two-piece suit, gloves, vest)
 * define required attributes, default size scale, default routing, default label set and compliance rules; children inherit
 * from parents"; design products.settings psettings.types), pure. A type (factory-db ProductTypeProfile) refines one kind of
 * garment (Style.productType) and says:
 *
 *   requiredAttributes   the style fields a style of it must have filled before release (B-W2b-231's check reads
 *                        `missingAttributes`); a child's add to its parent's (`effectiveType`)
 *   defaults             the size scale, the garment label template, the measurement template and the PPE category,
 *                        standard and class a new style of it starts with; a child's empty default is its parent's (and so
 *                        on up the tree)
 *   compliance rules     its PPE defaults here, and B-W2b-216's requirements that name the type (no free code)
 *
 * The database (ProductTypeProfile_check) holds the shape: code 1-60 without spaces, name 1-200, a parent of the same kind of
 * garment and the type's company or tenant-wide, no circle, defaults of the type's company or tenant-wide. Routing defaults
 * are not modelled (B-W2b-206: a copy of a style takes its routing).
 */

export const TYPE_LIMITS = Object.freeze({ code: 60, name: 200, standard: 60, ppeClass: 10, required: 50, depth: 100 })

/** Style fields a type may require: the ones a style may leave empty. */
export const REQUIRABLE_ATTRIBUTES = [
  'nameI18n',
  'description',
  'season',
  'brandPartyId',
  'sizes',
  'baseSize',
  'ppeStandard',
  'ppeClass',
  'measurementTemplateId',
  'hsCode',
  'originCountry',
  'netMassKg',
  'gender',
] as const satisfies readonly StyleField[]
export type RequirableAttribute = (typeof REQUIRABLE_ATTRIBUTES)[number]

/** A type's own row as far as inheritance goes (null: not set on this type). */
export interface TypeRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly productType: ProductType
  readonly parentId: string | null
  readonly requiredAttributes: readonly string[]
  readonly defaultSizeScaleId: string | null
  readonly labelTemplateId: string | null
  readonly measurementTemplateId: string | null
  readonly defaultPpeCategory: PpeCategory | null
  readonly defaultPpeStandard: string | null
  readonly defaultPpeClass: string | null
}

export const DEFAULT_FIELDS = ['defaultSizeScaleId', 'labelTemplateId', 'measurementTemplateId', 'defaultPpeCategory', 'defaultPpeStandard', 'defaultPpeClass'] as const
export type DefaultField = (typeof DEFAULT_FIELDS)[number]

/** What a type gives, after inheritance, and which type each value comes from. */
export interface EffectiveType {
  readonly requiredAttributes: readonly { readonly name: string; readonly fromTypeId: string }[]
  readonly defaults: { readonly [Field in DefaultField]: { readonly value: TypeRow[Field]; readonly fromTypeId: string | null } }
}

/**
 * The type with what it inherits: `chain` is the type first, then its parent, its parent's parent … (the API walks it up to
 * TYPE_LIMITS.depth). A default is the first one set up the chain; the required attributes are the union, the top type's
 * first, each once.
 */
export function effectiveType(chain: readonly TypeRow[]): EffectiveType {
  const defaults = Object.fromEntries(
    DEFAULT_FIELDS.map((field) => {
      const from = chain.find((row) => row[field] !== null)
      return [field, { value: from ? from[field] : null, fromTypeId: from ? from.id : null }]
    }),
  ) as unknown as EffectiveType['defaults']
  const seen = new Set<string>()
  const requiredAttributes: { name: string; fromTypeId: string }[] = []
  for (const row of [...chain].reverse()) {
    for (const name of row.requiredAttributes) {
      if (seen.has(name)) continue
      seen.add(name)
      requiredAttributes.push({ name, fromTypeId: row.id })
    }
  }
  return { requiredAttributes, defaults }
}

/** A style's values as far as required attributes go (any field; null, '' and [] are empty). */
export type StyleValues = { readonly [Field in StyleField]?: unknown }

const isEmpty = (value: unknown): boolean => value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)

/** The required attributes the style has not filled (B-W2b-231's release check reads it). */
export function missingAttributes(style: StyleValues, required: readonly { readonly name: string }[]): string[] {
  return required.filter((entry) => isEmpty(style[entry.name as StyleField])).map((entry) => entry.name)
}

/** The defaults a new style of the type takes, in Style's columns (null: the type gives none). */
export interface StyleDefaults {
  readonly sizeScaleId: string | null
  readonly measurementTemplateId: string | null
  readonly ppeCategory: PpeCategory | null
  readonly ppeStandard: string | null
  readonly ppeClass: string | null
  /** For the first revision's label (W1 names it per revision: PUT …/revisions/:id/label). */
  readonly labelTemplateId: string | null
}

export function styleDefaultsOf(effective: EffectiveType): StyleDefaults {
  const { defaults } = effective
  return {
    sizeScaleId: defaults.defaultSizeScaleId.value,
    measurementTemplateId: defaults.measurementTemplateId.value,
    ppeCategory: defaults.defaultPpeCategory.value,
    ppeStandard: defaults.defaultPpeStandard.value,
    ppeClass: defaults.defaultPpeClass.value,
    labelTemplateId: defaults.labelTemplateId.value,
  }
}

/** A new style's fields as typed (undefined: left out), the fields the type fills. */
export interface NewStyleTyped {
  readonly sizeScaleId?: string | undefined
  readonly mtmAllowed?: boolean | undefined
  readonly measurementTemplateId?: string | null | undefined
  readonly ppeCategory?: PpeCategory | undefined
  readonly ppeStandard?: string | null | undefined
  readonly ppeClass?: string | null | undefined
}

/**
 * What a new style takes from its type: each field the person left out, from the type's defaults. The measurement template
 * only for a style that may be made to measure (W1's rule), the PPE standard and class only when the style's category is
 * the type's (a style typed "not PPE" takes no standard).
 */
export function fillFromType<Body extends NewStyleTyped>(body: Body, defaults: StyleDefaults): Body {
  const filled = { ...body } as Record<string, unknown>
  if (body.sizeScaleId === undefined && defaults.sizeScaleId !== null) filled.sizeScaleId = defaults.sizeScaleId
  if (body.measurementTemplateId === undefined && body.mtmAllowed === true && defaults.measurementTemplateId !== null) filled.measurementTemplateId = defaults.measurementTemplateId
  if (body.ppeCategory === undefined && defaults.ppeCategory !== null) filled.ppeCategory = defaults.ppeCategory
  const category = (filled.ppeCategory as PpeCategory | undefined) ?? null
  if (category !== null && category !== 'NOT_PPE' && category === defaults.ppeCategory) {
    if (body.ppeStandard === undefined && defaults.ppeStandard !== null) filled.ppeStandard = defaults.ppeStandard
    if (body.ppeClass === undefined && defaults.ppeClass !== null) filled.ppeClass = defaults.ppeClass
  }
  return filled as Body
}

// ---- a type as typed -------------------------------------------------------------------------------------------------------

export const TYPE_CODE = /^\S{1,60}$/

export interface TypeFields {
  readonly code: string
  readonly name: string
  readonly nameI18n: LocalisedNames | null
  readonly productType: ProductType
  readonly parentId: string | null
  readonly requiredAttributes: readonly string[]
  readonly defaultSizeScaleId: string | null
  readonly labelTemplateId: string | null
  readonly measurementTemplateId: string | null
  readonly defaultPpeCategory: PpeCategory | null
  readonly defaultPpeStandard: string | null
  readonly defaultPpeClass: string | null
}

/** The type's own fields: code, name, the required attributes (each once, of REQUIRABLE_ATTRIBUTES). Paths are field names. */
export function typeProblems(type: Pick<TypeFields, 'code' | 'name' | 'requiredAttributes' | 'defaultPpeStandard' | 'defaultPpeClass'>): Issue[] {
  const issues: Issue[] = []
  if (!TYPE_CODE.test(type.code)) issues.push({ path: 'code', message: `A code is 1 to ${TYPE_LIMITS.code} characters without spaces.` })
  if (type.name.trim() === '' || type.name.length > TYPE_LIMITS.name) issues.push({ path: 'name', message: `A name is 1 to ${TYPE_LIMITS.name} characters.` })
  if (type.requiredAttributes.length > TYPE_LIMITS.required) issues.push({ path: 'requiredAttributes', message: `At most ${TYPE_LIMITS.required} required attributes.` })
  const seen = new Set<string>()
  type.requiredAttributes.forEach((name, index) => {
    if (!(REQUIRABLE_ATTRIBUTES as readonly string[]).includes(name)) issues.push({ path: `requiredAttributes/${index}`, message: `${name} is not a style field a type can require (${REQUIRABLE_ATTRIBUTES.join(', ')}).` })
    else if (seen.has(name)) issues.push({ path: `requiredAttributes/${index}`, message: `${name} is listed twice.` })
    seen.add(name)
  })
  if (type.defaultPpeStandard !== null && type.defaultPpeStandard.length > TYPE_LIMITS.standard) issues.push({ path: 'defaultPpeStandard', message: `A standard is at most ${TYPE_LIMITS.standard} characters.` })
  if (type.defaultPpeClass !== null && type.defaultPpeClass.length > TYPE_LIMITS.ppeClass) issues.push({ path: 'defaultPpeClass', message: `A class is at most ${TYPE_LIMITS.ppeClass} characters.` })
  return issues
}

/**
 * The PPE defaults after inheritance, as a style of the type would carry them (W1's ppeProblems: EN 17092 never on gloves,
 * Category II at least …). Nothing to check without a category. Paths are the type's fields.
 */
export function inheritedPpeProblems(productType: ProductType, effective: EffectiveType): Issue[] {
  const category = effective.defaults.defaultPpeCategory.value
  const standard = effective.defaults.defaultPpeStandard.value
  const ppeClass = effective.defaults.defaultPpeClass.value
  if (category === null) {
    return standard === null && ppeClass === null ? [] : [{ path: 'defaultPpeCategory', message: 'Name the PPE category the standard and class go with (here or on a parent type).' }]
  }
  const field: Record<string, string> = { ppeCategory: 'defaultPpeCategory', ppeStandard: 'defaultPpeStandard', ppeClass: 'defaultPpeClass' }
  return ppeProblems({ productType, ppeCategory: category, ppeStandard: standard, ppeClass }).map((issue) => ({ path: field[issue.path] ?? issue.path, message: issue.message }))
}

/** A circle: the parent named is the type itself or one of its descendants (`chain` = the parent's chain up). */
export const parentCircle = (typeId: string, parentChain: readonly { readonly id: string }[]): boolean => parentChain.some((row) => row.id === typeId)
