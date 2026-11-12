import type { Issue } from '../../core/errors'
import { businessDate, businessDayRange, isBusinessDate, type BusinessDate } from '../../core/time'
import { daysFrom, plusDays } from '../../calendars/dates'
import { ITEM_KINDS } from '../../product/materials/rules'
import { dimensionOf, fixedRatio, type Uom } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import type { StockMoveReason } from '../ledger/moves'

/**
 * Warehouse reports (B-W2b-356; design warehouse.reports SCR-257: wr-ageing, wr-leather, pop:wr-arrange, tab:wr-tab-print), the
 * rules of the figures, pure. The API reads the stock ledger (StockMove, its StockValuation, the lots) and folds it here; nothing
 * is copied from the ledger's rules: a balance is the moves' sum, a value the ledger's own valuation, never recomputed.
 *
 *   stock ageing     what lies in stock at the end of the period, by material type (the item's kind) and age bucket (0–90,
 *                    91–180, 181–365 days, over a year). A lot (or a hide of it) is as old as the lot: its received day, else
 *                    its first move into stock (opening stock). An untracked article is aged first in, first out: what is on
 *                    hand is the latest that came in, each part as old as the move that brought it. Quantities are summed per
 *                    unit, never across units (a fixed factor turns ft² into m², cm into m, a pair into two pieces); the share
 *                    of each bucket and the average age need one unit. The value of a stock key is the ledger's (the sum of its
 *                    moves' valuations), shared among its parts by quantity; values only with the cost grain.
 *   leather use      per article (leather item and colour) and supplier lot (a split lot's children count with their parent,
 *                    B-W2b-313), the moves of the period by what they did: received (from a supplier), issued to work orders,
 *                    back whole, back as a remnant, scrapped, anything else (opening stock, adjustments, counts, transfers
 *                    between sites, returns to the supplier); cut = issued less what came back whole or as a remnant; on hand
 *                    at the start and at the end. It adds up: start + received − cut − scrapped + other = end.
 */

export const REPORT_LIMITS = Object.freeze({
  /** The longest period one read covers, in days (both ends included). */
  maxDays: 366,
  /** The first day a report reads. */
  firstDay: '2020-01-01',
  /** At most this many articles per material type in the ageing answer (the largest first; `more` counts the rest). */
  articlesPerType: 50,
  /** At most this many supplier lots in the leather answer (`more` counts the rest). */
  leatherLots: 500,
})

/** The design's age buckets ("0–90, 91–180, 181–365, over a year"), youngest first. */
export const AGE_BUCKETS = ['d0to90', 'd91to180', 'd181to365', 'overYear'] as const
export type AgeBucket = (typeof AGE_BUCKETS)[number]

/** The days each bucket holds, both ends included; null: no end. */
export const AGE_BUCKET_DAYS: Readonly<Record<AgeBucket, readonly [number, number | null]>> = Object.freeze({
  d0to90: [0, 90],
  d91to180: [91, 180],
  d181to365: [181, 365],
  overYear: [366, null],
})

/** The bucket of an age in days (an age below 0, a move dated after the day, counts as 0). */
export function bucketOf(days: number): AgeBucket {
  if (days <= 90) return 'd0to90'
  if (days <= 180) return 'd91to180'
  if (days <= 365) return 'd181to365'
  return 'overYear'
}

/** The material types the ageing shows (the item kinds, finished garments last), in that order. */
export const MATERIAL_TYPES = [...ITEM_KINDS, 'FINISHED'] as const
export type MaterialType = (typeof MATERIAL_TYPES)[number]

/** What a leather move did (wr-leather), in the table's order. */
export const LEATHER_FLOWS = ['received', 'issued', 'returned', 'remnant', 'scrapped', 'other'] as const
export type LeatherFlow = (typeof LEATHER_FLOWS)[number]

// ---- the period ---------------------------------------------------------------------------------------------------------------

