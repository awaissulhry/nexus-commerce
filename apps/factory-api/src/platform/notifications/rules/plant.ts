import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as plantEvents } from '@nexus/factory-domain/plant/events'
import { PLANT_JOBS_WORK, PLANT_REQUESTS_TRIAGE } from '@nexus/factory-domain/plant/permissions'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * The plant's notices to maintenance (B-W2a-35; QHS-178, QHS-184; design plant.requests "Home › Notifications"), quiet:
 *   maintenance_request.reported   to the people who triage the machine's requests (plant.requests.triage over its company
 *                                  and site): ALERT when it was marked unsafe or the machine stopped, else SYSTEM; never
 *                                  the office reporter themselves. Routing to the technician on shift and escalation are
 *                                  Plant settings (W2b).
 *   maintenance_job.assigned       ASSIGNMENT to the office technician a job was given to (not when they took it
 *                                  themselves); a floor technician sees it on the tablet's My jobs.
 * Each re-checks that the person still reaches Home (home.view: the bell) and may do it now.
 */

const payloadOf = (type: string) => plantEvents.find((event) => event.type === type)!.payload

const TITLE_MAX = 80

export const PLANT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'plant.reported',
    events: ['maintenance_request.reported'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('maintenance_request.reported').parse(raw) as unknown as { requestId: string; machineId: string; assetNumber: string; unsafe: boolean; down: boolean }
      const request = await context.tx.maintenanceRequest.findUnique({ where: { id: payload.requestId }, select: { companyId: true, siteId: true, reportedById: true, description: true, symptom: { select: { labelEn: true } } } })
      if (!request) return []
      const scope = { companyId: request.companyId, siteId: request.siteId }
      const title = (request.symptom?.labelEn ?? request.description ?? 'a problem').slice(0, TITLE_MAX)
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        if (userId === request.reportedById) continue
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, PLANT_REQUESTS_TRIAGE, scope)) continue
        drafts.push({
          userId,
          category: payload.unsafe || payload.down ? 'ALERT' : 'SYSTEM',
          record: { type: 'Machine', id: payload.machineId, label: payload.assetNumber },
          companyId: request.companyId,
          anchor: `request:${payload.requestId}`,
          messageKey: payload.unsafe ? 'notifications.plant.unsafe' : 'notifications.plant.reported',
          params: { title, requestId: payload.requestId, unsafe: payload.unsafe, down: payload.down },
          actorId: request.reportedById,
        })
      }
      return drafts
    },
  },
  {
    name: 'plant.jobAssigned',
    events: ['maintenance_job.assigned'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('maintenance_job.assigned').parse(raw) as unknown as { jobId: string; number: string; assigneeId: string | null; assignedById: string | null }
      if (payload.assigneeId === null) return []
      const job = await context.tx.maintenanceJob.findUnique({ where: { id: payload.jobId }, select: { companyId: true, siteId: true, assigneeId: true, problem: true, status: true } })
      // Given to someone else meanwhile, or done: nothing to tell.
      if (!job || job.assigneeId !== payload.assigneeId || job.status === 'CLOSED' || job.status === 'CANCELLED') return []
      const reader = await context.reader(payload.assigneeId)
      if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, PLANT_JOBS_WORK, { companyId: job.companyId, siteId: job.siteId })) return []
      return [
        {
          userId: payload.assigneeId,
          category: 'ASSIGNMENT',
          record: { type: 'MaintenanceJob', id: payload.jobId, label: payload.number },
          companyId: job.companyId,
          anchor: `job:${payload.jobId}`,
          messageKey: 'notifications.assigned.job',
          params: { actorId: payload.assignedById, title: job.problem.slice(0, TITLE_MAX), jobId: payload.jobId },
          actorId: payload.assignedById,
        },
      ]
    },
  },
])
