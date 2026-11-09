import type { Issue } from '../../core/errors'
import { Dec, type Decimal } from '../../tax/decimal'
import { areaIn, AREA_UOMS, isAreaUom, type AreaUom } from '../../inventory/hides/area'
import { MINIMUM_REMNANT } from '../../inventory/remnants/rules'
import { DEFAULT_SHADE_RULE, SHADE_RULES, type ShadeRule } from '../../inventory/reservations/shade'

/**
 * A site's cutting rules (B-W2b-219; the follow-ups of B-W2b-100, -103 and -132; Production › Floor rules & codes, the
 * Cutting card; factory-db production.prisma ProductionSettings, B-W2b-204's columns), pure. The office sets them per site
 * (production.settings.manage); the floor reads its own site's (the column grant) where the rule acts:
 *
 *   shadeRule          one shade lot per ORDER (the default, Q18), per GARMENT (the cutting table checks a garment's parts),
 *                      or OFF (no check): read by the API's shadeRuleFor (the reserve, the pick, the table, the board, the
 *                      leather need).
 *   hidePhotoRequired  the hide check asks a photo of the hide on the table before Cut (MES-060; default off: optional).
 *   minimumRemnant     the smallest leftover kept as a remnant (SCM-254; default 10 dm²): a smaller piece is waste. Above 0
 *                      and at most 10 m², in M2, DM2 or FT2 (the database keeps the same: ProductionSettings_cutting_check).
 *
 * A change applies from now on: hides already reserved, issued, cut or tagged keep what they were.
 */

export const CUTTING_RULE_FIELDS = ['shadeRule', 'hidePhotoRequired', 'minimumRemnant'] as const
export type CuttingRuleField = (typeof CUTTING_RULE_FIELDS)[number]

/** The largest minimum remnant a site may set (a whole hide is 4–6 m²). */
export const MAX_MINIMUM_REMNANT_M2 = '10'
/** The places a minimum keeps (the column's scale). */
export const MINIMUM_REMNANT_PLACES = 4

export interface MinimumRemnant {
  /** Four places at most, above 0. */
  readonly area: string
  readonly uom: AreaUom
}

export interface CuttingRules {
  readonly shadeRule: ShadeRule
  readonly hidePhotoRequired: boolean
  readonly minimumRemnant: MinimumRemnant
}

/** The schema's defaults: a site without its own row runs on them (and on what every site did before). */
export const DEFAULT_CUTTING_RULES: CuttingRules = Object.freeze({
  shadeRule: DEFAULT_SHADE_RULE,
  hidePhotoRequired: false,
  minimumRemnant: Object.freeze({ area: new Dec(MINIMUM_REMNANT.area).toFixed(MINIMUM_REMNANT_PLACES), uom: MINIMUM_REMNANT.uom }),
})

export const isShadeRule = (value: unknown): value is ShadeRule => (SHADE_RULES as readonly unknown[]).includes(value)

/** The row's columns as the API reads them (Decimal or text for the area). */
export interface CuttingRulesRow {
  readonly shadeRule?: string | null
  readonly hidePhotoRequired?: boolean | null
  readonly minimumRemnantArea?: { toString(): string } | string | null
  readonly minimumRemnantUom?: string | null
}

/** A site's rules: its row's, or the defaults for a site without one (a value the rules do not know falls back too). */
export function cuttingRulesOf(row: CuttingRulesRow | null | undefined): CuttingRules {
  if (!row) return DEFAULT_CUTTING_RULES
  const area = row.minimumRemnantArea === null || row.minimumRemnantArea === undefined ? null : row.minimumRemnantArea.toString()
  const uom = row.minimumRemnantUom ?? null
  const minimum = area !== null && uom !== null && isAreaUom(uom) ? { area: new Dec(area).toFixed(MINIMUM_REMNANT_PLACES), uom } : DEFAULT_CUTTING_RULES.minimumRemnant
  return Object.freeze({
    shadeRule: isShadeRule(row.shadeRule) ? row.shadeRule : DEFAULT_CUTTING_RULES.shadeRule,
    hidePhotoRequired: row.hidePhotoRequired ?? DEFAULT_CUTTING_RULES.hidePhotoRequired,
    minimumRemnant: Object.freeze(minimum),
  })
}

/** The minimum in square metres (to compare it with the cap). */
export const minimumInM2 = (minimum: MinimumRemnant): Decimal => areaIn(minimum.area, minimum.uom, 'M2')

export interface CuttingRulesChange {
  readonly shadeRule?: unknown
  readonly hidePhotoRequired?: unknown
  readonly minimumRemnantArea?: unknown
  readonly minimumRemnantUom?: unknown
  readonly reason?: unknown
}

export const CUTTING_REASON_MAX = 500
const AREA_TEXT = /^\d{1,7}(\.\d{1,4})?$/

