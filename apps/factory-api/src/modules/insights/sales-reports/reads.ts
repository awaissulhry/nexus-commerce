import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  backlogFiguresOf,
  backlogGroupsOf,
  backlogWeekOf,
  backlogWeeksOf,
  bucketOfDay,
  FEES_KEY,
  horizonOf,
  intakeBucketsOf,
  intakeFold,
  NO_KEY,
  pctOf,
  quoteSpeedOf,
  returnFiguresOf,
  returnGroupsOf,
  returnHeatmapOf,
  SALES_REPORT_LIMITS,
  type BacklogFigures,
  type IntakeFigures,
  type QuoteSpeedFigures,
  type ReturnFigures,
  type ValueFigures,
} from '@nexus/factory-domain/insights/sales-reports/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../core/command'
import { headOf, placeOf } from './access'
import type { BacklogQuery, IntakeQuery, PeriodQuery } from './contract'
import { backlogOf, intakeOf, quoteSpeedOf as readQuoteSpeed, returnsOf, shippedPiecesOf } from './facts'

/**
 * The sales reports' answers (B-W2b-348): what facts.ts reads, folded by factory-domain insights/sales-reports/rules. Amounts are
 * marked with the price grain (the HTTP filter drops them for a caller without it); the groups are ranked by value only for a
 * caller who may see amounts (else by pieces), so the order itself never tells an amount.
 */

const price = <T>(value: T) => asMoney('price', value)

function valueView(figures: ValueFigures) {
  return { byCurrency: figures.byCurrency.map((entry) => ({ currency: entry.currency, value: price(entry.value) })), value: price(figures.value), currency: figures.currency, mixedCurrencies: figures.mixedCurrencies }
}
const intakeView = (figures: IntakeFigures) => ({ orders: figures.orders, pieces: figures.pieces, ...valueView(figures) })
const backlogView = (figures: BacklogFigures) => ({ orders: figures.orders, lines: figures.lines, pieces: figures.pieces, late: figures.late, ...valueView(figures) })
const returnView = (figures: ReturnFigures) => ({ returns: figures.returns, lines: figures.lines, pieces: figures.pieces, ...valueView(figures) })
const speedView = (speed: QuoteSpeedFigures) => ({
  answered: speed.answered,
  medianAnswerMinutes: speed.medianAnswerMinutes,
  fromInquiries: speed.fromInquiries,
  accepted: speed.accepted,
  declined: speed.declined,
  expired: speed.expired,
  winRatePct: speed.winRatePct,
  medianDecisionHours: speed.medianDecisionHours,
})

/** GET /sales/reports/headline (sec strip): the period in five numbers — intake, backlog now, quote win rate and speed, return rate. */
export async function headlineAnswer(caller: CommandCaller, query: PeriodQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const currency = place.companyCurrency
    const intake = await intakeOf(db, place)
    const backlog = await backlogOf(db, place)
    const speed = await readQuoteSpeed(db, place)
    const returns = await returnsOf(db, place)
    const shipped = await shippedPiecesOf(db, place)
    const returned = returnFiguresOf(returns.rows, currency)
    return {
      ...headOf(place),
      sight: place.sight,
      companyCurrency: currency,
      intake: place.sight.orders ? intakeView(intakeFold(intake.lines, [], 'none', { byValue: place.sight.values, companyCurrency: currency }).all) : null,
      backlog: place.sight.orders ? backlogView(backlogFiguresOf(backlog.rows, place.today, currency)) : null,
      quotes: place.sight.quotes ? speedView(quoteSpeedOf(speed.answers, speed.decisions, currency)) : null,
      returns: place.sight.returns ? { returns: returned.returns, pieces: returned.pieces, shipped, returnRatePct: shipped === null ? null : pctOf(returned.pieces, shipped) } : null,
      complete: intake.complete && backlog.complete && speed.complete && returns.complete,
    }
  })
}

