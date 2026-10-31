import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { SITES_MANAGE, SITES_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { areaProblems, cleanStructureCode, orgTreeOf } from '@nexus/factory-domain/people/teams/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { actorOf } from '../../../core/context'
import { actorIdOf, assertMay, assertMayWrite, assertVersion, bodyIssue, may, officeOf, problemsError, refuse } from '../employees/access'

/**
 * The org tree: site › area › line › station (B-W2b-26; PLT-005; design admin.org "Lines and stations", people.employees
 * "Teams view" grouped by Site › Line › Team). Areas are part of a site's structure: read with sites.view, kept with
 * sites.manage (Admin › Companies & sites keeps the sites, lines and stations: platform/admin/org), each checked with
 * can() against the site's company and site.
 *
 *   GET  /org/tree                       the tree of the caller's sites (a site, a company), with each line's teams
 *   POST /org/sites/:siteId/areas        an area of a site (a hall, a room): a code unique on the site, a name, its order
 *   PATCH /org/areas/:areaId             its name and order
 *   POST /org/areas/:areaId/archive      archived (only with no active line in it)
 *   PUT  /org/lines/:lineId/area         the area a line is in (one of its site's active areas), or none
 */

const AREA_SELECT = { id: true, companyId: true, siteId: true, code: true, name: true, sortOrder: true, status: true, version: true } as const satisfies Prisma.OrgAreaSelect
type AreaRow = Prisma.OrgAreaGetPayload<{ select: typeof AREA_SELECT }>

const areaView = (row: AreaRow) => ({ id: row.id, siteId: row.siteId, code: row.code, name: row.name, sortOrder: row.sortOrder, status: row.status as 'ACTIVE' | 'ARCHIVED', version: row.version })

const WORDS = "A site's areas are kept by a role that keeps its sites and lines (sites.manage)."

/** GET /org/tree. */
export async function orgTree(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly companyId?: string | undefined; readonly includeArchived?: boolean | undefined }) {
  const context = officeOf(caller)
  const active = query.includeArchived ? {} : { status: 'ACTIVE' as const }
  return caller.withClient(async (client) => {
    const siteScope = scopeWhereSite(context)
    const sites = await client.site.findMany({ where: { AND: [siteScope, query.siteId ? { id: query.siteId } : {}, query.companyId ? { companyId: query.companyId } : {}, active] }, orderBy: [{ code: 'asc' }], take: 200, select: { id: true, companyId: true, code: true, name: true, status: true } })
    const siteIds = sites.map((site) => site.id)
    const [areas, lines, stations, teams] = [
      await client.orgArea.findMany({ where: { siteId: { in: siteIds }, ...active }, select: AREA_SELECT }),
      await client.line.findMany({ where: { siteId: { in: siteIds }, ...active }, select: { id: true, siteId: true, areaId: true, code: true, name: true, status: true, version: true } }),
      await client.station.findMany({ where: { siteId: { in: siteIds }, ...active }, select: { id: true, siteId: true, lineId: true, code: true, name: true, status: true } }),
      await client.team.findMany({ where: { siteId: { in: siteIds }, status: 'ACTIVE' }, select: { id: true, siteId: true, lineId: true, code: true, name: true, _count: { select: { members: { where: { until: null } } } } } }),
    ]
    const tree = orgTreeOf({
      sites,
      areas: areas.map((area) => ({ ...areaView(area), siteId: area.siteId })),
      lines,
      stations,
      teams: teams.map((team) => ({ id: team.id, siteId: team.siteId, lineId: team.lineId, code: team.code, name: team.name, members: team._count.members })),
    })
    const strip = <T extends { readonly siteId: string }>(row: T): Omit<T, 'siteId'> => {
      const { siteId: _site, ...rest } = row
      return rest
    }
    return {
      sites: tree.map((site) => ({
        id: site.id,
        companyId: site.companyId,
        code: site.code,
        name: site.name,
        status: site.status,
        areas: site.areas.map((area) => ({ ...area, status: area.status as 'ACTIVE' | 'ARCHIVED', lines: area.lines.map((line) => ({ ...strip(line), stations: line.stations.map(strip), teams: line.teams.map(strip) })) })),
        linesWithoutArea: site.linesWithoutArea.map((line) => ({ ...strip(line), stations: line.stations.map(strip), teams: line.teams.map(strip) })),
        stationsWithoutLine: site.stationsWithoutLine.map(strip),
        teamsWithoutLine: site.teamsWithoutLine.map(strip),
        canManage: may(context, SITES_MANAGE, { companyId: site.companyId, siteId: site.id }),
      })),
    }
  })
}

