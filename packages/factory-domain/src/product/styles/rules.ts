import type { Issue } from '../../core/errors'
import { LOCALES } from '../../email/rules'
import { defineMachine } from '../../state/machine'
import type { LocalisedNames } from '../materials/rules'
import { inScaleOrder, normaliseSizeCode, SIZE_CODE, SIZE_CODE_RULE, type PlacedSize } from '../sizes/rules'

/**
 * The style rules (plan A1 §2.4 B; features PRD-001, PRD-002, PRD-022, PRD-025, PRD-048, PRD-270), pure. A style
 * (factory-db `Style`) is the model we make: the parent of its colourways (./colourways), its colour x size SKUs
 * (./matrix, ./sku), its revisions (BOM, routing, label: ./revisions) and the orders and certificates that name it.
 *
 *   code        1 to 24 capital letters or digits, with . _ - inside, unique in the tenant; SKUs start with it, so it
 *               never changes once the style has SKUs
 *   range       (PRD-048) codes of the style's scale, in the scale's order, each once; a size newly put in the range is
 *               an ACTIVE size of the scale; the base (sample) size grading works from is one of them. The scale does
 *               not change once the style has SKUs.
 *   PPE         (PRD-270; Reg. (EU) 2016/425 art. 18, Annex I; PPE Guidelines items 14.2-14.4) the category; the
 *               harmonised standard it is made to and its class: none when it is not PPE; EN 17092 (garments: part 2
 *               AAA, 3 AA, 4 A, 5 B, 6 C) never on gloves, EN 13594 (levels 1, 2, 1KP, 2KP) only on gloves, both
 *               Category II at least
 *   MTM         a measurement template only for a style that may be made to measure, of its product type (the API
 *               checks the type)
 *   tracking    (PRD-025; Reg. (EU) 2016/425 art. 8(5)) a PPE garment carries a type, batch or serial number: its
 *               garments are traced by lot (the work order's batch)
 *
 * DRAFT → ACTIVE (it has a released revision: it can be sold) → ARCHIVED, and back (PRD-022: never deleted).
 */

export const STYLE_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export type StyleStatus = (typeof STYLE_STATUSES)[number]
export const PRODUCT_TYPES = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'] as const
export type ProductType = (typeof PRODUCT_TYPES)[number]
export const PPE_CATEGORIES = ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III'] as const
export type PpeCategory = (typeof PPE_CATEGORIES)[number]

/** What the style machine's guard reads. */
export interface StyleFacts {
  /** The style has a RELEASED revision. */
  readonly releasedRevision: boolean
}

/** DRAFT → ACTIVE (a released revision) → ARCHIVED; ARCHIVED → DRAFT, or ACTIVE again with a released revision. */
export const styleMachine = defineMachine<StyleStatus, StyleFacts>({
  name: 'style',
  states: STYLE_STATUSES,
  transitions: { DRAFT: ['ACTIVE', 'ARCHIVED'], ACTIVE: ['ARCHIVED'], ARCHIVED: ['DRAFT', 'ACTIVE'] },
  guards: { ACTIVE: (facts) => (facts.releasedRevision ? [] : ['a released revision (its BOM, routing and label frozen)']) },
})

/** Where an archived style goes back to: ACTIVE when it has a released revision, else DRAFT. */
export const reactivatedStatus = (facts: StyleFacts): StyleStatus => (facts.releasedRevision ? 'ACTIVE' : 'DRAFT')

/** The style code: 1 to 24 capital letters or digits, with . _ - inside ("GT-JKT-01"). */
export const STYLE_CODE = /^[A-Z0-9](?:[A-Z0-9._-]{0,22}[A-Z0-9])?$/
export const STYLE_CODE_RULE = '1 to 24 capital letters or digits, with . _ - inside'
export const MAX_RANGE_SIZES = 60

