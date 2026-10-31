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
