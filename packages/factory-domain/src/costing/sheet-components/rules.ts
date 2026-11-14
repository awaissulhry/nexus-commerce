import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { isCurrencyCode } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import type { ItemKind } from '../../product/materials/rules'
import { COST_SCALE, decimalOf, decimalText, QUANTITY_SCALE, roundTo, type RoundTo } from '../../product/units/units'
import { defineMachine } from '../../state/machine'

/**
 * The cost sheet's components (B-W2b-418; FIN-003, FIN-006, FIN-008, FIN-009, FIN-011, FIN-020; the tables of B-W2b-378), pure:
 * the inputs a cost sheet reads beyond W1's material, labour and overhead percent, and the rules that choose among them.
 *
 *   leather       a leather article's cost basis (FIN-003): the unit of area it is priced in (ft² or dm²), the expected
 *                 cutting yield and the grade mix of what is bought. The bought area of a garment is its net area ÷
 *                 (yield × Σ share × usable share of each grade): the usable share is the article's own grade rule, else
 *                 the grade's. With a basis the yield takes the place of the BOM line's wastage (counting both would count
 *                 the waste twice); without one the BOM line's area with its wastage stays (W1).
 *   uplifts       what lands on top of a price (FIN-008, FIN-009): freight, duty and insurance percents on one material or a
 *                 kind of material, typed or read from the landed cost of a window of receipts; and a workshop's transport
 *                 out and back per piece.
 *
 * Choosing: a basis or an uplift is ACTIVE with its first day on or before the day costed; the company's own before every
 * company's; for leather a style's own before every style's; for a material its own uplift before its kind's; the newest
 * first day among equals. Every figure is a plain decimal string; costs are rounded once, half up, to 6 places, quantities
 * to 4 (the cost sheet line's columns).
 */

export const COST_ROUND: RoundTo = { scale: COST_SCALE, rounding: 'HALF_UP' }
export const QUANTITY_ROUND: RoundTo = { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }
/** Percents of a basis or an uplift: Decimal(7,4). */
export const PCT_ROUND: RoundTo = { scale: 4, rounding: 'HALF_UP' }

export const six = (value: Decimal): string => decimalText(roundTo(value, COST_ROUND))
export const four = (value: Decimal): string => decimalText(roundTo(value, QUANTITY_ROUND))
/** A line's cost: its quantity × its unit cost, rounded once to 6 places (the database checks the same). */
export const lineCost = (quantity: string, unitCost: string): string => six(decimalOf(quantity).times(decimalOf(unitCost)))

/** ACTIVE → ARCHIVED, final (a new figure from a later day is a new row). */
export const COMPONENT_INPUT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type ComponentInputStatus = (typeof COMPONENT_INPUT_STATUSES)[number]
export const componentInputMachine = defineMachine({ name: 'costInput', states: COMPONENT_INPUT_STATUSES, transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: [] } })

// ---- leather (FIN-003) ------------------------------------------------------------------------------------------------

export const AREA_UNITS = ['FT2', 'DM2'] as const
export type AreaUnit = (typeof AREA_UNITS)[number]

/** The key of a basis (B-W2b-378's guard): `leather:<item>:<style | all>:<company | all>`. */
export const leatherKey = (itemId: string, styleId: string | null, companyId: string | null): string => `leather:${itemId}:${styleId ?? 'all'}:${companyId ?? 'all'}`

/** A grade mix: grade code → its share of what is bought, percent with at most 4 decimals, totalling exactly 100. */
export type GradeMix = Readonly<Record<string, string>>

export interface LeatherBasisFacts {
  readonly id: string
  readonly companyId: string | null
  readonly itemId: string
  readonly styleId: string | null
  readonly areaUnit: AreaUnit
  readonly expectedYieldPct: string
  readonly gradeMix: GradeMix
  readonly validFrom: BusinessDate
  readonly status: ComponentInputStatus
}

const SHARE = /^\d{1,3}(\.\d{1,4})?$/