export interface StyleFields {
  readonly code: string
  readonly name: string
  readonly nameI18n: LocalisedNames | null
  readonly description: string | null
  readonly productType: ProductType
  /** The season or collection ("FW27"). */
  readonly season: string | null
  /** The brand it is made for (private label); null: our own collection. */
  readonly brandPartyId: string | null
  readonly sizeScaleId: string
  /** The range: size codes of the scale, in its order. */
  readonly sizes: readonly string[]
  readonly baseSize: string | null
  readonly ppeCategory: PpeCategory
  readonly ppeStandard: string | null
  readonly ppeClass: string | null
  readonly mtmAllowed: boolean
  readonly measurementTemplateId: string | null
}
export type StyleField = keyof StyleFields
export const STYLE_FIELDS: readonly StyleField[] = Object.freeze([
  'code', 'name', 'nameI18n', 'description', 'productType', 'season', 'brandPartyId', 'sizeScaleId', 'sizes', 'baseSize',
  'ppeCategory', 'ppeStandard', 'ppeClass', 'mtmAllowed', 'measurementTemplateId',
] as const)

/** A new style as typed: what is left out is empty (no range yet, not PPE unless said, not made to measure). */
export type StyleInput = Pick<StyleFields, 'code' | 'name' | 'productType' | 'sizeScaleId'> & {
  readonly [Field in Exclude<StyleField, 'code' | 'name' | 'productType' | 'sizeScaleId'>]?: StyleFields[Field] | null | undefined
}
/** A change as typed: only the fields it names (null clears an optional one). */
export type StylePatch = { readonly [Field in StyleField]?: StyleFields[Field] | null | undefined }

/** The scale's sizes a range is checked against. */
export type ScaleSizes = readonly PlacedSize[]

// ---- PPE ----------------------------------------------------------------------------------------------------------------

/** EN 17092 (protective garments for motorcycle riders): the part says the class. */
const EN_17092 = /^EN 17092(?:-([1-6]))?(?::(\d{4}))?$/
export const EN_17092_CLASSES = ['AAA', 'AA', 'A', 'B', 'C'] as const
const EN_17092_PART_CLASS: Readonly<Record<string, (typeof EN_17092_CLASSES)[number]>> = { '2': 'AAA', '3': 'AA', '4': 'A', '5': 'B', '6': 'C' }
/** EN 13594 (protective gloves for motorcycle riders): level 1 or 2, with knuckle protection KP. */
const EN_13594 = /^EN 13594(?::(\d{4}))?$/
export const EN_13594_CLASSES = ['1', '2', '1KP', '2KP'] as const
const STANDARD = /^[A-Z][A-Z0-9 ./:+-]{1,39}$/

/** A standard as typed: trimmed, single spaces, upper case ("en 17092-4:2020" → "EN 17092-4:2020"). */
export const normaliseStandard = (value: string): string => value.trim().replace(/\s+/g, ' ').toUpperCase()

type PpeFields = Pick<StyleFields, 'productType' | 'ppeCategory' | 'ppeStandard' | 'ppeClass'>

/** The class an EN 17092 part sets ("EN 17092-4:2020" → A), or null. */
export function classOfStandard(standard: string | null): string | null {
  const part = standard === null ? undefined : EN_17092.exec(standard)?.[1]
  return part === undefined ? null : (EN_17092_PART_CLASS[part] ?? null)
}

