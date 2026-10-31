import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { lensesFor } from '@nexus/factory-domain/insights/flow'
import { CUT_OFF, numbersFor, TARGET_SET_BY, targetWordOf, type NumberRule } from '@nexus/factory-domain/insights/reports/numbers'
import { lastWeeks, pctText, periodRange, weekStart, type DayRange } from '@nexus/factory-domain/insights/reports/results'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import { QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { listCertificates } from '../../compliance/certificates/certificates'
import { orderMargins } from '../../costing/margins/margins'
import { stockValuation } from '../../costing/valuation/valuation'
import { capacity } from '../../planning/capacity/capacity'
import { shortages } from '../../planning/readiness/readiness'
import { dailyView, previousWorkingDayOf, readDaily, siteFor } from '../../production/reports/daily'
import { countWorkOrders } from '../../production/work-orders/work-orders'
import { expectedDeliveries, listOrders as listPurchaseOrders } from '../../purchasing/orders'
import { ncrCounts } from '../../quality/ncr/reads'
import { ageing } from '../../receivables/ageing'
import { officeContextOf } from '../viewer'
import { OPEN_ORDER_STATUSES } from './kit'
import { sitesReached } from './run'

/**
 * GET /home/numbers (B-W2a-79; ANA-001; design home.today `key-numbers` + pop:number-explain): per Today lens the person
 * has, its three to five numbers (factory-domain insights/reports/numbers: only those whose list and grain the person
 * holds), each read AS THE PERSON through its module's own read or in its records' own scope, with its target word, its
 * 8-week line where the records' dates make one, and how it is made. A number that cannot be read now says so (null,
 * `problem`), never 0. Money is marked with its grain (the grain filter drops it again for anyone without it). Read only.
 */

export const NUMBER_PROBLEMS = ['UNAVAILABLE', 'MIXED_CURRENCIES', 'NO_DATA'] as const
export type NumberProblem = (typeof NUMBER_PROBLEMS)[number]

interface Reading {
  readonly value: number | null
  readonly currency?: string | null
  readonly spark?: readonly (number | null)[] | null
  readonly complete?: boolean
  readonly problem?: NumberProblem | null
}

interface Context {
  readonly caller: CommandCaller
  readonly actor: Actor
  readonly today: BusinessDate
  readonly now: Date
}

const day = (value: BusinessDate) => new Date(`${value}T00:00:00Z`)
const ordersScope = (actor: Actor) => scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' })
const decimal = (value: string | null | undefined) => (value === null || value === undefined ? null : Number.parseFloat(value))

/** Sums per week of (day, amount, currency) rows; one currency only (else the value is not summed). */
function weeklySums(rows: readonly { day: BusinessDate; amount: number; currency: string }[], weeks: readonly DayRange[], current: DayRange): Reading {
  const currencies = new Set(rows.map((row) => row.currency))
  if (currencies.size > 1) return { value: null, problem: 'MIXED_CURRENCIES', spark: null }
  const sum = (range: DayRange) => rows.filter((row) => row.day >= range.from && row.day <= range.to).reduce((total, row) => total + row.amount, 0)
  return { value: sum(current), currency: [...currencies][0] ?? null, spark: weeks.map(sum) }
}

const READERS: Readonly<Record<string, (context: Context) => Promise<Reading>>> = Object.freeze({
  async 'orders.inThisWeek'({ caller, actor, today }) {
    const weeks = lastWeeks(today)
    const found = await caller.withClient((db) =>
      db.salesOrder.findMany({
        where: { AND: [ordersScope(actor) as Prisma.SalesOrderWhereInput, { status: { not: 'CANCELLED' }, orderDate: { gte: day(weeks[0]!.from), lte: day(today) } }] },
        select: { orderDate: true, netAmount: true, currency: true },
      }),
    )
    return weeklySums(found.map((row) => ({ day: businessDate(row.orderDate, 'UTC'), amount: row.netAmount, currency: row.currency })), weeks, periodRange('THIS_WEEK', today))
  },

  async 'orders.late'({ caller, actor, today }) {
    const value = await caller.withClient((db) => db.salesOrder.count({ where: { AND: [ordersScope(actor) as Prisma.SalesOrderWhereInput, { status: { in: [...OPEN_ORDER_STATUSES] }, promiseDate: { lt: day(today) } }] } }))
    return { value }
  },

  async 'orders.promisedThisWeek'({ caller, actor, today }) {
    const week = periodRange('THIS_WEEK', today)
    const value = await caller.withClient((db) =>
      db.salesOrder.count({ where: { AND: [ordersScope(actor) as Prisma.SalesOrderWhereInput, { status: { in: [...OPEN_ORDER_STATUSES] }, promiseDate: { gte: day(week.from), lte: day(week.to) } }] } }),
    )
    return { value }
  },

  async 'orders.shippedOnTime'({ caller, actor, today }) {
    const weeks = lastWeeks(today)
    const found = await caller.withClient((db) =>
      db.shipment.findMany({
        where: {
          AND: [
            ordersScope(actor) as Prisma.ShipmentWhereInput,
            { status: { in: ['SHIPPED', 'DELIVERED'] }, shippedAt: { gte: new Date(day(weeks[0]!.from).getTime() - 86_400_000) }, salesOrder: { promiseDate: { not: null } } },
          ],
        },
        select: { shippedAt: true, salesOrder: { select: { promiseDate: true } } },
      }),
    )
    const shipped = found
      .filter((row) => row.shippedAt && row.salesOrder.promiseDate)
      .map((row) => ({ day: businessDate(row.shippedAt!), onTime: businessDate(row.shippedAt!) <= businessDate(row.salesOrder.promiseDate!, 'UTC') }))
    const share = (range: DayRange) => {
      const inRange = shipped.filter((row) => row.day >= range.from && row.day <= range.to)
      const text = pctText(inRange.filter((row) => row.onTime).length, inRange.length)
      return text === null ? null : Number.parseFloat(text)
    }
    const value = share({ from: weeks[4]!.from, to: today })
    return { value, spark: weeks.map(share), problem: value === null ? 'NO_DATA' : null }
  },

  async 'orders.marginThisMonth'({ caller, today }) {
    const month = periodRange('THIS_MONTH', today)
    const answer = await orderMargins(caller, { status: ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED'], from: month.from, to: today, limit: 1 })
    const average = decimal(answer.tiles.averageMarginPct as string | null)
    const value = average === null ? null : Math.round(average * 10) / 10
    return { value, problem: value === null ? 'NO_DATA' : null }
  },

  async 'workorders.late'({ caller }) {
    return { value: (await countWorkOrders(caller, {})).counts.late }
  },

  async 'planning.shortages'({ caller, actor }) {
    const ids = new Set<string>()
    for (const site of await sitesReached(caller, actor, PLANNING_VIEW)) {
      for (const row of (await shortages(caller, { siteId: site.id })).rows) if (row.workOrder.status === 'RELEASED' || row.workOrder.status === 'IN_PROGRESS') ids.add(row.workOrder.id)
    }
    return { value: ids.size }
  },

  async 'planning.loadNextWeek'({ caller, actor, today }) {
    const from = plusDays(weekStart(today), 7)
    let booked = 0
    let available = 0
    for (const site of await sitesReached(caller, actor, PLANNING_VIEW)) {
      const answer = await capacity(caller, { siteId: site.id, from, to: plusDays(from, 6), bucket: 'WEEK' })
      for (const lane of answer.lanes) {
        booked += decimal(lane.overall.bookedMinutes as unknown as string) ?? 0
        available += decimal(lane.overall.availableMinutes as unknown as string) ?? 0
      }
    }
    const text = pctText(booked, available)
    return { value: text === null ? null : Number.parseFloat(text), problem: text === null ? 'NO_DATA' : null }
  },

  async 'production.goodLastDay'({ caller, actor, today }) {
    let good = 0
    for (const reached of await sitesReached(caller, actor, PRODUCTION_REPORTS_VIEW)) {
      good += await caller.withClient(async (db) => {
        const site = await siteFor(db, actor, PRODUCTION_REPORTS_VIEW, reached.id)
        return dailyView(await readDaily(db, site, await previousWorkingDayOf(db, site.id, today))).totals.good
      })
    }
    return { value: good }
  },

  async 'purchasing.notConfirmed'({ caller }) {
    return { value: (await listPurchaseOrders(caller, { limit: 1 })).summary.notConfirmedAfter48h }
  },

  async 'purchasing.lateDeliveries'({ caller }) {
    const answer = await expectedDeliveries(caller, { limit: 1 })
    return { value: answer.tiles.LATE.orders, complete: answer.complete }
  },

  async 'purchasing.dueThisWeek'({ caller }) {
    const answer = await expectedDeliveries(caller, { limit: 1 })
    return { value: answer.tiles.THIS_WEEK.orders, complete: answer.complete }
  },

  async 'finance.overdue'({ caller }) {
    const tiles = (await ageing(caller, { limit: 1 })).tiles as readonly { currency: string; overdue: unknown }[]
    if (tiles.length > 1) return { value: null, problem: 'MIXED_CURRENCIES' }
    const tile = tiles[0]
    return tile ? { value: Number(tile.overdue), currency: tile.currency } : { value: 0, currency: null }
  },

  async 'finance.sdiRefused'({ caller, actor }) {
    const value = await caller.withClient((db) =>
      db.invoice.count({ where: { AND: [scopeWhere(actor, INVOICES_VIEW, { company: 'companyId', party: 'buyerPartyId' }) as Prisma.InvoiceWhereInput, { status: 'REJECTED' }] } }),
    )
    return { value }
  },

  async 'finance.invoicedThisWeek'({ caller, actor, today }) {
    const weeks = lastWeeks(today)
    const found = await caller.withClient((db) =>
      db.invoice.findMany({
        where: {
          AND: [
            scopeWhere(actor, INVOICES_VIEW, { company: 'companyId', party: 'buyerPartyId' }) as Prisma.InvoiceWhereInput,
            // A rejected invoice counts as never issued until it is sent again (SDI NS).
            { status: { notIn: ['DRAFT', 'REJECTED'] }, issueDate: { gte: day(weeks[0]!.from), lte: day(today) } },
          ],
        },
        select: { issueDate: true, netTotal: true, docType: true, currency: true },
      }),
    )
    return weeklySums(
      found.filter((row) => row.issueDate).map((row) => ({ day: businessDate(row.issueDate!, 'UTC'), amount: row.docType === 'TD04' ? -row.netTotal : row.netTotal, currency: row.currency })),
      weeks,
      periodRange('THIS_WEEK', today),
    )
  },

  async 'finance.stockValue'({ caller }) {
    const answer = await stockValuation(caller, {})
    const value = answer.value as unknown as number | null
    return { value, currency: answer.currency, complete: !answer.truncated, problem: value === null && answer.rows.length > 0 ? 'MIXED_CURRENCIES' : null }
  },

  async 'quality.lotsOnHold'({ caller, actor }) {
    const value = await caller.withClient((db) =>
      db.lot.count({ where: { AND: [scopeWhere(actor, QUALITY_LOTS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.LotWhereInput, { qualityStatus: { in: ['QUARANTINE', 'BLOCKED'] } }] } }),
    )
    return { value }
  },

  async 'quality.ncrOverdue'({ caller }) {
    return { value: (await ncrCounts(caller, {})).counts.containmentOverdue }
  },

  async 'quality.ncrOpen'({ caller }) {
    return { value: (await ncrCounts(caller, {})).counts.open }
  },

  async 'compliance.certificatesExpiring'({ caller }) {
    const answer = await listCertificates(caller, { expiringWithinDays: 90 })
    return { value: answer.certificates.length, complete: answer.certificates.length < 500 }
  },
})

/** The readers' keys (a test holds them equal to the registry's). */
export const NUMBER_READER_KEYS: readonly string[] = Object.freeze(Object.keys(READERS))

/** A value for the answer: money and margin numbers marked with their grain. */
const marked = (rule: NumberRule, value: unknown) => (value === null || value === undefined ? null : rule.grain ? markMoney(rule.grain, value) : value)

async function readNumber(rule: NumberRule, context: Context) {
  const reader = READERS[rule.key]
  let reading: Reading
  try {
    reading = reader ? await reader(context) : { value: null, problem: 'UNAVAILABLE' }
  } catch {
    // One number that cannot be read does not take Today down: it says "Not available now".
    reading = { value: null, problem: 'UNAVAILABLE' }
  }
  return {
    key: rule.key,
    label: rule.label,
    unit: rule.unit,
    grain: rule.grain,
    value: marked(rule, reading.value),
    currency: reading.currency ?? null,
    target: rule.target ? { ...rule.target } : null,
    targetWord: targetWordOf(reading.value, rule.target),
    history: rule.history,
    spark: rule.history && reading.spark ? marked(rule, [...reading.spark]) : null,
    complete: reading.complete ?? true,
    problem: reading.problem ?? null,
    list: rule.list ? { api: rule.list.api, query: { ...rule.list.query } } : null,
    report: rule.report ? { key: rule.report.key, filters: { ...rule.report.filters } } : null,
    explain: { definition: rule.definition, formula: rule.formula, sources: rule.sources, period: rule.period, cutOff: CUT_OFF, setBy: rule.target ? TARGET_SET_BY : null },
  }
}

/** GET /home/numbers: my numbers per lens (the lenses of Today's flow strip that have numbers for me). */
export async function myNumbers(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  const run: Context = { caller, actor, today: businessDate(now), now }
  const lenses = []
  for (const lens of lensesFor(actor)) {
    const rules = numbersFor(actor, lens)
    if (rules.length === 0) continue
    const numbers = []
    for (const rule of rules) numbers.push(await readNumber(rule, run))
    lenses.push({ lens, numbers })
  }
  return { asOf: toUtcIso(now), today: run.today, lenses }
}
