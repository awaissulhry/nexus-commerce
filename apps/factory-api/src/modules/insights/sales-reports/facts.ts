import type { Prisma } from '@nexus/factory-db'
import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { workingMinutesBetween } from '@nexus/factory-domain/calendars/working-time'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { currentPromiseOf } from '@nexus/factory-domain/planning/promise/rules'
import {
  BACKLOG_STATUSES,
  bookedOnOf,
  FEES_KEY,
  INTAKE_STATUSES,
  NO_KEY,
  openValueOf,
  RETURN_STATUSES,
  SALES_REPORT_LIMITS,
  type BacklogPiece,
  type IntakeLine,
  type QuoteDecision,
  type QuoteOutcome,
  type ReturnEntry,
} from '@nexus/factory-domain/insights/sales-reports/rules'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { readPromiseRows } from '../../planning/promise/store'
import { shippedOfLines } from '../../planning/promise-keep/store'
import { partyRef, type Place, type Reader, type Ref } from './access'

/**
 * What the sales reports count (B-W2b-348; the rules: factory-domain insights/sales-reports/rules.ts), read in one client, one
 * query after another, only within the records the caller reaches (`place.orders`, `place.quotes`, `place.returns`). Reads
 * only; at most SALES_REPORT_LIMITS.read records per answer (`complete`).
 */

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
/** A stored calendar day (a @db.Date column, UTC midnight) as a business day. */
const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const atMidnight = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

// ---- intake ------------------------------------------------------------------------------------------------------------------

export interface IntakeOrder {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly customer: Ref
  readonly bookedOn: BusinessDate
  readonly orderDate: BusinessDate
  readonly splitOff: boolean
  readonly season: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly currency: string
  readonly lines: IntakeLine[]
}

export interface IntakeRead {
  readonly orders: IntakeOrder[]
  readonly lines: IntakeLine[]
  readonly styles: Map<string, Ref>
  readonly complete: boolean
}

const INTAKE_SELECT = {
  id: true,
  number: true,
  status: true,
  orderDate: true,
  currency: true,
  party: { select: { id: true, code: true, legalName: true, tradeName: true } },
  season: { select: { id: true, code: true, name: true } },
  lines: { select: { kind: true, styleId: true, quantity: true, netAmount: true }, orderBy: [{ seq: 'asc' }] },
} as const satisfies Prisma.SalesOrderSelect

/** The orders split off another since `start` (B-W2b-303's `orders.splitOff` audit row names the order it came from). */
async function splitsSince(db: Reader, start: Date, companyId: string | null): Promise<Map<string, string>> {
  const rows = await db.auditLog.findMany({
    where: { action: 'orders.splitOff', recordType: 'SalesOrder', at: { gte: start }, ...(companyId ? { companyId } : {}) },
    select: { recordId: true, after: true },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
  })
  const out = new Map<string, string>()
  for (const row of rows) {
    const from = (row.after as { splitFrom?: unknown } | null)?.splitFrom
    if (typeof from === 'string') out.set(row.recordId, from)
  }
  return out
}

/**
 * The orders booked in the period (confirmed, not cancelled, no return's replacement), with their lines; an order split off
 * another counts on its first order's day — so one split off later still counts here, and one split off an earlier order does
 * not. Without orders.view: none.
 */
