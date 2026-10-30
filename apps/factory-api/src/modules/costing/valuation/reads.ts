import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { LayersQuery, LeatherQuery } from '@nexus/factory-domain/costing/valuation/contracts'
import { areaM2, basisWords, dependsOnMethod, totalsOf, unitCostOf, valuationRows, valuePerM2, type ValuedState } from '@nexus/factory-domain/costing/valuation/rules'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { lotUnitCost, type ValuationMethod } from '@nexus/factory-domain/inventory/ledger/valuation'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { siteFor } from '../../inventory/ledger/access'
import { unique } from '../actual/store'
import { endOfDay, keyBalances, methodsOf, visibleSites } from './valuation'

/**
 * "How this lot is valued" (design finance.reports pop-up: method, cost layers, receipts and their prices) and value by
 * hide area (SCM-256; design warehouse.hides "Leather dashboard": an area value series by article and colour, only with
 * the cost grain). Office reads with inventory.stock.view over the site; every value is money.cost.
 */

const LAYER_COLUMNS = {
  id: true,
  reason: true,
  occurredAt: true,
  reference: true,
  hideId: true,
  fromLocationId: true,
  toLocationId: true,
  baseQuantity: true,
  receiptLineId: true,
  reversalOfId: true,
} as const satisfies Prisma.StockMoveSelect