/** The shape of a yield and a grade mix (the database checks the grades against the tenant's active ones). */
export function leatherBasisProblems(values: { readonly expectedYieldPct?: string | undefined; readonly gradeMix?: Readonly<Record<string, string>> | undefined }, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (values.expectedYieldPct !== undefined) {
    const yieldPct = SHARE.test(values.expectedYieldPct) ? new Decimal(values.expectedYieldPct) : null
    if (yieldPct === null || yieldPct.lte(0) || yieldPct.gt(100)) problems.push({ path: `${at}/expectedYieldPct`, message: 'The expected cutting yield is a percent above 0 and at most 100, with at most 4 decimals.' })
  }
  if (values.gradeMix !== undefined) {
    const entries = Object.entries(values.gradeMix)
    if (entries.length < 1 || entries.length > 20) problems.push({ path: `${at}/gradeMix`, message: 'A grade mix names 1 to 20 grades.' })
    const bad = entries.filter(([, share]) => !SHARE.test(share) || new Decimal(share).lte(0))
    for (const [code] of bad) problems.push({ path: `${at}/gradeMix/${code}`, message: 'A grade’s share is a percent above 0 with at most 4 decimals.' })
    if (bad.length === 0 && entries.length > 0) {
      const sum = entries.reduce((total, [, share]) => total.plus(share), new Decimal(0))
      if (!sum.eq(100)) problems.push({ path: `${at}/gradeMix`, message: `The shares of a grade mix total exactly 100 (these total ${decimalText(sum)}).` })
    }
  }
  return problems
}

/** A grade mix as stored: codes in capitals, shares with 4 decimals. */
export const gradeMixOf = (mix: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(mix).map(([code, share]) => [code.trim().toUpperCase(), new Decimal(share).toFixed(4)]))

/** Which rows hold on a day: ACTIVE, first day on or before it. */
const holdsOn = (row: { readonly status: ComponentInputStatus; readonly validFrom: BusinessDate }, on: BusinessDate): boolean => row.status === 'ACTIVE' && row.validFrom <= on

function newest<Row extends { readonly validFrom: BusinessDate; readonly id: string }>(rows: readonly Row[]): Row | null {
  return rows.reduce<Row | null>((best, row) => (best === null || row.validFrom > best.validFrom || (row.validFrom === best.validFrom && row.id > best.id) ? row : best), null)
}

/**
 * The basis a garment of `styleId` for `companyId` takes for a leather article on `on`: the most specific one in force —
 * the company's for the style, the company's for every style, every company's for the style, every company's for every
 * style — the newest of each.
 */
export function pickLeatherBasis(bases: readonly LeatherBasisFacts[], itemId: string, styleId: string, companyId: string | null, on: BusinessDate): LeatherBasisFacts | null {
  const live = bases.filter((basis) => basis.itemId === itemId && holdsOn(basis, on))
  const ranks: { readonly companyId: string | null; readonly styleId: string | null }[] = [
    ...(companyId === null ? [] : [{ companyId, styleId }, { companyId, styleId: null }]),
    { companyId: null, styleId },
    { companyId: null, styleId: null },
  ]
  for (const rank of ranks) {
    const found = newest(live.filter((basis) => basis.companyId === rank.companyId && basis.styleId === rank.styleId))
    if (found) return found
  }
  return null
}

/** A grade's usable share for an article: its own rule (active), else the grade's. */
export interface GradeShares {
  /** grade code → the grade's usable share, percent (active grades only). */
  readonly grades: ReadonlyMap<string, string>
  /** grade code → the article's own usable share, percent (active rules only). */
  readonly itemRules: ReadonlyMap<string, string>
}

/**
 * The share of a bought hide area that is usable for the article: Σ share ÷ 100 × usable ÷ 100 over the mix. A grade of the
 * mix the tenant no longer has active is listed (`unknown`): the factor is then null (never a guess).
 */
