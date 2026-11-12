import { daysFrom, plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { PROMISE_REASON_CODES as CUSTOMER_REASON_CODES, PROMISE_REASON_WORDS as CUSTOMER_REASON_WORDS } from '../../sales/portal-orders/promise'
import { Dec, type Decimal } from '../../tax/decimal'
import type { Bridge, PromiseProblem } from './ctp'

/**
 * Promise dates (B-W2b-301; PLN-168, PLN-169, PLN-171, PLN-179), pure: where a size's material comes from and when, the
 * sizes that finish together, the words of a date's bridge, and which PromiseRecord rows an order line's promise per size
 * writes (B-W2b-286's append-only history: one FIRST per line and size, every later date a RE_PROMISE with its reason).
 */

// ---- reasons ----------------------------------------------------------------------------------------------------------

/**
 * A re-promise's reason codes (PromiseRecord.reasonCode; B-W2b-286 left the list to factory-domain): the customer's curated
 * reasons of the portal (sales/portal-orders/promise: a code there is shown to the customer in its words) and the planning
 * ones of this step. SIZES_FINISH_APART: a size promised apart from the line because it finishes on another day (PLN-171).
 */
export const PROMISE_REASON_CODES = [...CUSTOMER_REASON_CODES, 'SIZES_FINISH_APART'] as const
export type PromiseReasonCode = (typeof PROMISE_REASON_CODES)[number]

export const PROMISE_REASON_WORDS: Readonly<Record<PromiseReasonCode, { readonly it: string; readonly en: string }>> = Object.freeze({
  ...CUSTOMER_REASON_WORDS,
  SIZES_FINISH_APART: { it: 'Le taglie sono pronte in giorni diversi', en: 'The sizes finish on different days' },
})

/** The code a per-size promise carries when the caller names none. */
export const DEFAULT_SIZE_REASON: PromiseReasonCode = 'SIZES_FINISH_APART'

// ---- material --------------------------------------------------------------------------------------------------------

export const MATERIAL_SOURCES = ['STOCK', 'PURCHASE_ORDER', 'FIRM', 'BUY', 'MAKE'] as const
export type MaterialSource = (typeof MATERIAL_SOURCES)[number]

/** One supply of a size's part of a material, as the plan's netting found it (planning/mrp/net PartSupply). */
export interface NeedSupply {
  readonly kind: 'ISSUED' | 'RESERVATION' | 'STOCK' | 'PURCHASE_ORDER' | 'FIRM' | 'PLANNED'
  readonly quantity: string
  readonly date?: BusinessDate | undefined
  readonly purchaseOrderLineId?: string | undefined
}

/** A size's need of one material: what the plan found for it, and the material's lead times at the site. */
export interface MaterialNeed {
  readonly itemId: string
  readonly itemColourId: string | null
  /** "SEED-LTH-100 BLK". */
  readonly label: string
  readonly action: 'BUY' | 'MAKE'
  readonly supplies: readonly NeedSupply[]
  /** Still short after stock, purchase orders and firm planned orders: what has to be bought or made. */
  readonly uncovered: string
  /** BUY: the supplier's days from order to the goods at the site; MAKE: the make lead time; null: none on record. */
  readonly leadTimeDays: number | null
  /** Days between arrival and use (incoming inspection, put-away; ItemPlanning.delayDays). */
  readonly delayDays: number | null
  /** The purchase order line's number words ("PO-00012 line 10"), when a supply names one. */
  readonly purchaseOf?: (purchaseOrderLineId: string) => string | undefined
}

export interface MaterialArrival {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly label: string
  readonly source: MaterialSource
  /** The day it is there for this size (today for stock). */
  readonly date: BusinessDate
  readonly leadTimeDays: number | null
  readonly purchaseOrderLineId: string | null
  readonly words: string
}

export const MATERIAL_WARNING_CODES = ['NO_LEAD_TIME', 'NO_MAKE_LEAD_TIME', 'PURCHASE_OVERDUE'] as const
export type MaterialWarningCode = (typeof MATERIAL_WARNING_CODES)[number]

export interface MaterialWarning {
  readonly code: MaterialWarningCode
  readonly words: string
}

const later = (a: BusinessDate, b: BusinessDate): BusinessDate => (a > b ? a : b)
const shortDay = (date: BusinessDate): string => date

/** When one material is there for a size, per source (the latest is what counts). */
export function arrivalsOf(need: MaterialNeed, today: BusinessDate): { arrivals: MaterialArrival[]; warnings: MaterialWarning[] } {
  const arrivals: MaterialArrival[] = []
  const warnings: MaterialWarning[] = []
  const delay = Math.max(0, need.delayDays ?? 0)
  const after = (date: BusinessDate) => plusDays(later(date, today), delay)
  let stock = false
  for (const supply of need.supplies) {
    if (!new Dec(supply.quantity).gt(0)) continue
    if (supply.kind === 'STOCK' || supply.kind === 'RESERVATION' || supply.kind === 'ISSUED') {
      if (!stock) arrivals.push({ itemId: need.itemId, itemColourId: need.itemColourId, label: need.label, source: 'STOCK', date: today, leadTimeDays: null, purchaseOrderLineId: null, words: `${need.label} is in stock.` })
      stock = true
    } else if (supply.kind === 'PURCHASE_ORDER') {
      const due = supply.date ?? today
      const po = supply.purchaseOrderLineId ? (need.purchaseOf?.(supply.purchaseOrderLineId) ?? 'a purchase order') : 'a purchase order'
      if (due < today) warnings.push({ code: 'PURCHASE_OVERDUE', words: `${need.label} on ${po} was due ${shortDay(due)} and has not arrived: counted from today.` })
      const date = after(due)
      arrivals.push({ itemId: need.itemId, itemColourId: need.itemColourId, label: need.label, source: 'PURCHASE_ORDER', date, leadTimeDays: null, purchaseOrderLineId: supply.purchaseOrderLineId ?? null, words: `${need.label} arrives on ${po} by ${shortDay(date)}.` })
    } else if (supply.kind === 'FIRM') {
      const date = after(supply.date ?? today)
      arrivals.push({ itemId: need.itemId, itemColourId: need.itemColourId, label: need.label, source: 'FIRM', date, leadTimeDays: null, purchaseOrderLineId: null, words: `${need.label} comes with a firm planned order by ${shortDay(date)}.` })
    }
  }
  if (new Dec(need.uncovered).gt(0)) {
    const lead = need.leadTimeDays
    if (lead === null) warnings.push(need.action === 'BUY' ? { code: 'NO_LEAD_TIME', words: `${need.label} has no lead time on record: the date counts it as there today.` } : { code: 'NO_MAKE_LEAD_TIME', words: `${need.label} is made here and has no make lead time on record: the date counts it as ready today.` })
    const date = plusDays(today, Math.max(0, lead ?? 0) + delay)
    arrivals.push({
      itemId: need.itemId,
      itemColourId: need.itemColourId,
      label: need.label,
      source: need.action === 'MAKE' ? 'MAKE' : 'BUY',
      date,
      leadTimeDays: lead,
      purchaseOrderLineId: null,
      words: need.action === 'MAKE' ? `${need.label} is to make: ready by ${shortDay(date)}.` : `${need.label} is to buy: ${lead ?? 0} day(s) to arrive, by ${shortDay(date)}.`,
    })
  }
  return { arrivals, warnings }
}

/** The day every material of a size is there, the arrival that sets it (the latest; null: nothing to wait for). */
export function materialDateOf(needs: readonly MaterialNeed[], today: BusinessDate): { date: BusinessDate; setBy: MaterialArrival | null; arrivals: MaterialArrival[]; warnings: MaterialWarning[] } {
  const arrivals: MaterialArrival[] = []
  const warnings: MaterialWarning[] = []
  for (const need of needs) {
    const found = arrivalsOf(need, today)
    arrivals.push(...found.arrivals)
    warnings.push(...found.warnings)
  }
  let setBy: MaterialArrival | null = null
  for (const arrival of arrivals) if (arrival.date > today && (setBy === null || arrival.date > setBy.date)) setBy = arrival
  return { date: setBy?.date ?? today, setBy, arrivals, warnings }
}

// ---- words --------------------------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** "4 Dec" (with the year when it is not today's: "4 Jan 2027"). */
export function dayWords(date: BusinessDate, today: BusinessDate): string {
  const words = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`
  return date.slice(0, 4) === today.slice(0, 4) ? words : `${words} ${date.slice(0, 4)}`
}

const days = (count: number): string => `${count} day${count === 1 ? '' : 's'}`

/** "base lead time 15 days + queue at today's load 6 days + leather to buy 14 days = 35 days → 4 Dec". */
export function bridgeWords(bridge: Bridge, setBy: Pick<MaterialArrival, 'label' | 'source'> | null, today: BusinessDate): string {
  const material =
    setBy === null || bridge.materialDays === 0
      ? `material ready ${days(0)}`
      : setBy.source === 'BUY'
        ? `${setBy.label} to buy ${days(bridge.materialDays)}`
        : setBy.source === 'MAKE'
          ? `${setBy.label} to make ${days(bridge.materialDays)}`
          : setBy.source === 'PURCHASE_ORDER'
            ? `${setBy.label} on order ${days(bridge.materialDays)}`
            : `${setBy.label} planned ${days(bridge.materialDays)}`
  return `base lead time ${days(bridge.baseDays)} + queue at today's load ${days(bridge.queueDays)} + ${material} = ${days(bridge.totalDays)} → ${dayWords(bridge.finish, today)}`
}

export interface SizeDate {
  readonly size: string
  /** null: not promised (no date: not certified, or beyond the horizon). */
  readonly date: BusinessDate | null
}

export interface SizeGroup {
  readonly sizes: string[]
  readonly date: BusinessDate | null
  /** "48–52 4 Dec"; "56 not promised". */
  readonly words: string
}

/**
 * The sizes that finish together, in the style's size order (PLN-171: "S–L 4 Dec, XL 11 Dec"): a run of neighbouring sizes
 * with the same date is one group. Sizes the order does not name are left out of the runs (they do not break one).
 */
export function sizeGroupsOf(sizes: readonly SizeDate[], sizeOrder: readonly string[], today: BusinessDate): SizeGroup[] {
  const rank = (size: string) => {
    const index = sizeOrder.indexOf(size)
    return index < 0 ? sizeOrder.length : index
  }
  const sorted = [...sizes].sort((a, b) => rank(a.size) - rank(b.size) || (a.size < b.size ? -1 : a.size > b.size ? 1 : 0))
  const groups: { sizes: string[]; date: BusinessDate | null }[] = []
  for (const entry of sorted) {
    const last = groups[groups.length - 1]
    if (last && last.date === entry.date) last.sizes.push(entry.size)
    else groups.push({ sizes: [entry.size], date: entry.date })
  }
  return groups.map((group) => {
    const label = group.sizes.length === 1 ? group.sizes[0]! : `${group.sizes[0]}–${group.sizes[group.sizes.length - 1]}`
    return { sizes: group.sizes, date: group.date, words: `${label} ${group.date === null ? 'not promised' : dayWords(group.date, today)}` }
  })
}

/** "48–52 4 Dec, 54 11 Dec". */
export const groupsWords = (groups: readonly SizeGroup[]): string => groups.map((group) => group.words).join(', ')

// ---- one size's answer -------------------------------------------------------------------------------------------------

/** SHIPPED: an order line's size with nothing left to ship (only an order line's view says it). */
export const SIZE_STATES = ['FROM_STOCK', 'MAKE', 'STOCK_AND_MAKE', 'NOT_CERTIFIED', 'NO_DATE', 'SHIPPED'] as const
export type SizeState = (typeof SIZE_STATES)[number]

/** The words of a size's answer. */
export function sizeWords(input: { readonly size: string; readonly state: SizeState; readonly date: BusinessDate | null; readonly fromStock: number; readonly toMake: number; readonly why?: string | null }, today: BusinessDate): string {
  if (input.state === 'NOT_CERTIFIED') return `Size ${input.size} is not promised: ${input.why ?? 'no valid certificate covers it.'}`
  if (input.state === 'NO_DATE' || input.date === null) return `Size ${input.size} has no date: ${input.why ?? 'it does not fit within the horizon.'}`
  const when = dayWords(input.date, today)
  if (input.state === 'FROM_STOCK') return `Size ${input.size}: ${input.fromStock} from stock by ${when}.`
  if (input.state === 'STOCK_AND_MAKE') return `Size ${input.size}: ${input.fromStock} from stock, ${input.toMake} to make, all by ${when}.`
  return `Size ${input.size}: ${input.toMake} to make by ${when}.`
}

/** The wanted date is met (null: none asked). */
export const meetsWanted = (date: BusinessDate | null, wanted: BusinessDate | null): boolean | null => (wanted === null ? null : date !== null && date <= wanted)

/** Days late against the wanted date (0 on time; null without both). */
export const daysAfterWanted = (date: BusinessDate | null, wanted: BusinessDate | null): number | null => (wanted === null || date === null ? null : Math.max(0, daysFrom(wanted, date)))

// ---- an order line's promise per size -----------------------------------------------------------------------------------

/** One stored promise (PromiseRecord), as the rows read it. */
export interface StoredPromise {
  readonly id: string
  /** null: every size of the line. */
  readonly size: string | null
  readonly promisedDate: BusinessDate
  readonly kind: 'FIRST' | 'RE_PROMISE'
  readonly promisedAt: Date
}

export interface CurrentPromise {
  readonly date: BusinessDate
  /** RECORD: a PromiseRecord row (of the size, or of every size); TYPED: the date sales typed on the line or the order (W1). */
  readonly source: 'RECORD' | 'TYPED'
  readonly kind: 'FIRST' | 'RE_PROMISE' | null
  readonly recordId: string | null
  /** The row is the size's own (false: the line's every-size row, or the typed date). */
  readonly ownSize: boolean
}

const newest = (rows: readonly StoredPromise[]): StoredPromise | null =>
  rows.reduce<StoredPromise | null>((best, row) => (best === null || row.promisedAt.getTime() > best.promisedAt.getTime() || (row.promisedAt.getTime() === best.promisedAt.getTime() && row.id > best.id) ? row : best), null)

/** A size's promise now: its newest own row, else the newest every-size row, else the date typed on the line or the order. */
export function currentPromiseOf(size: string | null, rows: readonly StoredPromise[], typed: BusinessDate | null): CurrentPromise | null {
  const own = size === null ? null : newest(rows.filter((row) => row.size === size))
  const every = newest(rows.filter((row) => row.size === null))
  const row = own ?? every
  if (row) return { date: row.promisedDate, source: 'RECORD', kind: row.kind, recordId: row.id, ownSize: row === own && size !== null }
  return typed === null ? null : { date: typed, source: 'TYPED', kind: null, recordId: null, ownSize: false }
}

export interface PromiseAsk {
  /** null: every size of the line (a made-to-measure unit, or one date for all). */
  readonly size: string | null
  readonly date: BusinessDate
}

export interface PromiseRow {
  readonly size: string | null
  readonly promisedDate: BusinessDate
  readonly kind: 'FIRST' | 'RE_PROMISE'
  readonly reasonCode: string | null
  readonly reason: string | null
  /** The typed date written as the line's first promise before the sizes apart (promisedAt = the order's time). */
  readonly backfill: boolean
}

export interface PromisePlan {
  readonly rows: PromiseRow[]
  /** Sizes asked for the date they already have: nothing written for them. */
  readonly unchanged: (string | null)[]
}

/**
 * The rows an order line's promise per size writes (PLN-171, on B-W2b-286's history): a line never promised gets its FIRST
 * row(s) — one for every size when every size has the same date and all are asked, else one per size; a line already
 * promised (rows, or a date sales typed, which becomes the line's FIRST row first) gets a RE_PROMISE for each size asked
 * for another date, with its reason (SIZES_FINISH_APART when none is given); a size asked for the date it has writes
 * nothing. The first promise is never overwritten.
 */
export function promisePlanOf(input: {
  readonly asks: readonly PromiseAsk[]
  /** The line's open sizes (a made-to-measure line: none). */
  readonly sizes: readonly string[]
  readonly rows: readonly StoredPromise[]
  readonly typed: BusinessDate | null
  readonly reasonCode: string | null
  readonly reason: string | null
}): PromisePlan {
  const out: PromiseRow[] = []
  const unchanged: (string | null)[] = []
  const reasonCode = input.reasonCode ?? (input.reason ? null : DEFAULT_SIZE_REASON)
  const firstOf = (size: string | null) => input.rows.some((row) => row.kind === 'FIRST' && (row.size === size || row.size === null))
  if (input.rows.length === 0 && input.typed === null) {
    const dates = new Set(input.asks.map((ask) => ask.date))
    const all = input.asks.some((ask) => ask.size === null) || (input.sizes.length > 0 && input.sizes.every((size) => input.asks.some((ask) => ask.size === size)))
    if (dates.size === 1 && all) return { rows: [{ size: null, promisedDate: input.asks[0]!.date, kind: 'FIRST', reasonCode: null, reason: input.reason, backfill: false }], unchanged }
    return { rows: input.asks.map((ask) => ({ size: ask.size, promisedDate: ask.date, kind: 'FIRST', reasonCode: null, reason: input.reason, backfill: false })), unchanged }
  }
  let backfilled = false
  for (const ask of input.asks) {
    const current = currentPromiseOf(ask.size, input.rows, input.typed)
    if (current && current.date === ask.date) {
      unchanged.push(ask.size)
      continue
    }
    if (input.rows.length === 0 && input.typed !== null && !backfilled) {
      out.push({ size: null, promisedDate: input.typed, kind: 'FIRST', reasonCode: null, reason: null, backfill: true })
      backfilled = true
    }
    const hasFirst = backfilled || firstOf(ask.size)
    out.push(hasFirst ? { size: ask.size, promisedDate: ask.date, kind: 'RE_PROMISE', reasonCode, reason: input.reason, backfill: false } : { size: ask.size, promisedDate: ask.date, kind: 'FIRST', reasonCode: null, reason: input.reason, backfill: false })
  }
  return { rows: out, unchanged }
}

/** Words for a planned row. */
export const promiseRowWords = (row: PromiseRow, today: BusinessDate): string =>
  `${row.size === null ? 'Every size' : `Size ${row.size}`}: ${row.kind === 'FIRST' ? (row.backfill ? 'first promise (as typed)' : 'first promise') : 're-promised'} ${dayWords(row.promisedDate, today)}.`

/** Every problem of the planner's per-size dates at once (sizes of the line, each once, today or later, a size still open). */
export function promiseAskProblems(input: {
  readonly asks: readonly PromiseAsk[]
  readonly sizes: readonly string[]
  readonly openOf: (size: string) => number
  readonly madeToMeasure: boolean
  readonly today: BusinessDate
  readonly orderDate: BusinessDate
}): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = []
  const seen = new Set<string>()
  input.asks.forEach((ask, index) => {
    const path = `body/sizes/${index}`
    const key = ask.size ?? '*'
    if (seen.has(key)) problems.push({ path: `${path}/size`, message: `Size ${ask.size ?? '(every size)'} is named twice.` })
    seen.add(key)
    if (input.madeToMeasure && ask.size !== null) problems.push({ path: `${path}/size`, message: 'A made-to-measure line is promised as one unit: leave the size out.' })
    if (!input.madeToMeasure && ask.size !== null && !input.sizes.includes(ask.size)) problems.push({ path: `${path}/size`, message: `Size ${ask.size} is not on the line (${input.sizes.join(', ') || 'no sizes'}).` })
    if (!input.madeToMeasure && ask.size !== null && input.sizes.includes(ask.size) && input.openOf(ask.size) <= 0) problems.push({ path: `${path}/size`, message: `Size ${ask.size} has shipped: nothing is left to promise.` })
    if (ask.date < input.today) problems.push({ path: `${path}/date`, message: 'A promise is today or later.' })
    if (ask.date < input.orderDate) problems.push({ path: `${path}/date`, message: `A promise is on or after the order's date (${input.orderDate}).` })
  })
  if (seen.has('*') && seen.size > 1) problems.push({ path: 'body/sizes', message: 'Either one date for every size, or a date per size: not both.' })
  return problems
}

/** A reason code of the list, or null when none is given; anything else is a problem. */
export function reasonProblem(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null
  return (PROMISE_REASON_CODES as readonly string[]).includes(code) ? null : `Unknown reason ${code}: one of ${PROMISE_REASON_CODES.join(', ')}.`
}

/** The problems of a walk and the material, as one list of words (codes kept). */
export interface PromiseWarning {
  readonly code: string
  readonly words: string
}

export const warningsOf = (problems: readonly (PromiseProblem | MaterialWarning | PromiseWarning)[]): PromiseWarning[] => {
  const seen = new Set<string>()
  return problems.filter((problem) => {
    const key = `${problem.code}|${problem.words}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Garments as a decimal (minutes × garments). */
export const minutesFor = (standardMinutes: string, garments: number): Decimal => new Dec(standardMinutes).times(Math.max(0, garments))
