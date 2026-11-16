import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { Reader, SiteRow } from '../store'

/**
 * When each work order starts on the site's working plan (B-W2b-20; B-W2a-22's and B-W2a-34's named swap): the day of its
 * earliest bar or part on the planning board (ScheduleSlot of the site's WORKING plan), in the site's zone. A work order
 * that is not on the board has no start here: its material stays needed on its order line's date. The plan inputs
 * (../inputs) give these to the netting, so the run's pegging, readiness and the shortage list need the material on the
 * scheduled start. Two reads (the working plan, its slots' earliest start per work order); no permission.
 */
export async function scheduledStartsOf(db: Reader, site: Pick<SiteRow, 'id' | 'timezone'>): Promise<Map<string, BusinessDate>> {
  const plan = await db.planVersion.findFirst({ where: { siteId: site.id, kind: 'WORKING' }, select: { id: true } })
  if (!plan) return new Map()
  const rows = await db.scheduleSlot.groupBy({ by: ['workOrderId'], where: { planVersionId: plan.id }, _min: { startAt: true } })
  const out = new Map<string, BusinessDate>()
  for (const row of rows) if (row._min.startAt) out.set(row.workOrderId, businessDate(row._min.startAt, site.timezone))
  return out
}

/**
 * B-W2b-GB29 (G218, B-W2b-20's gap): when each operation of a work order starts on the site's working plan: the day of its
 * earliest bar there (a bar names its work order operation), keyed `<workOrderId>|<routingSeq>`; an unplanned operation (no
 * routing step) and a bar of no operation are left out. The plan needs a material on the start of the first operation that
 * uses it (BomLine.routingSeq), else on the work order's start (above). Two reads; no permission.
 */
export async function scheduledOperationStartsOf(db: Reader, site: Pick<SiteRow, 'id' | 'timezone'>): Promise<Map<string, BusinessDate>> {
  const plan = await db.planVersion.findFirst({ where: { siteId: site.id, kind: 'WORKING' }, select: { id: true } })
  if (!plan) return new Map()
  const rows = await db.scheduleSlot.groupBy({ by: ['workOrderId', 'workOrderOperationId'], where: { planVersionId: plan.id, workOrderOperationId: { not: null } }, _min: { startAt: true } })
  const ids = [...new Set(rows.flatMap((row) => (row.workOrderOperationId ? [row.workOrderOperationId] : [])))]
  const operations = ids.length === 0 ? [] : await db.workOrderOperation.findMany({ where: { id: { in: ids }, routingSeq: { not: null } }, select: { id: true, routingSeq: true } })
  const seqOf = new Map(operations.map((operation) => [operation.id, operation.routingSeq]))
  const out = new Map<string, BusinessDate>()
  for (const row of rows) {
    const seq = row.workOrderOperationId ? seqOf.get(row.workOrderOperationId) : undefined
    if (seq === undefined || seq === null || !row._min.startAt) continue
    const key = `${row.workOrderId}|${seq}`
    const day = businessDate(row._min.startAt, site.timezone)
    const known = out.get(key)
    if (known === undefined || day < known) out.set(key, day)
  }
  return out
}