export function usableFactor(mix: GradeMix, shares: GradeShares): { readonly factor: Decimal | null; readonly unknown: readonly string[] } {
  const unknown: string[] = []
  let factor = new Decimal(0)
  for (const [code, share] of Object.entries(mix)) {
    const usable = shares.itemRules.get(code) ?? shares.grades.get(code)
    if (usable === undefined) {
      unknown.push(code)
      continue
    }
    factor = factor.plus(new Decimal(share).div(100).times(new Decimal(usable).div(100)))
  }
  return { factor: unknown.length > 0 || factor.lte(0) ? null : factor, unknown }
}

/** The area bought for a net area (in any unit): net ÷ (yield ÷ 100 × usable factor), exact. */
export const boughtArea = (net: Decimal, yieldPct: string, factor: Decimal): Decimal => net.div(new Decimal(yieldPct).div(100).times(factor))

// ---- uplifts (FIN-008, FIN-009) ---------------------------------------------------------------------------------------

export const UPLIFT_TARGETS = ['MATERIAL', 'CATEGORY', 'WORKSHOP'] as const
export type UpliftTarget = (typeof UPLIFT_TARGETS)[number]
export const UPLIFT_SOURCES = ['TYPED', 'LANDED_COST'] as const
export type UpliftSource = (typeof UPLIFT_SOURCES)[number]
/** Which percent of an uplift a landed cost fills (a supplier's charge line has no freight / duty split). */
export const LANDED_AS = ['FREIGHT', 'DUTY', 'INSURANCE'] as const
export type LandedAs = (typeof LANDED_AS)[number]

/** The key of an uplift (B-W2b-378's guard). */
export function upliftKey(companyId: string | null, target: { readonly target: UpliftTarget; readonly itemId?: string | null; readonly itemKind?: ItemKind | null; readonly partyId?: string | null }): string {
  const company = companyId ?? 'all'
  if (target.target === 'MATERIAL') return `uplift:${company}:item:${target.itemId}`
  if (target.target === 'CATEGORY') return `uplift:${company}:kind:${target.itemKind}`
  return `uplift:${company}:workshop:${target.partyId}`
}

export interface UpliftFacts {
  readonly id: string
  readonly companyId: string | null
  readonly target: UpliftTarget
  readonly itemId: string | null
  readonly itemKind: ItemKind | null
  readonly partyId: string | null
  readonly source: UpliftSource
  readonly freightPct: string | null
  readonly dutyPct: string | null
  readonly insurancePct: string | null
  readonly transportOutPerPiece: string | null
  readonly transportBackPerPiece: string | null
  readonly currency: string | null
  readonly validFrom: BusinessDate
  readonly status: ComponentInputStatus
}

/** The uplift a material takes: the company's own for the material, every company's for it, the company's for its kind, every company's for its kind. */
export function pickMaterialUplift(uplifts: readonly UpliftFacts[], material: { readonly itemId: string; readonly kind: ItemKind }, companyId: string | null, on: BusinessDate): UpliftFacts | null {
  const live = uplifts.filter((uplift) => holdsOn(uplift, on))
  const ranks: ((uplift: UpliftFacts) => boolean)[] = [
    ...(companyId === null ? [] : [(uplift: UpliftFacts) => uplift.companyId === companyId && uplift.target === 'MATERIAL' && uplift.itemId === material.itemId]),
    (uplift) => uplift.companyId === null && uplift.target === 'MATERIAL' && uplift.itemId === material.itemId,
    ...(companyId === null ? [] : [(uplift: UpliftFacts) => uplift.companyId === companyId && uplift.target === 'CATEGORY' && uplift.itemKind === material.kind]),
    (uplift) => uplift.companyId === null && uplift.target === 'CATEGORY' && uplift.itemKind === material.kind,
  ]
  for (const rank of ranks) {
    const found = newest(live.filter(rank))
    if (found) return found
  }
  return null
}

/** The transport a workshop's operations take: the company's own, else every company's. */
export function pickWorkshopUplift(uplifts: readonly UpliftFacts[], partyId: string, companyId: string | null, on: BusinessDate): UpliftFacts | null {
  const live = uplifts.filter((uplift) => holdsOn(uplift, on) && uplift.target === 'WORKSHOP' && uplift.partyId === partyId)
  return (companyId === null ? null : newest(live.filter((uplift) => uplift.companyId === companyId))) ?? newest(live.filter((uplift) => uplift.companyId === null))
}

