import { Decimal } from 'decimal.js'
import { isUuid } from '../../core/ids'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { addDays } from '../../planning/buy'
import { decimalOf, QUANTITY_SCALE, roundTo, type DecimalInput, type Uom } from '../../product/units/units'
import type { PartyRole, PartyStatus } from '../../parties/rules'
import { isPurchaseParty, MAX_LINES } from '../orders'

/**
 * Requests to buy (SCM-034, SCM-036; design purchasing.requests "Requests to buy"; B-W2a-10), pure: the buyer's one queue
 * of what to buy, and the rules of turning many of them into draft purchase orders at once. The queue is a read model of
 * what already exists, nothing is stored for it (factory-db has no request table in W2a):
 *
 *   PLAN      a line to buy of a site's latest DONE planning run (MaterialRequirement, action BUY, something to buy):
 *             what the confirmed orders and their open work orders still need, less usable stock and what is on order.
 *             OPEN until it is drafted into a purchase order (CONVERTED: ORDERED with its line) or set aside (SET_ASIDE:
 *             IGNORED, planning's "Set aside" = the queue's "Reject with reason"). A firm planned order (wave 4's firm
 *             columns) is bought as the planner fixed it: quantity, date and supplier.
 *   REORDER   an item a site plans by a reorder point or min/max (ItemPlanning) whose stock position (usable stock + open
 *             purchase orders − what is reserved and not issued yet) is at or below its reorder point, or below its
 *             minimum: order the lot size, or up to the maximum, then the site's own minimum, steps and maximum (all in
 *             the base unit). Always OPEN while it holds: once a draft order covers it the position rises and it leaves the
 *             queue by itself.
 *
 * Staff requests ("Ask to buy", SCM-035, with who asked and an approval) are W2b, and a shortage on an open work order is
 * in its plan line (the W1 run counts the open work orders' material, less what was issued); the shortage list with its
 * fixes is B-W2a-22's (PLN-085).
 *
 * Converting: one draft purchase order per supplier and delivery site (its open draft, or a new one), one line per
 * request, in ONE command (apps/factory-api modules/purchasing/requests). A request that cannot be drafted now says why
 * (`holdOf`): the command refuses the whole batch rather than drafting a part of it.
 */

export const REQUEST_KINDS = ['PLAN', 'REORDER'] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]

