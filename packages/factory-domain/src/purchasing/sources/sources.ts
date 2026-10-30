import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal, isCurrencyCode, QUANTITY, UNIT_PRICE, type CurrencyCode } from '../../core/money'
import { suggestionFor, type SupplyRules, type Suggestion } from '../../planning/buy'
import { baseFactor, convertibleUnits, COST_SCALE, decimalOf, roundTo, type DecimalInput, type ItemUnits, type Uom } from '../../product/units/units'

/**
 * Approved sources (SCM-005; design purchasing.suppliers › Items & prices "Approved sources", Products › material
 * "Supplier prices"; factory-db sourcing.prisma SupplierItem), pure: what a supplier sells us of a material, in which unit,
 * at which price (a cost), with its minimum, its steps and its lead time, and which source a buy takes.
 *
 *   scope       a source holds for one buying company (or every company: no company), one material and one colour of
 *               it (or every colour: no colour). Supplier, company, material and colour never change: another one is a
 *               new source.
 *   one each    a supplier has at most one ACTIVE source per scope (a second is a duplicate), and a scope has at most one
 *               ACTIVE PRIMARY source (making another one PRIMARY makes the first a BACKUP). The database holds neither
 *               (the isolation copy tests need rows without a unique key of ids): apps/factory-api's
 *               modules/purchasing/supplier-items holds both under one lock per material.
 *   archived    a source that is no longer approved is ARCHIVED, never deleted (purchase orders were made from it), and
 *               may be approved again.
 *   unit        the unit the supplier sells in must be one the material converts (its base unit's dimension, or its
 *               purchase or consumption unit), so a purchase order line in that unit counts in the material's base unit
 *               at the material's own factor. A supplier's own average per hide is not kept apart from the material's.
 *   which       a need (company, material, colour) is met by the ACTIVE sources whose scope reaches it; they rank PRIMARY
 *               first, then a colour's own before every colour, then a company's own before every company. The first is
 *               the suggested source; a chosen supplier takes its own best source.
 *   approved    once a material has a source that reaches a need, only its sources' suppliers are approved for it; a
 *               material without any is bought from any supplier, as in W1.
 *   terms       a source's minimum and steps (in its unit) and its lead time (else the supplier's usual one) are the
 *               rules a suggestion follows (planning/buy `suggestionFor`); its price is the line's price when it is in
 *               the order's currency, moved to the line's unit through the base unit.
 *
 * Prices are costs (money.cost; Owner answer C2: never on a supplier screen). Nothing here reads or writes the database.
 */

export const SOURCE_PREFERENCES = ['PRIMARY', 'BACKUP'] as const
export type SourcePreference = (typeof SOURCE_PREFERENCES)[number]

export const SOURCE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type SourceStatus = (typeof SOURCE_STATUSES)[number]

export const SOURCE_TEXT = Object.freeze({ code: 60, description: 300, note: 1000, reason: 500 })
/** Calendar days from the order to the goods at the site (ItemPlanning's bound). */
export const MAX_LEAD_TIME_DAYS = 366

/** Who sells what to whom: the fixed part of a source. */
export interface SourceScope {
  /** null: every company of the tenant. */
  readonly companyId: string | null
  readonly partyId: string
  readonly itemId: string
  /** null: every colour of the material. */
  readonly itemColourId: string | null
}

/** A source as the rules read it. Decimals as plain strings. */
export interface SourceFacts extends SourceScope {
  readonly id: string
  readonly preference: SourcePreference
  readonly status: SourceStatus
  readonly purchaseUom: Uom
  /** Per `purchaseUom`, in `currency`; null: none on record. */
  readonly unitPrice: string | null
  readonly currency: string
  /** In `purchaseUom`. */
  readonly minOrderQty: string | null
  readonly orderMultiple: string | null
  readonly leadTimeDays: number | null
  readonly supplierArticleCode: string | null
  readonly supplierColourCode: string | null
}

/** The fields a person sets on a source, merged with what it holds. */
export interface SourceFields {
  readonly purchaseUom: Uom
  readonly unitPrice: string | null
  readonly currency: string
  readonly minOrderQty: string | null
  readonly orderMultiple: string | null
  readonly leadTimeDays: number | null
  readonly supplierArticleCode: string | null
  readonly supplierColourCode: string | null
  readonly description: string | null
  readonly note: string | null
}