export async function intakeOf(db: Reader, place: Place): Promise<IntakeRead> {
  if (!place.sight.orders) return { orders: [], lines: [], styles: new Map(), complete: true }
  const counted: Prisma.SalesOrderWhereInput = { AND: [place.orders, { status: { in: [...INTAKE_STATUSES] } }, { replacementFor: { none: {} } }] }
  const inPeriod = await db.salesOrder.findMany({
    where: { AND: [counted, { orderDate: { gte: atMidnight(place.period.from), lte: atMidnight(place.period.to) } }] },
    select: INTAKE_SELECT,
    orderBy: [{ orderDate: 'desc' }, { number: 'desc' }, { id: 'asc' }],
    take: SALES_REPORT_LIMITS.read + 1,
  })
  const splits = await splitsSince(db, place.span.start, place.company?.id ?? null)
  // Every order on a split chain, for its booking day.
  const dates = new Map<string, { orderDate: BusinessDate; splitFrom: string | null }>()
  for (const row of inPeriod) dates.set(row.id, { orderDate: dayOf(row.orderDate), splitFrom: splits.get(row.id) ?? null })
  let missing = unique([...splits.keys(), ...splits.values()]).filter((orderId) => !dates.has(orderId))
  for (let round = 0; round < 5 && missing.length > 0; round += 1) {
    const found = await db.salesOrder.findMany({ where: { id: { in: missing } }, select: { id: true, orderDate: true } })
    for (const row of found) dates.set(row.id, { orderDate: dayOf(row.orderDate), splitFrom: splits.get(row.id) ?? null })
    missing = unique(found.map((row) => splits.get(row.id))).filter((orderId) => !dates.has(orderId))
  }
  const booked = (orderId: string) => bookedOnOf(orderId, dates)
  const inside = (day: BusinessDate | null) => day !== null && day >= place.period.from && day <= place.period.to
  // Split off later (dated after the period) from an order booked in it: counted here too.
  const later = [...splits.keys()].filter((orderId) => !inPeriod.some((row) => row.id === orderId) && inside(booked(orderId)))
  const extra = later.length === 0 ? [] : await db.salesOrder.findMany({ where: { AND: [counted, { id: { in: later } }] }, select: INTAKE_SELECT, orderBy: [{ orderDate: 'desc' }, { number: 'desc' }, { id: 'asc' }] })
  const rows = [...inPeriod.slice(0, SALES_REPORT_LIMITS.read), ...extra].filter((row) => inside(booked(row.id)))
  const orders = rows.map((row): IntakeOrder => {
    const bookedOn = booked(row.id)!
    const customer = partyRef(row.party)
    const seasonKey = row.season?.id ?? NO_KEY
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      customer,
      bookedOn,
      orderDate: dayOf(row.orderDate),
      splitOff: splits.has(row.id),
      season: row.season,
      currency: row.currency,
      lines: row.lines.map((line) => ({
        orderId: row.id,
        bookedOn,
        customer: customer.id,
        style: line.kind === 'FEE' ? FEES_KEY : line.styleId,
        season: seasonKey,
        pieces: line.kind === 'FEE' ? 0 : line.quantity,
        value: line.netAmount,
        currency: row.currency,
      })),
    }
  })
  orders.sort((a, b) => b.bookedOn.localeCompare(a.bookedOn) || b.number.localeCompare(a.number))
  const lines = orders.flatMap((order) => order.lines)
  const styleIds = unique(lines.map((line) => (line.style === FEES_KEY ? null : line.style)))
  const styles = new Map((styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: row.name }]))
  return { orders, lines, styles, complete: inPeriod.length <= SALES_REPORT_LIMITS.read }
}

// ---- backlog -----------------------------------------------------------------------------------------------------------------

export interface BacklogRow extends BacklogPiece {
  readonly number: string
  readonly status: string
  readonly seq: number
  readonly customerRef: Ref
  readonly styleRef: Ref
  readonly colourway: { readonly code: string; readonly name: string }
  readonly size: string | null
  readonly promiseSource: 'RECORD' | 'TYPED' | null
}

const BACKLOG_SELECT = {
  id: true,
  seq: true,
  kind: true,
  orderId: true,
  quantity: true,
  netAmount: true,
  promiseDate: true,
  sizes: { select: { size: true, quantity: true } },
  style: { select: { id: true, code: true, name: true, sizes: true } },
  colourway: { select: { code: true, name: true } },
  order: { select: { number: true, status: true, currency: true, promiseDate: true, party: { select: { id: true, code: true, legalName: true, tradeName: true } } } },
} as const satisfies Prisma.SalesOrderLineSelect

/**
 * The backlog now: every open size of the garment lines (not closed short) of the open orders the caller reaches — ordered
 * less shipped (SHIPPED / DELIVERED shipments), at its promise now (B-W2b-301's currentPromiseOf over the promise history, else
 * the date typed on the line or the order). Without orders.view: none.
 */