export const REQUEST_STATUSES = ['OPEN', 'CONVERTED', 'SET_ASIDE'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

/** At most this many requests in one conversion (one order holds at most as many lines). */
export const MAX_CONVERT = MAX_LINES
/** The tile "Need date within 14 days". */
export const DUE_SOON_DAYS = 14

const PREFIX: Readonly<Record<RequestKind, string>> = Object.freeze({ PLAN: 'plan', REORDER: 'reorder' })

/** A request's id in the queue: `plan:<requirement id>` or `reorder:<item planning id>`. */
export const requestIdOf = (kind: RequestKind, refId: string): string => `${PREFIX[kind]}:${refId}`

/** A queue id read back; null when it is not one. */
export function parseRequestId(value: string): { readonly kind: RequestKind; readonly refId: string } | null {
  const match = /^(plan|reorder):(.+)$/.exec(value)
  if (!match || !isUuid(match[2])) return null
  return { kind: match[1] === 'plan' ? 'PLAN' : 'REORDER', refId: match[2]! }
}

/** The kind a path segment names (`plan`, `reorder`). */
export const kindOfPath = (segment: string): RequestKind | null => (segment === 'plan' ? 'PLAN' : segment === 'reorder' ? 'REORDER' : null)

// ---- reorder points ---------------------------------------------------------------------------------------------------

export const REORDER_METHODS = ['REORDER_POINT', 'MIN_MAX'] as const
export type ReorderMethod = (typeof REORDER_METHODS)[number]

/** A site's rule for an item (ItemPlanning), in the item's base unit. */
export interface ReorderRule {
  readonly method: ReorderMethod
  readonly reorderPoint: string | null
  readonly lotSize: string | null
  readonly minStock: string | null
  readonly maxStock: string | null
  readonly minOrderQty: string | null
  readonly orderMultiple: string | null
  readonly maxOrderQty: string | null
}

/** What the position counts, in the base unit. */
export interface StockPosition {
  /** RELEASED stock the site may use (planning's usable stock). */
  readonly usable: DecimalInput
  /** What the site's open purchase orders still bring (drafts included). */
  readonly onOrder: DecimalInput
  /** What ACTIVE reservations hold and was not issued yet. */
  readonly reserved: DecimalInput
}

export type LotStepRule = 'LOT_SIZE' | 'UP_TO_MAXIMUM' | 'MINIMUM' | 'MULTIPLE' | 'MAXIMUM'

export interface LotStep {
  readonly rule: LotStepRule
  /** The quantity after the step, base unit, four places. */
  readonly quantity: string
}

export interface ReorderNeed {
  readonly method: ReorderMethod
  /** usable + on order − reserved, base unit, four places. */
  readonly position: string
  /** The reorder point (REORDER_POINT) or the minimum (MIN_MAX) it is compared with. */
  readonly level: string
  /** At or below the reorder point; below the minimum. */
  readonly triggered: boolean
  /** What to order, base unit, four places; 0 when not triggered. */
  readonly quantity: string
  readonly steps: readonly LotStep[]
}

const q4 = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const nonNegative = (value: string | null): Decimal | null => (value !== null && /^\d+(\.\d+)?$/.test(value) ? decimalOf(value) : null)
const above0 = (value: string | null): Decimal | null => {
  const parsed = nonNegative(value)
  return parsed !== null && parsed.gt(0) ? parsed : null
}

/** usable + on order − reserved; below 0 when more is reserved than the site has and expects (a real shortage). */
export function positionOf(stock: StockPosition): string {
  return q4(roundTo(decimalOf(stock.usable).plus(decimalOf(stock.onOrder)).minus(decimalOf(stock.reserved)), { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }))
}

/** The site's minimum, steps and maximum on an order quantity (base unit), rounded up: never less than asked but by the maximum. */
export function lotSized(base: DecimalInput, rules: Pick<ReorderRule, 'minOrderQty' | 'orderMultiple' | 'maxOrderQty'>): { readonly quantity: string; readonly steps: LotStep[] } {
  let quantity = roundTo(base, { scale: QUANTITY_SCALE, rounding: 'UP' })
  const steps: LotStep[] = []
  const minimum = above0(rules.minOrderQty)
  if (minimum && quantity.lt(minimum)) {
    quantity = minimum
    steps.push({ rule: 'MINIMUM', quantity: q4(quantity) })
  }
  const multiple = above0(rules.orderMultiple)
  if (multiple) {
    const stepped = quantity.div(multiple).toDecimalPlaces(0, Decimal.ROUND_UP).times(multiple)
    if (!stepped.eq(quantity)) {
      quantity = stepped
      steps.push({ rule: 'MULTIPLE', quantity: q4(quantity) })
    }
  }
  const maximum = above0(rules.maxOrderQty)
  if (maximum && quantity.gt(maximum)) {
    quantity = maximum
    steps.push({ rule: 'MAXIMUM', quantity: q4(quantity) })
  }
  return { quantity: q4(quantity), steps }
}

/**
 * Whether the rule asks for an order now, and how much (base unit): REORDER_POINT orders its lot size when the position
 * is at or below the reorder point; MIN_MAX orders up to the maximum when the position is below the minimum. null when
 * the rule is not complete (a reorder point without a lot size, a minimum without a maximum): it suggests nothing.
 */
export function reorderNeedOf(rule: ReorderRule, stock: StockPosition): ReorderNeed | null {
  const position = decimalOf(positionOf(stock))
  if (rule.method === 'REORDER_POINT') {
    const point = nonNegative(rule.reorderPoint)
    const lot = above0(rule.lotSize)
    if (point === null || lot === null) return null
    const triggered = position.lte(point)
    if (!triggered) return { method: rule.method, position: q4(position), level: q4(point), triggered, quantity: q4(new Decimal(0)), steps: [] }
    const sized = lotSized(lot, rule)
    return { method: rule.method, position: q4(position), level: q4(point), triggered, quantity: sized.quantity, steps: [{ rule: 'LOT_SIZE', quantity: q4(lot) }, ...sized.steps] }
  }
  const minimum = nonNegative(rule.minStock)
  const maximum = nonNegative(rule.maxStock)
  if (minimum === null || maximum === null || maximum.lte(minimum)) return null
  const triggered = position.lt(minimum)
  if (!triggered) return { method: rule.method, position: q4(position), level: q4(minimum), triggered, quantity: q4(new Decimal(0)), steps: [] }
  const upTo = maximum.minus(position)
  const sized = lotSized(upTo, rule)
  return { method: rule.method, position: q4(position), level: q4(minimum), triggered, quantity: sized.quantity, steps: [{ rule: 'UP_TO_MAXIMUM', quantity: q4(upTo) }, ...sized.steps] }
}

const n = (value: DecimalInput): string => {
  const text = decimalOf(value).toFixed(QUANTITY_SCALE)
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** The reorder row's "why", in words (the screens show their own words from the numbers). */
export function reorderWhy(need: ReorderNeed, stock: StockPosition, uom: Uom): string {
  const position = `Stock ${n(need.position)} ${uom} (usable ${n(stock.usable)} + on order ${n(stock.onOrder)} − reserved ${n(stock.reserved)})`
  if (need.method === 'REORDER_POINT') {
    return need.triggered ? `${position} is at or below the reorder point ${n(need.level)}: order ${n(need.quantity)} ${uom}.` : `${position} is above the reorder point ${n(need.level)}.`
  }
  return need.triggered ? `${position} is below the minimum ${n(need.level)}: order ${n(need.quantity)} ${uom}, up to the maximum.` : `${position} is not below the minimum ${n(need.level)}.`
}

// ---- what stops a request ---------------------------------------------------------------------------------------------

export const REQUEST_HOLDS = ['NO_SUPPLIER', 'NOT_A_SUPPLIER', 'SUPPLIER_BLOCKED', 'SUPPLIER_ARCHIVED', 'NOT_APPROVED', 'MATERIAL_ARCHIVED', 'NOT_OPEN', 'PLAN_REPLACED', 'NOT_NEEDED'] as const
export type RequestHoldCode = (typeof REQUEST_HOLDS)[number]

export interface RequestHold {
  readonly code: RequestHoldCode
  readonly message: string
}

export interface HoldFacts {
  readonly status: RequestStatus
  /** PLAN: its run is still the site's latest DONE one. */
  readonly latest: boolean
  /** REORDER: the stock is still at or below the reorder point (below the minimum). */
  readonly needed: boolean
  readonly material: { readonly code: string; readonly active: boolean }
  readonly supplier: { readonly name: string; readonly roles: readonly PartyRole[]; readonly status: PartyStatus } | null
  /** The supplier is one of the material's approved sources for the need (or the material has none). */
  readonly approved: boolean
}

/** Why the request cannot be drafted into a purchase order now; null when it can. */
export function holdOf(facts: HoldFacts): RequestHold | null {
  if (!facts.latest) return { code: 'PLAN_REPLACED', message: 'A newer plan replaced this one: draft the lines of the latest plan.' }
  if (!facts.needed) return { code: 'NOT_NEEDED', message: 'The stock is above its reorder level now (the reorder point, or the minimum): nothing to buy.' }
  if (facts.status !== 'OPEN') return { code: 'NOT_OPEN', message: facts.status === 'CONVERTED' ? 'It is on a purchase order already.' : 'It was set aside: open it again first.' }
  if (!facts.material.active) return { code: 'MATERIAL_ARCHIVED', message: `${facts.material.code} is archived: it is not bought any more.` }
  const supplier = facts.supplier
  if (!supplier) return { code: 'NO_SUPPLIER', message: `Pick a supplier first: ${facts.material.code} has no approved source or default supplier.` }
  if (!isPurchaseParty(supplier.roles)) return { code: 'NOT_A_SUPPLIER', message: `${supplier.name} is not a supplier: pick an approved source.` }
  if (supplier.status === 'BLOCKED') return { code: 'SUPPLIER_BLOCKED', message: `${supplier.name} is blocked: pick another approved source.` }
  if (supplier.status === 'ARCHIVED') return { code: 'SUPPLIER_ARCHIVED', message: `${supplier.name} is archived: pick another approved source.` }
  if (!facts.approved) return { code: 'NOT_APPROVED', message: `${supplier.name} is not an approved source of ${facts.material.code}: pick one of its sources, or add this supplier to them first.` }
  return null
}

/** What the buyer should know before drafting, never blocking. */
export const REQUEST_WARNINGS = ['SUPPLIER_PROSPECT', 'NO_PRICE', 'ORDER_BY_PASSED', 'NO_LEAD_TIME', 'SOURCE_UNIT_NOT_CONVERTED'] as const
export type RequestWarningCode = (typeof REQUEST_WARNINGS)[number]

export const WARNING_WORDS: Readonly<Record<RequestWarningCode, string>> = Object.freeze({
  SUPPLIER_PROSPECT: 'The supplier is a prospect: the order can be drafted, not sent, until it is active.',
  NO_PRICE: 'No price on record for this supplier: the buyer types it on the order before sending it.',
  ORDER_BY_PASSED: 'The day to order by has passed: the goods may come after the need date.',
  NO_LEAD_TIME: 'No lead time on record: the day to order by is the need date itself.',
  SOURCE_UNIT_NOT_CONVERTED: "The material no longer converts the supplier's unit: bought in the material's own purchase unit.",
})

// ---- the queue --------------------------------------------------------------------------------------------------------

/** The ISO 8601 week of a day, `YYYY-Www` (the queue's "need week" group). */
export function needWeekOf(date: BusinessDate): string {
  if (!isBusinessDate(date)) throw new RangeError(`not a calendar day: ${String(date)}`)
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  const at = new Date(Date.UTC(year, month - 1, day))
  const weekday = at.getUTCDay() === 0 ? 7 : at.getUTCDay()
  at.setUTCDate(at.getUTCDate() + 4 - weekday) // the Thursday of its week names the year
  const isoYear = at.getUTCFullYear()
  const week = Math.ceil(((at.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

export interface TileRow {
  readonly status: RequestStatus
  readonly needDate: BusinessDate
  /** The day (Europe/Rome) a request was drafted into a purchase order; null while it was not. */
  readonly convertedOn: BusinessDate | null
}

export interface RequestTiles {
  /** Open requests: what is still to buy. */
  readonly open: number
  /** Open requests needed within DUE_SOON_DAYS days (or late already). */
  readonly needWithin14Days: number
  /** Staff requests waiting for an approval: W2b, unknown until then (null, drawn as '—'). */
  readonly waitingApproval: null
  /** Requests drafted into a purchase order today (plan lines: a reorder row leaves no trace of its own). */
  readonly convertedToday: number
}

export function requestTiles(rows: readonly TileRow[], today: BusinessDate): RequestTiles {
  const soon = addDays(today, DUE_SOON_DAYS)
  return {
    open: rows.filter((row) => row.status === 'OPEN').length,
    needWithin14Days: rows.filter((row) => row.status === 'OPEN' && row.needDate <= soon).length,
    waitingApproval: null,
    convertedToday: rows.filter((row) => row.status === 'CONVERTED' && row.convertedOn === today).length,
  }
}

/** The queue's order: need date, then the day to order by, then the material's code, then the id. */
export function compareRequests(a: { readonly needDate: string; readonly orderBy: string; readonly code: string; readonly id: string }, b: typeof a): number {
  return a.needDate.localeCompare(b.needDate) || a.orderBy.localeCompare(b.orderBy) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id)
}
