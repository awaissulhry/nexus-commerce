import type { Prisma } from '@nexus/factory-db'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { defineCalendarSource, sourceOf, type SourceItem } from '../source'

/**
 * INAIL reports (B-W2b-120 reading factory-db InailFiling, B-W2b-91; the filings are B-W2b-125's): filings DUE (the
 * certificate received, due 48 hours after it) whose due time falls in the window, counted per incident — the incident's
 * number, never the injured person (protected: B-W2b-91 "others see 'One person involved' (count only)"). The filing is a
 * manual send on the INAIL portal; Plant › Incidents records it. D.Lgs. 81/2008 art. 18 c.1 r.
 */
export default defineCalendarSource({
  kind: 'INAIL_REPORT',
  async read(client, _context, window, scope) {
    const filings = await client.inailFiling.findMany({
      where: { status: 'DUE', dueAt: { gte: businessDayRange(window.openFrom).start, lt: businessDayRange(window.to).end }, incident: scope.site as Prisma.IncidentWhereInput },
      take: 2000,
      // The due time and the incident only: never the person, the type or the certificate.
      select: { dueAt: true, incident: { select: { id: true, companyId: true, siteId: true, number: true } } },
    })
    const groups = new Map<string, { incident: (typeof filings)[number]['incident']; dueOn: string; count: number }>()
    for (const filing of filings) {
      const dueOn = businessDate(filing.dueAt!)
      const key = `${filing.incident.id}:${dueOn}`
      const group = groups.get(key)
      if (group) group.count += 1
      else groups.set(key, { incident: filing.incident, dueOn, count: 1 })
    }
    return [...groups.entries()].map(([key, { incident, dueOn, count }]): SourceItem => ({
      key: `INAIL_REPORT:${key}`,
      kind: 'INAIL_REPORT',
      recordType: 'Incident',
      recordId: incident.id,
      companyId: incident.companyId,
      siteId: incident.siteId,
      dueOn,
      count,
      params: { incident: incident.number },
      ownerId: null,
      evidence: null,
      law: 'D.Lgs. 81/2008 art. 18 c.1 r',
      source: sourceOf('plant.incidents', 'Incident', incident.id),
      editable: false,
    }))
  },
})
