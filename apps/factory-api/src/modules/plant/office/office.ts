import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { PLANT_JOBS_MANAGE, PLANT_JOBS_WORK, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { officeOf } from '../access'

/**
 * What the Office's plant screens pick from (B-W2a-53; design plant.machines, plant.requests, plant.jobs):
 *
 *   GET /plant/places             the sites of the screen's company (`x-factory-company`; every company the caller's
 *                                 plant.view reaches without one), each with its ACTIVE lines, work centres and stations:
 *                                 the New machine dialog and the machines list's station / work centre cells.
 *   GET /plant/technicians?siteId who a job of the site may be given to — the same people `checkAssignee` (../making.ts)
 *                                 takes: ACTIVE office users whose live roles work maintenance jobs (plant.jobs.work) over
 *                                 the site's company and site, and the site's ACTIVE floor workers with a live floor role
 *                                 that holds it. Floor workers are listed (by name) only to a caller who may see the floor
 *                                 workers at all (workers.view, as Admin › Users); a picker only — no figure, list, filter
 *                                 or total names anyone (Statuto dei Lavoratori art. 4; Owner answer W1).
 */

/** The most office people the technicians' list reads (a tenant's office staff), as the report recipients. */
const MAX_PEOPLE = 500
/** The most floor workers of one site it reads. */
const MAX_WORKERS = 1000

const WORKERS_VIEW = 'workers.view'

const placeOf = (row: { readonly id: string; readonly code: string; readonly name: string }) => ({ id: row.id, code: row.code, name: row.name })

/** GET /plant/places. */
export async function plantPlaces(caller: CommandCaller) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({
      where: { status: 'ACTIVE', ...(context.companyId ? { companyId: context.companyId } : {}) },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      select: { id: true, companyId: true, code: true, name: true },
    })
    const mine = sites.filter((site) => can(actor, PLANT_VIEW, { companyId: site.companyId, siteId: site.id }))
    const ids = mine.map((site) => site.id)
    // One query after the other: a transaction client runs one at a time.
    const lines = ids.length > 0 ? await client.line.findMany({ where: { siteId: { in: ids }, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, siteId: true, code: true, name: true } }) : []
    const centres = ids.length > 0 ? await client.workCentre.findMany({ where: { siteId: { in: ids }, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, siteId: true, code: true, name: true } }) : []
    const stations =
      ids.length > 0 ? await client.station.findMany({ where: { siteId: { in: ids }, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, siteId: true, code: true, name: true, lineId: true, workCentreId: true } }) : []
    return {
      sites: mine.map((site) => ({
        id: site.id,
        companyId: site.companyId,
        code: site.code,
        name: site.name,
        lines: lines.filter((row) => row.siteId === site.id).map(placeOf),
        workCentres: centres.filter((row) => row.siteId === site.id).map(placeOf),
        stations: stations.filter((row) => row.siteId === site.id).map((row) => ({ ...placeOf(row), lineId: row.lineId, workCentreId: row.workCentreId })),
      })),
    }
  })
}

/** GET /plant/technicians?siteId (plant.jobs.manage at the site). */
export async function plantTechnicians(caller: CommandCaller, siteId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = new Date()
  return caller.withClient(async (client) => {
    const site = isUuid(siteId) ? await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } }) : null
    if (!site || (context.companyId && site.companyId !== context.companyId) || !can(actor, PLANT_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
    const scope = { companyId: site.companyId, siteId: site.id }
    if (!can(actor, PLANT_JOBS_MANAGE, scope)) throw new ForbiddenError('Giving a job to a technician needs plant.jobs.manage at its site.')

    const technicians: { kind: 'USER' | 'WORKER'; id: string; name: string; me: boolean }[] = []
    const users = await client.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: MAX_PEOPLE, select: { id: true, displayName: true } })
    for (const user of users) {
      const reader: Actor = { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, user.id, now), true) }
      if (can(reader, PLANT_JOBS_WORK, scope)) technicians.push({ kind: 'USER', id: user.id, name: user.displayName, me: user.id === context.actorId })
    }

    const floorListed = can(actor, WORKERS_VIEW, scope)
    if (floorListed) {
      const workers = await client.worker.findMany({
        where: { siteId: site.id, status: 'ACTIVE', roles: { some: { endedAt: null, role: { permissions: { has: PLANT_JOBS_WORK } } } } },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: MAX_WORKERS,
        select: { id: true, displayName: true },
      })
      for (const worker of workers) technicians.push({ kind: 'WORKER', id: worker.id, name: worker.displayName, me: false })
    }
    // Me first (I take the job myself), then the office people, then the floor technicians, each by name.
    return { technicians: [...technicians.filter((entry) => entry.me), ...technicians.filter((entry) => !entry.me)], floorListed }
  })
}
