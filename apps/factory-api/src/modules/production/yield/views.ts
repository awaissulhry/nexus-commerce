import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { entryPattern, partOf } from '@nexus/factory-domain/production/cutting/rules'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { addTotals, netOfWastage, yieldFigures, yieldTotals, type YieldEntry, type YieldTotals } from '@nexus/factory-domain/production/yield/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Hide yield (B-W2a-13; MES-057, SCM-255; design production.cutting "Yield", the work order's Cutting tab "Yield"): how
 * much of each hide's area became pieces, from the cut log (B-W1-40) and the work orders' frozen BOM rows; planned
 * against actual per style and per supplier lot (factory-domain production/yield/rules). Office only: a work order's
 * yield with workorders.view, the cutting room's across work orders with production.cutting.view. Never by cutter
 * (SCM-255; Statuto dei Lavoratori art. 4): per hide, work order, style and supplier lot. Nothing here carries money.
 */

type Reader = FactoryClient | CommandTx

function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

interface EntryRow {
  readonly id: string
  readonly workOrderId: string
  readonly lotId: string
  readonly hideId: string
  readonly baseAreaUsed: Prisma.Decimal
  readonly baseRemnantArea: Prisma.Decimal
  readonly serverTime: Date
}

/** The live entries (no reversal, not reversed) matching `where`, oldest first. */
async function liveEntries(db: Reader, where: Prisma.CutLogWhereInput): Promise<EntryRow[]> {
  const rows = await db.cutLog.findMany({ where, select: { id: true, workOrderId: true, lotId: true, hideId: true, baseAreaUsed: true, baseRemnantArea: true, reversalOfId: true, serverTime: true }, orderBy: { id: 'asc' } })
  const reversed = new Set((await db.cutLog.findMany({ where: { reversalOfId: { in: rows.map((row) => row.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId!))
  return rows.filter((row) => row.reversalOfId === null && !reversed.has(row.id))
}

/** Per entry: its yield entry (used, remnant, net pattern, BOM need), from its work order's frozen BOM rows. */
async function yieldEntries(db: Reader, entries: readonly EntryRow[]): Promise<Map<string, YieldEntry>> {
  const out = new Map<string, YieldEntry>()
  const pieces = entries.length === 0 ? [] : await db.cutLogPiece.findMany({ where: { cutLogId: { in: entries.map((entry) => entry.id) } }, select: { cutLogId: true, workOrderSizeId: true, part: true, pieces: true } })
  const hides = new Map((await db.hide.findMany({ where: { id: { in: unique(entries.map((entry) => entry.hideId)) } }, select: { id: true, itemId: true } })).map((row) => [row.id, row]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: unique(entries.map((entry) => entry.lotId)) } }, select: { id: true, itemColourId: true } })).map((row) => [row.id, row]))
  for (const workOrderId of unique(entries.map((entry) => entry.workOrderId))) {
    const materials = await db.workOrderMaterial.findMany({ where: { workOrderId }, select: { bomLineId: true, itemId: true, itemColourId: true, workOrderSizeId: true, baseQuantity: true } })
    const items = new Map((await db.item.findMany({ where: { id: { in: unique(materials.map((row) => row.itemId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
    const lines = new Map((await db.bomLine.findMany({ where: { id: { in: unique(materials.map((row) => row.bomLineId)) } }, select: { id: true, placement: true, wastagePct: true } })).map((row) => [row.id, row]))
    const cells = new Map((await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, quantity: true } })).map((row) => [row.id, row.quantity]))
    for (const entry of entries.filter((row) => row.workOrderId === workOrderId)) {
      const hide = hides.get(entry.hideId)
      const colour = lots.get(entry.lotId)?.itemColourId ?? null
      const rows = materials.filter((row) => row.itemId === hide?.itemId && row.itemColourId === colour)
      const cellsOf = (net: boolean) =>
        new Map(
          [...cells.entries()].map(([cellId, quantity]) => {
            const mine = rows.filter((row) => row.workOrderSizeId === cellId)
            const need = mine.reduce<Decimal>((sum, row) => sum.plus(net ? netOfWastage(row.baseQuantity.toString(), lines.get(row.bomLineId)?.wastagePct.toString() ?? '0') : new Dec(row.baseQuantity.toString())), ZERO)
            return [cellId, { parts: [...new Set(mine.map((row) => partOf(lines.get(row.bomLineId)?.placement, items.get(row.itemId)?.code ?? '')))].sort(), need: need.toFixed(6), quantity }]
          }),
        )
      const mine = pieces.filter((piece) => piece.cutLogId === entry.id).map((piece) => ({ cellId: piece.workOrderSizeId, part: piece.part, pieces: piece.pieces }))
      const net = entryPattern(mine, cellsOf(true))
      const need = entryPattern(mine, cellsOf(false))
      out.set(entry.id, { used: entry.baseAreaUsed.toString(), remnant: entry.baseRemnantArea.toString(), pattern: net === null ? null : net.toFixed(6), need: need === null ? null : need.toFixed(6) })
    }
  }
  return out
}

/** The hides of entries, with lot, supplier and area in. */
async function hideFacts(db: Reader, entries: readonly EntryRow[]) {
  const hides = await db.hide.findMany({ where: { id: { in: unique(entries.map((entry) => entry.hideId)) } }, select: { id: true, code: true, lotId: true, itemId: true, baseArea: true, grade: true, shade: true, state: true } })
  const lots = new Map((await db.lot.findMany({ where: { id: { in: unique(hides.map((hide) => hide.lotId)) } }, select: { id: true, code: true, supplierId: true, supplierLotRef: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: unique([...lots.values()].map((lot) => lot.supplierId)) } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, { id: row.id, name: row.tradeName || row.legalName }]))
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(hides.map((hide) => hide.itemId)) } }, select: { id: true, code: true, baseUom: true } })).map((row) => [row.id, row]))
  return { hides: new Map(hides.map((hide) => [hide.id, hide])), lots, parties, items }
}

function hideRows(entries: readonly EntryRow[], figures: ReadonlyMap<string, YieldEntry>, facts: Awaited<ReturnType<typeof hideFacts>>) {
  return unique(entries.map((entry) => entry.hideId)).map((hideId) => {
    const hide = facts.hides.get(hideId)!
    const lot = facts.lots.get(hide.lotId)
    const totals = yieldTotals(entries.filter((entry) => entry.hideId === hideId).map((entry) => figures.get(entry.id)!))
    return {
      totals,
      view: {
        hide: { id: hide.id, code: hide.code, grade: hide.grade, shade: hide.shade, state: hide.state },
        lot: { id: hide.lotId, code: lot?.code ?? '', supplierLotRef: lot?.supplierLotRef ?? null },
        supplier: lot?.supplierId ? { id: lot.supplierId, name: facts.parties.get(lot.supplierId)?.name ?? '' } : null,
        item: { id: hide.itemId, code: facts.items.get(hide.itemId)?.code ?? '', uom: facts.items.get(hide.itemId)?.baseUom ?? 'FT2' },
        areaIn: new Dec(hide.baseArea.toString()).toFixed(4),
        ...yieldFigures(totals),
      },
    }
  })
}

/** GET /production/yield/work-orders/:workOrderId: the work order's hides, its totals against its style's plan. */
export async function workOrderYield(caller: CommandCaller, workOrderId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const workOrder = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true, number: true, status: true, styleId: true, styleRevisionId: true } })
    if (!workOrder || !can(actorOf(context), WORKORDERS_VIEW, workOrder)) throw new NotFoundError('Work order not found.')
    const entries = await liveEntries(db, { workOrderId: workOrder.id })
    const figures = await yieldEntries(db, entries)
    const rows = hideRows(entries, figures, await hideFacts(db, entries))
    const planned = workOrder.styleRevisionId ? (await db.styleRevision.findUnique({ where: { id: workOrder.styleRevisionId }, select: { plannedHideYieldPct: true } }))?.plannedHideYieldPct : null
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status },
      plannedSource: planned ? ('STYLE' as const) : ('BOM' as const),
      overall: yieldFigures(addTotals(rows.map((row) => row.totals)), planned ? planned.toString() : null),
      hides: rows.map((row) => row.view),
    }
  })
}

