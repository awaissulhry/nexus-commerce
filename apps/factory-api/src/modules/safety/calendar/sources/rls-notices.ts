import type { Prisma } from '@nexus/factory-db'
import { RLS_NOTICE_LAW } from '@nexus/factory-domain/safety/organisation/rules'
import { appointeeName } from '../../organisation/store'
import { dateOfDay, dayOfDate, defineCalendarSource, sourceOf } from '../source'

/**
 * The RLS notice to INAIL (B-W2b-120; QHS-226; art. 18 c.1 aa): a PENDING notice on its due day, a FILED one on the day it
 * was filed (done). The plan gives no number of days for it: a notice still on its default day (the RLS's first day) is
 * "to confirm", never late; once a person set the day the safety consultant confirmed (POST …/due), it is a deadline like
 * any other.
 */
export default defineCalendarSource({
  kind: 'RLS_NOTICE',
  async read(client, _context, window, scope) {
    const from = dateOfDay(window.from)
    const openFrom = dateOfDay(window.openFrom)
    const to = dateOfDay(window.to)
    const rows = await client.rlsNotice.findMany({
      where: { appointment: scope.place as Prisma.SafetyAppointmentWhereInput, OR: [{ status: 'PENDING', dueOn: { gte: openFrom, lte: to } }, { status: 'FILED', filedOn: { gte: from, lte: to } }] },
      orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
      take: 500,
      select: { id: true, companyId: true, status: true, dueOn: true, filedOn: true, appointment: { select: { siteId: true, role: true, fromDate: true, outsideName: true, employee: { select: { firstName: true, lastName: true, status: true } } } } },
    })
    return rows.map((row) => ({
      key: `RLS_NOTICE:${row.id}`,
      kind: 'RLS_NOTICE',
      recordType: 'RlsNotice',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.appointment.siteId,
      dueOn: dayOfDate(row.status === 'FILED' ? row.filedOn! : row.dueOn),
      done: row.status === 'FILED',
      toConfirm: row.status === 'PENDING' && row.dueOn.getTime() === row.appointment.fromDate.getTime(),
      count: null,
      params: { role: row.appointment.role, person: appointeeName(row.appointment) },
      ownerId: null,
      evidence: null,
      law: RLS_NOTICE_LAW,
      source: sourceOf('plant.calendar', 'RlsNotice', row.id),
      editable: false,
    }))
  },
})
