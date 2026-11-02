import { events as alertEvents } from '@nexus/factory-domain/alerts/events'
import { roleReaches } from '@nexus/factory-domain/alerts/rules'
import { holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { maySee } from '../../../platform/alerts/store'
import { liveAssignment } from '../../../platform/auth/roles/access'
import { MAX_PEOPLE, type Draft, type FanOutRule, type RuleContext } from '../../../platform/notifications/fan-out'
import { rulesFor } from '../shifts/checks'
import type { LimitKind } from '@nexus/factory-domain/people/shifts/limits'

/**
 * Who a limit alerts (B-W2b-42; MES-232; design people.settings "who is alerted"): besides the exception rule's own
 * recipient (platform/notifications/rules/alerts), the raised WORKING_TIME_LIMIT alert tells the holders of the roles the
 * limit in force at its site names (WorkingTimeRule.alertRoles), where their assignment reaches the site, they still reach
 * Home (the bell) and may see the alert. The fan-out keeps one notification per person and event: nobody hears twice. The
 * alert names a site and a limit, never a person or a figure.
 */

const raised = alertEvents.find((event) => event.type === 'alert.raised')!.payload

export const LIMIT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'people.limitAlert',
    events: ['alert.raised'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = raised.parse(raw) as unknown as { alertId: string }
      const alert = await context.tx.alert.findUnique({ where: { id: payload.alertId }, select: { id: true, ruleKind: true, state: true, companyId: true, siteId: true, partyId: true, recordType: true, recordId: true, recordLabel: true, facts: true, rule: { select: { name: true } } } })
      if (!alert || alert.ruleKind !== 'WORKING_TIME_LIMIT' || alert.state === 'RESOLVED' || !alert.companyId || !alert.siteId) return []
      const limit = (alert.facts as { limit?: LimitKind } | null)?.limit
      if (!limit) return []
      const rules = await rulesFor(context.tx)
      const ruleId = rules({ companyId: alert.companyId, siteId: alert.siteId })[limit].ruleId
      const row = ruleId ? await context.tx.workingTimeRule.findUnique({ where: { id: ruleId }, select: { alertRoles: true } }) : null
      if (!row || row.alertRoles.length === 0) return []
      const held = await context.tx.roleAssignment.findMany({
        where: { role: { key: { in: row.alertRoles }, audience: 'OFFICE' }, ...liveAssignment(context.now), user: { status: 'ACTIVE' } },
        orderBy: [{ userId: 'asc' }, { id: 'asc' }],
        take: MAX_PEOPLE * 4,
        select: { userId: true, roleId: true, allCompanies: true, companyIds: true, siteIds: true, partyIds: true },
      })
      const scope = { companyId: alert.companyId, siteId: alert.siteId, partyId: alert.partyId }
      const people = new Set(held.filter((entry) => roleReaches({ roleId: entry.roleId, scope: { allCompanies: entry.allCompanies, companyIds: entry.companyIds, siteIds: entry.siteIds, partyIds: entry.partyIds } }, scope)).map((entry) => entry.userId))
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
])
