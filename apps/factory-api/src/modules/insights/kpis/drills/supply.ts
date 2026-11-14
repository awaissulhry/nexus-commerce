import type { Prisma } from '@nexus/factory-db'
import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { coverDays, COVER_WINDOW_DAYS, onTimePct } from '@nexus/factory-domain/insights/kpis/supplier-on-time'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../../core/command'
import { serverClock } from '../../../../core/time'
import { leatherBalancesOf } from '../../../inventory/reports/facts'
import { shortages } from '../../../planning/readiness/readiness'
import { liveEntries } from '../../../production/yield/views'
import { readSupplyLines, type SupplyLine } from '../../facts/sources/supply'
import type { Reader } from '../../facts/rows'
import { asOf, drillActor, groupBy, limited, namesOf, refOf, sitesFor, spanOf, DRILL_ROW_LIMIT } from './access'

/**
 * GET /insights/kpis/drills/supply (B-W2b-429; ANA-023 "supplier on-time rate, open shortages per order, days of cover of
 * critical leathers"; KPI purchasing.supplier_on_time): the receipt lines of the period against a purchase order line (the
 * supply source's own read) by supplier, each with its due day and how late; the open shortages per work order of the latest
 * plan of each site I plan (the planning module's own read; null without planning.view); the days of cover of the leathers
 * an open work order still needs at each site whose stock I read (null without inventory.stock.view). Filters: period, site,
 * supplier, category (the article's kind); for the cover an article and a least age (days its oldest lot on hand has lain).
 * purchasing.view over the purchase order's company and supplier.
 */

export interface SupplyDrillQuery {
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly siteId?: string | undefined
  readonly supplierId?: string | undefined
  readonly category?: ItemKind | undefined
  readonly itemId?: string | undefined
  readonly minAgeDays?: number | undefined
}

const OPEN = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const quantityText = (value: Decimal) => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)

/** The cover of the leathers the open work orders of a site still need. */
async function coverOf(db: Reader, site: { id: string; timezone: string }, query: SupplyDrillQuery) {
  const now = serverClock.now()
  const materials = await db.workOrderMaterial.findMany({ where: { siteId: site.id, workOrder: { status: { in: [...OPEN] } }, ...(query.itemId ? { itemId: query.itemId } : {}) }, select: { itemId: true, itemColourId: true }, distinct: ['itemId', 'itemColourId'] })
  const leathers = new Set((await db.item.findMany({ where: { id: { in: [...new Set(materials.map((row) => row.itemId))] }, kind: 'LEATHER' }, select: { id: true } })).map((row) => row.id))
  const wanted = materials.filter((row) => leathers.has(row.itemId))
  if (wanted.length === 0) return []
  const key = (itemId: string, colourId: string | null) => `${itemId}|${colourId ?? ''}`
  const balances = await leatherBalancesOf(db, [site.id], now)
  const lots = new Map((await db.lot.findMany({ where: { id: { in: [...new Set(balances.flatMap((row) => (row.rootLotId ? [row.rootLotId] : [])))] } }, select: { id: true, receivedAt: true, createdAt: true } })).map((row) => [row.id, row.receivedAt ?? row.createdAt]))
  const today = businessDate(now, site.timezone)
  const onHand = new Map<string, { quantity: Decimal; hides: number; oldest: number | null }>()
  for (const row of balances) {
    const entry = onHand.get(key(row.itemId, row.itemColourId)) ?? { quantity: ZERO, hides: 0, oldest: null }
    const quantity = new Dec(row.quantity)
    entry.quantity = entry.quantity.plus(quantity)
    entry.hides += row.hides
    const received = row.rootLotId ? lots.get(row.rootLotId) : undefined
    if (quantity.gt(0) && received) {
      const age = Math.max(0, daysFrom(businessDate(received, site.timezone), today))
      entry.oldest = entry.oldest === null ? age : Math.max(entry.oldest, age)
    }
    onHand.set(key(row.itemId, row.itemColourId), entry)
  }
  const since = businessDayRange(plusDays(today, -COVER_WINDOW_DAYS + 1), site.timezone).start
  const entries = await liveEntries(db, { siteId: site.id, serverTime: { gte: since } })
  const hideItem = new Map((await db.hide.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.hideId))] } }, select: { id: true, itemId: true } })).map((row) => [row.id, row.itemId]))
  const lotColour = new Map((await db.lot.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.lotId))] } }, select: { id: true, itemColourId: true } })).map((row) => [row.id, row.itemColourId]))
  const used = new Map<string, Decimal>()
  for (const entry of entries) {
    const itemId = hideItem.get(entry.hideId)
    if (!itemId) continue
    const k = key(itemId, lotColour.get(entry.lotId) ?? null)
    used.set(k, (used.get(k) ?? ZERO).plus(new Dec(entry.baseAreaUsed.toString())))
  }
  return wanted
    .map((row) => {
      const stock = onHand.get(key(row.itemId, row.itemColourId)) ?? { quantity: ZERO, hides: 0, oldest: null }
      const usedInWindow = used.get(key(row.itemId, row.itemColourId)) ?? ZERO
      return { siteId: site.id, itemId: row.itemId, colourId: row.itemColourId, onHand: stock.quantity, hides: stock.hides, usedInWindow, perDay: usedInWindow.div(COVER_WINDOW_DAYS), cover: coverDays(stock.quantity, usedInWindow), oldestLotDays: stock.oldest }
    })
    .filter((row) => query.minAgeDays === undefined || (row.oldestLotDays !== null && row.oldestLotDays >= query.minAgeDays))
}

