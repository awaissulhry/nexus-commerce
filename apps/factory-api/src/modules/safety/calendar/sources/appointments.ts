import type { Prisma } from '@nexus/factory-db'
import { ROLE_LAW, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import { appointeeName } from '../../organisation/store'
import { dateOfDay, dayOfDate, defineCalendarSource, sourceOf } from '../source'

/**
 * Appointments ending (B-W2b-120; QHS-224; design "appointment renewals"): a safety role's term whose last day falls in the
 * window, named with its appointee (the organisation register the calendar's readers keep). A term that has ended is done.
 */
export default defineCalendarSource({
  kind: 'APPOINTMENT_END',
  async read(client, _context, window, scope) {
    const rows = await client.safetyAppointment.findMany({
      where: { AND: [scope.place as Prisma.SafetyAppointmentWhereInput, { untilDate: { gte: dateOfDay(window.from), lte: dateOfDay(window.to) } }] },
      orderBy: [{ untilDate: 'asc' }, { id: 'asc' }],
      take: 1000,
      select: { id: true, companyId: true, siteId: true, role: true, untilDate: true, outsideName: true, employee: { select: { firstName: true, lastName: true, status: true } } },
    })
    return rows.map((row) => {
      const dueOn = dayOfDate(row.untilDate!)
      return {
        key: `APPOINTMENT_END:${row.id}`,
        kind: 'APPOINTMENT_END',
        recordType: 'SafetyAppointment',
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        dueOn,
        done: dueOn < window.today,
        count: null,
        params: { role: row.role, person: appointeeName(row) },
        ownerId: null,
        evidence: null,
        law: ROLE_LAW[row.role as SafetyRole],
        source: sourceOf('plant.calendar', 'SafetyAppointment', row.id),
        editable: false,
      }
    })
  },
})
