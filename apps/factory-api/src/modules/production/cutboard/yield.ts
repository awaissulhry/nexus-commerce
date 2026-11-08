import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { differencePct } from '@nexus/factory-domain/production/cutboard/board'
import { cutSums, DEFAULT_YIELD_PERIOD, groupFigures, groupTotals, MAX_YIELD_DAYS, periodFrom, worstFirst, YIELD_ORDER_LIMIT, type CutLineFigures } from '@nexus/factory-domain/production/cutboard/yield'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import { yieldTotals } from '@nexus/factory-domain/production/yield/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { Reader } from '../cutorders/store'
import { officeContextOf, siteFor, sitesFor } from '../reports/daily'
import { liveEntries, yieldEntries } from '../yield/views'
import type { AreaUom } from './board'

/**
 * GET /production/cutboard/yield (B-W2b-130; MES-302; design production.reports "Cutting and yield": "Cut vs ordered, material
 * used, yield per hide lot and supplier"): one site, a period of whole days (30 ending today by default).
 *
 *   cut       cut vs ordered of the cut orders cut in the period (CUT or RECONCILED, by cutAt): a reconciled line's frozen
 *             figures (B-W2b-116's CutReconciliation), else a fabric line's ratio × the plies counted on its cut lays; a leather
 *             line not reconciled yet has no figure (the cut log names no cut order): its cut order is counted as waiting
 *   fabric    the lays cut in the period: the estimate against the fabric the table confirmed, in metres, per material
 *   leather   the cut log of the period (B-W2a-13's yield): per area unit, per material, per hide lot (worst first) and per
 *             supplier and unit
 *
 * Office, production.reports.view at the site. Never by cutter: the reads name no worker (SCM-255; Statuto dei Lavoratori art. 4).
 */

