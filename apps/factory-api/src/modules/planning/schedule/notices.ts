import { can, holds, reachesEveryParty } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as planningEvents } from '@nexus/factory-domain/planning/events'
import { PRODUCTION_DISPATCH_VIEW } from '@nexus/factory-domain/production/dispatch/permissions'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'

/**
 * "Notify line leaders" on a publish (B-W2b-GB29, G217; B-W2a-34's and B-W2a-45's gap; design planning.board pop "Publish
 * schedule v13 to the floor"): when a version of the working plan is published (`planning.schedule_published`) and the
 * publisher left "Notify line leaders" on, each leader of a line the version covers — the current lead of an ACTIVE team of
 * that line at the site (TeamMember.isLead, no end; an ACTIVE employee) with an office account — gets a SYSTEM notification
 * in the bell, anchored to the version and the line (a replay tells nobody twice), if they still reach Home (home.view) and
 * may read the dispatch list at the site now (production.dispatch.view: where the new list shows; B-PR-07: over every customer,
 * as the list holds every customer's work). The line tablets get the version by the live event, as before. Quiet: nobody
 * else, and never the publisher themselves.
 */

const payloadSchema = planningEvents.find((event) => event.type === 'planning.schedule_published')!.payload

export const SCHEDULE_PUBLISH_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'planning.schedulePublished',
    events: ['planning.schedule_published'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadSchema.parse(raw) as { siteId: string; planVersionId: string; number: number; notifyLeaders?: boolean }
      if (payload.notifyLeaders === false) return []
      const version = await context.tx.planVersion.findUnique({ where: { id: payload.planVersionId }, select: { companyId: true, siteId: true, kind: true, publishedById: true } })
      if (!version || version.kind !== 'PUBLISHED') return []
      const slots = await context.tx.scheduleSlot.findMany({ where: { planVersionId: payload.planVersionId, lineId: { not: null } }, distinct: ['lineId'], select: { lineId: true } })
      const lineIds = slots.flatMap((slot) => (slot.lineId ? [slot.lineId] : []))
      if (lineIds.length === 0) return []
      const lines = await context.tx.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true }, orderBy: { code: 'asc' } })
      const leads = await context.tx.teamMember.findMany({
        where: { isLead: true, until: null, employee: { status: 'ACTIVE', userId: { not: null } }, team: { siteId: version.siteId, status: 'ACTIVE', lineId: { in: lineIds } } },
        select: { employee: { select: { userId: true } }, team: { select: { lineId: true } } },
      })
      const scope = { companyId: version.companyId, siteId: version.siteId }
      const drafts: Draft[] = []
      for (const line of lines) {
        const userIds = [...new Set(leads.filter((lead) => lead.team.lineId === line.id).flatMap((lead) => (lead.employee.userId ? [lead.employee.userId] : [])))].sort()
        for (const userId of userIds) {
          if (userId === version.publishedById) continue
          const reader = await context.reader(userId)
          if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, PRODUCTION_DISPATCH_VIEW, scope)) continue
          // B-PR-07: the dispatch list needs every customer at the site; a lead limited to some customers cannot open it.
          if (!reachesEveryParty(reader.actor, PRODUCTION_DISPATCH_VIEW, scope)) continue
          drafts.push({
            userId,
            category: 'SYSTEM',
            record: { type: 'PlanVersion', id: payload.planVersionId, label: `v${payload.number}` },
            companyId: version.companyId,
            anchor: `line:${line.id}`,
            messageKey: 'notifications.planning.schedulePublished',
            params: { title: line.code, lineId: line.id, number: payload.number },
            actorId: version.publishedById,
          })
        }
      }
      return drafts
    },
  },
])
