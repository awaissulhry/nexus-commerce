import type { Prisma } from '@nexus/factory-db'
import { SAFETY_CALENDAR_MANAGE } from '@nexus/factory-domain/safety/calendar/permissions'
import { mayAt } from '../../organisation/access'
import { dateOfDay, dayOfDate, defineCalendarSource, sourceOf } from '../source'

/**
 * The deadlines typed on the safety calendar (B-W2b-120; QHS-227; factory-db SafetyDeadline: drills, the periodic meeting,
 * inspections, renewals, reports to an authority): open, done and cancelled ones due in the window, with their owner and
 * whether their evidence is on file. The only items the calendar edits in place (safety.calendar.manage).
 */
export default defineCalendarSource({
  kind: 'DEADLINE',
  async read(client, context, window, scope) {
    const rows = await client.safetyDeadline.findMany({
      where: { AND: [scope.place as Prisma.SafetyDeadlineWhereInput, { OR: [{ dueOn: { gte: dateOfDay(window.from), lte: dateOfDay(window.to) } }, { status: 'OPEN', dueOn: { gte: dateOfDay(window.openFrom), lte: dateOfDay(window.to) } }] }] },
      orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
      take: 2000,
      select: { id: true, companyId: true, siteId: true, title: true, kind: true, dueOn: true, status: true, ownerId: true, evidenceRequired: true },
    })
    const onFile = new Set(
      (await client.storedFile.findMany({ where: { recordType: 'SafetyDeadline', recordId: { in: rows.map((row) => row.id) }, status: 'AVAILABLE' }, select: { recordId: true } })).map((file) => file.recordId),
    )
    return rows.map((row) => ({
      key: `DEADLINE:${row.id}`,
      kind: 'DEADLINE',
      recordType: 'SafetyDeadline',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      dueOn: dayOfDate(row.dueOn),
      done: row.status === 'DONE',
      cancelled: row.status === 'CANCELLED',
      count: null,
      params: { title: row.title, kind: row.kind },
      ownerId: row.ownerId,
      evidence: { required: row.evidenceRequired, onFile: onFile.has(row.id) },
      law: null,
      source: sourceOf('plant.calendar', 'SafetyDeadline', row.id),
      editable: row.status === 'OPEN' && mayAt(context, SAFETY_CALENDAR_MANAGE, { companyId: row.companyId, siteId: row.siteId }),
    }))
  },
})
