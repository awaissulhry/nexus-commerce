import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { RELEASE_STATUSES } from '@nexus/factory-domain/quality/release/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { scanProgressOf } from '../../production/scans/progress'
import { inspectorOf } from './access'
import { releasedPerCell } from './store'

/**
 * The inspection bench's work orders (B-W1-45 part 2; A2 SCR-097, design floor.final "scan"): what a floor inspector (or
 * the office) can inspect or release now, or the one work order a scanned traveller names. The floor inspector's role
 * holds no production permission, so this is the bench's only way from a traveller's number to a work order. Within the
 * caller's companies and sites (scopeWhere; a floor device: its own site, row-level security too); highest priority,
 * then earliest due. A row is READY when its work order is released, in progress or completed and has finished garments
 * (good at the final operation) not yet released. No money and no person in any row.
 */

export interface BenchQuery {
  /** A scanned number (exact): that work order whatever its state, so the bench can say why it is not ready. */
  readonly number?: string | undefined
  readonly limit: number
}

/** How many work orders are looked at to fill a list of ready ones (each needs its scan progress). */
const CANDIDATES = 200

export async function benchWorkOrders(caller: CommandCaller, query: BenchQuery) {
  const context = inspectorOf(caller)
  const number = query.number?.trim()
  const where: Prisma.WorkOrderWhereInput = {
    AND: [
      scopeWhere(actorOf(context), QUALITY_INSPECTIONS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput,
      context.audience === 'floor' ? { siteId: context.siteId } : {},
      number ? { number } : { status: { in: ['IN_PROGRESS', 'COMPLETED'] } },
    ],
  }
  return caller.withClient(async (db) => {
    const orders = await db.workOrder.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { number: 'asc' }],
      take: number ? 5 : CANDIDATES,
      select: { id: true, number: true, batchNumber: true, status: true, siteId: true, dueDate: true, priority: true, styleId: true },
    })
    const styles = new Map(
      (await db.style.findMany({ where: { id: { in: [...new Set(orders.map((order) => order.styleId))] } }, select: { id: true, code: true, name: true } })).map((style) => [style.id, { code: style.code, name: style.name }]),
    )
    const open = new Map(
      (await db.inspection.findMany({ where: { workOrderId: { in: orders.map((order) => order.id) }, status: 'OPEN' }, select: { id: true, workOrderId: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }))
        .reverse()
        .map((row) => [row.workOrderId, row.id]),
    )
    const rows = []
    for (const order of orders) {
      const cells = await db.workOrderSize.findMany({ where: { workOrderId: order.id }, select: { id: true, quantity: true } })
      const pieces = cells.reduce((sum, cell) => sum + cell.quantity, 0)
      const progress = await scanProgressOf(db, order)
      const values = [...progress.values()].map((cell) => cell.finished)
      const finished = values.length === 0 ? 0 : values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      const counts = await releasedPerCell(db, cells.map((cell) => cell.id))
      const released = [...counts.values()].reduce((sum, entry) => sum + entry.released - entry.reversed, 0)
      const ready = (RELEASE_STATUSES as readonly string[]).includes(order.status) && finished !== null && finished > released
      if (!number && !ready) continue
      rows.push({
        id: order.id,
        number: order.number,
        batchNumber: order.batchNumber,
        status: order.status,
        siteId: order.siteId,
        dueDate: order.dueDate ? order.dueDate.toISOString().slice(0, 10) : null,
        priority: order.priority,
        style: styles.get(order.styleId) ?? { code: '', name: '' },
        pieces,
        finished,
        released,
        openInspectionId: open.get(order.id) ?? null,
        ready,
      })
      if (rows.length >= query.limit) break
    }
    return { workOrders: rows }
  })
}