export function ppeProblems(style: PpeFields): Issue[] {
  const { productType, ppeCategory, ppeStandard, ppeClass } = style
  if (ppeCategory === 'NOT_PPE') {
    const issues: Issue[] = []
    if (ppeStandard !== null) issues.push({ path: 'ppeStandard', message: 'A garment that is not PPE is made to no PPE standard.' })
    if (ppeClass !== null) issues.push({ path: 'ppeClass', message: 'A garment that is not PPE has no protection class.' })
    return issues
  }
  if (ppeStandard === null) return ppeClass === null ? [] : [{ path: 'ppeClass', message: 'Name the standard the class is of.' }]
  if (!STANDARD.test(ppeStandard)) return [{ path: 'ppeStandard', message: 'Write the standard with its edition, as "EN 17092-4:2020" (at most 40 characters).' }]
  const garment = EN_17092.exec(ppeStandard)
  if (garment) {
    if (garment[1] === '1') return [{ path: 'ppeStandard', message: 'EN 17092-1 holds the test methods: name the part of the class (EN 17092-2 to -6).' }]
    if (productType === 'GLOVES') return [{ path: 'ppeStandard', message: 'Rider gloves are made to EN 13594, not EN 17092.' }]
    if (ppeCategory === 'CATEGORY_I') return [{ path: 'ppeCategory', message: 'A garment made to EN 17092 is Category II PPE (PPE Guidelines, items 14.2-14.4).' }]
    if (ppeClass !== null && !(EN_17092_CLASSES as readonly string[]).includes(ppeClass)) return [{ path: 'ppeClass', message: `EN 17092 classes are ${EN_17092_CLASSES.join(', ')}.` }]
    const partClass = classOfStandard(ppeStandard)
    if (partClass !== null && ppeClass !== null && ppeClass !== partClass) return [{ path: 'ppeClass', message: `${ppeStandard} is class ${partClass}.` }]
    return []
  }
  if (EN_13594.test(ppeStandard)) {
    if (productType !== 'GLOVES') return [{ path: 'ppeStandard', message: 'EN 13594 is the standard of rider gloves.' }]
    if (ppeCategory === 'CATEGORY_I') return [{ path: 'ppeCategory', message: 'Rider gloves made to EN 13594 are Category II PPE (PPE Guidelines, item 14.4).' }]
    if (ppeClass !== null && !(EN_13594_CLASSES as readonly string[]).includes(ppeClass)) return [{ path: 'ppeClass', message: `EN 13594 levels are ${EN_13594_CLASSES.join(', ')}.` }]
    return []
  }
  if (ppeClass !== null && (ppeClass.length > 20 || !/^[A-Z0-9][A-Z0-9 .+/-]*$/.test(ppeClass))) return [{ path: 'ppeClass', message: 'A class is at most 20 capital letters, digits, spaces or . + / -.' }]
  return []
}

/** The standard and class as stored: normalised, and an EN 17092 part's class filled in when left out. */
export function normalisePpe(style: Pick<StyleFields, 'ppeStandard' | 'ppeClass'>): Pick<StyleFields, 'ppeStandard' | 'ppeClass'> {
  const standard = style.ppeStandard === null ? null : normaliseStandard(style.ppeStandard)
  const typed = style.ppeClass === null ? null : style.ppeClass.trim().toUpperCase()
  return { ppeStandard: standard === '' ? null : standard, ppeClass: typed === '' || typed === null ? classOfStandard(standard) : typed }
}

/**
 * How the garments of a style are traced (PRD-025; Reg. (EU) 2016/425 art. 8(5): a type, batch or serial number on
 * each PPE garment): LOT for PPE (the work order's batch is on the label), NONE otherwise.
 */
export const garmentTracking = (style: Pick<StyleFields, 'ppeCategory'>): 'LOT' | 'NONE' => (style.ppeCategory === 'NOT_PPE' ? 'NONE' : 'LOT')

// ---- the range ----------------------------------------------------------------------------------------------------------

/**
 * The range against the scale: each code a size of it, each once; a size new to the range (not in `kept`) an ACTIVE
 * one; at most 60. Paths are `sizes/<index>`.
 */
export function rangeProblems(sizes: readonly string[], scale: ScaleSizes, kept: readonly string[] = []): Issue[] {
  if (sizes.length > MAX_RANGE_SIZES) return [{ path: 'sizes', message: `A range has at most ${MAX_RANGE_SIZES} sizes.` }]
  const byCode = new Map(scale.map((size) => [size.code, size]))
  const seen = new Set<string>()
  const issues: Issue[] = []
  sizes.forEach((code, index) => {
    const path = `sizes/${index}`
    const size = byCode.get(code)
    if (!SIZE_CODE.test(code)) issues.push({ path, message: `Expected ${SIZE_CODE_RULE}.` })
    else if (seen.has(code)) issues.push({ path, message: `Size ${code} is listed twice.` })
    else if (!size) issues.push({ path, message: `The style's size scale has no size ${code}.` })
    else if (size.status !== 'ACTIVE' && !kept.includes(code)) issues.push({ path, message: `Size ${code} is archived in the scale: it is no longer added to a range.` })
    seen.add(code)
  })
  return issues
}