/** The sites sites.view reaches (on Site the site key is its id). */
const scopeWhereSite = (context: ReturnType<typeof officeOf>): Prisma.SiteWhereInput => scopeWhere(actorOf(context), SITES_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput

/** POST /org/sites/:siteId/areas. */
export async function createArea(caller: CommandCaller, siteId: string, body: { readonly code: string; readonly name: string; readonly sortOrder?: number | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = areaProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The area is not valid.')
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, status: true, code: true } })) : null
  if (!site) throw new NotFoundError('Site not found.')
  assertMay(context, SITES_VIEW, { companyId: site.companyId, siteId: site.id }, 'Site')
  assertMayWrite(context, SITES_MANAGE, { companyId: site.companyId, siteId: site.id }, WORDS)
  const code = cleanStructureCode(body.code)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'org.createArea', idempotencyKey, input: { siteId, ...body } }, async (tools) => {
    const { tx, now } = tools
    if (site.status !== 'ACTIVE') refuse('SITE_ARCHIVED', `Site ${site.code} is archived.`)
    if (await tx.orgArea.findFirst({ where: { siteId, code }, select: { id: true } })) refuse('CODE_TAKEN', `The site has an area ${code} already.`, 'code')
    await tx.orgArea.create({ data: { id, companyId: site.companyId, siteId, code, name: body.name.trim(), sortOrder: body.sortOrder ?? 0, createdAt: now, updatedAt: now, createdById: actorIdOf(tools.context) }, select: { id: true } })
    tools.audit({ action: 'org.createArea', recordType: 'OrgArea', recordId: id, companyId: site.companyId, siteId, after: { code, name: body.name.trim(), sortOrder: body.sortOrder ?? 0 } })
    tools.emit({ type: 'org_area.changed', subject: id, companyId: site.companyId, siteId, payload: { areaId: id, code, change: 'CREATED', lineIds: [] } })
    return { area: areaView((await tx.orgArea.findUnique({ where: { id }, select: AREA_SELECT }))!) }
  })
  return { ...result, replayed }
}

async function writableArea(caller: CommandCaller, areaId: string): Promise<AreaRow> {
  const context = officeOf(caller)
  const area = isUuid(areaId) ? await caller.withClient((client) => client.orgArea.findUnique({ where: { id: areaId }, select: AREA_SELECT })) : null
  if (!area) throw new NotFoundError('Area not found.')
  assertMay(context, SITES_VIEW, area, 'Area')
  assertMayWrite(context, SITES_MANAGE, area, WORDS)
  return area
}

async function lockArea(tx: CommandTx, areaId: string): Promise<AreaRow> {
  await tx.$queryRaw`SELECT "id" FROM "OrgArea" WHERE "id" = ${areaId}::uuid FOR UPDATE`
  return (await tx.orgArea.findUnique({ where: { id: areaId }, select: AREA_SELECT }))!
}

