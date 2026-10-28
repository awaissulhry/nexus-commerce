import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal, isCurrencyCode, UNIT_PRICE } from '../../core/money'
import { LOCALES, type Locale } from '../../email/rules'
import { defineMachine } from '../../state/machine'
import { carriedFactor, decimalText, dimensionOf, resolveItemUnits, type Uom } from '../units/units'

/**
 * The material library's rules (plan A1 §2.4 B, PLAN §2.8 "Cr VI"; features PRD-024, PRD-025, PRD-028, PRD-030,
 * GAP-006), pure. A material (factory-db `Item`) is a leather article, a textile, a lining or membrane, padding, thread,
 * a trim or hardware, a protector, a label, packaging, or a part we make. apps/factory-api's modules/product/materials
 * checks every create, change and import against these rules BEFORE it writes, so a refusal is a clear 400, never the
 * database trigger's bare P2003 (the …_product_guards trigger holds the units and the Cr VI rule for every login).
 *
 *   kind        LEATHER needs its animal species, tannage, grade and thickness range, counts in an area unit, is traced
 *               by lot or hide by hide, and is of animal origin (Reg. (EU) 1007/2011 art. 12 label phrase)
 *   Cr VI       a limit exactly when every lot needs a Cr VI test, above 0 and at most 3 mg/kg (REACH Annex XVII
 *               entry 47: leather articles in contact with the skin), or a brand's lower one
 *   make or buy (PRD-024) a COMPONENT is made (MAKE or MAKE_OR_BUY); a MAKE material has no supplier
 *   tracking    (PRD-025) HIDE only for leather; SERIAL only for a material counted in pieces; a PPE component (an EN 1621
 *               protector) is traced by lot or serial, so the garments that hold one lot can be found (Reg. (EU)
 *               2016/425 art. 8(5) batch identification)
 *   units       (PRD-030) ../units: the factors are resolved and checked there
 *
 * A material in use is archived, never deleted (PRD-022); an archived material is read only until it is reactivated.
 */

export const ITEM_KINDS = ['LEATHER', 'TEXTILE', 'LINING', 'MEMBRANE', 'PADDING', 'THREAD', 'TRIM', 'HARDWARE', 'PROTECTOR', 'LABEL', 'PACKAGING', 'COMPONENT'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]
export const ITEM_SOURCINGS = ['BUY', 'MAKE', 'MAKE_OR_BUY'] as const
export type ItemSourcing = (typeof ITEM_SOURCINGS)[number]
export const ITEM_TRACKINGS = ['NONE', 'LOT', 'HIDE', 'SERIAL'] as const
export type ItemTracking = (typeof ITEM_TRACKINGS)[number]
export const TANNAGES = ['CHROME', 'VEGETABLE', 'CHROME_FREE', 'COMBINATION'] as const
export type Tannage = (typeof TANNAGES)[number]
export const MATERIAL_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number]

/** ACTIVE ↔ ARCHIVED (PRD-022: master data in use is archived, never deleted). */
export const materialMachine = defineMachine({
  name: 'material',
  states: MATERIAL_STATUSES,
  transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: ['ACTIVE'] },
})

/** The legal Cr VI limit for leather articles in contact with the skin, mg/kg (REACH Annex XVII entry 47). */
export const CR6_LEGAL_LIMIT_MG_KG = '3'

/** Our article code: upper-case letters and digits, with . _ - / inside; 1 to 40 characters. */
export const MATERIAL_CODE = /^[A-Z0-9](?:[A-Z0-9._/-]{0,38}[A-Z0-9])?$/
export const MATERIAL_CODE_RULE = '1 to 40 capital letters or digits, with . _ - / inside'

/** A code as typed, trimmed and upper-cased. */
export const normaliseCode = (value: string): string => value.trim().toUpperCase()

/** One fibre of a composition (Reg. (EU) 1007/2011): the percentage as a decimal string. */
export interface FibreShare {
  readonly fibre: string
  readonly percent: string
}

export type LocalisedNames = Partial<Readonly<Record<Locale, string>>>

/** Everything a material holds but its cost, code-level ids and bookkeeping: what the rules look at. */
export interface MaterialFields {
  readonly code: string
  readonly name: string
  readonly nameI18n: LocalisedNames | null
  readonly kind: ItemKind
  readonly sourcing: ItemSourcing
  readonly tracking: ItemTracking
  readonly baseUom: Uom
  readonly purchaseUom: Uom
  readonly purchaseFactor: string
  readonly consumptionUom: Uom
  readonly consumptionFactor: string
  readonly defaultSupplierId: string | null
  readonly supplierArticleCode: string | null
  readonly animalSpecies: string | null
  readonly tannage: Tannage | null
  readonly grade: string | null
  readonly finish: string | null
  readonly thicknessMinMm: string | null
  readonly thicknessMaxMm: string | null
  readonly composition: readonly FibreShare[] | null
  readonly animalOrigin: boolean
  readonly attributes: Readonly<Record<string, string>> | null
  readonly isPpeComponent: boolean
  readonly requiresCrViTest: boolean
  readonly crViLimitMgKg: string | null
}