export interface Period {
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The first day of a day's month. */
export const monthStart = (day: BusinessDate): BusinessDate => `${day.slice(0, 7)}-01`

/**
 * The period asked, else this month so far (the monthly stock review: from the 1st to today); a lone `from` runs to today, a
 * lone `to` starts on the 1st of its month.
 */
export function periodOf(query: { readonly from?: string | undefined; readonly to?: string | undefined }, today: BusinessDate): Period {
  const to = query.to ?? today
  const from = query.from ?? (isBusinessDate(to) ? monthStart(to) : monthStart(today))
  return { from, to }
}

/** A period the report reads: real days, the end on or after the start, not after today, at most 366 days, from 2020. */
export function periodProblems(period: Period, today: BusinessDate): Issue[] {
  if (!isBusinessDate(period.from)) return [{ path: 'querystring/from', message: 'Give the first day as YYYY-MM-DD.' }]
  if (!isBusinessDate(period.to)) return [{ path: 'querystring/to', message: 'Give the last day as YYYY-MM-DD.' }]
  if (period.to < period.from) return [{ path: 'querystring/to', message: 'The period ends before it starts.' }]
  if (period.to > today) return [{ path: 'querystring/to', message: 'A report reads what was recorded: the period cannot end after today.' }]
  if (period.from < REPORT_LIMITS.firstDay) return [{ path: 'querystring/from', message: `A report starts on ${REPORT_LIMITS.firstDay} or later.` }]
  if (daysFrom(period.from, period.to) + 1 > REPORT_LIMITS.maxDays) return [{ path: 'querystring/from', message: `A report covers at most ${REPORT_LIMITS.maxDays} days.` }]
  return []
}

/** The instants of a period in Rome: from the start of its first day to the end of its last (exclusive). */
export function spanOf(period: Period): { readonly start: Date; readonly end: Date } {
  return { start: businessDayRange(period.from).start, end: businessDayRange(period.to).end }
}

/** The previous calendar month of a day (the band's "Last month"). */
export function lastMonthOf(today: BusinessDate): Period {
  const end = plusDays(monthStart(today), -1)
  return { from: monthStart(end), to: end }
}

// ---- units --------------------------------------------------------------------------------------------------------------------

/** The unit a quantity is summed in: its dimension's reference (m², m, pieces, kg, l), else its own (hides, rolls, cones…). */
export function referenceUnitOf(uom: Uom): Uom {
  switch (dimensionOf(uom)) {
    case 'AREA':
      return 'M2'
    case 'LENGTH':
      return 'M'
    case 'COUNT':
      return 'PCS'
    case 'MASS':
      return 'KG'
    case 'VOLUME':
      return 'L'
    default:
      return uom
  }
}

/** A quantity in its reference unit (exact: the fixed factor). */
export function inReferenceUnit(quantity: DecimalInput, uom: Uom): { readonly quantity: Decimal; readonly uom: Uom } {
  const unit = referenceUnitOf(uom)
  const ratio = fixedRatio(uom, unit) ?? new Dec(1)
  return { quantity: new Dec(quantity).times(ratio), uom: unit }
}

/** A quantity as the API writes it: four places. */
export const quantityText = (value: Decimal): string => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)