// ---- the rules ----------------------------------------------------------------------------------------------------------

function textProblem(value: string | null, max: number): string | null {
  if (value === null) return null
  if (value.trim() !== value || value === '') return 'Expected text without leading or trailing spaces.'
  return value.length > max ? `At most ${max} characters.` : null
}

/** Every rule a style breaks against its scale's sizes; `kept` are range sizes it had before (an archived one stays). */
export function styleProblems(style: StyleFields, scale: ScaleSizes, kept: readonly string[] = []): Issue[] {
  const issues: Issue[] = []
  const add = (path: string, message: string | null) => {
    if (message) issues.push({ path, message })
  }
  if (!STYLE_CODE.test(style.code)) add('code', `Expected ${STYLE_CODE_RULE}.`)
  add('name', style.name.trim() === '' ? 'Name the style.' : textProblem(style.name, 200))
  for (const [locale, name] of Object.entries(style.nameI18n ?? {})) {
    if (!(LOCALES as readonly string[]).includes(locale)) add(`nameI18n/${locale}`, `Names are kept in ${LOCALES.join(' and ')}.`)
    else add(`nameI18n/${locale}`, name === undefined ? null : textProblem(name, 200))
  }
  add('description', textProblem(style.description, 4000))
  add('season', textProblem(style.season, 20))

  issues.push(...rangeProblems(style.sizes, scale, kept))
  if (style.baseSize !== null && !style.sizes.includes(style.baseSize)) {
    add('baseSize', style.sizes.length === 0 ? 'Choose the range before its base size.' : `The base size is one of the range: ${style.sizes.join(', ')}.`)
  }

  issues.push(...ppeProblems(style))
  if (style.measurementTemplateId !== null && !style.mtmAllowed) {
    add('measurementTemplateId', 'A measurement template is for a style that may be made to measure (mtmAllowed).')
  }
  return issues
}

export type StyleOutcome = { readonly ok: true; readonly style: StyleFields } | { readonly ok: false; readonly issues: readonly Issue[] }

const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** The fields as stored: codes upper-cased, texts trimmed, the range in the scale's order, the PPE class filled in. */
function normalised(style: StyleFields, scale: ScaleSizes): StyleFields {
  const sizes = style.sizes.map(normaliseSizeCode)
  const unique = [...new Set(sizes)]
  return {
    ...style,
    code: style.code.trim().toUpperCase(),
    name: style.name.trim(),
    description: textOrNull(style.description),
    season: textOrNull(style.season),
    // A repeated code stays repeated, so the rule reports it; a valid range is put in the scale's order.
    sizes: unique.length === sizes.length ? inScaleOrder(sizes, scale) : sizes,
    baseSize: style.baseSize === null ? null : normaliseSizeCode(style.baseSize),
    ...normalisePpe(style),
  }
}

function checked(style: StyleFields, scale: ScaleSizes, kept: readonly string[] = []): StyleOutcome {
  const next = normalised(style, scale)
  const issues = styleProblems(next, scale, kept)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, style: next }
}