/** A percent of an uplift: 0 to 100 with at most 4 decimals. */
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/
const percentOk = (value: string): boolean => PERCENT.test(value) && new Decimal(value).lte(100)
const COST = /^\d{1,12}(\.\d{1,6})?$/

/** The figures of an uplift for its target (the database holds the same rules). */
export function upliftFigureProblems(
  target: UpliftTarget,
  figures: { readonly freightPct?: string | null; readonly dutyPct?: string | null; readonly insurancePct?: string | null; readonly transportOutPerPiece?: string | null; readonly transportBackPerPiece?: string | null; readonly currency?: string | null },
  at = 'body',
): Issue[] {
  const problems: Issue[] = []
  const percents = (['freightPct', 'dutyPct', 'insurancePct'] as const).filter((field) => figures[field] !== undefined && figures[field] !== null)
  const transports = (['transportOutPerPiece', 'transportBackPerPiece'] as const).filter((field) => figures[field] !== undefined && figures[field] !== null)
  if (target === 'WORKSHOP') {
    if (percents.length > 0) problems.push({ path: `${at}/${percents[0]}`, message: 'A workshop’s uplift is its transport out and back per piece: no percent.' })
    if (transports.length === 0) problems.push({ path: `${at}/transportOutPerPiece`, message: 'Give the transport out, back, or both, per piece.' })
    for (const field of transports) if (!COST.test(figures[field]!)) problems.push({ path: `${at}/${field}`, message: 'A transport per piece is 0 or more, with at most 12 digits and 6 decimals.' })
    if (!figures.currency || !isCurrencyCode(figures.currency)) problems.push({ path: `${at}/currency`, message: 'A transport per piece has its ISO 4217 currency.' })
  } else {
    if (transports.length > 0) problems.push({ path: `${at}/${transports[0]}`, message: 'A material’s uplift is a freight, duty or insurance percent: no transport.' })
    if (figures.currency) problems.push({ path: `${at}/currency`, message: 'Percents have no currency.' })
    for (const field of percents) if (!percentOk(figures[field]!)) problems.push({ path: `${at}/${field}`, message: 'A percent is 0 to 100, with at most 4 decimals.' })
  }
  return problems
}

/**
 * The landed cost of a window of receipts as a percent of what was received (FIN-009 "from actual landed cost"): the posted
 * landed shares on the lots ÷ the lots' received value × 100, rounded once to 4 places. Null when nothing was received.
 */
export function landedPct(landedMinor: number, receivedMinor: number): string | null {
  if (receivedMinor <= 0) return null
  return decimalText(roundTo(new Decimal(landedMinor).div(receivedMinor).times(100), PCT_ROUND))
}

// ---- piece-rate labour (FIN-006) --------------------------------------------------------------------------------------

/** The site whose piece rates a sheet reads: the one named, else the only site of the company paying piece rates that day. */
export function pieceRateSite(paying: readonly string[], named: string | null): { readonly siteId: string | null; readonly problem: 'NOT_PAYING' | 'SEVERAL_SITES' | 'NO_SITE' | null } {
  if (named !== null) return paying.includes(named) ? { siteId: named, problem: null } : { siteId: null, problem: 'NOT_PAYING' }
  if (paying.length === 1) return { siteId: paying[0]!, problem: null }
  return { siteId: null, problem: paying.length === 0 ? 'NO_SITE' : 'SEVERAL_SITES' }
}

// ---- words ------------------------------------------------------------------------------------------------------------

/** What the components could not cost: never a 0, the sheet says it and is not complete. */
export const COMPONENT_MISSING = [
  'NO_BOM',
  'BOM_QUANTITY',
  'MATERIAL_UNIT',
  'MATERIAL_PRICE',
  'MATERIAL_CURRENCY',
  'NO_ROUTING',
  'LABOUR_RATE',
  'LABOUR_CURRENCY',
  'LEATHER_GRADE',
  'LEATHER_UNIT',
  'PIECE_RATE_CURRENCY',
  'SUBCONTRACT_FEE',
  'SUBCONTRACT_CURRENCY',
  'TRANSPORT_CURRENCY',
  'PACKAGING_PRICE',
  'CARTON_PIECES',
  'OVERHEAD_FIGURE',
] as const
export type ComponentMissing = (typeof COMPONENT_MISSING)[number]

