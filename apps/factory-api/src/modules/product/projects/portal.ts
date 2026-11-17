import type { FastifyRequest } from 'fastify'
import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_PROJECTS_VIEW } from '@nexus/factory-domain/projects/permissions'
import { PROJECT_LIMITS, type ProjectStatus } from '@nexus/factory-domain/projects/rules'
import { partnerCallerOf } from '../../../platform/search/partner/session'
import { dayOf } from './store'

/**
 * The partner's side of projects (threads plan TH-5, B-TH-069; PROJ-G07; design PROJ.portal-F01, F08):
 *
 *   GET /portal/projects    the projects of the portal's company the person is a MEMBER of (the office added them one by one),
 *                           open first, then by target date: number, name, status, target date — the Home's Messages card and
 *                           the supplier portal's own list (a customer also sees them on Samples & tech packs). Each opens on the
 *                           portal record page (its thread through the partner view, platform/search/partner/views/project.ts).
 *
 * Read in the PARTNER scope: the party's own member rows (RecordFollower by party) and projects (Project by party), never the
 * office's columns. Another person of the same company who was not added lists nothing; another company reads no row at all.
 */
export async function portalProjects(request: FastifyRequest) {
  const caller = partnerCallerOf(request)
  const companyId = caller.session.company.id
  return request.withClient(async (client) => {
    const mine = await client.recordFollower.findMany({ where: { recordType: 'Project', userId: caller.context.actorId }, select: { recordId: true }, take: PROJECT_LIMITS.list })
    if (mine.length === 0) return { projects: [] }
    const rows = await client.project.findMany({
      where: { id: { in: mine.map((row) => row.recordId) }, companyId },
      orderBy: [{ targetDate: 'asc' }, { id: 'asc' }],
      select: { id: true, companyId: true, partyId: true, number: true, name: true, status: true, targetDate: true },
    })
    const visible = rows.filter((row) => row.partyId !== null && can(caller.actor, PORTAL_PROJECTS_VIEW, { companyId: row.companyId, partyId: row.partyId }))
    const ordered = [...visible.filter((row) => row.status !== 'CLOSED'), ...visible.filter((row) => row.status === 'CLOSED')]
    return { projects: ordered.map((row) => ({ id: row.id, number: row.number, name: row.name, status: row.status as ProjectStatus, targetDate: dayOf(row.targetDate) })) }
  })
}
