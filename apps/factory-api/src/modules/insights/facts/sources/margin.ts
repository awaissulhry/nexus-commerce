import type { Prisma } from '@nexus/factory-db'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import type { WhereClause } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { shareOf } from '@nexus/factory-domain/insights/kpis/margin'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { convertMinor } from '@nexus/factory-domain/money/currency/convert'
import type { RateBook } from '../../../../platform/currency/service'
import { numberOf, type DayFact, type Reader, type Source } from '../rows'

/**
 * The margin source (B-W2b-429; ANA-021; measures margin.shipped_value, margin.quoted, margin.actual, margin.unconverted;
 * rules factory-domain insights/kpis/margin.ts): the cost of goods sold posted at shipment (B-W2b-407's CostOfSalesEntry; a
 * reversed entry and its reversal left out) of the garments that left on a day of the company's clock, against the net value
 * and the cost at order of their sales order line, in the company's currency (an order in another currency at the day's
 * rate; no rate: left out and counted in margin.unconverted). Lines with no cost at order are left out. One row per measure
 * and day at company level, zeros included. `readMarginRows` is also the drill's read (kpis/drills/margin.ts).
 */

const CHUNK = 1000

export interface MarginRow {
  readonly entryId: string
  readonly companyId: string
  readonly partyId: string
  readonly day: BusinessDate
  readonly orderId: string
  readonly orderNumber: string
  readonly seasonId: string | null
  readonly styleId: string
  readonly garments: number
  /** Minor units of the company's currency; null: no rate of the day for the order's currency. */
  readonly value: number | null
  readonly quotedCost: number | null
  readonly actualCost: number | null
  readonly currency: string
}

/**
 * The garments that left between two days on their company's clock with their cost of goods sold posted and a cost at order.
 * `where` is a reader's own scope (company and customer of the entry); `extra` the drill's filters on the order line.
 */
export async function readMarginRows(db: Reader, input: { readonly companies: readonly { readonly id: string; readonly currency: string; readonly timezone: string }[]; readonly from: BusinessDate; readonly to: BusinessDate; readonly rates: RateBook; readonly where?: WhereClause | undefined; readonly extra?: Prisma.SalesOrderLineWhereInput }): Promise<MarginRow[]> {
  const rows: MarginRow[] = []
  for (const company of input.companies) {
    const entries = await db.costOfSalesEntry.findMany({
      where: {
        AND: [
          (input.where ?? {}) as Prisma.CostOfSalesEntryWhereInput,
          { companyId: company.id, reversalOfId: null, shipmentLineId: { not: null } },
          { shipmentLine: { shipment: { shippedAt: { gte: businessDayRange(input.from, company.timezone).start, lt: businessDayRange(input.to, company.timezone).end } }, salesOrderLine: { AND: [{ costAmount: { not: null } }, input.extra ?? {}] } } },
        ],
      },
      select: { id: true, partyId: true, quantity: true, amount: true, currency: true, shipmentLine: { select: { shipment: { select: { shippedAt: true } }, salesOrderLine: { select: { styleId: true, quantity: true, netAmount: true, costAmount: true, order: { select: { id: true, number: true, currency: true, seasonId: true } } } } } } },
      orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
    })
    const reversed = new Set<string>()
    for (let index = 0; index < entries.length; index += CHUNK) {
      for (const row of await db.costOfSalesEntry.findMany({ where: { reversalOfId: { in: entries.slice(index, index + CHUNK).map((entry) => entry.id) } }, select: { reversalOfId: true } })) reversed.add(row.reversalOfId!)
    }
    for (const entry of entries) {
      if (reversed.has(entry.id) || !entry.shipmentLine?.shipment.shippedAt) continue
      const line = entry.shipmentLine.salesOrderLine
      const day = businessDate(entry.shipmentLine.shipment.shippedAt, company.timezone)
      const garments = Number(entry.quantity.toString())
      const inCompany = (amount: number, currency: string): number | null => {
        if (currency === company.currency) return amount
        const rate = input.rates.rate(company.currency, currency, day)
        return rate ? convertMinor(amount, currency, company.currency, rate) : null
      }
      rows.push({
        entryId: entry.id,
        companyId: company.id,
        partyId: entry.partyId,
        day,
        orderId: line.order.id,
        orderNumber: line.order.number,
        seasonId: line.order.seasonId,
        styleId: line.styleId,
        garments,
        value: inCompany(shareOf(line.netAmount, garments, line.quantity), line.order.currency),
        quotedCost: inCompany(shareOf(line.costAmount!, garments, line.quantity), line.order.currency),
        actualCost: inCompany(entry.amount, entry.currency),
        currency: company.currency,
      })
    }
  }
  return rows
}

export const marginSource: Source = async (db, { company, from, to, now, rates, where }) => {
  const today = businessDate(now, company.timezone)
  const last = to < today ? to : today
  if (last < from) return { daily: [], hourly: [] }
  const rows = await readMarginRows(db, { companies: [company], from, to: last, rates, where })
  const days = new Map(eachDay(from, last).map((day) => [day, { value: 0, quoted: 0, actual: 0, unconverted: 0 }]))
  for (const row of rows) {
    const sums = days.get(row.day)
    if (!sums) continue
    if (row.value === null || row.quotedCost === null || row.actualCost === null) {
      sums.unconverted += 1
      continue
    }
    sums.value += row.value
    sums.quoted += row.value - row.quotedCost
    sums.actual += row.value - row.actualCost
  }
  const daily: DayFact[] = []
  const of = { 'margin.shipped_value': 'value', 'margin.quoted': 'quoted', 'margin.actual': 'actual', 'margin.unconverted': 'unconverted' } as const
  for (const [day, sums] of days) {
    for (const [key, field] of Object.entries(of) as [keyof typeof of, (typeof of)[keyof typeof of]][]) {
      daily.push({ companyId: company.id, siteId: null, lineId: null, day, measureKey: key, number: numberOf(measureOf(key)!, sums[field]) })
    }
  }
  return { daily, hourly: [] }
}
