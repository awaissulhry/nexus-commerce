import { events as alertEvents } from '@nexus/factory-domain/alerts/events'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { holds } from '@nexus/factory-domain/core/permissions'
import { maySee } from '../../alerts/store'
import { ALERTS_HANDLE } from '@nexus/factory-domain/alerts/permissions'
// B-W2b-435 (ANA-041): the rule's routes decide who is told at a place they cover; elsewhere the rule's own role.
import { alertRecipients } from '../../alerts/routes/recipients'
import { MAX_PEOPLE, type Draft, type FanOutRule, type RuleContext } from '../fan-out'

/**
 * The exception rules' alerts (B-W2a-33; design home.alerts "who gets them", PLT-142 quiet defaults):
 *   alert.raised     ALERT to the people the rule names: the holders of its recipient role whose assignment reaches the
 *                    alert's place (company, site, party), who still reach Home (the bell) and may see the alert (alerts.view
 *                    and its record's own view permission there); B-W2b-435: where the rule's routes cover the alert's place
 *                    (company, site, line, customer), the routes' roles and people instead (../../alerts/routes/recipients.ts).
 *                    A rule without a role or a covering route tells nobody; a rule whose
 *                    channels leave out the bell makes no notification (W2a refuses such a rule: e-mail alone waits for
 *                    the preferences, W2b; the daily digest a person turned on carries ALERT notifications).
 *   alert.assigned   ASSIGNMENT to the person an alert was given to (not when they took it themselves), while it is still
 *                    theirs and unresolved, and they may still handle it.
 * No amount: an alert's words carry none.
 */

const payloadOf = (type: string) => alertEvents.find((event) => event.type === type)!.payload

const ALERT_SELECT = { id: true, ruleId: true, ruleKind: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true, recordLabel: true, facts: true, state: true, assignedToId: true, rule: { select: { name: true, recipientRoleId: true, channels: true } } } as const

export const ALERT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'alerts.raised',
    events: ['alert.raised'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('alert.raised').parse(raw) as unknown as { alertId: string }
      const alert = await context.tx.alert.findUnique({ where: { id: payload.alertId }, select: ALERT_SELECT })
      if (!alert || alert.state === 'RESOLVED' || !alert.rule.channels.includes('IN_APP')) return []
      const { people } = await alertRecipients(context.tx, alert, context.now, MAX_PEOPLE)
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