const m4 = (value: Prisma.Decimal | null | undefined): Decimal => new Dec(value ? value.toString() : '0')
const unique = (values: readonly (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

export interface YieldQuery {
  readonly siteId?: string | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
}

/** The period asked, checked: from ≤ to, at most a year. */
function periodOf(query: YieldQuery, today: BusinessDate): { from: BusinessDate; to: BusinessDate } {
  const to = query.to ?? today
  const from = query.from ?? periodFrom(to, DEFAULT_YIELD_PERIOD)
  if (from > to) throw new ValidationError('The period starts after it ends.', [{ path: 'querystring/from', message: 'The first day comes on or before the last day.' }])
  if (daysFrom(from, to) + 1 > MAX_YIELD_DAYS) throw new ValidationError('A period of at most a year.', [{ path: 'querystring/from', message: `At most ${MAX_YIELD_DAYS} days.` }])
  return { from, to }
}

/** Cut vs ordered of the cut orders cut in the range (see the module comment). */
async function cutOfPeriod(db: Reader, siteId: string, range: { readonly start: Date; readonly end: Date }) {
  const orders = await db.cutOrder.findMany({
    where: { siteId, status: { in: ['CUT', 'RECONCILED'] }, cutAt: { gte: range.start, lt: range.end } },
    select: { id: true, number: true, kind: true, status: true, companyId: true, siteId: true, cutAt: true, item: { select: { id: true, code: true, name: true } }, itemColour: { select: { id: true, code: true, name: true } } },
    orderBy: [{ cutAt: 'desc' }, { number: 'desc' }],
  })
  const ids = orders.map((order) => order.id)
  const [lines, lays, done] = ids.length
    ? await Promise.all([
        db.cutOrderLine.findMany({ where: { cutOrderId: { in: ids } }, select: { id: true, cutOrderId: true, quantity: true, ratio: true } }),
        db.lay.findMany({ where: { cutOrderId: { in: ids }, status: 'CUT' }, select: { cutOrderId: true, plyCountLeft: true, plies: true } }),
        db.cutReconciliation.findMany({ where: { cutOrderId: { in: ids } }, select: { cutOrderLineId: true, orderedQuantity: true, cutQuantity: true, varianceReasonCode: true } }),
      ])
    : [[], [], []]
  const stored = new Map(done.map((row) => [row.cutOrderLineId, row]))
  const figuresOf = new Map(
    orders.map((order) => {
      const counted = lays.filter((lay) => lay.cutOrderId === order.id).reduce((sum, lay) => sum + (lay.plyCountLeft ?? lay.plies), 0)
      const figures = lines
        .filter((line) => line.cutOrderId === order.id)
        .map((line): CutLineFigures => {
          const row = stored.get(line.id)
          if (row) return { ordered: row.orderedQuantity, cut: row.cutQuantity, variance: row.varianceReasonCode !== null }
          return { ordered: line.quantity, cut: order.kind === 'FABRIC' ? (line.ratio ?? 0) * counted : null, variance: false }
        })
      return [order.id, figures] as const
    }),
  )
  const sums = cutSums([...figuresOf.values()])
  const listed = orders.slice(0, YIELD_ORDER_LIMIT).map((order) => {
    const figures = figuresOf.get(order.id) ?? []
    const known = figures.every((line) => line.cut !== null)
    return {
      id: order.id,
      number: order.number,
      kind: order.kind,
      status: order.status,
      companyId: order.companyId,
      siteId: order.siteId,
      cutAt: toUtcIso(order.cutAt!),
      item: order.item,
      colour: order.itemColour,
      ordered: figures.reduce((sum, line) => sum + line.ordered, 0),
      cut: known ? figures.reduce((sum, line) => sum + (line.cut ?? 0), 0) : null,
      reconciled: order.status === 'RECONCILED',
    }
  })
  return { sums, listed, more: Math.max(0, orders.length - listed.length) }
}

/** Fabric used in the range: the lays cut then, per material (metres; lays still to confirm counted apart). */
async function fabricOfPeriod(db: Reader, siteId: string, range: { readonly start: Date; readonly end: Date }) {
  const lays = await db.lay.findMany({
    where: { siteId, status: 'CUT', cutAt: { gte: range.start, lt: range.end } },
    select: {
      id: true,
      consumptions: { select: { estimated: true, recorded: true, confirmed: true } },
      cutOrder: { select: { itemId: true, itemColourId: true, item: { select: { id: true, code: true, name: true } }, itemColour: { select: { id: true, code: true, name: true } } } },
    },
  })
  const materials = new Map<string, { item: { id: string; code: string; name: string }; colour: { id: string; code: string; name: string } | null; lays: number; estimated: Decimal; used: Decimal }>()
  let estimated = ZERO
  let used = ZERO
  let confirmed = 0
  for (const lay of lays) {
    const consumption = lay.consumptions[0]
    if (!consumption) continue
    confirmed += 1
    const lengthUsed = consumption.confirmed ? m4(consumption.confirmed) : m4(consumption.recorded)
    estimated = estimated.plus(m4(consumption.estimated))
    used = used.plus(lengthUsed)
    const key = `${lay.cutOrder.itemId}|${lay.cutOrder.itemColourId ?? '-'}`
    const entry = materials.get(key) ?? { item: lay.cutOrder.item, colour: lay.cutOrder.itemColour, lays: 0, estimated: ZERO, used: ZERO }
    entry.lays += 1
    entry.estimated = entry.estimated.plus(m4(consumption.estimated))
    entry.used = entry.used.plus(lengthUsed)
    materials.set(key, entry)
  }
  return {
    lays: confirmed,
    waiting: lays.length - confirmed,
    estimated: estimated.toFixed(4),
    used: used.toFixed(4),
    differencePct: differencePct(used, estimated),
    materials: [...materials.values()]
      .sort((a, b) => a.item.code.localeCompare(b.item.code))
      .map((entry) => ({ item: entry.item, colour: entry.colour, lays: entry.lays, estimated: entry.estimated.toFixed(4), used: entry.used.toFixed(4), differencePct: differencePct(entry.used, entry.estimated) })),
  }
}

/** Leather of the range from the cut log: per material, per hide lot (worst yield first) and per supplier and unit. */
async function leatherOfPeriod(db: Reader, siteId: string, range: { readonly start: Date; readonly end: Date }) {
  const entries = await liveEntries(db, { siteId, serverTime: { gte: range.start, lt: range.end } })
  if (entries.length === 0) return { units: [], materials: [], lots: [], suppliers: [] }
  const figures = await yieldEntries(db, entries)
  const hides = new Map((await db.hide.findMany({ where: { id: { in: unique(entries.map((entry) => entry.hideId)) } }, select: { id: true, itemId: true } })).map((row) => [row.id, row]))
  const lots = new Map(
    (await db.lot.findMany({ where: { id: { in: unique(entries.map((entry) => entry.lotId)) } }, select: { id: true, code: true, supplierLotRef: true, supplierId: true, itemColourId: true } })).map((row) => [row.id, row]),
  )
  const items = new Map((await db.item.findMany({ where: { id: { in: unique([...hides.values()].map((hide) => hide.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]))
  const colours = new Map((await db.itemColour.findMany({ where: { id: { in: unique([...lots.values()].map((lot) => lot.itemColourId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: unique([...lots.values()].map((lot) => lot.supplierId)) } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, { id: row.id, name: row.tradeName || row.legalName }]))

  const facts = entries.map((entry) => {
    const item = items.get(hides.get(entry.hideId)?.itemId ?? '')
    const lot = lots.get(entry.lotId)
    return {
      entry,
      item: item ? { id: item.id, code: item.code, name: item.name } : { id: entry.hideId, code: '', name: '' },
      uom: (item?.baseUom ?? 'FT2') as AreaUom,
      lot: { id: entry.lotId, code: lot?.code ?? '', supplierLotRef: lot?.supplierLotRef ?? null },
      colour: lot?.itemColourId ? (colours.get(lot.itemColourId) ?? null) : null,
      supplier: lot?.supplierId ? (parties.get(lot.supplierId) ?? null) : null,
      totals: yieldTotals([figures.get(entry.id)!]),
    }
  })
  type Fact = (typeof facts)[number]
  const hidesOf = (rows: readonly Fact[]) => unique(rows.map((row) => row.entry.hideId)).length
  const byTotals = (row: Fact) => row.totals

  const units = groupTotals(facts, (row) => row.uom, byTotals).map((group) => ({ uom: group.first.uom, hides: hidesOf(group.rows), ...groupFigures(group.totals) }))
  const materials = groupTotals(facts, (row) => `${row.item.id}|${row.colour?.id ?? '-'}`, byTotals)
    .map((group) => ({ item: group.first.item, colour: group.first.colour, uom: group.first.uom, hides: hidesOf(group.rows), ...groupFigures(group.totals) }))
    .sort((a, b) => a.item.code.localeCompare(b.item.code))
  const lotRows = worstFirst(
    groupTotals(facts, (row) => row.lot.id, byTotals).map((group) => ({ name: group.first.lot.code, lot: group.first.lot, supplier: group.first.supplier, item: group.first.item, uom: group.first.uom, hides: hidesOf(group.rows), ...groupFigures(group.totals) })),
  ).map(({ name: _name, ...row }) => row)
  const suppliers = worstFirst(
    groupTotals(facts, (row) => `${row.supplier?.id ?? '-'}|${row.uom}`, byTotals).map((group) => ({
      name: group.first.supplier?.name ?? '',
      supplier: group.first.supplier,
      uom: group.first.uom,
      lots: unique(group.rows.map((row) => row.lot.id)).length,
      hides: hidesOf(group.rows),
      ...groupFigures(group.totals),
    })),
  ).map(({ name: _name, ...row }) => row)
  return { units, materials, lots: lotRows, suppliers }
}

/** GET /production/cutboard/yield. */
export async function yieldReport(caller: CommandCaller, query: YieldQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const sites = await sitesFor(db, actor, PRODUCTION_REPORTS_VIEW, context.companyId)
    const site = query.siteId ? await siteFor(db, actor, PRODUCTION_REPORTS_VIEW, query.siteId, context.companyId) : sites[0]
    if (!site) throw new NotFoundError('No site where you may read the production reports.')
    const today = businessDate(now, site.timezone)
    const period = periodOf(query, today)
    const range = { start: businessDayRange(period.from, site.timezone).start, end: businessDayRange(period.to, site.timezone).end }
    const cut = await cutOfPeriod(db, site.id, range)
    const fabric = await fabricOfPeriod(db, site.id, range)
    const leather = await leatherOfPeriod(db, site.id, range)
    return {
      asOf: toUtcIso(now),
      site: { id: site.id, code: site.code, name: site.name, timeZone: site.timezone },
      sites: sites.map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })),
      from: period.from,
      to: period.to,
      today,
      cut: cut.sums,
      orders: cut.listed,
      more: cut.more,
      fabric,
      leather,
    }
  })
}
