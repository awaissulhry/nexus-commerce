import type { Prisma } from '@nexus/factory-db'
import { businessDate as businessDateOf, toUtcIso } from '@nexus/factory-domain/core/time'
import { stockValue } from '@nexus/factory-domain/inventory/ledger/valuation'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { LOSS_DRIFT_POINTS, LOSS_MIN_CUTS, LOSS_WINDOW_DAYS, lossOfYield, lossProposal, MAX_LOSS_PCT, plannedLossOf, type LossProposal, type LossSource } from '@nexus/factory-domain/planning/leather/loss'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { yieldFigures, yieldTotals } from '@nexus/factory-domain/production/yield/rules'
import { Dec, HUNDRED, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { readLines } from '../../product/bom/store'
import { liveEntries, yieldEntries, type EntryRow } from '../../production/yield/views'
import { officeContextOf, seesCost, siteFor } from '../access'
import type { Reader, SiteRow } from '../store'
import type { YieldRowView } from './contract'
import { decisionsOf, siteViewOf, type StoredDecision } from './facts'

/**
 * Planned against actual yield per style (B-W2b-132; PLN-109; design planning.leather "Planned vs actual yield"). Office,
 * planning.view at the site. Reads the cut log (B-W1-40) through production/yield's own readers (B-W2a-13: live entries,
 * each entry's pattern and BOM need from its work order's frozen BOM rows), for the site's work orders of each style over
 * the last LOSS_WINDOW_DAYS calendar days: hides and cuts, the planned area (the BOM's need of what was cut, loss included)
 * against the area the cuts used, the planned loss (the style's released revision: its planned hide yield, else its leather
 * wastage; else what the work orders' BOM rows expected) against the actual, the trend per work order, and the proposal
 * (factory-domain planning/leather/loss) with the latest decision at the site. Never by cutter (Statuto dei Lavoratori art.
 * 4): per style and work order only. The extra loss's value only with the cost grain.
 */

/** The window's first day: LOSS_WINDOW_DAYS calendar days back in the site's zone (stable through the day). */
export const windowStart = (site: Pick<SiteRow, 'timezone'>, now: Date): Date => new Date(`${addDays(businessDateOf(now, site.timezone), -LOSS_WINDOW_DAYS)}T00:00:00.000Z`)

const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
const q4 = (value: Decimal): string => value.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)

export interface StyleYield {
  readonly style: { readonly id: string; readonly code: string; readonly name: string }
  readonly revision: { readonly id: string; readonly revision: number } | null
  readonly draft: { readonly id: string; readonly revision: number; readonly version: number } | null
  readonly hides: number
  readonly cuts: number
  readonly plannedArea: string
  readonly actualArea: string
  readonly uom: YieldRowView['uom']
  readonly plannedLossPct: string | null
  readonly plannedSource: LossSource | null
  readonly actualLossPct: string | null
  readonly trend: { workOrder: string; lossPct: string | null }[]
  readonly proposal: LossProposal
  readonly last: StoredDecision | null
  /** The leather the cuts used (one article: its standard cost and currency), for the extra loss's value. */
  readonly leather: { readonly id: string; readonly currency: string; readonly standardCost: Prisma.Decimal | null } | null
}