const positive = (value: string): boolean => fitsDecimal(value, QUANTITY.precision, QUANTITY.scale) && decimalOf(value).gt(0)

/** What is wrong with a source's fields for this material; paths are `body/<field>`. */
export function sourceProblems(fields: SourceFields, material: { readonly units: ItemUnits }): Issue[] {
  const problems: Issue[] = []
  if (baseFactor(fields.purchaseUom, material.units) === null) {
    problems.push({ path: 'body/purchaseUom', message: `The material converts ${convertibleUnits(material.units).join(', ')}: the supplier's unit must be one of them.` })
  }
  if (fields.unitPrice !== null && (!fitsDecimal(fields.unitPrice, UNIT_PRICE.precision, UNIT_PRICE.scale) || decimalOf(fields.unitPrice, 'unitPrice').lt(0))) {
    problems.push({ path: 'body/unitPrice', message: 'A price of 0 or more, at most six decimals.' })
  }
  if (!isCurrencyCode(fields.currency)) problems.push({ path: 'body/currency', message: 'Expected an ISO 4217 currency code.' })
  for (const key of ['minOrderQty', 'orderMultiple'] as const) {
    const value = fields[key]
    if (value !== null && !positive(value)) problems.push({ path: `body/${key}`, message: 'Above 0, at most four decimals, in the supplier’s unit.' })
  }
  if (fields.leadTimeDays !== null && (!Number.isSafeInteger(fields.leadTimeDays) || fields.leadTimeDays < 0 || fields.leadTimeDays > MAX_LEAD_TIME_DAYS)) {
    problems.push({ path: 'body/leadTimeDays', message: `Whole days, 0 to ${MAX_LEAD_TIME_DAYS}.` })
  }
  for (const key of ['supplierArticleCode', 'supplierColourCode'] as const) {
    if ((fields[key]?.length ?? 0) > SOURCE_TEXT.code) problems.push({ path: `body/${key}`, message: `At most ${SOURCE_TEXT.code} characters.` })
  }
  if ((fields.description?.length ?? 0) > SOURCE_TEXT.description) problems.push({ path: 'body/description', message: `At most ${SOURCE_TEXT.description} characters.` })
  if ((fields.note?.length ?? 0) > SOURCE_TEXT.note) problems.push({ path: 'body/note', message: `At most ${SOURCE_TEXT.note} characters.` })
  return problems
}

/** The material's factor for the supplier's unit (what SupplierItem.purchaseFactor stores), 8 places; null: not converted. */
export function factorOf(uom: Uom, units: ItemUnits): string | null {
  const factor = baseFactor(uom, units)
  return factor === null ? null : factor.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(8)
}

// ---- one each -----------------------------------------------------------------------------------------------------------

const sameScope = (a: Omit<SourceScope, 'partyId'>, b: Omit<SourceScope, 'partyId'>): boolean =>
  a.companyId === b.companyId && a.itemId === b.itemId && a.itemColourId === b.itemColourId

/** Another ACTIVE source of the same supplier for the same company, material and colour: a duplicate. */
export function duplicateOf(candidate: SourceScope & { readonly id?: string }, others: readonly SourceFacts[]): SourceFacts | null {
  return others.find((other) => other.id !== candidate.id && other.status === 'ACTIVE' && other.partyId === candidate.partyId && sameScope(other, candidate)) ?? null
}

/** The ACTIVE PRIMARY source of the same company, material and colour, other than the candidate. */
export function primaryOf(candidate: Omit<SourceScope, 'partyId'> & { readonly id?: string }, others: readonly SourceFacts[]): SourceFacts | null {
  return others.find((other) => other.id !== candidate.id && other.status === 'ACTIVE' && other.preference === 'PRIMARY' && sameScope(other, candidate)) ?? null
}

// ---- which source a need takes ------------------------------------------------------------------------------------------

/** What is bought: for one company, a material and (when it comes in colours) one colour of it. */
export interface Need {
  readonly companyId: string
  readonly itemId: string
  readonly itemColourId: string | null
}