/** GET /costing/valuation/layers: one stock key's moves up to the date, each with what the ledger valued it at. */
export async function valuationLayers(caller: CommandCaller, query: LayersQuery) {
  const site = await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'query/siteId')
  const at = query.asOf ? endOfDay(query.asOf) : null
  return caller.withClient(async (db) => {
    const item = isUuid(query.itemId) ? await db.item.findUnique({ where: { id: query.itemId }, select: { id: true, code: true, name: true, kind: true, baseUom: true, tracking: true } }) : null
    if (!item) throw new NotFoundError('Item not found.')
    const lot = query.lotId ? await db.lot.findUnique({ where: { id: query.lotId }, select: { id: true, code: true, qualityStatus: true, siteId: true, itemId: true } }) : null
    if (query.lotId && (!lot || lot.siteId !== site.id || lot.itemId !== item.id)) throw new NotFoundError('Lot not found.')
    const key: Prisma.StockMoveWhereInput = {
      siteId: site.id,
      itemId: item.id,
      ...(query.itemColourId ? { itemColourId: query.itemColourId } : {}),
      ...(query.lotId ? { lotId: query.lotId } : {}),
      ...(query.hideId ? { hideId: query.hideId } : {}),
      ...(at ? { occurredAt: { lte: at } } : {}),
      OR: [
        { fromLocationId: null, toLocationId: { not: null } },
        { fromLocationId: { not: null }, toLocationId: null },
      ],
    }
    const latest = await db.stockMove.findMany({ where: key, select: LAYER_COLUMNS, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: query.limit + 1 })
    const shown = latest.slice(0, query.limit).reverse()
    const first = shown[0]
    // The balance before the moves shown (the earlier ones, summed by the database).
    const earlier: Prisma.StockMoveWhereInput = first && latest.length > query.limit ? { AND: [key, { OR: [{ occurredAt: { lt: first.occurredAt } }, { occurredAt: first.occurredAt, id: { lt: first.id } }] }] } : { id: { in: [] } }
    // One query at a time: the client may be one transaction's connection.
    const into = await db.stockMove.aggregate({ where: { AND: [earlier, { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
    const outOf = await db.stockMove.aggregate({ where: { AND: [earlier, { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
    const earlierValue = await db.stockValuation.aggregate({ where: { move: earlier }, _sum: { valueAmount: true } })
    const openingQuantity = new Dec(into._sum.baseQuantity?.toString() ?? '0').minus(new Dec(outOf._sum.baseQuantity?.toString() ?? '0'))
    const openingValue = earlierValue._sum.valueAmount ?? 0

    const valuations = new Map((await db.stockValuation.findMany({ where: { moveId: { in: shown.map((move) => move.id) } }, select: { moveId: true, method: true, unitCost: true, valueAmount: true, currency: true } })).map((row) => [row.moveId, row]))
    const allMethods = (await db.stockValuation.groupBy({ by: ['method'], where: { move: key } })).map((row) => row.method as ValuationMethod)
    const hides = new Map((await db.hide.findMany({ where: { id: { in: unique(shown.map((move) => move.hideId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
    const lines = await db.goodsReceiptLine.findMany({ where: { id: { in: unique(shown.map((move) => move.receiptLineId)) } }, select: { id: true, receiptId: true, purchaseOrderLineId: true } })
    const receipts = new Map((await db.goodsReceipt.findMany({ where: { id: { in: unique(lines.map((line) => line.receiptId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
    const orderLines = new Map(
      (await db.purchaseOrderLine.findMany({ where: { id: { in: unique(lines.map((line) => line.purchaseOrderLineId)) } }, select: { id: true, purchaseOrderId: true, unitPrice: true, uom: true } })).map((row) => [row.id, row]),
    )
    const orders = new Map((await db.purchaseOrder.findMany({ where: { id: { in: unique([...orderLines.values()].map((row) => row.purchaseOrderId)) } }, select: { id: true, number: true, currency: true } })).map((row) => [row.id, row]))
    const lineOf = new Map(lines.map((line) => [line.id, line]))

    let quantity = openingQuantity
    let value = openingValue
    const currencies = new Set<string>()
    const layers = shown.map((move) => {
      const signed = move.toLocationId === null ? new Dec(move.baseQuantity.toString()).negated() : new Dec(move.baseQuantity.toString())
      const valuation = valuations.get(move.id)
      quantity = quantity.plus(signed)
      value += valuation?.valueAmount ?? 0
      if (valuation) currencies.add(valuation.currency)
      const line = move.receiptLineId ? lineOf.get(move.receiptLineId) : undefined
      const orderLine = line?.purchaseOrderLineId ? orderLines.get(line.purchaseOrderLineId) : undefined
      const order = orderLine ? orders.get(orderLine.purchaseOrderId) : undefined
      return {
        moveId: move.id,
        reason: move.reason,
        occurredAt: toUtcIso(move.occurredAt),
        day: businessDate(move.occurredAt),
        reference: move.reference,
        hide: move.hideId ? (hides.get(move.hideId) ?? null) : null,
        quantity: quantityText(signed),
        method: valuation?.method ?? null,
        unitCost: asMoney('cost', valuation ? new Dec(valuation.unitCost.toString()).toFixed(6) : null),
        value: asMoney('cost', valuation?.valueAmount ?? null),
        receipt: line ? (receipts.get(line.receiptId) ?? null) : null,
        purchaseOrder: orderLine && order ? { id: order.id, number: order.number, unitPrice: asMoney('cost', new Dec(orderLine.unitPrice.toString()).toFixed(6)), uom: orderLine.uom, currency: order.currency } : null,
        balanceQuantity: quantityText(quantity),
        balanceValue: asMoney('cost', value),
        reversalOfId: move.reversalOfId,
      }
    })
    const currency = currencies.size === 1 ? [...currencies][0]! : null
    // The lot's cost the next issue leaves at: inventory's moving average of the lot's valuations at the site up to the date.
    const lotValuations = lot ? await db.stockValuation.findMany({ where: { siteId: site.id, lotId: lot.id, ...(at ? { move: { occurredAt: { lte: at } } } : {}) }, select: { quantity: true, unitCost: true } }) : []
    const lotCost = lot ? lotUnitCost(lotValuations.map((row) => ({ quantity: row.quantity.toString(), unitCost: row.unitCost.toString() }))) : null
    const method = (await methodsOf(db, [site.companyId])).get(site.companyId)!
    const unvalued = shown.filter((move) => !valuations.has(move.id)).length
    const valued: ValuedState = unvalued === 0 ? 'FULL' : allMethods.length === 0 ? 'NONE' : 'PART'
    const depends = dependsOnMethod(method.method, allMethods)
    return {
      asOf: at === null ? null : toUtcIso(at),
      site: { id: site.id, code: site.code },
      item,
      lot: lot ? { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus } : null,
      quantity: quantityText(quantity),
      value: asMoney('cost', value),
      unitCost: asMoney('cost', currency ? unitCostOf(value, quantity, currency) : null),
      lotCost: asMoney('cost', lotCost ? lotCost.toFixed(6) : null),
      currency,
      opening: { quantity: quantityText(openingQuantity), value: asMoney('cost', openingValue) },
      layers,
      complete: latest.length <= query.limit,
      method,
      dependsOnMethod: depends,
      words: [
        basisWords(allMethods, valued, unvalued),
        lot ? "A receipt adds its hides or quantity at its purchase order's price; an issue or a return moves at the lot's average cost of what came in; the value left is what the lot holds." : null,
        method.words,
      ]
        .filter((text): text is string => text !== null)
        .join(' '),
    }
  })
}

interface AreaAcc {
  hides: number
  quantity: Decimal
  area: Decimal | null
  value: number
  currencies: Set<string>
  valued: ValuedState
}

const mergeValued = (a: ValuedState, b: ValuedState): ValuedState => (a === b ? a : 'PART')

/** GET /costing/valuation/leather: leather on hand valued by area, per site, article and colour, with its lots. */
export async function leatherByArea(caller: CommandCaller, query: LeatherQuery) {
  const at = query.asOf ? endOfDay(query.asOf) : null
  return caller.withClient(async (db) => {
    const siteIds = await visibleSites(caller, db, query)
    const leathers = await db.item.findMany({ where: { kind: 'LEATHER', ...(query.itemId ? { id: query.itemId } : {}) }, select: { id: true, code: true, name: true, kind: true, baseUom: true, tracking: true } })
    const itemOf = new Map(leathers.map((row) => [row.id, row]))
    const { rows } = valuationRows((await keyBalances(db, { siteIds, companyId: query.companyId, itemId: query.itemId }, at)).filter((row) => itemOf.has(row.itemId)))
    const lots = new Map((await db.lot.findMany({ where: { id: { in: unique(rows.map((row) => row.lotId)) } }, select: { id: true, code: true, qualityStatus: true } })).map((row) => [row.id, row]))
    const colours = new Map((await db.itemColour.findMany({ where: { id: { in: unique(rows.map((row) => row.itemColourId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const sites = new Map((await db.site.findMany({ where: { id: { in: unique(rows.map((row) => row.siteId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
    const methods = await methodsOf(db, unique(rows.map((row) => row.companyId)))

    const figures = (acc: AreaAcc) => {
      const currency = acc.currencies.size === 1 ? [...acc.currencies][0]! : null
      return {
        hides: acc.hides,
        quantity: quantityText(acc.quantity),
        areaM2: acc.area === null ? null : quantityText(acc.area),
        value: asMoney('cost', acc.value),
        valuePerM2: asMoney('cost', currency ? valuePerM2(acc.value, acc.area, currency) : null),
        unitCost: asMoney('cost', currency ? unitCostOf(acc.value, acc.quantity, currency) : null),
      }
    }
    const groups = new Map<string, { row: (typeof rows)[number]; acc: AreaAcc; lots: { lot: { id: string; code: string; qualityStatus: string }; acc: AreaAcc }[]; methods: Set<ValuationMethod> }>()
    for (const row of rows) {
      const item = itemOf.get(row.itemId)!
      const area = areaM2(row.quantity, item.baseUom as Uom)
      const acc: AreaAcc = { hides: row.hides, quantity: row.quantity, area, value: row.value, currencies: new Set(row.currency ? [row.currency] : []), valued: row.valued }
      const key = `${row.siteId}|${row.itemId}|${row.itemColourId ?? '-'}`
      const group = groups.get(key) ?? { row, acc: { hides: 0, quantity: ZERO, area: area === null ? null : ZERO, value: 0, currencies: new Set<string>(), valued: row.valued }, lots: [], methods: new Set<ValuationMethod>() }
      group.acc.hides += acc.hides
      group.acc.quantity = group.acc.quantity.plus(acc.quantity)
      group.acc.area = group.acc.area === null || area === null ? null : group.acc.area.plus(area)
      group.acc.value += acc.value
      for (const currency of acc.currencies) group.acc.currencies.add(currency)
      group.acc.valued = mergeValued(group.acc.valued, row.valued)
      for (const method of row.methods) group.methods.add(method)
      if (row.lotId) group.lots.push({ lot: lots.get(row.lotId) ?? { id: row.lotId, code: '', qualityStatus: '' }, acc })
      groups.set(key, group)
    }
    const out = [...groups.values()]
      .map(({ row, acc, lots: rowLots, methods: used }) => {
        const item = itemOf.get(row.itemId)!
        return {
          exactArea: acc.area,
          companyId: row.companyId,
          site: sites.get(row.siteId) ?? { id: row.siteId, code: '' },
          item: { id: item.id, code: item.code, name: item.name, kind: item.kind, baseUom: item.baseUom, tracking: item.tracking },
          colour: row.itemColourId ? (colours.get(row.itemColourId) ?? null) : null,
          ...figures(acc),
          currency: acc.currencies.size === 1 ? [...acc.currencies][0]! : null,
          valued: acc.valued,
          lots: rowLots.sort((a, b) => a.lot.code.localeCompare(b.lot.code)).map((entry) => ({ lot: entry.lot, ...figures(entry.acc), valued: entry.acc.valued })),
          dependsOnMethod: dependsOnMethod(methods.get(row.companyId)?.method ?? 'UNDECIDED', [...used]),
        }
      })
      .sort((a, b) => a.site.code.localeCompare(b.site.code) || a.item.code.localeCompare(b.item.code) || (a.colour?.code ?? '').localeCompare(b.colour?.code ?? ''))
    const total = totalsOf(out.map((row) => ({ value: row.value as number, currency: row.currency })))
    const area = out.reduce((sum, row) => (row.exactArea === null ? sum : sum.plus(row.exactArea)), ZERO)
    const notArea = out.filter((row) => row.exactArea === null).length
    const allArea = notArea === 0
    return {
      asOf: at === null ? null : toUtcIso(at),
      rows: out.map(({ exactArea: _exact, ...row }) => row),
      hides: out.reduce((sum, row) => sum + row.hides, 0),
      areaM2: quantityText(area),
      value: asMoney('cost', total.value),
      valuePerM2: asMoney('cost', total.value !== null && total.currency && allArea ? valuePerM2(total.value, area, total.currency) : null),
      currency: total.currency,
      notArea,
      methods: [...methods.values()],
      words: [
        'Leather is stock by area: each hide comes in with its own measured area, valued at its purchase order\'s price per unit of area; what is cut leaves at the lot\'s average cost. The value per m² is the value the ledger holds ÷ the area on hand.',
        notArea > 0 ? `${notArea} row(s) count their leather in a unit that is not an area: they are left out of the m² and of the value per m².` : null,
        total.words,
        ...new Set([...methods.values()].map((row) => row.words)),
      ]
        .filter((text): text is string => text !== null)
        .join(' '),
    }
  })
}