/** PATCH /org/areas/:areaId. */
export async function updateArea(caller: CommandCaller, areaId: string, body: { readonly version: number; readonly name?: string | undefined; readonly sortOrder?: number | undefined }, idempotencyKey?: string) {
  const problems = areaProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
  await writableArea(caller, areaId)
  const { result } = await command(caller, { name: 'org.updateArea', idempotencyKey, input: { areaId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const area = await lockArea(tx, areaId)
    assertVersion('area', area.version, body.version)
    if (area.status !== 'ACTIVE') refuse('AREA_ARCHIVED', `Area ${area.code} is archived: it no longer changes.`)
    const data: Prisma.OrgAreaUncheckedUpdateInput = {}
    if (body.name !== undefined && body.name.trim() !== area.name) data.name = body.name.trim()
    if (body.sortOrder !== undefined && body.sortOrder !== area.sortOrder) data.sortOrder = body.sortOrder
    if (Object.keys(data).length > 0) {
      await tx.orgArea.update({ where: { id: area.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.emit({ type: 'org_area.changed', subject: area.id, companyId: area.companyId, siteId: area.siteId, payload: { areaId: area.id, code: area.code, change: 'EDITED', lineIds: [] } })
    }
    tools.audit({ action: 'org.updateArea', recordType: 'OrgArea', recordId: area.id, companyId: area.companyId, siteId: area.siteId, before: { name: area.name, sortOrder: area.sortOrder }, after: Object.keys(data).length > 0 ? data : { unchanged: true } })
    return { area: areaView((await tx.orgArea.findUnique({ where: { id: area.id }, select: AREA_SELECT }))!) }
  })
  return result
}

/** POST /org/areas/:areaId/archive: only with no active line in it. */
export async function archiveArea(caller: CommandCaller, areaId: string, body: { readonly version: number }, idempotencyKey?: string) {
  await writableArea(caller, areaId)
  const { result } = await command(caller, { name: 'org.archiveArea', idempotencyKey, input: { areaId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const area = await lockArea(tx, areaId)
    assertVersion('area', area.version, body.version)
    if (area.status !== 'ACTIVE') refuse('AREA_ARCHIVED', `Area ${area.code} is archived already.`)
    const lines = await tx.line.findMany({ where: { areaId, status: 'ACTIVE' }, select: { code: true }, orderBy: { code: 'asc' } })
    if (lines.length > 0) refuse('AREA_NOT_EMPTY', `Lines ${lines.map((line) => line.code).join(', ')} are in area ${area.code}: move them out first.`)
    await tx.orgArea.update({ where: { id: area.id }, data: { status: 'ARCHIVED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'org.archiveArea', recordType: 'OrgArea', recordId: area.id, companyId: area.companyId, siteId: area.siteId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    tools.emit({ type: 'org_area.changed', subject: area.id, companyId: area.companyId, siteId: area.siteId, payload: { areaId: area.id, code: area.code, change: 'ARCHIVED', lineIds: [] } })
    return { area: areaView((await tx.orgArea.findUnique({ where: { id: area.id }, select: AREA_SELECT }))!) }
  })
  return result
}

/** PUT /org/lines/:lineId/area: the area the line is in (an active area of its site), or none. */
export async function setLineArea(caller: CommandCaller, lineId: string, body: { readonly version: number; readonly areaId: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = isUuid(lineId) ? await caller.withClient((client) => client.line.findUnique({ where: { id: lineId }, select: { id: true, companyId: true, siteId: true } })) : null
  if (!known) throw new NotFoundError('Line not found.')
  assertMay(context, SITES_VIEW, known, 'Line')
  assertMayWrite(context, SITES_MANAGE, known, WORDS)
  const { result } = await command(caller, { name: 'org.setLineArea', idempotencyKey, input: { lineId, ...body }, record: { type: 'Line', id: lineId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const line = (await tx.line.findUnique({ where: { id: lineId }, select: { id: true, companyId: true, siteId: true, code: true, name: true, areaId: true, status: true, version: true } }))!
    if (line.status !== 'ACTIVE') refuse('LINE_ARCHIVED', `Line ${line.code} is archived.`)
    if (body.areaId !== null) {
      const area = await tx.orgArea.findUnique({ where: { id: body.areaId }, select: { siteId: true, status: true, code: true } })
      if (!area || area.siteId !== line.siteId) throw bodyIssue('areaId', "The area is an area of the line's site.")
      if (area.status !== 'ACTIVE') refuse('AREA_ARCHIVED', `Area ${area.code} is archived: pick an active one.`, 'areaId')
    }
    if (body.areaId !== line.areaId) {
      await tx.line.update({ where: { id: line.id }, data: { areaId: body.areaId, updatedAt: now }, select: { id: true } })
      tools.emit({ type: 'org_area.changed', subject: body.areaId ?? line.areaId ?? line.id, companyId: line.companyId, siteId: line.siteId, payload: { areaId: body.areaId, code: null, change: 'LINE_MOVED', lineIds: [line.id] } })
    }
    tools.audit({ action: 'org.setLineArea', recordType: 'Line', recordId: line.id, companyId: line.companyId, siteId: line.siteId, before: { areaId: line.areaId }, after: { areaId: body.areaId } })
    return { line: { id: line.id, siteId: line.siteId, code: line.code, name: line.name, areaId: body.areaId, version: line.version } }
  })
  return result
}