/** part / whole as a percent with one decimal ("42.5"); null when there is nothing to count (never 0 for nothing). */
export function pct(part: Decimal, whole: Decimal): string | null {
  if (!whole.greaterThan(0)) return null
  return part.div(whole).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

// ---- ageing ---------------------------------------------------------------------------------------------------------------------

/** A move into stock of an untracked article: when, and how much (base unit). */
export interface InLayer {
  readonly at: Date
  readonly quantity: DecimalInput
}

/** A part of what is on hand and when it came in (null: no move says, which a consistent ledger never leaves). */
export interface AgeSlice {
  readonly at: Date | null
  readonly quantity: Decimal
}

/**
 * First in, first out: the quantity on hand is the latest that came in. The moves into stock are taken newest first until the
 * quantity is covered (the oldest of them in part); anything not covered by a move into stock has no date.
 */
export function fifoSlices(onHand: DecimalInput, ins: readonly InLayer[]): AgeSlice[] {
  let left = new Dec(onHand)
  if (!left.greaterThan(0)) return []
  const out: AgeSlice[] = []
  for (const layer of [...ins].sort((a, b) => b.at.getTime() - a.at.getTime())) {
    if (!left.greaterThan(0)) break
    const quantity = new Dec(layer.quantity)
    if (!quantity.greaterThan(0)) continue
    const taken = Dec.min(quantity, left)
    out.push({ at: layer.at, quantity: taken })
    left = left.minus(taken)
  }
  if (left.greaterThan(0)) out.push({ at: null, quantity: left })
  return out
}

/** Whole days from the day a part came in (in Rome) to the day of the report; never below 0. */
export const ageDays = (at: Date, asOf: BusinessDate): number => Math.max(0, daysFrom(businessDate(at), asOf))

/** One stock key on hand at the end of the period: an article (and colour), a lot or a hide, at a site. */
export interface AgeingPosition {
  readonly itemId: string
  readonly kind: MaterialType
  /** The article's base unit (the moves' base quantities). */
  readonly uom: Uom
  readonly onHand: DecimalInput
  /** The ledger's value of the key, minor units; null: not valued (customer-owned stock, or no move valued). */
  readonly value: number | null
  readonly currency: string | null
  /** Lot-tracked (a lot or a hide of it): the lot's received day, else its first move into stock. */
  readonly lotSince: Date | null
  readonly tracked: boolean
  /** Untracked: its moves into stock up to the end of the period. */
  readonly ins: readonly InLayer[]
}

export interface PositionSlice {
  /** null: no move says when it came in. */
  readonly bucket: AgeBucket | null
  readonly days: number | null
  readonly quantity: Decimal
  /** Its share of the key's value (minor units; the last part takes the rounding), null when the key has none. */
  readonly value: number | null
}

/** A key's parts by age: a lot whole at its age, an untracked article first in, first out; the value shared by quantity. */
export function slicesOf(position: AgeingPosition, asOf: BusinessDate): PositionSlice[] {
  const onHand = new Dec(position.onHand)
  if (!onHand.greaterThan(0)) return []
  const parts: AgeSlice[] = position.tracked
    ? [{ at: position.lotSince ?? oldest(position.ins), quantity: onHand }]
    : fifoSlices(onHand, position.ins)
  let valueLeft = position.value
  return parts.map((part, index) => {
    const days = part.at === null ? null : ageDays(part.at, asOf)
    let value: number | null = null
    if (position.value !== null && valueLeft !== null) {
      value = index === parts.length - 1 ? valueLeft : Number.parseInt(part.quantity.div(onHand).times(position.value).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10)
      valueLeft -= value
    }
    return { bucket: days === null ? null : bucketOf(days), days, quantity: part.quantity, value }
  })
}

const oldest = (ins: readonly InLayer[]): Date | null => ins.reduce<Date | null>((first, layer) => (first === null || layer.at.getTime() < first.getTime() ? layer.at : first), null)

/** Quantities per unit (never across units), as the API writes them. */
export interface UnitQuantity {
  readonly uom: Uom
  readonly quantity: string
}

class Quantities {
  private readonly byUnit = new Map<Uom, Decimal>()
  add(quantity: Decimal, uom: Uom): void {
    const reference = inReferenceUnit(quantity, uom)
    this.byUnit.set(reference.uom, (this.byUnit.get(reference.uom) ?? ZERO).plus(reference.quantity))
  }
  get units(): number {
    return this.byUnit.size
  }
  /** The one unit's total, or null with several units (or none). */
  get single(): { uom: Uom; quantity: Decimal } | null {
    if (this.byUnit.size !== 1) return null
    const [uom, quantity] = [...this.byUnit.entries()][0]!
    return { uom, quantity }
  }
  list(): UnitQuantity[] {
    return [...this.byUnit.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([uom, quantity]) => ({ uom, quantity: quantityText(quantity) }))
  }
}

class Values {
  private amount = 0
  private readonly currencies = new Set<string>()
  /** Parts without a value (customer-owned, or not valued yet). */
  unvalued = 0
  add(value: number | null, currency: string | null): void {
    if (value === null) {
      this.unvalued += 1
      return
    }
    this.amount += value
    if (currency) this.currencies.add(currency)
  }
  /** The sum, or null when there is none or several currencies. */
  get value(): number | null {
    if (this.currencies.size > 1) return null
    return this.amount
  }
  get currency(): string | null {
    return this.currencies.size === 1 ? [...this.currencies][0]! : null
  }
  get mixedCurrencies(): boolean {
    return this.currencies.size > 1
  }
}

export interface BucketFigures {
  readonly quantities: readonly UnitQuantity[]
  /** Minor units; null: several currencies. */
  readonly value: number | null
  /** The bucket's share of the group's quantity, one decimal; null with several units or nothing. */
  readonly share: string | null
}

export interface AgeingFigures {
  readonly buckets: Readonly<Record<AgeBucket, BucketFigures>>
  /** What no move dates (never on a consistent ledger). */
  readonly undated: readonly UnitQuantity[]
  /** Everything of the group (named `whole`: a name like a money total is a money field to the contracts' guard). */
  readonly whole: { readonly quantities: readonly UnitQuantity[]; readonly value: number | null }
  readonly currency: string | null
  readonly mixedCurrencies: boolean
  /** Parts without a value (customer-owned stock, or not valued yet). */
  readonly unvalued: number
  /** The average age weighted by quantity, one decimal; null with several units or nothing dated. */
  readonly averageDays: string | null
  readonly oldestDays: number | null
  /** The stock keys counted (lots, hides, untracked articles by colour). */
  readonly keys: number
}

/** Fold slices of a group (a material type, an article) into its figures. */
export function figuresOf(slices: readonly { readonly slice: PositionSlice; readonly uom: Uom; readonly currency: string | null }[], keys: number): AgeingFigures {
  const per = Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket, { quantities: new Quantities(), values: new Values() }])) as Record<AgeBucket, { quantities: Quantities; values: Values }>
  const undated = new Quantities()
  const total = new Quantities()
  const values = new Values()
  let weighted = ZERO
  let dated = ZERO
  let oldestDays: number | null = null
  for (const { slice, uom, currency } of slices) {
    total.add(slice.quantity, uom)
    values.add(slice.value, currency)
    if (slice.bucket === null || slice.days === null) {
      undated.add(slice.quantity, uom)
      continue
    }
    per[slice.bucket].quantities.add(slice.quantity, uom)
    per[slice.bucket].values.add(slice.value, currency)
    const reference = inReferenceUnit(slice.quantity, uom).quantity
    weighted = weighted.plus(reference.times(slice.days))
    dated = dated.plus(reference)
    oldestDays = oldestDays === null ? slice.days : Math.max(oldestDays, slice.days)
  }
  const one = total.single
  const figuresOfBucket = (bucket: AgeBucket): BucketFigures => {
    const part = per[bucket]
    const mine = part.quantities.single
    const share = one !== null && (part.quantities.units === 0 || (mine !== null && mine.uom === one.uom)) ? pct(mine?.quantity ?? ZERO, one.quantity) : null
    return { quantities: part.quantities.list(), value: values.mixedCurrencies ? null : part.values.value, share }
  }
  const buckets: Record<AgeBucket, BucketFigures> = { d0to90: figuresOfBucket('d0to90'), d91to180: figuresOfBucket('d91to180'), d181to365: figuresOfBucket('d181to365'), overYear: figuresOfBucket('overYear') }
  return {
    buckets,
    undated: undated.list(),
    whole: { quantities: total.list(), value: values.value },
    currency: values.currency,
    mixedCurrencies: values.mixedCurrencies,
    unvalued: values.unvalued,
    averageDays: one && dated.greaterThan(0) ? weighted.div(dated).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) : null,
    oldestDays,
    keys,
  }
}

