import type { Prisma } from '@nexus/factory-db'
import { businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { addAreas, yieldOfAreas } from '@nexus/factory-domain/insights/kpis/leather-yield'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import type { CommandCaller } from '../../../../core/command'
import { readLeatherCuts, type LeatherCut } from '../../facts/sources/leather'
import { asOf, drillActor, groupBy, limited, namesOf, refOf, sitesFor, spanOf } from './access'

/**
 * GET /insights/kpis/drills/leather-yield (B-W2b-429; ANA-020 "by grade, supplier lot and style"; KPI production.leather_yield):
 * the live cuts of the period at the sites I read (the leather source's own read: each cut's hide area consumed and the net
 * area of its pieces, in square metres), by grade, supplier lot and style, and per hide and work order. Filters: period, site,
 * grade, supplier, lot, style. production.reports.view over the site. Never by cutter.
 */

export interface LeatherDrillQuery {
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly siteId?: string | undefined
  readonly grade?: string | undefined
  readonly supplierId?: string | undefined
  readonly lotId?: string | undefined
  readonly styleId?: string | undefined
}

const figuresOf = (cuts: readonly LeatherCut[]) => ({ ...yieldOfAreas(addAreas(cuts)), hides: new Set(cuts.map((cut) => cut.entry.hideId)).size })

export async function leatherDrill(caller: CommandCaller, query: LeatherDrillQuery) {
  const kpiKey = 'production.leather_yield'
  const actor = drillActor(caller, [kpiKey])
  const span = spanOf(kpiKey, query)
  return caller.withClient(async (db) => {
    const sites = await sitesFor(db, actor, PRODUCTION_REPORTS_VIEW, { siteId: query.siteId })
    const zone = new Map(sites.map((site) => [site.id, site.timezone]))
    const cutsAll: LeatherCut[] = []
    for (const site of sites) {
      const where: Prisma.CutLogWhereInput = {
        siteId: site.id,
        serverTime: { gte: businessDayRange(span.from, site.timezone).start, lt: businessDayRange(span.to, site.timezone).end },
        ...(query.lotId ? { lotId: query.lotId } : {}),
        ...(query.styleId ? { workOrder: { styleId: query.styleId } } : {}),
        ...(query.grade || query.supplierId ? { hide: { ...(query.grade ? { grade: query.grade } : {}), ...(query.supplierId ? { lot: { supplierId: query.supplierId } } : {}) } } : {}),
      }
      cutsAll.push(...(await readLeatherCuts(db, where, (siteId) => zone.get(siteId)!)))
    }
    // Only the cuts whose pattern is known count (as the KPI); a hide, lot and work order are named once.
    const cuts = cutsAll.filter((cut) => !cut.cut.isZero())
    const hides = new Map((await db.hide.findMany({ where: { id: { in: [...new Set(cuts.map((cut) => cut.entry.hideId))] } }, select: { id: true, code: true, grade: true } })).map((row) => [row.id, row]))
    const lots = new Map((await db.lot.findMany({ where: { id: { in: [...new Set(cuts.map((cut) => cut.entry.lotId))] } }, select: { id: true, code: true, supplierLotRef: true, supplierId: true } })).map((row) => [row.id, row]))
    const orders = new Map((await db.workOrder.findMany({ where: { id: { in: [...new Set(cuts.map((cut) => cut.entry.workOrderId))] } }, select: { id: true, number: true, styleId: true } })).map((row) => [row.id, row]))
    const names = await namesOf(db, { parties: [...lots.values()].map((lot) => lot.supplierId), styles: [...orders.values()].map((order) => order.styleId), sites: cuts.map((cut) => cut.siteId) })
    const lotView = (lotId: string) => {
      const lot = lots.get(lotId)
      return { id: lotId, code: lot?.code ?? '', supplierLotRef: lot?.supplierLotRef ?? null }
    }
    const byHideAndOrder = [...groupBy(cuts, (cut) => `${cut.entry.hideId}|${cut.entry.workOrderId}`).values()]
      .map((mine) => ({ mine, last: mine.reduce((day, cut) => (cut.day > day ? cut.day : day), mine[0]!.day) }))
      .sort((a, b) => (a.last !== b.last ? (a.last < b.last ? 1 : -1) : (hides.get(a.mine[0]!.entry.hideId)?.code ?? '').localeCompare(hides.get(b.mine[0]!.entry.hideId)?.code ?? '')))
    const { rows, more } = limited(byHideAndOrder)
    const worstFirst = <T extends { yieldPct: string | null }>(list: T[]) => list.sort((a, b) => (a.yieldPct === null ? 1 : b.yieldPct === null ? -1 : Number(a.yieldPct) - Number(b.yieldPct)))
    return {
      kpiKey,
      period: span,
      asOf: asOf(),
      totals: figuresOf(cuts),
      byGrade: worstFirst([...groupBy(cuts, (cut) => hides.get(cut.entry.hideId)?.grade ?? 'NONE')].map(([grade, mine]) => ({ grade: grade === 'NONE' ? null : grade, ...figuresOf(mine) }))),
      byLot: worstFirst([...groupBy(cuts, (cut) => cut.entry.lotId)].map(([lotId, mine]) => ({ lot: lotView(lotId), supplier: refOf(names.party, lots.get(lotId)?.supplierId), ...figuresOf(mine) }))),
      byStyle: worstFirst([...groupBy(cuts, (cut) => orders.get(cut.entry.workOrderId)?.styleId ?? 'NONE')].map(([styleId, mine]) => ({ style: refOf(names.style, styleId), ...figuresOf(mine) }))),
      rows: rows.map(({ mine, last }) => {
        const first = mine[0]!.entry
        const hide = hides.get(first.hideId)
        const order = orders.get(first.workOrderId)
        const figures = yieldOfAreas(addAreas(mine))
        return {
          record: { type: 'Hide', id: first.hideId, label: hide?.code ?? '' },
          hide: { id: first.hideId, code: hide?.code ?? '', grade: hide?.grade ?? null },
          lot: lotView(first.lotId),
          supplier: refOf(names.party, lots.get(first.lotId)?.supplierId),
          site: refOf(names.site, mine[0]!.siteId),
          workOrder: { id: first.workOrderId, number: order?.number ?? '' },
          style: refOf(names.style, order?.styleId),
          lastCutOn: last,
          cutM2: figures.cutM2,
          patternM2: figures.patternM2,
          yieldPct: figures.yieldPct,
        }
      }),
      more,
    }
  })
}
