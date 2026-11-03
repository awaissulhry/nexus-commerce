import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { incidentEvents } from '@nexus/factory-domain/safety/events'
import { SAFETY_INCIDENTS_MANAGE, SAFETY_INCIDENTS_PEOPLE } from '@nexus/factory-domain/safety/incidents/permissions'
import { KIND_WORDS, reminderHoursOf, type IncidentKind } from '@nexus/factory-domain/safety/incidents/rules'
import { events as timerEvents } from '@nexus/factory-domain/timers/events'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'

/**
 * Who is told about incidents (B-W2b-125; the plan: "an INAIL deadline under 24 hours is never missed"), quiet, each one a
 * role's matter, never a chosen person:
 *
 *   incident.reported   ALERT to the safety roles who keep incidents at the site (safety.incidents.manage) and reach Home:
 *                       "New report INC-…: Hazard". Never the reporter themselves; never who sent one without a name.
 *   timer.fired         an INAIL filing's reminder (platform/timers, key INAIL_FILING_DUE:-24h, :-4h, and at the deadline:
 *                       ./filings.ts sets them when the certificate is recorded): ALERT to the people who keep the filings
 *                       (safety.incidents.people) at the site — "INAIL report for INC-… due by 04/11/2026 09:00", or late —
 *                       while the filing is still DUE with that deadline (filed, not needed or moved: nobody). The words name
 *                       the incident and the time only: never the person, the type or the absence.
 *
 * The bell carries them at once; the person's digest e-mail, when they switched it on, carries ALERTs too.
 */

const reportedSchema = incidentEvents.find((event) => event.type === 'incident.reported')!.payload
const timerSchema = timerEvents.find((event) => event.type === 'timer.fired')!.payload

/** A deadline in the factory's time zone, as people read it: 04/11/2026 09:00. */
export const deadlineWords = (at: Date): string =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at).replace(',', '')

async function holdersAt(context: RuleContext, permission: Permission, place: { readonly companyId: string; readonly siteId: string }, except: string | null): Promise<string[]> {
  const people: string[] = []
  for (const userId of await context.people()) {
    if (userId === except) continue
    const reader = await context.reader(userId)
    if (reader && holds(reader.actor, HOME_VIEW) && can(reader.actor, permission, place)) people.push(userId)
  }
  return people
}

export const INCIDENT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'safety.incidentReported',
    events: ['incident.reported'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = reportedSchema.parse(raw) as { incidentId: string; number: string; kind: IncidentKind }
      const incident = await context.tx.incident.findUnique({ where: { id: payload.incidentId }, select: { companyId: true, siteId: true, status: true, reportedById: true } })
      if (!incident || incident.status !== 'OPEN') return []
      const users = await holdersAt(context, SAFETY_INCIDENTS_MANAGE, incident, incident.reportedById)
      return users.map((userId) => ({
        userId,
        category: 'ALERT' as const,
        record: { type: 'Incident', id: payload.incidentId, label: payload.number },
        companyId: incident.companyId,
        anchor: `incident:${payload.incidentId}`,
        messageKey: 'notifications.safety.incidentReported' as const,
        params: { title: KIND_WORDS[payload.kind].en, kind: payload.kind },
        actorId: incident.reportedById,
      }))
    },
  },
  {
    name: 'safety.inailDue',
    events: ['timer.fired'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = timerSchema.parse(raw) as { timerId: string; timerKey: string; ruleId: string | null; recordType: string; recordId: string }
      const hours = payload.ruleId === null && payload.recordType === 'InailFiling' ? reminderHoursOf(payload.timerKey) : null
      if (hours === null) return []
      const timer = await context.tx.dueTimer.findUnique({ where: { id: payload.timerId }, select: { status: true, dueAt: true } })
      if (!timer || timer.status !== 'FIRED') return []
      const filing = await context.tx.inailFiling.findUnique({ where: { id: payload.recordId }, select: { status: true, dueAt: true, incident: { select: { id: true, number: true, companyId: true, siteId: true } } } })
      if (!filing || filing.status !== 'DUE' || filing.dueAt?.getTime() !== timer.dueAt.getTime()) return []
      const users = await holdersAt(context, SAFETY_INCIDENTS_PEOPLE, filing.incident, null)
      return users.map((userId) => ({
        userId,
        category: 'ALERT' as const,
        record: { type: 'Incident', id: filing.incident.id, label: filing.incident.number },
        companyId: filing.incident.companyId,
        anchor: `inail:${payload.recordId}`,
        messageKey: hours === 0 ? ('notifications.safety.inailLate' as const) : ('notifications.safety.inailDue' as const),
        params: { title: deadlineWords(filing.dueAt!), dueAt: filing.dueAt!.toISOString(), hoursBefore: hours },
        actorId: null,
      }))
    },
  },
])
