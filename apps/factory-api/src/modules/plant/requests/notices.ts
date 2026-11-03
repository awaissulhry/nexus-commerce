import { businessDate } from '@nexus/factory-domain/core/time'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { depthEvents, events as plantEvents } from '@nexus/factory-domain/plant/events'
import { PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import type { CommandTx } from '../../../core/command'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'

/**
 * Who is told where a machine request went and when it escalated (B-W2b-96; QHS-179; design plant.settings "push on",
 * "escalate … → supervisor → maintenance lead"), quiet:
 *   maintenance_request.reported    the office accounts of the team or technician the request was routed to (the team's
 *                                   members today, or the employee's own account), when the rule's push is on: ASSIGNMENT.
 *                                   Someone who also triages the site's requests already has W2a's notice of the report
 *                                   (one notice per person per event: that rule comes first).
 *   maintenance_request.escalated   the office account of the employee it escalated to: ALERT.
 * Each re-checks that the person still reaches Home (home.view) and sees the site's plant (plant.view). A technician on
 * the floor sees it on the tablet's queue at once (the live event; routed and escalated to them first). Nobody is told
 * about their own report.
 */

const reportedSchema = plantEvents.find((event) => event.type === 'maintenance_request.reported')!.payload
const escalatedSchema = depthEvents.find((event) => event.type === 'maintenance_request.escalated')!.payload

const TITLE_MAX = 80

/** The office accounts of a team's members today, or of one employee. */
async function accountsOf(tx: CommandTx, target: { readonly teamId: string | null; readonly employeeId: string | null }, now: Date): Promise<string[]> {
  let employeeIds: string[] = []
  if (target.teamId) {
    const today = new Date(`${businessDate(now)}T00:00:00.000Z`)
    const members = await tx.teamMember.findMany({ where: { teamId: target.teamId, since: { lte: today }, OR: [{ until: null }, { until: { gte: today } }] }, select: { employeeId: true } })
    employeeIds = members.map((member) => member.employeeId)
  } else if (target.employeeId) employeeIds = [target.employeeId]
  if (employeeIds.length === 0) return []
  const rows = await tx.employee.findMany({ where: { id: { in: [...new Set(employeeIds)] }, status: 'ACTIVE', userId: { not: null } }, select: { userId: true } })
  return [...new Set(rows.map((row) => row.userId).filter((id): id is string => id !== null))]
}

async function draftsFor(context: RuleContext, userIds: readonly string[], scope: { readonly companyId: string; readonly siteId: string }, base: Omit<Draft, 'userId'>): Promise<Draft[]> {
  const drafts: Draft[] = []
  for (const userId of userIds) {
    const reader = await context.reader(userId)
    if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, PLANT_VIEW, scope)) continue
    drafts.push({ ...base, userId })
  }
  return drafts
}

export const ROUTING_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'plant.routed',
    events: ['maintenance_request.reported'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = reportedSchema.parse(raw) as unknown as { requestId: string; machineId: string; assetNumber: string; unsafe: boolean; down: boolean }
      const request = await context.tx.maintenanceRequest.findUnique({
        where: { id: payload.requestId },
        select: { companyId: true, siteId: true, status: true, reportedById: true, description: true, routedTeamId: true, routedEmployeeId: true, symptom: { select: { labelEn: true } }, routingRule: { select: { push: true } } },
      })
      // Not routed, push off, or triaged before the fan-out ran: nobody to tell.
      if (!request || !request.routingRule?.push || (request.status !== 'NEW' && request.status !== 'ACKNOWLEDGED')) return []
      const users = await accountsOf(context.tx, { teamId: request.routedTeamId, employeeId: request.routedEmployeeId }, context.now)
      return draftsFor(context, users, { companyId: request.companyId, siteId: request.siteId }, {
        category: 'ASSIGNMENT',
        record: { type: 'Machine', id: payload.machineId, label: payload.assetNumber },
        companyId: request.companyId,
        anchor: `request:${payload.requestId}`,
        messageKey: 'notifications.plant.routed',
        params: { title: (request.symptom?.labelEn ?? request.description ?? 'a problem').slice(0, TITLE_MAX), requestId: payload.requestId, unsafe: payload.unsafe, down: payload.down },
        actorId: request.reportedById,
      })
    },
  },
  {
    name: 'plant.escalated',
    events: ['maintenance_request.escalated'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = escalatedSchema.parse(raw) as { requestId: string; machineId: string; assetNumber: string; level: number; escalatedToId: string }
      const request = await context.tx.maintenanceRequest.findUnique({ where: { id: payload.requestId }, select: { companyId: true, siteId: true, status: true, acknowledgedAt: true, description: true, symptom: { select: { labelEn: true } } } })
      // Acknowledged or triaged before the fan-out ran: nothing to tell.
      if (!request || request.status !== 'NEW' || request.acknowledgedAt !== null) return []
      const users = await accountsOf(context.tx, { teamId: null, employeeId: payload.escalatedToId }, context.now)
      return draftsFor(context, users, { companyId: request.companyId, siteId: request.siteId }, {
        category: 'ALERT',
        record: { type: 'Machine', id: payload.machineId, label: payload.assetNumber },
        companyId: request.companyId,
        anchor: `request:${payload.requestId}`,
        messageKey: 'notifications.plant.escalated',
        params: { title: (request.symptom?.labelEn ?? request.description ?? 'a problem').slice(0, TITLE_MAX), requestId: payload.requestId, level: payload.level },
        actorId: null,
      })
    },
  },
])