export async function backlogOf(db: Reader, place: Place): Promise<{ rows: BacklogRow[]; complete: boolean }> {
  if (!place.sight.orders) return { rows: [], complete: true }
  const read = await db.salesOrderLine.findMany({
    where: { kind: { in: ['SIZE_GRID', 'MADE_TO_MEASURE'] }, closedShortAt: null, order: { AND: [place.orders, { status: { in: [...BACKLOG_STATUSES] } }] } },
    select: BACKLOG_SELECT,
    orderBy: [{ orderId: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
    take: SALES_REPORT_LIMITS.read + 1,
  })
  const lines = read.slice(0, SALES_REPORT_LIMITS.read)
  const lineIds = lines.map((line) => line.id)
  const shipped = await shippedOfLines(db, lineIds)
  const promises = await readPromiseRows(db, lineIds)
  const rows: BacklogRow[] = []
  for (const line of lines) {
    const typedDate = line.promiseDate ?? line.order.promiseDate
    const typed = typedDate ? dayOf(typedDate) : null
    const own = promises.get(line.id) ?? []
    const order = line.style.sizes
    const sizes = line.kind === 'MADE_TO_MEASURE' ? [{ size: null as string | null, quantity: 1 }] : [...line.sizes].sort((a, b) => order.indexOf(a.size) - order.indexOf(b.size))
    for (const entry of sizes) {
      const open = Math.max(0, entry.quantity - shipped(line.id, entry.size))
      if (open === 0) continue
      const current = currentPromiseOf(entry.size, own, typed)
      const customer = partyRef(line.order.party)
      rows.push({
        orderId: line.orderId,
        lineId: line.id,
        customer: customer.id,
        style: line.style.id,
        open,
        value: openValueOf(line.netAmount, line.quantity, open),
        currency: line.order.currency,
        promise: current?.date ?? null,
        number: line.order.number,
        status: line.order.status,
        seq: line.seq,
        customerRef: customer,
        styleRef: { id: line.style.id, code: line.style.code, name: line.style.name },
        colourway: line.colourway,
        size: entry.size,
        promiseSource: current?.source ?? null,
      })
    }
  }
  return { rows, complete: read.length <= SALES_REPORT_LIMITS.read }
}

// ---- returns -----------------------------------------------------------------------------------------------------------------

export interface ReturnRow extends ReturnEntry {
  readonly number: string
  readonly status: string
  readonly seq: number
  readonly requestedOn: BusinessDate
  readonly styleRef: Ref | null
  readonly colourRef: { readonly code: string; readonly name: string } | null
  readonly sizeOf: string | null
  readonly customerRef: Ref
  readonly currency: string | null
}

const ORDER_LINE_FACTS = { styleId: true, colourwayId: true, style: { select: { id: true, code: true, name: true } }, colourway: { select: { id: true, code: true, name: true } }, order: { select: { currency: true } } } as const satisfies Prisma.SalesOrderLineSelect

/**
 * The lines of the returns asked for in the period (not rejected or cancelled) the caller reaches with sales.returns.view, with
 * the style, colour and size of the order line they name (directly or through their invoice line), the customer, the reason and
 * the credit decided. Without sales.returns.view: none.
 */
export async function returnsOf(db: Reader, place: Place): Promise<{ rows: ReturnRow[]; words: Map<string, { it: string; en: string }>; complete: boolean }> {
  if (!place.sight.returns) return { rows: [], words: new Map(), complete: true }
  const read = await db.returnLine.findMany({
    where: { rma: { AND: [place.returns, { status: { in: [...RETURN_STATUSES] }, requestedAt: { gte: place.span.start, lt: place.span.end } }] } },
    select: {
      id: true,
      seq: true,
      returnId: true,
      size: true,
      quantity: true,
      reasonCode: true,
      creditAmount: true,
      salesOrderLine: { select: ORDER_LINE_FACTS },
      invoiceLine: { select: { size: true, invoice: { select: { currency: true } }, salesOrderLine: { select: ORDER_LINE_FACTS } } },
      rma: { select: { number: true, status: true, requestedAt: true, party: { select: { id: true, code: true, legalName: true, tradeName: true } } } },
    },
    orderBy: [{ rma: { requestedAt: 'desc' } }, { returnId: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
    take: SALES_REPORT_LIMITS.read + 1,
  })
  const lines = read.slice(0, SALES_REPORT_LIMITS.read)
  const codes = unique(lines.map((line) => line.reasonCode))
  const reasons = codes.length === 0 ? [] : await db.reasonCode.findMany({ where: { list: 'RETURN', code: { in: codes } }, select: { code: true, labelIt: true, labelEn: true } })
  const words = new Map(reasons.map((row) => [row.code, { it: row.labelIt, en: row.labelEn }]))
  const rows = lines.map((line): ReturnRow => {
    const orderLine = line.salesOrderLine ?? line.invoiceLine?.salesOrderLine ?? null
    const size = line.size ?? line.invoiceLine?.size ?? null
    const currency = line.invoiceLine?.invoice.currency ?? orderLine?.order.currency ?? place.companyCurrency
    const customer = partyRef(line.rma.party)
    return {
      returnId: line.returnId,
      lineId: line.id,
      reason: line.reasonCode,
      style: orderLine?.styleId ?? NO_KEY,
      colour: orderLine ? `${orderLine.styleId}|${orderLine.colourwayId}` : NO_KEY,
      size: size ?? NO_KEY,
      customer: customer.id,
      pieces: line.quantity,
      credited: line.creditAmount !== null && currency ? { currency, value: line.creditAmount } : null,
      number: line.rma.number,
      status: line.rma.status,
      seq: line.seq,
      requestedOn: businessDate(line.rma.requestedAt),
      styleRef: orderLine ? orderLine.style : null,
      colourRef: orderLine ? { code: orderLine.colourway.code, name: orderLine.colourway.name } : null,
      sizeOf: size,
      customerRef: customer,
      currency,
    }
  })
  return { rows, words, complete: read.length <= SALES_REPORT_LIMITS.read }
}

/** Pieces shipped in the period on the orders the caller reaches (the return rate's whole); null without orders.view. */
export async function shippedPiecesOf(db: Reader, place: Place): Promise<number | null> {
  if (!place.sight.orders) return null
  const sum = await db.shipmentLine.aggregate({
    where: { shipment: { status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { gte: place.span.start, lt: place.span.end }, salesOrder: place.orders } },
    _sum: { quantity: true },
  })
  return sum._sum.quantity ?? 0
}

// ---- quote speed -------------------------------------------------------------------------------------------------------------

/** At most this many days back for a quote's start (its working minutes are counted from then). */
const SPEED_REACH_DAYS = 366

/**
 * The quotes first sent in the period (their first send of any version inside it), each from new — the inquiry it came from
 * (B-W2b-295: its arrival) else the quote's making — to that send in working minutes on its company's calendar; and the versions
 * answered in the period (ACCEPTED / DECLINED by the customer, EXPIRED by the sweep), with the hours from their send to the
 * answer and their net value. Without quotes.view: none.
 */
export async function quoteSpeedOf(db: Reader, place: Place): Promise<{ answers: { minutes: number | null; fromInquiry: boolean }[]; decisions: QuoteDecision[]; complete: boolean }> {
  if (!place.sight.quotes) return { answers: [], decisions: [], complete: true }
  const inside = { gte: place.span.start, lt: place.span.end }
  const quotes = await db.quote.findMany({
    where: { AND: [place.quotes, { versions: { some: { sentAt: inside } } }, { versions: { none: { sentAt: { lt: place.span.start } } } }] },
    select: { id: true, companyId: true, createdAt: true, versions: { where: { sentAt: { not: null } }, select: { sentAt: true }, orderBy: [{ sentAt: 'asc' }], take: 1 } },
    orderBy: [{ id: 'asc' }],
    take: SALES_REPORT_LIMITS.read + 1,
  })
  const shown = quotes.slice(0, SALES_REPORT_LIMITS.read)
  const quoteIds = shown.map((quote) => quote.id)
  const inquiries = quoteIds.length === 0 ? [] : await db.inquiry.findMany({ where: { quoteId: { in: quoteIds } }, select: { quoteId: true, receivedAt: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] })
  const arrived = new Map<string, Date>()
  for (const row of inquiries) if (row.quoteId && !arrived.has(row.quoteId)) arrived.set(row.quoteId, row.receivedAt)
  const starts = shown.map((quote) => ({ quote, start: arrived.get(quote.id) ?? quote.createdAt, sentAt: quote.versions[0]?.sentAt ?? null }))
  const answers: { minutes: number | null; fromInquiry: boolean }[] = []
  if (starts.length > 0) {
    const today = place.today
    const oldest = starts.map((entry) => businessDate(entry.start)).reduce((a, b) => (a < b ? a : b))
    const from = daysFrom(oldest, today) > SPEED_REACH_DAYS ? plusDays(today, -SPEED_REACH_DAYS) : plusDays(oldest, -2)
    const calendars = await workingCalendarsFor(db as Prisma.TransactionClient, unique(starts.map((entry) => entry.quote.companyId)).map((id) => ({ scope: 'COMPANY' as const, id })), { from, to: plusDays(today, 1) })
    const reach = new Date(`${plusDays(from, 1)}T00:00:00.000Z`)
    for (const entry of starts) {
      const calendar = calendars.get(ownerKey({ scope: 'COMPANY', id: entry.quote.companyId }))?.calendar
      if (!entry.sentAt) continue
      const start = entry.start < reach ? reach : entry.start
      // No working calendar for the company: the quote is counted, its time is not.
      answers.push({ minutes: calendar ? Math.round(workingMinutesBetween(calendar, start, entry.sentAt)) : null, fromInquiry: arrived.has(entry.quote.id) })
    }
  }
  const versions = await db.quoteVersion.findMany({
    where: { status: { in: ['ACCEPTED', 'DECLINED', 'EXPIRED'] }, closedAt: inside, quote: place.quotes },
    select: { status: true, sentAt: true, closedAt: true, netAmount: true, currency: true },
    orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
    take: SALES_REPORT_LIMITS.read + 1,
  })
  const decisions = versions.slice(0, SALES_REPORT_LIMITS.read).map(
    (version): QuoteDecision => ({
      outcome: version.status as QuoteOutcome,
      hours: version.sentAt && version.closedAt && version.closedAt > version.sentAt ? Math.round((version.closedAt.getTime() - version.sentAt.getTime()) / 3_600_000) : null,
      value: version.netAmount,
      currency: version.currency,
    }),
  )
  return { answers, decisions, complete: quotes.length <= SALES_REPORT_LIMITS.read && versions.length <= SALES_REPORT_LIMITS.read }
}