// ---- leather use --------------------------------------------------------------------------------------------------------------

/** What a move of a leather article did: by its reason (a reversal carries its move's reason and the other direction). */
export function flowOf(reason: StockMoveReason): LeatherFlow {
  switch (reason) {
    case 'RECEIPT':
      return 'received'
    case 'ISSUE':
      return 'issued'
    case 'RETURN':
      return 'returned'
    case 'REMNANT':
      return 'remnant'
    case 'SCRAP':
      return 'scrapped'
    default:
      return 'other'
  }
}

/** The direction a flow counts in: received, back whole, back as a remnant and other count what came IN; issued and scrapped what went OUT. */
export const FLOW_SIGN: Readonly<Record<LeatherFlow, 1 | -1>> = Object.freeze({ received: 1, issued: -1, returned: 1, remnant: 1, scrapped: -1, other: 1 })

/** The moves of one reason and direction in the period, summed (base unit; value: minor units, signed + into stock). */
export interface FlowSum {
  readonly reason: StockMoveReason
  readonly direction: 'IN' | 'OUT'
  readonly quantity: DecimalInput
  readonly value: number | null
}

export interface LeatherFigures {
  readonly start: Decimal
  readonly received: Decimal
  readonly issued: Decimal
  readonly returned: Decimal
  readonly remnant: Decimal
  /** Issued less what came back whole or as a remnant. */
  readonly cut: Decimal
  readonly scrapped: Decimal
  readonly other: Decimal
  readonly end: Decimal
  /** start + received − cut − scrapped + other = end (it always does on the ledger: a check, never assumed). */
  readonly addsUp: boolean
  readonly values: {
    readonly start: number | null
    readonly received: number | null
    readonly cut: number | null
    readonly scrapped: number | null
    readonly end: number | null
  }
}

