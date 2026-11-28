import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PEOPLE_STRUCTURE_MANAGE } from '@nexus/factory-domain/people/structure/permissions'
import { movePlan } from '@nexus/factory-domain/people/teams/rules'
import { UNIT_ACTIONS } from '@nexus/factory-domain/people/units/history'
import { OPEN_ORDER_STATES, readyMadePreview, readyMadeRows, UNIT_REFUSALS, type ReadyMadeChange, type ReadyMadeKind } from '@nexus/factory-domain/people/units/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { actorIdOf, assertMayWrite, dateOf, dayOf, officeOf, refuse, todayOf } from '../employees/access'
import { nameOf } from '../employees/store'
import { lockStructure } from './read'
import { MANAGE_WORDS, refuseAll, tenantOf } from './units'

/**
 * Ready-made factory structures (owb-ss5 step 5.2; design § 5zb "Start fast: Ready-made… the owner and the teams · with supervisors ·
 * with a general manager. Then you change it"; prototype org.js ORG_TPL, orgArrange, orgTplDiff): office only,
 * people.structure.manage over the site.
 *
 *   POST /people/units/ready-made/preview { kind, siteId? }   { rows: [{ name, words }] }: what it would make, move and close on
 *                                                            the site, one line a unit (writes nothing); a blocker is a line too
 *   POST /people/units/ready-made/apply   { kind, siteId? }   the same, read again under the structure's lock and written in one
 *                                                            command ({ rows, applied }); refused in words while a blocker stands
 *
 * The plan is the domain's readyMadePreview (factory-domain people/units/rules): the levels above the teams, found by their fixed
 * codes on the site (made, or opened again), the units at the top or under a ready-made unit placed, the ready-made units no
 * longer wanted closed (their people taken out: they wait in "In no unit yet"). A unit the owner put under one of their own units
 * stays there. Without `siteId`: the one site where the caller keeps the structure (more than one: 409 SITE_NEEDED).
 */

type Client = FactoryClient | CommandTx

export interface ReadyMadeBody {
  readonly kind: ReadyMadeKind
  readonly siteId?: string | undefined
}

/** The site of a ready-made structure: the one named (one the caller keeps the structure of), or the only one they keep. */
async function siteOf(caller: CommandCaller, context: OfficeContext, siteId: string | undefined) {
  return caller.withClient(async (client) => {
    if (siteId !== undefined) {
      const site = isUuid(siteId) ? await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, status: true } }) : null
      if (!site) throw new NotFoundError('Site not found.')
      assertMayWrite(context, PEOPLE_STRUCTURE_MANAGE, { companyId: site.companyId, siteId: site.id }, MANAGE_WORDS)
      return site
    }
    const sites = await client.site.findMany({ where: { AND: [scopeWhere(actorOf(context), PEOPLE_STRUCTURE_MANAGE, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, { status: 'ACTIVE' }] }, take: 2, select: { id: true, companyId: true, status: true } })
    if (sites.length !== 1) return refuse('SITE_NEEDED', UNIT_REFUSALS.SITE_NEEDED, 'siteId')
    return sites[0]!
  })
}

/** The facts of one site: its units (with their area, people and orders in work), its areas, and the memberships to end. */
async function factsOf(client: Client, siteId: string) {
  const site = (await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, name: true } }))!
  const units = await client.team.findMany({ where: { siteId }, orderBy: [{ code: 'asc' }], select: { id: true, code: true, name: true, parentTeamId: true, takesOrders: true, status: true, mergedIntoId: true, lineId: true } })
  const unitIds = units.map((unit) => unit.id)
  const lineIds = [...new Set(units.flatMap((unit) => (unit.lineId ? [unit.lineId] : [])))]
  const areaOfLine = new Map((lineIds.length === 0 ? [] : await client.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, areaId: true } })).map((line) => [line.id, line.areaId]))
  const areas = await client.orgArea.findMany({ where: { siteId, status: 'ACTIVE' }, select: { id: true, code: true, name: true, sortOrder: true } })
  const members =
    unitIds.length === 0
      ? []
      : await client.teamMember.findMany({ where: { teamId: { in: unitIds }, until: null }, select: { id: true, teamId: true, employeeId: true, isLead: true, since: true, employee: { select: { firstName: true, lastName: true } } } })
  const working = unitIds.length === 0 ? [] : await client.orderTeam.findMany({ where: { teamId: { in: unitIds }, endedAt: null, salesOrder: { status: { in: [...OPEN_ORDER_STATES] } } }, select: { teamId: true } })
  const plannable = {
    siteName: site.name,
    areas,
    units: units.map((unit) => ({
      id: unit.id,
      code: unit.code,
      name: unit.name,
      parentId: unit.parentTeamId,
      takesOrders: unit.takesOrders,
      closed: unit.status !== 'ACTIVE',
      mergedIntoId: unit.mergedIntoId,
      areaId: unit.lineId ? (areaOfLine.get(unit.lineId) ?? null) : null,
      members: members.filter((member) => member.teamId === unit.id).map((member) => ({ employeeId: member.employeeId, name: nameOf(member.employee) })),
      openOrders: working.filter((row) => row.teamId === unit.id).length,
    })),
  }
  return { site, plannable, members }
}