/** A new style: the defaults for what is left out, then every rule against the scale's sizes. */
export function newStyle(input: StyleInput, scale: ScaleSizes): StyleOutcome {
  return checked(
    {
      code: input.code,
      name: input.name,
      nameI18n: input.nameI18n ?? null,
      description: input.description ?? null,
      productType: input.productType,
      season: input.season ?? null,
      brandPartyId: input.brandPartyId ?? null,
      sizeScaleId: input.sizeScaleId,
      sizes: input.sizes ?? [],
      baseSize: input.baseSize ?? null,
      ppeCategory: input.ppeCategory ?? 'NOT_PPE',
      ppeStandard: input.ppeStandard ?? null,
      ppeClass: input.ppeClass ?? null,
      mtmAllowed: input.mtmAllowed ?? false,
      measurementTemplateId: input.measurementTemplateId ?? null,
    },
    scale,
  )
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export type StyleChange =
  | { readonly ok: true; readonly style: StyleFields; readonly changed: readonly StyleField[] }
  | { readonly ok: false; readonly issues: readonly Issue[] }

/**
 * A change to a style: the patch over the current fields, then every rule against the scale's sizes (the new scale's
 * when the patch moves it). A new standard without a class takes its part's class again. What the database knows
 * (SKUs, the brand, the template) is the API's to check: `styleChangeRefusals`.
 */
export function changeStyle(current: StyleFields, patch: StylePatch, scale: ScaleSizes): StyleChange {
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as StylePatch
  const merged = { ...current, ...given } as StyleFields
  const standardMoved = given.ppeStandard !== undefined && given.ppeStandard !== current.ppeStandard
  const outcome = checked(
    {
      ...merged,
      // Clearing the standard or the category clears the class it set, unless the patch types one.
      ppeClass: given.ppeClass !== undefined ? merged.ppeClass : standardMoved || merged.ppeCategory === 'NOT_PPE' ? null : merged.ppeClass,
      ppeStandard: merged.ppeCategory === 'NOT_PPE' && given.ppeStandard === undefined ? null : merged.ppeStandard,
      measurementTemplateId: given.mtmAllowed === false && given.measurementTemplateId === undefined ? null : merged.measurementTemplateId,
    },
    scale,
    merged.sizeScaleId === current.sizeScaleId ? current.sizes : [],
  )
  if (!outcome.ok) return outcome
  const changed = STYLE_FIELDS.filter((field) => !same(outcome.style[field], current[field]))
  return { ok: true, style: outcome.style, changed }
}

/** What the database says about a style, for the changes that SKUs freeze. */
export interface StyleUsage {
  /** Its SKUs, any status. */
  readonly variants: number
}

/** The refusals of a valid change that the style's SKUs decide (a 409 each): its code and its scale stay. */
export function styleChangeRefusals(current: StyleFields, next: StyleFields, usage: StyleUsage): string[] {
  const refusals: string[] = []
  if (usage.variants > 0 && next.code !== current.code) refusals.push(`The style has SKUs, which start with its code: its code stays ${current.code}.`)
  if (usage.variants > 0 && next.sizeScaleId !== current.sizeScaleId) refusals.push('The style has SKUs in sizes of its scale: its size scale stays.')
  return refusals
}

// ---- hints for the style page -------------------------------------------------------------------------------------------

export const STYLE_WARNINGS = ['NO_SIZE_RANGE', 'NO_BASE_SIZE', 'NO_COLOURWAY', 'SKUS_MISSING', 'NO_PPE_STANDARD', 'NO_PPE_CLASS', 'NO_MEASUREMENT_TEMPLATE'] as const
export type StyleWarningCode = (typeof STYLE_WARNINGS)[number]

export interface StyleWarning {
  readonly code: StyleWarningCode
  readonly message: string
}

/** What the style page points out without refusing it (A2 SCR-041). */
export function styleWarnings(style: StyleFields, facts: { readonly activeColourways: number; readonly missingCells: number }): StyleWarning[] {
  const warnings: StyleWarning[] = []
  const warn = (code: StyleWarningCode, message: string) => warnings.push({ code, message })
  if (style.sizes.length === 0) warn('NO_SIZE_RANGE', 'Choose the sizes it is made in: the SKUs are built from them.')
  else if (style.baseSize === null) warn('NO_BASE_SIZE', 'Choose the base (sample) size grading works from.')
  if (facts.activeColourways === 0) warn('NO_COLOURWAY', 'Add a colourway: orders, BOM colours and stock are per colourway.')
  if (facts.missingCells > 0) warn('SKUS_MISSING', `${facts.missingCells} colour and size combination(s) have no SKU yet: generate the SKUs.`)
  if (style.ppeCategory !== 'NOT_PPE' && style.ppeStandard === null) warn('NO_PPE_STANDARD', 'Name the harmonised standard it is made to: the label, the certificate and the declaration of conformity need it.')
  else if (style.ppeCategory !== 'NOT_PPE' && style.ppeClass === null) warn('NO_PPE_CLASS', 'Name the class it is made for: the label shows it.')
  if (style.mtmAllowed && style.measurementTemplateId === null) warn('NO_MEASUREMENT_TEMPLATE', 'Choose the measurement template a made-to-measure unit is measured with.')
  return warnings
}