export type MaterialField = keyof MaterialFields
export const MATERIAL_FIELDS: readonly MaterialField[] = Object.freeze([
  'code', 'name', 'nameI18n', 'kind', 'sourcing', 'tracking', 'baseUom', 'purchaseUom', 'purchaseFactor', 'consumptionUom',
  'consumptionFactor', 'defaultSupplierId', 'supplierArticleCode', 'animalSpecies', 'tannage', 'grade', 'finish',
  'thicknessMinMm', 'thicknessMaxMm', 'composition', 'animalOrigin', 'attributes', 'isPpeComponent', 'requiresCrViTest',
  'crViLimitMgKg',
] as const)

/** A unit factor as typed: a decimal string, or null / left out when the units derive it (FT2 in M2). */
type TypedFactors = { readonly purchaseFactor?: string | null | undefined; readonly consumptionFactor?: string | null | undefined }
type FactorField = 'purchaseFactor' | 'consumptionFactor'

/** A new material as typed: what is left out takes the kind's default. */
export type MaterialInput = Pick<MaterialFields, 'code' | 'name' | 'kind' | 'baseUom'> & {
  readonly [Field in Exclude<MaterialField, 'code' | 'name' | 'kind' | 'baseUom' | FactorField>]?: MaterialFields[Field] | undefined
} & TypedFactors

/** A change as typed: only the fields it names (null clears an optional one; a null factor is derived again). */
export type MaterialPatch = { readonly [Field in Exclude<MaterialField, FactorField>]?: MaterialFields[Field] | undefined } & TypedFactors

// ---- defaults ---------------------------------------------------------------------------------------------------------

/** What a new material of a kind is when the office leaves it out. */
export function kindDefaults(kind: ItemKind): Pick<MaterialFields, 'sourcing' | 'tracking' | 'animalOrigin' | 'isPpeComponent'> {
  return {
    sourcing: kind === 'COMPONENT' ? 'MAKE' : 'BUY',
    // Hides are received and cut one by one (W1-33, W1-40); protectors come in certified lots.
    tracking: kind === 'LEATHER' ? 'HIDE' : kind === 'PROTECTOR' ? 'LOT' : 'NONE',
    animalOrigin: kind === 'LEATHER',
    isPpeComponent: kind === 'PROTECTOR',
  }
}

// ---- the rules --------------------------------------------------------------------------------------------------------

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
const PLAIN = /^\d+(?:\.\d+)?$/

/** A positive decimal string of Decimal(precision, scale) above 0, or what is wrong with it. */
function positiveProblem(value: string, precision: number, scale: number): string | null {
  if (!PLAIN.test(value) || !fitsDecimal(value, precision, scale)) return `Expected a number above 0 with at most ${precision - scale} digits and ${scale} decimals.`
  if (new D(value).lte(0)) return 'Expected a number above 0.'
  return null
}

/** The Cr VI fields (REACH Annex XVII entry 47): a limit exactly when a test is required, 0 < limit ≤ 3 mg/kg. */
export function crViProblems(requiresCrViTest: boolean, crViLimitMgKg: string | null): Issue[] {
  if (requiresCrViTest && crViLimitMgKg === null) {
    return [{ path: 'crViLimitMgKg', message: 'A material whose lots need a Cr VI test has its limit: at most 3 mg/kg (REACH Annex XVII entry 47), or a brand\'s lower one.' }]
  }
  if (!requiresCrViTest && crViLimitMgKg !== null) {
    return [{ path: 'crViLimitMgKg', message: 'A Cr VI limit is set only when the lots need a Cr VI test.' }]
  }
  if (crViLimitMgKg !== null) {
    if (!PLAIN.test(crViLimitMgKg) || !fitsDecimal(crViLimitMgKg, 8, 3) || new D(crViLimitMgKg).lte(0) || new D(crViLimitMgKg).gt(CR6_LEGAL_LIMIT_MG_KG)) {
      return [{ path: 'crViLimitMgKg', message: 'The Cr VI limit is above 0 and at most 3 mg/kg (REACH Annex XVII entry 47), with at most 3 decimals.' }]
    }
  }
  return []
}