/** What the components cost but a person should know (the sheet stays complete). */
export const COMPONENT_WARNINGS = [
  'NO_WRITTEN_TERMS',
  'NO_TRANSPORT',
  'NO_PIECE_RATE',
  'PIECE_RATE_SITE',
  'PACKAGING_TWICE',
  'OVERHEAD_TWICE',
  'NO_LEATHER_BASIS',
] as const
export type ComponentWarning = (typeof COMPONENT_WARNINGS)[number]

export const PIECE_RATE_SITE_WORDS: Readonly<Record<'NOT_PAYING' | 'SEVERAL_SITES' | 'NO_SITE', string>> = Object.freeze({
  NOT_PAYING: 'The site named does not pay piece rates today: the labour is costed by its minutes.',
  SEVERAL_SITES: 'Several sites of the company pay piece rates: name the site to cost its rates; until then the labour is costed by its minutes.',
  NO_SITE: 'Piece-rate labour is on, but no site of the company pays piece rates today: the labour is costed by its minutes.',
})

/** The refusals of the components' commands (409 `refusal/<CODE>`, the words from the code). */
export const COMPONENT_REFUSALS = ['NOT_DRAFT', 'INCOMPLETE', 'NO_COMPANY', 'ARCHIVED', 'NOTHING_CHANGES', 'START_TAKEN', 'NO_RECEIPTS', 'PIECE_PAY_OFF', 'DATABASE'] as const
export type ComponentRefusal = (typeof COMPONENT_REFUSALS)[number]

export const COMPONENT_REFUSAL_WORDS: Readonly<Record<Exclude<ComponentRefusal, 'DATABASE' | 'INCOMPLETE'>, string>> = Object.freeze({
  NOT_DRAFT: 'Only a draft cost sheet takes new lines: an approved sheet is locked and a change is a new version.',
  NO_COMPANY: 'A cost sheet is costed for one company: name the company (the style is every company’s).',
  ARCHIVED: 'It is archived: a new figure is a new row from its first day.',
  NOTHING_CHANGES: 'Nothing changes: every value sent is the one it has.',
  START_TAKEN: 'Another row of the same material, style, company or workshop starts on that day: choose another first day, or correct that one.',
  NO_RECEIPTS: 'No receipt of that material or kind was valued in those days: there is no landed cost to read a percent from.',
  PIECE_PAY_OFF: 'Piece-rate labour is switched on only while a site of the company pays piece rates (GATE-PIECE-PAY): start piece pay there first.',
})

/** The words of an incomplete sheet that was not written. */
export const incompleteWords = (count: number): string =>
  `${count} input${count === 1 ? ' is' : 's are'} missing: the lines would leave ${count === 1 ? 'it' : 'them'} out. Complete ${count === 1 ? 'it' : 'them'}, or write the lines leaving ${count === 1 ? 'it' : 'them'} out (the sheet keeps the list).`

/** UNVERIFIED (GATE-ACCOUNTANT): what a cost sheet's components change. */
export const COMPONENTS_UNVERIFIED =
  'UNVERIFIED (GATE-ACCOUNTANT): the bought leather area, freight and duty, transport, packaging and overhead on a cost sheet are an estimate; they change no posted cost until a person freezes a standard from an approved sheet.'

/** Why piece-rate labour is costed or not, in words. */
export function pieceRateWords(on: boolean, sites: number): string {
  if (!on) return 'Piece-rate labour is off: labour is costed by its standard minutes at the cost per minute (GATE-PIECE-PAY).'
  return sites === 0
    ? 'Piece-rate labour is on, but no site of the company pays piece rates now: labour is costed by its minutes.'
    : 'Piece-rate labour is on: an operation with a published piece rate is costed at its rate per piece (per operation, never per worker).'
}