async function shortagesFor(caller: CommandCaller, actor: Actor, siteId: string | undefined) {
  if (!holds(actor, PLANNING_VIEW)) return null
  const sites = await caller.withClient((db) => sitesFor(db, actor, PLANNING_VIEW, { siteId }))
  const workOrders: { record: { type: string; id: string; label: string }; workOrder: { id: string; number: string; status: string }; siteId: string; style: { id: string; code: string; name: string } | null; materials: string[]; neededBy: BusinessDate }[] = []
  for (const site of sites) {
    const answer = await shortages(caller, { siteId: site.id })
    for (const [, rows] of groupBy(answer.rows, (row) => row.workOrder.id)) {
      const first = rows[0]!
      workOrders.push({
        record: { type: 'WorkOrder', id: first.workOrder.id, label: first.workOrder.number },
        workOrder: { id: first.workOrder.id, number: first.workOrder.number, status: first.workOrder.status },
        siteId: site.id,
        style: first.workOrder.style ? { id: first.workOrder.style.id, code: first.workOrder.style.code, name: first.workOrder.style.name } : null,
        materials: [...new Set(rows.map((row) => row.material.label))],
        neededBy: rows.map((row) => row.neededBy).sort()[0]!,
      })
    }
  }
  // The most materials short first, then the earliest need.
  return workOrders.sort((a, b) => b.materials.length - a.materials.length || (a.neededBy < b.neededBy ? -1 : a.neededBy > b.neededBy ? 1 : a.workOrder.number.localeCompare(b.workOrder.number)))
}