/** The source's scope reaches the need, and it is ACTIVE. */
export const appliesTo = (source: SourceFacts, need: Need): boolean =>
  source.status === 'ACTIVE' &&
  source.itemId === need.itemId &&
  (source.companyId === null || source.companyId === need.companyId) &&
  (source.itemColourId === null || source.itemColourId === need.itemColourId)

const rank = (source: SourceFacts): number => (source.preference === 'PRIMARY' ? 0 : 4) + (source.itemColourId === null ? 2 : 0) + (source.companyId === null ? 1 : 0)

/** The sources that meet the need, best first (PRIMARY, a colour's own, a company's own; then by id). */
export function rankedSources(sources: readonly SourceFacts[], need: Need): SourceFacts[] {
  return sources.filter((source) => appliesTo(source, need)).sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The source a buy takes: the chosen supplier's best one, else the best of all; null when none meets the need. */
export function sourceFor(sources: readonly SourceFacts[], need: Need, supplierId?: string | null): SourceFacts | null {
  const ranked = rankedSources(sources, need)
  return (supplierId ? ranked.find((source) => source.partyId === supplierId) : ranked[0]) ?? null
}

/** The suppliers approved for the need, best first (none: the material has no source for it yet). */
export function approvedSupplierIds(sources: readonly SourceFacts[], need: Need): string[] {
  return [...new Set(rankedSources(sources, need).map((source) => source.partyId))]
}

/** False when the material has sources for the need and the supplier is not one of theirs. */
export function isApproved(sources: readonly SourceFacts[], need: Need, supplierId: string): boolean {
  const approved = approvedSupplierIds(sources, need)
  return approved.length === 0 || approved.includes(supplierId)
}

// ---- its terms ----------------------------------------------------------------------------------------------------------

/** The rules a suggestion follows from this source: its minimum and steps, its lead time (else the supplier's usual one). */
export function sourceRules(source: Pick<SourceFacts, 'minOrderQty' | 'orderMultiple' | 'leadTimeDays'>, supplierLeadTimeDays: number | null): SupplyRules {
  const lead = source.leadTimeDays ?? supplierLeadTimeDays
  return {
    leadTimeDays: lead !== null && Number.isSafeInteger(lead) && lead >= 0 ? lead : null,
    minOrderQuantity: source.minOrderQty !== null && positive(source.minOrderQty) ? source.minOrderQty : null,
    orderMultiple: source.orderMultiple !== null && positive(source.orderMultiple) ? source.orderMultiple : null,
  }
}

/** The material's units with the supplier's unit as the one it is bought in; null when the material does not convert it. */
export function unitsBoughtIn(units: ItemUnits, uom: Uom): ItemUnits | null {
  const factor = baseFactor(uom, units)
  if (factor === null || factor.lte(0)) return null
  return { ...units, purchaseUom: uom, purchaseFactor: factor.toFixed() }
}

/**
 * What to buy from this source for a net need in the material's base unit: in the source's unit, whole for a unit that
 * comes whole, then its minimum and its steps (planning/buy). null when the material no longer converts the source's unit.
 */
export function buyFromSource(netBase: DecimalInput, units: ItemUnits, source: Pick<SourceFacts, 'purchaseUom' | 'minOrderQty' | 'orderMultiple' | 'leadTimeDays'>, supplierLeadTimeDays: number | null): Suggestion | null {
  const bought = unitsBoughtIn(units, source.purchaseUom)
  return bought === null ? null : suggestionFor(netBase, 'BUY', bought, sourceRules(source, supplierLeadTimeDays))
}

/**
 * The source's price per `uom` (six places, half up), through the base unit: null without a price, in another currency
 * than the order's, or when the material does not convert one of the units.
 */
export function priceIn(source: Pick<SourceFacts, 'unitPrice' | 'currency' | 'purchaseUom'>, uom: Uom, units: ItemUnits, orderCurrency: CurrencyCode): string | null {
  if (source.unitPrice === null || source.currency !== orderCurrency) return null
  const from = baseFactor(source.purchaseUom, units)
  const to = baseFactor(uom, units)
  if (from === null || to === null || from.lte(0)) return null
  return roundTo(decimalOf(source.unitPrice, 'unitPrice').div(from).times(to), { scale: COST_SCALE, rounding: 'HALF_UP' }).toFixed(COST_SCALE)
}