/** GET /sales/reports/intake (sec intake, SAL-105): the orders booked by week or month, split by customer, style or season. */
export async function intakeAnswer(caller: CommandCaller, query: IntakeQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const read = await intakeOf(db, place)
    const buckets = intakeBucketsOf(place.period, query.by)
    const fold = intakeFold(read.lines, buckets, query.split, { byValue: place.sight.values, companyCurrency: place.companyCurrency })
    const customers = new Map(read.orders.map((order) => [order.customer.id, order.customer]))
    const seasons = new Map(read.orders.flatMap((order) => (order.season ? [[order.season.id, order.season] as const] : [])))
    const labelOf = (key: string): { code: string | null; name: string | null } => {
      if (key === FEES_KEY || key === NO_KEY) return { code: null, name: null }
      const named = query.split === 'customer' ? customers.get(key) : query.split === 'style' ? read.styles.get(key) : seasons.get(key)
      return named ? { code: named.code, name: named.name } : { code: null, name: null }
    }
    const shown = fold.groups.slice(0, SALES_REPORT_LIMITS.groups)
    return {
      ...headOf(place),
      sight: place.sight,
      by: query.by,
      split: query.split,
      companyCurrency: place.companyCurrency,
      all: intakeView(fold.all),
      buckets: fold.buckets.map((bucket) => ({ key: bucket.key, from: bucket.from, to: bucket.to, figures: intakeView(bucket.figures) })),
      groups: shown.map((group) => ({ key: group.key, ...labelOf(group.key), figures: intakeView(group.figures), buckets: group.buckets.map((bucket) => ({ key: bucket.key, figures: intakeView(bucket.figures) })) })),
      more: Math.max(0, fold.groups.length - shown.length),
      orders: read.orders.slice(0, SALES_REPORT_LIMITS.rows).map((order) => {
        const styles = new Map<string, { pieces: number; value: number }>()
        for (const line of order.lines) {
          const seen = styles.get(line.style) ?? { pieces: 0, value: 0 }
          styles.set(line.style, { pieces: seen.pieces + line.pieces, value: seen.value + line.value })
        }
        return {
          id: order.id,
          number: order.number,
          status: order.status,
          customer: order.customer,
          bookedOn: order.bookedOn,
          orderDate: order.orderDate,
          splitOff: order.splitOff,
          season: order.season,
          bucket: bucketOfDay(buckets, order.bookedOn) ?? '',
          pieces: order.lines.reduce((sum, line) => sum + line.pieces, 0),
          value: price(order.lines.reduce((sum, line) => sum + line.value, 0)),
          currency: order.currency,
          styles: [...styles.entries()].map(([key, entry]) => ({ key, pieces: entry.pieces, value: price(entry.value) })),
        }
      }),
      complete: read.complete && read.orders.length <= SALES_REPORT_LIMITS.rows,
    }
  })
}

/**
 * GET /sales/reports/backlog (sec backlog, SAL-106): what is confirmed and not shipped, by the week of each size's promise now
 * (late weeks before this one), by customer or style with the pieces per horizon, and every open size behind them.
 */
export async function backlogAnswer(caller: CommandCaller, query: BacklogQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, {})
    const { rows, complete } = await backlogOf(db, place)
    const today = place.today
    const currency = place.companyCurrency
    const weeks = backlogWeeksOf(rows, today)
    const weekOf = new Map(rows.map((row) => [row, backlogWeekOf(weeks, row.promise)]))
    const groups = backlogGroupsOf(rows, query.by, today, { byValue: place.sight.values, companyCurrency: currency })
    const shown = groups.slice(0, SALES_REPORT_LIMITS.groups)
    const customers = new Map(rows.map((row) => [row.customer, row.customerRef]))
    const styles = new Map(rows.map((row) => [row.style, row.styleRef]))
    const sorted = [...rows].sort((a, b) => (a.promise ?? '9999-12-31').localeCompare(b.promise ?? '9999-12-31') || a.number.localeCompare(b.number) || a.seq - b.seq || (a.size ?? '').localeCompare(b.size ?? ''))
    return {
      company: place.company,
      today,
      asOf: toUtcIso(place.now),
      sight: place.sight,
      by: query.by,
      companyCurrency: currency,
      all: backlogView(backlogFiguresOf(rows, today, currency)),
      weeks: weeks.map((week) => ({ ...week, figures: backlogView(backlogFiguresOf(rows.filter((row) => weekOf.get(row) === week.key), today, currency)) })),
      groups: shown.map((group) => {
        const named = query.by === 'customer' ? customers.get(group.key) : styles.get(group.key)
        return { key: group.key, code: named?.code ?? '', name: named?.name ?? '', figures: backlogView(group.figures), horizons: group.horizons }
      }),
      more: Math.max(0, groups.length - shown.length),
      lines: sorted.slice(0, SALES_REPORT_LIMITS.rows).map((row) => ({
        orderId: row.orderId,
        number: row.number,
        status: row.status,
        lineId: row.lineId,
        seq: row.seq,
        customer: row.customerRef,
        style: row.styleRef,
        colourway: row.colourway,
        size: row.size,
        open: row.open,
        promise: row.promise,
        promiseSource: row.promiseSource,
        week: weekOf.get(row) ?? 'NONE',
        horizon: horizonOf(row.promise, today),
        value: price(row.value),
        currency: row.currency,
      })),
      complete: complete && rows.length <= SALES_REPORT_LIMITS.rows,
    }
  })
}

