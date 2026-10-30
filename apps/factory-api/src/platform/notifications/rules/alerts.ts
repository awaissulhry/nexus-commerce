import { events as alertEvents } from '@nexus/factory-domain/alerts/events'
import { roleReaches } from '@nexus/factory-domain/alerts/rules'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { holds } from '@nexus/factory-domain/core/permissions'
import { maySee } from '../../alerts/store'
import { ALERTS_HANDLE } from '@nexus/factory-domain/alerts/permissions'
import { liveAssignment } from '../../auth/roles/access'
import { MAX_PEOPLE, type Draft, type FanOutRule, type RuleContext } from '../fan-out'

/**
 * The exception rules' alerts (B-W2a-33; design home.alerts "who gets them", PLT-142 quiet defaults):
 *   alert.raised     ALERT to the people the rule names: the holders of its recipient role whose assignment reaches the
 *                    alert's place (company, site, party), who still reach Home (the bell) and may see the alert (alerts.view
 *                    and its record's own view permission there). A rule without a role tells nobody; a rule whose
 *                    channels leave out the bell makes no notification (W2a refuses such a rule: e-mail alone waits for
 *                    the preferences, W2b; the daily digest a person turned on carries ALERT notifications).
 *   alert.assigned   ASSIGNMENT to the person an alert was given to (not when they took it themselves), while it is still
 *                    theirs and unresolved, and they may still handle it.
 * No amount: an alert's words carry none.
 */

const payloadOf = (type: string) => alertEvents.find((event) => event.type === type)!.payload

const ALERT_SELECT = { id: true, ruleKind: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true, recordLabel: true, state: true, assignedToId: true, rule: { select: { name: true, recipientRoleId: true, channels: true } } } as const

/** The live office assignments of a role, with their people (at most MAX_PEOPLE people). */
async function holdersOf(context: RuleContext, roleId: string) {
  return context.tx.roleAssignment.findMany({
    where: { roleId, ...liveAssignment(context.now), user: { status: 'ACTIVE' } },
    orderBy: [{ userId: 'asc' }, { id: 'asc' }],
    take: MAX_PEOPLE * 4,
    select: { userId: true, roleId: true, allCompanies: true, companyIds: true, siteIds: true, partyIds: true },
  })
}

export const ALERT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'alerts.raised',
    events: ['alert.raised'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('alert.raised').parse(raw) as unknown as { alertId: string }
      const alert = await context.tx.alert.findUnique({ where: { id: payload.alertId }, select: ALERT_SELECT })
      if (!alert || alert.state === 'RESOLVED' || !alert.rule.recipientRoleId || !alert.rule.channels.includes('IN_APP')) return []
      const scope = { companyId: alert.companyId, siteId: alert.siteId, partyId: alert.partyId }
      const people = new Set<string>()
      for (const held of await holdersOf(context, alert.rule.recipientRoleId)) {
        if (roleReaches({ roleId: held.roleId, scope: { allCompanies: held.allCompanies, companyIds: held.companyIds, siteIds: held.siteIds, partyIds: held.partyIds } }, scope)) people.add(held.userId)
        if (people.size >= MAX_PEOPLE) break
      }
      const drafts: Draft[] = []
      for (const userId of people) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !maySee(reader.actor, alert)) continue
        drafts.push({
          userId,
          category: 'ALERT',
          record: { type: alert.recordType, id: alert.recordId, label: alert.recordLabel },
          companyId: alert.companyId,
          anchor: `alert:${alert.id}`,
          messageKey: 'notifications.alert.raised',
          params: { title: alert.rule.name, alertId: alert.id, ruleKind: alert.ruleKind },
          actorId: null,
        })
      }
      return drafts
    },
  },
  {
    name: 'alerts.assigned',
    events: ['alert.assigned'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('alert.assigned').parse(raw) as unknown as { alertId: string; assigneeId: string | null; assignedById: string }
      if (payload.assigneeId === null) return []
      const alert = await context.tx.alert.findUnique({ where: { id: payload.alertId }, select: ALERT_SELECT })
      // Taken back, given to someone else or resolved meanwhile: nothing to tell.
      if (!alert || alert.state === 'RESOLVED' || alert.assignedToId !== payload.assigneeId) return []
      const reader = await context.reader(payload.assigneeId)
      if (!reader || !holds(reader.actor, HOME_VIEW) || !maySee(reader.actor, alert, ALERTS_HANDLE)) return []
      return [
        {
          userId: payload.assigneeId,
          category: 'ASSIGNMENT',
          record: { type: alert.recordType, id: alert.recordId, label: alert.recordLabel },
          companyId: alert.companyId,
          anchor: `alert:${alert.id}`,
          messageKey: 'notifications.assigned.alert',
          params: { actorId: payload.assignedById, title: alert.rule.name, alertId: alert.id },
          actorId: payload.assignedById,
        },
      ]
    },
  },
])