export interface YieldQuery {
  readonly siteId?: string | undefined
  readonly styleId?: string | undefined
  readonly lotId?: string | undefined
  readonly from?: Date | undefined
  readonly to?: Date | undefined
}

/** GET /production/yield: the cutting room's yield per hide, per style and supplier lot, and in total. */
export async function cuttingYield(caller: CommandCaller, query: YieldQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const orders = await db.workOrder.findMany({
      where: { AND: [scopeWhere(actorOf(context), PRODUCTION_CUTTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput, query.siteId ? { siteId: query.siteId } : {}, query.styleId ? { styleId: query.styleId } : {}] },
      select: { id: true, styleId: true, styleRevisionId: true },
    })
    const entries = await liveEntries(db, {
      AND: [{ workOrderId: { in: orders.map((order) => order.id) } }, query.lotId ? { lotId: query.lotId } : {}, query.from ? { serverTime: { gte: query.from } } : {}, query.to ? { serverTime: { lt: query.to } } : {}],
    })
    const figures = await yieldEntries(db, entries)
    const facts = await hideFacts(db, entries)
    const styles = new Map((await db.style.findMany({ where: { id: { in: unique(orders.map((order) => order.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const styleOf = new Map(orders.map((order) => [order.id, order.styleId]))
    // Per style and supplier lot.
    const groups = new Map<string, { styleId: string; lotId: string; totals: YieldTotals[] }>()
    for (const entry of entries) {
      const styleId = styleOf.get(entry.workOrderId)!
      const key = `${styleId}|${entry.lotId}`
      const group = groups.get(key) ?? { styleId, lotId: entry.lotId, totals: [] }
      group.totals.push(yieldTotals([figures.get(entry.id)!]))
      groups.set(key, group)
    }
    const revisions = new Map((await db.styleRevision.findMany({ where: { id: { in: unique(orders.map((order) => order.styleRevisionId)) } }, select: { id: true, styleId: true, plannedHideYieldPct: true } })).map((row) => [row.id, row]))
    const plannedOf = (styleId: string) => {
      const values = unique(orders.filter((order) => order.styleId === styleId).map((order) => (order.styleRevisionId ? (revisions.get(order.styleRevisionId)?.plannedHideYieldPct?.toString() ?? null) : null)))
      return values.length === 1 ? values[0]! : null
    }
    return {
      hides: hideRows(entries, figures, facts).map((row) => row.view),
      byStyleAndLot: [...groups.values()].map((group) => {
        const lot = facts.lots.get(group.lotId)
        const style = styles.get(group.styleId)
        return {
          style: { id: group.styleId, code: style?.code ?? '', name: style?.name ?? '' },
          lot: { id: group.lotId, code: lot?.code ?? '', supplierLotRef: lot?.supplierLotRef ?? null },
          supplier: lot?.supplierId ? { id: lot.supplierId, name: facts.parties.get(lot.supplierId)?.name ?? '' } : null,
          hides: unique(entries.filter((entry) => styleOf.get(entry.workOrderId) === group.styleId && entry.lotId === group.lotId).map((entry) => entry.hideId)).length,
          ...yieldFigures(addTotals(group.totals), plannedOf(group.styleId)),
        }
      }),
      overall: yieldFigures(addTotals(entries.map((entry) => yieldTotals([figures.get(entry.id)!])))),
    }
  })
}