/** GET /sales/reports/returns (sec returns, SAL-458): the return lines of the period by reason, style, size, colour and customer. */
export async function returnsAnswer(caller: CommandCaller, query: PeriodQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query)
    const currency = place.companyCurrency
    const { rows, words, complete } = await returnsOf(db, place)
    const shipped = await shippedPiecesOf(db, place)
    const all = returnFiguresOf(rows, currency)
    const styles = new Map(rows.flatMap((row) => (row.styleRef ? [[row.style, row.styleRef] as const] : [])))
    const colours = new Map(rows.flatMap((row) => (row.colourRef ? [[row.colour, row.colourRef] as const] : [])))
    const customers = new Map(rows.map((row) => [row.customer, row.customerRef]))
    const named = (by: 'style' | 'colour' | 'size' | 'customer') =>
      returnGroupsOf(rows, by, currency)
        .slice(0, SALES_REPORT_LIMITS.groups)
        .map((group) => {
          const label = by === 'style' ? styles.get(group.key) : by === 'colour' ? colours.get(group.key) : by === 'customer' ? customers.get(group.key) : null
          return { key: group.key, code: label?.code ?? (by === 'size' && group.key !== NO_KEY ? group.key : null), name: label?.name ?? null, figures: returnView(group.figures) }
        })
    const map = returnHeatmapOf(rows)
    return {
      ...headOf(place),
      sight: place.sight,
      companyCurrency: currency,
      all: returnView(all),
      shipped,
      returnRatePct: shipped === null ? null : pctOf(all.pieces, shipped),
      reasons: returnGroupsOf(rows, 'reason', currency).map((group) => ({ key: group.key, words: words.get(group.key) ?? null, figures: returnView(group.figures) })),
      styles: named('style'),
      colours: named('colour'),
      sizes: named('size'),
      customers: named('customer'),
      heatmap: { styles: map.styles.map((key) => ({ key, code: styles.get(key)?.code ?? '', name: styles.get(key)?.name ?? '' })), sizes: map.sizes, cells: map.cells },
      lines: rows.slice(0, SALES_REPORT_LIMITS.rows).map((row) => ({
        returnId: row.returnId,
        number: row.number,
        status: row.status,
        lineId: row.lineId,
        seq: row.seq,
        requestedOn: row.requestedOn,
        reason: row.reason,
        style: row.styleRef,
        colour: row.colourRef,
        size: row.sizeOf,
        customer: row.customerRef,
        pieces: row.pieces,
        credited: price(row.credited?.value ?? null),
        currency: row.currency,
      })),
      complete: complete && rows.length <= SALES_REPORT_LIMITS.rows,
    }
  })
}

/** GET /sales/reports/quote-speed (Sales › Quotes sec quotes.speed): how fast we answer and how often we win, in the period. */
export async function quoteSpeedAnswer(caller: CommandCaller, query: PeriodQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(db, caller, query, 'quotes')
    const read = await readQuoteSpeed(db, place)
    const speed = quoteSpeedOf(read.answers, read.decisions, place.companyCurrency)
    return { ...headOf(place), sight: place.sight, companyCurrency: place.companyCurrency, ...speedView(speed), won: valueView(speed.won), complete: read.complete }
  })
}
