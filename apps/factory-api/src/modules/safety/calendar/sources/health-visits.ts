import type { Prisma } from '@nexus/factory-db'
import { dateOfDay, dayOfDate, defineCalendarSource, sourceOf, type SourceItem } from '../source'

/**
 * Health visits (B-W2b-120 reading factory-db HealthVisit, B-W2b-91; the visits are B-W2b-135's): visits DUE or BOOKED
 * whose day falls in the window, as COUNTS per site and day, for everyone who reads the calendar (design: "medical visits
 * (a count for people without health access)" — the calendar is stricter: a count for all, so it writes no view of
 * protected data and names nobody). No visit type, no person, no judgement: those stay on Plant › Health surveillance,
 * behind its gate, every view recorded there (B-W2b-91 "HR and the safety roles"). D.Lgs. 81/2008 art. 41.
 */
export default defineCalendarSource({
  kind: 'HEALTH_VISIT',
  async read(client, _context, window, scope) {
    const visits = await client.healthVisit.findMany({
      where: { status: { in: ['DUE', 'BOOKED'] }, dueOn: { gte: dateOfDay(window.openFrom), lte: dateOfDay(window.to) }, employee: scope.site as Prisma.EmployeeWhereInput },
      take: 5000,
      // Only what a count needs: the day, the state, the company and the person's site (never the person or the type).
      select: { companyId: true, dueOn: true, status: true, employee: { select: { siteId: true } } },
    })
    const groups = new Map<string, { companyId: string; siteId: string; dueOn: string; due: number; booked: number }>()
    for (const visit of visits) {
      const dueOn = dayOfDate(visit.dueOn)
      const key = `${visit.companyId}:${visit.employee.siteId}:${dueOn}`
      const group = groups.get(key) ?? { companyId: visit.companyId, siteId: visit.employee.siteId, dueOn, due: 0, booked: 0 }
      if (visit.status === 'BOOKED') group.booked += 1
      else group.due += 1
      groups.set(key, group)
    }
    return [...groups.entries()].map(([key, group]): SourceItem => ({
      key: `HEALTH_VISIT:${key}`,
      kind: 'HEALTH_VISIT',
      recordType: null,
      recordId: null,
      companyId: group.companyId,
      siteId: group.siteId,
      dueOn: group.dueOn,
      count: group.due + group.booked,
      params: { due: String(group.due), booked: String(group.booked) },
      ownerId: null,
      evidence: null,
      law: 'D.Lgs. 81/2008 art. 41',
      source: sourceOf('plant.health'),
      editable: false,
    }))
  },
})
