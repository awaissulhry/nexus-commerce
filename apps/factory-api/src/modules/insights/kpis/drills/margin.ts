import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { addFigures, marginOf, type MarginFigures } from '@nexus/factory-domain/insights/kpis/margin'
import { convertMinor } from '@nexus/factory-domain/money/currency/convert'
import { EURO } from '@nexus/factory-domain/money/currency/currencies'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../../core/command'
import { loadRateBook } from '../../../../platform/currency/service'
import { readMarginRows, type MarginRow } from '../../facts/sources/margin'
import { asOf, companiesFor, drillActor, groupBy, holdsGrain, limited, namesOf, refOf, spanOf } from './access'

/**
 * GET /insights/kpis/drills/margin (B-W2b-429; ANA-021 "quoted against actual margin per order, rolled up by customer and style,
 * only with the margin grain"; KPIs sales.margin_quoted, sales.margin_actual): the garments that left in the period with their
 * cost of goods sold posted and a cost at order (the margin source's own read), per order, customer and style: value, cost at
 * order, cost of goods sold, the two margins and the points between them. costing.view over the company and customer, the
 * margin and price grains (403 otherwise); costs need the cost grain, and the margin AMOUNTS too (Owner answer S2: with the
 * price they would give the cost). Companies in several currencies count in the euro at each day's rate.
 */

export interface MarginDrillQuery {
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly styleId?: string | undefined
  readonly seasonId?: string | undefined
}

type Counted = MarginRow & MarginFigures

export async function marginDrill(caller: CommandCaller, query: MarginDrillQuery) {
  const kpiKey = 'sales.margin_actual'
  const actor = drillActor(caller, [kpiKey, 'sales.margin_quoted'])
  const span = spanOf(kpiKey, query)
  const withCost = holdsGrain(actor, 'cost')
  return caller.withClient(async (db) => {
    const companies = await companiesFor(db, actor, COSTING_VIEW, query.companyId)
    const rates = await loadRateBook(db, span.from, span.to)
    const extra: Prisma.SalesOrderLineWhereInput = {
      ...(query.partyId ? { partyId: query.partyId } : {}),
      ...(query.styleId ? { styleId: query.styleId } : {}),
      ...(query.seasonId ? { order: { seasonId: query.seasonId } } : {}),
    }
    const read = await readMarginRows(db, { companies, from: span.from, to: span.to, rates, where: scopeWhere(actor, COSTING_VIEW, { company: 'companyId', party: 'partyId' }), extra })
    // One currency: the companies'; several: the euro at each day's rate. Garments with no rate are counted apart.
    const currencies = [...new Set(read.map((row) => row.currency))].sort()
    const currency = currencies.length > 1 ? EURO : (currencies[0] ?? null)
    const toCurrency = (amount: number | null, from: string, day: BusinessDate): number | null => {
      if (amount === null || currency === null || from === currency) return amount
      const rate = rates.rate(EURO, from, day)
      return rate ? convertMinor(amount, from, EURO, rate) : null
    }
    let unconverted = 0
    const counted: Counted[] = []
    for (const row of read) {
      const value = toCurrency(row.value, row.currency, row.day)
      const quotedCost = toCurrency(row.quotedCost, row.currency, row.day)
      const actualCost = toCurrency(row.actualCost, row.currency, row.day)
      if (value === null || quotedCost === null || actualCost === null) {
        unconverted += 1
        continue
      }
      counted.push({ ...row, value, quotedCost, actualCost })
    }
    const names = await namesOf(db, { parties: counted.map((row) => row.partyId), styles: counted.map((row) => row.styleId), seasons: counted.map((row) => row.seasonId) })
    const view = (rows: readonly Counted[]) => {
      const margin = marginOf(addFigures(rows))
      return {
        value: asMoney('price', margin.value),
        quotedCost: asMoney('cost', margin.quotedCost),
        actualCost: asMoney('cost', margin.actualCost),
        quotedMargin: asMoney('margin', withCost ? margin.quotedMargin : null),
        actualMargin: asMoney('margin', withCost ? margin.actualMargin : null),
        quotedPct: asMoney('margin', margin.quotedPct),
        actualPct: asMoney('margin', margin.actualPct),
        changePts: asMoney('margin', margin.changePts),
      }
    }
    const garmentsOf = (rows: readonly Counted[]) => rows.reduce((total, row) => total + row.garments, 0)
    const byOrder = [...groupBy(counted, (row) => row.orderId).values()]
      .map((mine) => ({ mine, last: mine.reduce((day, row) => (row.day > day ? row.day : day), mine[0]!.day) }))
      .sort((a, b) => (a.last !== b.last ? (a.last < b.last ? 1 : -1) : a.mine[0]!.orderNumber.localeCompare(b.mine[0]!.orderNumber)))
    const { rows, more } = limited(byOrder)
    return {
      kpiKey,
      period: span,
      asOf: asOf(),
      currency,
      converted: currencies.length > 1 ? currencies.filter((code) => code !== EURO) : [],
      unconverted,
      totals: { ...view(counted), garments: garmentsOf(counted), orders: byOrder.length },
      byCustomer: [...groupBy(counted, (row) => row.partyId)]
        .map(([partyId, mine]) => ({ customer: refOf(names.party, partyId), orders: new Set(mine.map((row) => row.orderId)).size, garments: garmentsOf(mine), ...view(mine) }))
        .sort((a, b) => Number(b.value) - Number(a.value)),
      byStyle: [...groupBy(counted, (row) => row.styleId)].map(([styleId, mine]) => ({ style: refOf(names.style, styleId), garments: garmentsOf(mine), ...view(mine) })).sort((a, b) => Number(b.value) - Number(a.value)),
      rows: rows.map(({ mine, last }) => ({
        record: { type: 'SalesOrder', id: mine[0]!.orderId, label: mine[0]!.orderNumber },
        order: { id: mine[0]!.orderId, number: mine[0]!.orderNumber },
        customer: refOf(names.party, mine[0]!.partyId),
        season: refOf(names.season, mine[0]!.seasonId),
        lastShippedOn: last,
        garments: garmentsOf(mine),
        ...view(mine),
      })),
      more,
    }
  })
}