function textProblem(value: string | null, max: number): string | null {
  if (value === null) return null
  if (value.trim() !== value || value === '') return 'Expected text without leading or trailing spaces.'
  return value.length > max ? `At most ${max} characters.` : null
}

/** A fibre composition: fibres named once, each above 0 %, adding up to exactly 100 %. */
export function compositionProblems(composition: readonly FibreShare[] | null): Issue[] {
  if (composition === null) return []
  if (composition.length === 0) return [{ path: 'composition', message: 'Leave the composition out, or name at least one fibre.' }]
  if (composition.length > 10) return [{ path: 'composition', message: 'At most 10 fibres.' }]
  const issues: Issue[] = []
  const seen = new Set<string>()
  let sum = new D(0)
  composition.forEach((share, index) => {
    const fibre = share.fibre.trim().toLowerCase()
    if (fibre === '' || share.fibre.length > 60) issues.push({ path: `composition/${index}/fibre`, message: 'Name the fibre (at most 60 characters).' })
    else if (seen.has(fibre)) issues.push({ path: `composition/${index}/fibre`, message: 'Each fibre is listed once.' })
    seen.add(fibre)
    const problem = positiveProblem(share.percent, 5, 2)
    if (problem) issues.push({ path: `composition/${index}/percent`, message: problem })
    else sum = sum.plus(share.percent)
  })
  if (issues.length === 0 && !sum.eq(100)) issues.push({ path: 'composition', message: `The fibres add up to ${decimalText(sum)} %, not 100 %.` })
  return issues
}

const ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9 _-]{0,59}$/

function attributeProblems(attributes: Readonly<Record<string, string>> | null): Issue[] {
  if (attributes === null) return []
  const entries = Object.entries(attributes)
  if (entries.length > 50) return [{ path: 'attributes', message: 'At most 50 attributes.' }]
  return entries.flatMap(([key, value]) => {
    if (!ATTRIBUTE_KEY.test(key)) return [{ path: `attributes/${key}`, message: 'An attribute name starts with a letter: letters, digits, spaces, _ or -, at most 60.' }]
    if (typeof value !== 'string' || value.length > 500) return [{ path: `attributes/${key}`, message: 'An attribute value is text of at most 500 characters.' }]
    return []
  })
}

/** A material whose unit factors may not be resolved yet (undefined: not typed; derived or asked for). */
export type UnresolvedMaterial = Omit<MaterialFields, 'purchaseFactor' | 'consumptionFactor'> & {
  readonly purchaseFactor: string | undefined
  readonly consumptionFactor: string | undefined
}