/** Every reason a change of the cutting rules cannot be applied, at body/<field> (empty when it can). */
export function cuttingRulesChangeProblems(body: CuttingRulesChange): Issue[] {
  const problems: Issue[] = []
  if (body.shadeRule !== undefined && !isShadeRule(body.shadeRule)) problems.push({ path: 'body/shadeRule', message: `The shade rule is one of ${SHADE_RULES.join(', ')}.` })
  if (body.hidePhotoRequired !== undefined && typeof body.hidePhotoRequired !== 'boolean') problems.push({ path: 'body/hidePhotoRequired', message: 'Say true or false.' })
  const hasArea = body.minimumRemnantArea !== undefined
  const hasUom = body.minimumRemnantUom !== undefined
  if (hasArea !== hasUom) problems.push({ path: hasArea ? 'body/minimumRemnantUom' : 'body/minimumRemnantArea', message: 'Give the smallest remnant with its unit.' })
  if (hasUom && (typeof body.minimumRemnantUom !== 'string' || !isAreaUom(body.minimumRemnantUom))) problems.push({ path: 'body/minimumRemnantUom', message: `The unit is one of ${AREA_UOMS.join(', ')}.` })
  if (hasArea) {
    const text = typeof body.minimumRemnantArea === 'string' ? body.minimumRemnantArea.trim() : typeof body.minimumRemnantArea === 'number' ? String(body.minimumRemnantArea) : ''
    if (!AREA_TEXT.test(text) || new Dec(text).lte(0)) problems.push({ path: 'body/minimumRemnantArea', message: 'The smallest remnant is an area above 0, with up to four decimals.' })
    else if (typeof body.minimumRemnantUom === 'string' && isAreaUom(body.minimumRemnantUom) && minimumInM2({ area: text, uom: body.minimumRemnantUom }).gt(MAX_MINIMUM_REMNANT_M2)) {
      problems.push({ path: 'body/minimumRemnantArea', message: 'The smallest remnant is at most 10 m² (a whole hide is 4–6 m²).' })
    }
  }
  if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== 'string' || body.reason.trim().length > CUTTING_REASON_MAX)) problems.push({ path: 'body/reason', message: `A reason of at most ${CUTTING_REASON_MAX} characters.` })
  return problems
}

/** The rules after a change (fields left out stay as they are). Call after cuttingRulesChangeProblems found none. */
export function changedCuttingRules(before: CuttingRules, body: CuttingRulesChange): CuttingRules {
  const minimum =
    body.minimumRemnantArea !== undefined && body.minimumRemnantUom !== undefined
      ? { area: new Dec(String(body.minimumRemnantArea).trim()).toFixed(MINIMUM_REMNANT_PLACES), uom: body.minimumRemnantUom as AreaUom }
      : before.minimumRemnant
  return Object.freeze({
    shadeRule: body.shadeRule !== undefined ? (body.shadeRule as ShadeRule) : before.shadeRule,
    hidePhotoRequired: body.hidePhotoRequired !== undefined ? (body.hidePhotoRequired as boolean) : before.hidePhotoRequired,
    minimumRemnant: Object.freeze(minimum),
  })
}

/** The same minimum: the same unit and the same area (10 and 10.0000 dm² are no change; 0.1 m² is a change of the unit kept). */
export const sameMinimum = (a: MinimumRemnant, b: MinimumRemnant): boolean => a.uom === b.uom && new Dec(a.area).eq(b.area)

/** The fields that differ, in CUTTING_RULE_FIELDS order. */
export function changedCuttingFields(before: CuttingRules, after: CuttingRules): CuttingRuleField[] {
  return CUTTING_RULE_FIELDS.filter((field) => (field === 'minimumRemnant' ? !sameMinimum(before.minimumRemnant, after.minimumRemnant) : before[field] !== after[field]))
}

const SHADE_WORDS: Readonly<Record<ShadeRule, string>> = {
  ORDER: 'one shade lot per order: the reserve and the pick refuse a hide of another shade lot, the cutting table warns',
  GARMENT: 'one shade lot per garment: the cutting table warns when a part would complete a garment from another shade lot',
  OFF: 'no shade check',
}

/** The rules in words (English; the screens have their own words per key). */
export function cuttingRulesWords(rules: CuttingRules): string[] {
  return [
    `Shade: ${SHADE_WORDS[rules.shadeRule]}.`,
    rules.hidePhotoRequired ? 'A photo of the hide on the table is taken before every first cut of a hide.' : 'A photo of the hide before cutting is optional.',
    `A leftover smaller than ${new Dec(rules.minimumRemnant.area).toFixed(2)} ${rules.minimumRemnant.uom === 'M2' ? 'm²' : rules.minimumRemnant.uom === 'DM2' ? 'dm²' : 'ft²'} is waste, not a remnant.`,
  ]
}