/** POST /people/units/ready-made/preview: nothing is written; one line a unit that changes (its name, what happens), then the blockers. */
export async function previewReadyMade(caller: CommandCaller, body: ReadyMadeBody) {
  const context = officeOf(caller)
  const site = await siteOf(caller, context, body.siteId)
  return caller.withClient(async (client) => {
    const { plannable } = await factsOf(client, site.id)
    return { rows: readyMadeRows(readyMadePreview(body.kind, plannable)) }
  })
}

/** POST /people/units/ready-made/apply: the plan read again under the structure's lock, written in order, one audit row per change. */
export async function applyReadyMade(caller: CommandCaller, body: ReadyMadeBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const site = await siteOf(caller, context, body.siteId)
  const { result } = await command(caller, { name: UNIT_ACTIONS.readyMade, idempotencyKey, input: { ...body, siteId: site.id } }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    await lockStructure(tx, tenantOf(tools))
    if (site.status !== 'ACTIVE') refuse('SITE_ARCHIVED', UNIT_REFUSALS.SITE_ARCHIVED, 'siteId')
    const { site: facts, plannable, members } = await factsOf(tx, site.id)
    const plan = readyMadePreview(body.kind, plannable)
    if (plan.blockers.length > 0) refuseAll(plan.blockers)
    const idOfCode = new Map(plannable.units.map((unit) => [unit.code, unit.id]))
    const parentIdOf = (change: ReadyMadeChange): string | null => (change.parentCode === null ? null : (idOfCode.get(change.parentCode) ?? null))
    const facet = (change: ReadyMadeChange) => ({ kind: body.kind, change: change.change, from: change.from, to: change.to })
    const actorId = actorIdOf(tools.context)

    for (const change of plan.changes) {
      if (change.change === 'MAKE') {
        const id = newId()
        await tx.team.create({ data: { id, companyId: facts.companyId, siteId: facts.id, code: change.code, name: change.name, kindWord: change.kindWord, takesOrders: false, parentTeamId: parentIdOf(change), createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
        idOfCode.set(change.code, id)
        tools.audit({ action: UNIT_ACTIONS.readyMade, recordType: 'Team', recordId: id, companyId: facts.companyId, siteId: facts.id, after: facet(change) })
        tools.emit({ type: 'team.changed', subject: id, companyId: facts.companyId, siteId: facts.id, payload: { teamId: id, code: change.code, change: 'CREATED', employeeIds: [] } })
        continue
      }
      const unitId = change.unitId!
      if (change.change === 'REOPEN' || change.change === 'MOVE') {
        await tx.team.update({ where: { id: unitId }, data: { ...(change.change === 'REOPEN' ? { status: 'ACTIVE' as const } : {}), parentTeamId: parentIdOf(change), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ action: UNIT_ACTIONS.readyMade, recordType: 'Team', recordId: unitId, companyId: facts.companyId, siteId: facts.id, before: { parentName: change.from }, after: facet(change) })
        tools.emit({ type: 'team.changed', subject: unitId, companyId: facts.companyId, siteId: facts.id, payload: { teamId: unitId, code: change.code, change: 'EDITED', employeeIds: [] } })
        continue
      }
      // CLOSE: its people out first (they wait in "In no unit yet"), then today's archive.
      const out: string[] = []
      for (const member of members.filter((row) => row.teamId === unitId)) {
        const leaving = movePlan({ id: member.id, teamId: member.teamId, isLead: member.isLead, since: dayOf(member.since) }, null, today)
        if (leaving.kind !== 'MOVE') continue
        if (leaving.remove) await tx.teamMember.delete({ where: { id: leaving.remove }, select: { id: true } })
        if (leaving.end) {
          if (leaving.wasLead) await tx.teamMember.update({ where: { id: leaving.end.id }, data: { isLead: false, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
          await tx.teamMember.update({ where: { id: leaving.end.id }, data: { until: dateOf(leaving.end.until), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        }
        out.push(member.employeeId)
        tools.audit({ action: UNIT_ACTIONS.readyMade, recordType: 'Employee', recordId: member.employeeId, companyId: facts.companyId, siteId: facts.id, before: { teamId: unitId }, after: { kind: body.kind, from: { id: unitId, name: change.name }, wasLeader: member.isLead } })
      }
      await tx.team.update({ where: { id: unitId }, data: { status: 'ARCHIVED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: UNIT_ACTIONS.readyMade, recordType: 'Team', recordId: unitId, companyId: facts.companyId, siteId: facts.id, before: { status: 'ACTIVE', parentName: change.from }, after: { ...facet(change), people: out.length } })
      tools.emit({ type: 'team.changed', subject: unitId, companyId: facts.companyId, siteId: facts.id, payload: { teamId: unitId, code: change.code, change: 'ARCHIVED', employeeIds: out } })
    }
    // Nothing to change (the levels are like this already): the command is still on record.
    if (plan.changes.length === 0) tools.audit({ action: UNIT_ACTIONS.readyMade, recordType: 'Site', recordId: facts.id, companyId: facts.companyId, siteId: facts.id, after: { kind: body.kind, unchanged: true } })
    return { rows: readyMadeRows(plan), applied: true }
  })
  return result
}