/** Every rule but the units' (those are resolveItemUnits'). */
function ruleProblems(material: UnresolvedMaterial): Issue[] {
  const issues: Issue[] = []
  const add = (path: string, message: string | null) => {
    if (message) issues.push({ path, message })
  }
  if (!MATERIAL_CODE.test(material.code)) add('code', `Expected ${MATERIAL_CODE_RULE}.`)
  add('name', material.name.trim() === '' ? 'Name the material.' : textProblem(material.name, 200))
  for (const [locale, name] of Object.entries(material.nameI18n ?? {})) {
    if (!(LOCALES as readonly string[]).includes(locale)) add(`nameI18n/${locale}`, `Names are kept in ${LOCALES.join(' and ')}.`)
    else add(`nameI18n/${locale}`, name === undefined ? null : textProblem(name, 200))
  }
  add('supplierArticleCode', textProblem(material.supplierArticleCode, 64))
  add('animalSpecies', textProblem(material.animalSpecies, 60))
  add('grade', textProblem(material.grade, 40))
  add('finish', textProblem(material.finish, 80))

  // Leather (PRD-028; REACH Annex XVII entry 47 below; Reg. (EU) 1007/2011 art. 12).
  if (material.kind === 'LEATHER') {
    if (material.animalSpecies === null) add('animalSpecies', 'Leather names its animal (bovine, goat, kangaroo …).')
    if (material.tannage === null) add('tannage', 'Leather names its tannage (chrome tanning is why Cr VI is tested).')
    if (material.grade === null) add('grade', "Leather names the tannery's selection or grade.")
    if (material.thicknessMinMm === null) add('thicknessMinMm', 'Leather has its thickness range in millimetres.')
    if (material.thicknessMaxMm === null) add('thicknessMaxMm', 'Leather has its thickness range in millimetres.')
    if (dimensionOf(material.baseUom) !== 'AREA') add('baseUom', 'Leather counts in an area unit: m², dm² or ft².')
    if (material.tracking !== 'LOT' && material.tracking !== 'HIDE') add('tracking', 'Leather is traced by lot or hide by hide.')
    if (!material.animalOrigin) add('animalOrigin', 'Leather is of animal origin: the garment label says so (Reg. (EU) 1007/2011 art. 12).')
  }
  for (const field of ['thicknessMinMm', 'thicknessMaxMm'] as const) {
    const value = material[field]
    if (value !== null) add(field, positiveProblem(value, 6, 2))
  }
  if (
    material.thicknessMinMm !== null &&
    material.thicknessMaxMm !== null &&
    positiveProblem(material.thicknessMinMm, 6, 2) === null &&
    positiveProblem(material.thicknessMaxMm, 6, 2) === null &&
    new D(material.thicknessMinMm).gt(material.thicknessMaxMm)
  ) {
    add('thicknessMaxMm', 'The thickest is at least the thinnest.')
  }

  // Tracking (PRD-025).
  if (material.tracking === 'HIDE' && material.kind !== 'LEATHER') add('tracking', 'Only leather is traced hide by hide.')
  if (material.tracking === 'SERIAL' && material.baseUom !== 'PCS') add('tracking', 'A serial number is per piece: count it in pieces (PCS).')
  if (material.isPpeComponent && material.tracking === 'NONE') {
    add('tracking', 'A PPE component is traced by lot or serial, so the garments that hold one lot can be found (Reg. (EU) 2016/425 art. 8(5)).')
  }

  // Make or buy (PRD-024).
  if (material.kind === 'COMPONENT' && material.sourcing === 'BUY') add('sourcing', 'A component is a part we make: MAKE, or MAKE_OR_BUY.')
  if (material.sourcing === 'MAKE') {
    if (material.defaultSupplierId !== null) add('defaultSupplierId', 'A material we only make has no supplier.')
    if (material.supplierArticleCode !== null) add('supplierArticleCode', 'A material we only make has no supplier article code.')
  }

  issues.push(...crViProblems(material.requiresCrViTest, material.crViLimitMgKg))
  issues.push(...compositionProblems(material.composition))
  issues.push(...attributeProblems(material.attributes))
  return issues
}

/** Every rule a material breaks, with the field each one is about (`thicknessMaxMm`, `composition/1/percent`). */
export function materialProblems(material: MaterialFields): Issue[] {
  const units = resolveItemUnits(material)
  return [...(units.ok ? [] : units.issues), ...ruleProblems(material)]
}

// ---- a new material, a change ------------------------------------------------------------------------------------------

export type MaterialOutcome =
  | { readonly ok: true; readonly material: MaterialFields }
  | { readonly ok: false; readonly issues: readonly Issue[] }

const plainOrNull = (value: string | null): string | null => (value === null ? null : decimalText(value))

/** Resolves the unit factors and checks every rule; the decimals of a valid material are written plainly ("1.2"). */
function checked(material: UnresolvedMaterial): MaterialOutcome {
  const units = resolveItemUnits(material)
  const issues = [...(units.ok ? [] : units.issues), ...ruleProblems(material)]
  if (!units.ok || issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    material: {
      ...material,
      ...units.units,
      thicknessMinMm: plainOrNull(material.thicknessMinMm),
      thicknessMaxMm: plainOrNull(material.thicknessMaxMm),
      crViLimitMgKg: plainOrNull(material.crViLimitMgKg),
      composition: material.composition?.map((share) => ({ fibre: share.fibre.trim(), percent: decimalText(share.percent) })) ?? null,
    },
  }
}