/** Per style (of `styleIds`, else every style the site cut in the window): the figures and the proposal. */
export async function styleYields(db: Reader, site: SiteRow, from: Date, styleIds?: readonly string[], withCost = false): Promise<Map<string, StyleYield>> {
  const out = new Map<string, StyleYield>()
  const orders = await db.workOrder.findMany({ where: { siteId: site.id, ...(styleIds ? { styleId: { in: [...styleIds] } } : {}) }, select: { id: true, number: true, styleId: true }, orderBy: { number: 'asc' } })
  if (orders.length === 0) return out
  const entries = await liveEntries(db, { AND: [{ workOrderId: { in: orders.map((order) => order.id) } }, { serverTime: { gte: from } }] })
  if (entries.length === 0) return out
  const figures = await yieldEntries(db, entries)
  const orderOf = new Map(orders.map((order) => [order.id, order]))
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique(entries.map((entry) => orderOf.get(entry.workOrderId)?.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const hideItems = new Map((await db.hide.findMany({ where: { id: { in: unique(entries.map((entry) => entry.hideId)) } }, select: { id: true, itemId: true } })).map((row) => [row.id, row.itemId]))
  const items = new Map((await db.item.findMany({ where: { id: { in: unique([...hideItems.values()]) } }, select: { id: true, baseUom: true, currency: true, ...(withCost ? { standardCost: true } : {}) } })).map((row) => [row.id, row as typeof row & { standardCost?: Prisma.Decimal | null }]))
  const decisions = await decisionsOf(db, site.id, [...styles.keys()])
  for (const style of [...styles.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    const mine = entries.filter((entry) => orderOf.get(entry.workOrderId)?.styleId === style.id)
    const yields = mine.map((entry) => figures.get(entry.id)!).filter(Boolean)
    const totals = yieldTotals(yields)
    const cuts = yields.filter((entry) => entry.pattern !== null).length
    // The revision the plan uses now (the released one) and the draft a change goes into.
    const released = await db.styleRevision.findFirst({ where: { styleId: style.id, status: 'RELEASED' }, select: { id: true, revision: true, plannedHideYieldPct: true }, orderBy: { revision: 'desc' } })
    const draft = await db.styleRevision.findFirst({ where: { styleId: style.id, status: 'DRAFT' }, select: { id: true, revision: true, version: true }, orderBy: { revision: 'desc' } })
    const usedItems = unique(mine.map((entry) => hideItems.get(entry.hideId)))
    let planned: { lossPct: string | null; source: LossSource | null } = { lossPct: null, source: null }
    if (released) {
      const lines = (await readLines(db, released.id)).filter((line) => usedItems.includes(line.itemId))
      planned = plannedLossOf({ plannedHideYieldPct: released.plannedHideYieldPct?.toString() ?? null, leatherWastages: lines.map((line) => line.wastagePct) })
    }
    const figure = yieldFigures(totals)
    if (planned.lossPct === null && figure.plannedPct !== null) planned = { lossPct: lossOfYield(figure.plannedPct), source: 'BOM' }
    const actualLossPct = figure.yieldPct === null ? null : lossOfYield(figure.yieldPct)
    // The trend: the actual loss of each work order, oldest first.
    const trend = unique(mine.map((entry) => entry.workOrderId)).map((workOrderId) => {
      const one = yieldFigures(yieldTotals(mine.filter((entry) => entry.workOrderId === workOrderId).map((entry) => figures.get(entry.id)!)))
      return { workOrder: orderOf.get(workOrderId)?.number ?? '', lossPct: one.yieldPct === null ? null : lossOfYield(one.yieldPct) }
    })
    const last = decisions.get(style.id)?.[0] ?? null
    const leather = usedItems.length === 1 ? (items.get(usedItems[0]!) ?? null) : null
    out.set(style.id, {
      style,
      revision: released ? { id: released.id, revision: released.revision } : null,
      draft,
      hides: unique(mine.map((entry: EntryRow) => entry.hideId)).length,
      cuts,
      plannedArea: q4(totals.need),
      actualArea: q4(totals.used.minus(totals.unmatched)),
      uom: leather ? (leather.baseUom as YieldRowView['uom']) : null,
      plannedLossPct: planned.lossPct,
      plannedSource: planned.source,
      actualLossPct,
      trend: trend.slice(-12),
      proposal: lossProposal({ cuts, actualLossPct, plannedLossPct: planned.lossPct, last }),
      last,
      leather: leather ? { id: leather.id, currency: leather.currency, standardCost: leather.standardCost ?? null } : null,
    })
  }
  return out
}

/** The area lost beyond the plan: the area the cuts used × (actual − planned loss) ÷ 100, never below zero. */
const extraLoss = (row: StyleYield): string | null =>
  row.actualLossPct === null || row.plannedLossPct === null ? null : q4(Dec.max(ZERO, new Dec(row.actualArea).times(new Dec(row.actualLossPct).minus(row.plannedLossPct)).div(HUNDRED)))

/** GET /planning/leather/yield?siteId */
export async function leatherYield(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeContextOf(caller)
  const withCost = seesCost(context)
  return caller.withClient(async (client) => {
    const db = client as Reader
    const site = await siteFor(caller, query.siteId, PLANNING_VIEW, db)
    const from = windowStart(site, new Date())
    const rows: YieldRowView[] = [...(await styleYields(db, site, from, undefined, withCost)).values()].map((row) => {
      const extra = extraLoss(row)
      const cost = withCost && row.leather?.standardCost ? row.leather.standardCost.toString() : null
      return {
        style: row.style,
        revision: row.revision,
        draft: row.draft,
        hides: row.hides,
        cuts: row.cuts,
        plannedArea: row.plannedArea,
        actualArea: row.actualArea,
        uom: row.uom,
        plannedLossPct: row.plannedLossPct,
        plannedSource: row.plannedSource,
        actualLossPct: row.actualLossPct,
        trend: row.trend,
        proposal: row.proposal,
        lastDecision: row.last ? { decision: row.last.decision, toPct: row.last.toPct, cuts: row.last.cuts, at: row.last.at, reason: row.last.reason, revision: row.last.revision } : null,
        ...(withCost ? { extraLossValue: asMoney('cost', extra !== null && cost !== null && row.leather ? stockValue(extra, cost, row.leather.currency) : null) } : {}),
        currency: row.leather?.currency ?? null,
      }
    })
    return { site: siteViewOf(site), from: toUtcIso(from), minCuts: LOSS_MIN_CUTS, driftPoints: LOSS_DRIFT_POINTS, maxLossPct: MAX_LOSS_PCT, rows }
  })
}