/**
 * One group's leather figures (a supplier lot, an article): the balance before the period, the period's moves by reason and
 * direction, the balance at its end. Values (signed + into stock, minor units) are the ledger's; null where a move has none.
 */
export function leatherFiguresOf(
  start: { readonly quantity: DecimalInput; readonly value: number | null },
  flows: readonly FlowSum[],
  end: { readonly quantity: DecimalInput; readonly value: number | null },
): LeatherFigures {
  const sums = Object.fromEntries(LEATHER_FLOWS.map((flow) => [flow, ZERO])) as Record<LeatherFlow, Decimal>
  const valueSums = Object.fromEntries(LEATHER_FLOWS.map((flow) => [flow, 0 as number | null])) as Record<LeatherFlow, number | null>
  for (const row of flows) {
    const flow = flowOf(row.reason)
    const signed = row.direction === 'IN' ? new Dec(row.quantity) : new Dec(row.quantity).negated()
    sums[flow] = sums[flow].plus(signed.times(FLOW_SIGN[flow]))
    const current = valueSums[flow]
    valueSums[flow] = current === null || row.value === null ? null : current + row.value * FLOW_SIGN[flow]
  }
  const cut = sums.issued.minus(sums.returned).minus(sums.remnant)
  const startQuantity = new Dec(start.quantity)
  const endQuantity = new Dec(end.quantity)
  const cutValue = valueSums.issued === null || valueSums.returned === null || valueSums.remnant === null ? null : valueSums.issued - valueSums.returned - valueSums.remnant
  return {
    start: startQuantity,
    received: sums.received,
    issued: sums.issued,
    returned: sums.returned,
    remnant: sums.remnant,
    cut,
    scrapped: sums.scrapped,
    other: sums.other,
    end: endQuantity,
    addsUp: startQuantity.plus(sums.received).minus(cut).minus(sums.scrapped).plus(sums.other).equals(endQuantity),
    values: { start: start.value, received: valueSums.received, cut: cutValue, scrapped: valueSums.scrapped, end: end.value },
  }
}

/** Two groups' figures added (an article = its lots). */
export function addLeather(a: LeatherFigures, b: LeatherFigures): LeatherFigures {
  const plus = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y)
  const start = a.start.plus(b.start)
  const end = a.end.plus(b.end)
  const received = a.received.plus(b.received)
  const cut = a.cut.plus(b.cut)
  const scrapped = a.scrapped.plus(b.scrapped)
  const other = a.other.plus(b.other)
  return {
    start,
    received,
    issued: a.issued.plus(b.issued),
    returned: a.returned.plus(b.returned),
    remnant: a.remnant.plus(b.remnant),
    cut,
    scrapped,
    other,
    end,
    addsUp: start.plus(received).minus(cut).minus(scrapped).plus(other).equals(end),
    values: {
      start: plus(a.values.start, b.values.start),
      received: plus(a.values.received, b.values.received),
      cut: plus(a.values.cut, b.values.cut),
      scrapped: plus(a.values.scrapped, b.values.scrapped),
      end: plus(a.values.end, b.values.end),
    },
  }
}

/** Nothing moved in the period and nothing is on hand at either end: the group is not shown. */
export const isIdle = (figures: LeatherFigures): boolean =>
  figures.start.isZero() && figures.end.isZero() && [figures.received, figures.issued, figures.returned, figures.remnant, figures.scrapped, figures.other].every((value) => value.isZero())