/** A new material: the kind's defaults for what is left out, the derived unit factors, every rule checked. */
export function newMaterial(input: MaterialInput): MaterialOutcome {
  const defaults = kindDefaults(input.kind)
  return checked({
    code: normaliseCode(input.code),
    name: input.name.trim(),
    nameI18n: input.nameI18n ?? null,
    kind: input.kind,
    sourcing: input.sourcing ?? defaults.sourcing,
    tracking: input.tracking ?? defaults.tracking,
    baseUom: input.baseUom,
    purchaseUom: input.purchaseUom ?? input.baseUom,
    purchaseFactor: input.purchaseFactor ?? undefined,
    consumptionUom: input.consumptionUom ?? input.baseUom,
    consumptionFactor: input.consumptionFactor ?? undefined,
    defaultSupplierId: input.defaultSupplierId ?? null,
    supplierArticleCode: input.supplierArticleCode ?? null,
    animalSpecies: input.animalSpecies ?? null,
    tannage: input.tannage ?? null,
    grade: input.grade ?? null,
    finish: input.finish ?? null,
    thicknessMinMm: input.thicknessMinMm ?? null,
    thicknessMaxMm: input.thicknessMaxMm ?? null,
    composition: input.composition ?? null,
    animalOrigin: input.animalOrigin ?? defaults.animalOrigin,
    attributes: input.attributes ?? null,
    isPpeComponent: input.isPpeComponent ?? defaults.isPpeComponent,
    requiresCrViTest: input.requiresCrViTest ?? false,
    crViLimitMgKg: input.crViLimitMgKg ?? null,
  })
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export type MaterialChange =
  | { readonly ok: true; readonly material: MaterialFields; readonly changed: readonly MaterialField[] }
  | { readonly ok: false; readonly issues: readonly Issue[] }

/**
 * A change to a material: the patch over the current fields, then every rule on the result. Turning the Cr VI test
 * off clears its limit. When the base unit moves, a unit factor the patch does not type again is derived again, or
 * carried over by the fixed ratio of the old and new base unit (a hide of 52.5 ft² is 4.8774096 m²), or must be typed
 * again. What the database knows (BOM lines, the standard cost) is the API's to check.
 */
export function changeMaterial(current: MaterialFields, patch: MaterialPatch): MaterialChange {
  const given: MaterialPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  const { purchaseFactor: _purchase, consumptionFactor: _consumption, ...fields } = given
  const merged: Omit<MaterialFields, FactorField> = { ...current, ...fields }
  const base = merged.baseUom
  const factor = (unit: 'purchase' | 'consumption'): string | undefined => {
    const typed = given[`${unit}Factor`]
    if (typed !== undefined) return typed ?? undefined
    const unitMoved = given[`${unit}Uom`] !== undefined && given[`${unit}Uom`] !== current[`${unit}Uom`]
    if (unitMoved) return undefined
    if (base === current.baseUom) return current[`${unit}Factor`]
    return carriedFactor(current[`${unit}Uom`], current[`${unit}Factor`], current.baseUom, base)
  }
  const outcome = checked({
    ...merged,
    code: normaliseCode(merged.code),
    name: merged.name.trim(),
    crViLimitMgKg: given.requiresCrViTest === false && given.crViLimitMgKg === undefined ? null : merged.crViLimitMgKg,
    purchaseFactor: factor('purchase'),
    consumptionFactor: factor('consumption'),
  })
  if (!outcome.ok) return outcome
  const changed = MATERIAL_FIELDS.filter((field) => !same(outcome.material[field], current[field]))
  return { ok: true, material: outcome.material, changed }
}

// ---- the standard purchase price (GAP-006) -----------------------------------------------------------------------------

/** A standard cost per base unit: a decimal string of at most 12 digits and 6 decimals, 0 or more. */
export function standardCostProblems(standardCost: string | null, currency: string): Issue[] {
  const issues: Issue[] = []
  if (standardCost !== null && (!/^\d+(?:\.\d+)?$/.test(standardCost) || !fitsDecimal(standardCost, UNIT_PRICE.precision, UNIT_PRICE.scale))) {
    issues.push({ path: 'standardCost', message: 'Expected a price of 0 or more, with at most 12 digits and 6 decimals.' })
  }
  if (!isCurrencyCode(currency)) issues.push({ path: 'currency', message: 'Expected an ISO 4217 currency code such as EUR.' })
  return issues
}

// ---- hints for the material page ---------------------------------------------------------------------------------------

export const MATERIAL_WARNINGS = ['NO_DEFAULT_SUPPLIER', 'LEATHER_WITHOUT_CR6_TEST'] as const
export type MaterialWarningCode = (typeof MATERIAL_WARNINGS)[number]

export interface MaterialWarning {
  readonly code: MaterialWarningCode
  readonly message: string
}

/** What the material page points out without refusing it (A2 SCR-048). */
export function materialWarnings(material: Pick<MaterialFields, 'kind' | 'sourcing' | 'defaultSupplierId' | 'requiresCrViTest'>): MaterialWarning[] {
  const warnings: MaterialWarning[] = []
  if (material.sourcing === 'BUY' && material.defaultSupplierId === null) {
    warnings.push({ code: 'NO_DEFAULT_SUPPLIER', message: 'It is bought but has no default supplier yet: each purchase order will ask for one.' })
  }
  if (material.kind === 'LEATHER' && !material.requiresCrViTest) {
    warnings.push({ code: 'LEATHER_WITHOUT_CR6_TEST', message: 'Leather in contact with the skin needs Cr VI evidence for each lot (REACH Annex XVII entry 47): require a Cr VI test.' })
  }
  return warnings
}