export async function supplyDrill(caller: CommandCaller, query: SupplyDrillQuery) {
  const kpiKey = 'purchasing.supplier_on_time'
  const actor = drillActor(caller, [kpiKey])
  const span = spanOf(kpiKey, query)
  const short = await shortagesFor(caller, actor, query.siteId)
  return caller.withClient(async (db) => {
    const sites = await sitesFor(db, actor, PURCHASING_VIEW, { siteId: query.siteId })
    const extra: Prisma.PurchaseOrderLineWhereInput = { ...(query.supplierId ? { partyId: query.supplierId } : {}), ...(query.category ? { item: { kind: query.category } } : {}) }
    const lines = await readSupplyLines(db, { sites, from: span.from, to: span.to, where: scopeWhere(actor, PURCHASING_VIEW, { company: 'companyId', party: 'partyId' }), extra })
    lines.sort((a, b) => (a.onTime !== b.onTime ? (a.onTime ? 1 : -1) : b.lateDays - a.lateDays || (a.postedDay < b.postedDay ? 1 : a.postedDay > b.postedDay ? -1 : a.purchaseOrder.number.localeCompare(b.purchaseOrder.number) || a.seq - b.seq)))
    const stockSites = holds(actor, INVENTORY_STOCK_VIEW) ? await sitesFor(db, actor, INVENTORY_STOCK_VIEW, { siteId: query.siteId }) : null
    const cover = stockSites ? (await Promise.all(stockSites.map((site) => coverOf(db, site, query)))).flat() : null
    const names = await namesOf(db, {
      parties: lines.map((line) => line.supplierId),
      items: [...lines.map((line) => line.itemId), ...(cover ?? []).map((row) => row.itemId)],
      sites: [...lines.map((line) => line.siteId), ...(cover ?? []).map((row) => row.siteId), ...(short ?? []).map((row) => row.siteId)],
    })
    const colours = new Map((cover && cover.length > 0 ? await db.itemColour.findMany({ where: { id: { in: [...new Set(cover.flatMap((row) => (row.colourId ? [row.colourId] : [])))] } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
    const rateOf = (mine: readonly SupplyLine[]) => {
      const onTime = mine.filter((line) => line.onTime).length
      return { received: mine.length, onTime, pct: onTimePct(onTime, mine.length) }
    }
    const totals = rateOf(lines)
    const { rows, more } = limited(lines)
    return {
      kpiKey,
      period: span,
      asOf: asOf(),
      totals: { ...totals, late: totals.received - totals.onTime },
      bySupplier: [...groupBy(lines, (line) => line.supplierId)]
        .map(([supplierId, mine]) => ({ supplier: refOf(names.party, supplierId), ...rateOf(mine), worstLateDays: Math.max(0, ...mine.map((line) => line.lateDays)) }))
        .sort((a, b) => (a.pct === null ? 1 : b.pct === null ? -1 : Number(a.pct) - Number(b.pct)) || (a.supplier?.code ?? '').localeCompare(b.supplier?.code ?? '')),
      rows: rows.map((line) => ({
        record: { type: 'PurchaseOrder', id: line.purchaseOrder.id, label: line.purchaseOrder.number },
        purchaseOrder: line.purchaseOrder,
        seq: line.seq,
        receipt: line.receipt,
        supplier: refOf(names.party, line.supplierId),
        item: refOf(names.item, line.itemId),
        category: line.category as ItemKind,
        site: refOf(names.site, line.siteId),
        due: line.due,
        postedOn: line.postedDay,
        onTime: line.onTime,
        lateDays: line.lateDays,
      })),
      more,
      shortages: short
        ? {
            workOrders: short.slice(0, DRILL_ROW_LIMIT).map((row) => ({ record: row.record, workOrder: row.workOrder, site: refOf(names.site, row.siteId), style: row.style, shortages: row.materials.length, materials: row.materials, neededBy: row.neededBy })),
            total: short.reduce((total, row) => total + row.materials.length, 0),
            more: Math.max(0, short.length - DRILL_ROW_LIMIT),
          }
        : null,
      cover: cover
        ? {
            windowDays: COVER_WINDOW_DAYS,
            rows: cover
              .sort((a, b) => (a.cover === null ? 1 : b.cover === null ? -1 : Number(a.cover) - Number(b.cover)))
              .map((row) => ({
                site: refOf(names.site, row.siteId),
                item: refOf(names.item, row.itemId),
                colour: row.colourId ? refOf(colours, row.colourId) : null,
                uom: names.item.get(row.itemId)?.uom ?? '',
                onHand: quantityText(row.onHand),
                hides: row.hides,
                usedInWindow: quantityText(row.usedInWindow),
                perDay: quantityText(row.perDay),
                coverDays: row.cover,
                oldestLotDays: row.oldestLotDays,
              })),
          }
        : null,
    }
  })
}
