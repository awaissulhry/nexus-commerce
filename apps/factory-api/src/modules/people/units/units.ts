import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import { PEOPLE_STRUCTURE_MANAGE } from '@nexus/factory-domain/people/structure/permissions'
import { cleanStructureCode } from '@nexus/factory-domain/people/teams/rules'
import { UNIT_ACTIONS } from '@nexus/factory-domain/people/units/history'
import { cleanUnitText, closeBlockers, codeFromName, moveProblems, OPEN_ORDER_STATES, UNIT_REFUSALS, unitFieldProblems, type TreeUnit, type UnitRefusal } from '@nexus/factory-domain/people/units/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { actorIdOf, assertMay, assertMayWrite, assertVersion, bodyIssue, dateOf, dayOrNull, may, officeOf, refuse, todayOf } from '../employees/access'
import { lockStructure, lockUnit, readUnit, unitRecordView, type UnitRow } from './read'

/**
 * The factory structure's writes of one unit (owb-ss5 step 5.2; design § 5zb "Edit the profile", "Move…", "Close…"; prototype
 * org.js unitSave, unitMove, unitClose): office only, people.structure.manage checked with can() against the unit's company and
 * site (a person who may read but not keep the structure gets a 403 in words). Each write is one command with an Idempotency-Key,
 * at the version the person read; every rule is checked here first and refused in words (409, `refusal/<CODE>`), so the database's
 * Team_unit_check and Team_guard stay the last word.
 *
 *   POST  /people/units                 a unit of a site (a code unique on the site — made from the name when none is typed — a
 *                                       name, the unit above, the profile)
 *   PATCH /people/units/:unitId         the profile: name, kind, picture, what it does, who stands in and until when, the customers
 *                                       it works for, the most baskets, takes new orders, takes orders (the leader: PUT
 *                                       /people/teams/:teamId/lead)
 *   POST  /people/units/:unitId/move    under another unit of its company, or to the top (never a cycle, never under a closed unit)
 *   POST  /people/units/:unitId/close   today's archive, refused while people, units or orders still in work are on it
 */

export const MANAGE_WORDS = 'The factory structure of this site is kept by a role that keeps it.'

/** Refuses with every problem: the first as `refusal/<CODE>` (and its field), the others as more issues. */
export function refuseAll(problems: readonly UnitRefusal[]): never {
  const [first, ...rest] = problems
  return refuse(
    first!.code,
    first!.words,
    first!.field,
    rest.flatMap((problem) => [{ path: `refusal/${problem.code}`, message: problem.words }, ...(problem.field ? [{ path: `body/${problem.field}`, message: problem.words }] : [])]),
  )
}

/** The unit, or 404 when the caller may not read it; 403 in words when they may read it but not keep the structure. */
export async function writableUnit(caller: CommandCaller, context: OfficeContext, unitId: string): Promise<UnitRow> {
  const unit = isUuid(unitId) ? await caller.withClient((client) => readUnit(client, unitId)) : null
  if (!unit) throw new NotFoundError('Unit not found.')
  assertMay(context, PEOPLE_VIEW, unit, 'Unit')
  assertMayWrite(context, PEOPLE_STRUCTURE_MANAGE, unit, MANAGE_WORDS)
  return unit
}

/** Every unit of a company as the tree rules read it (the unit above, closed or not). */
export async function treeOf(tx: CommandTx, companyId: string): Promise<Map<string, TreeUnit>> {
  const rows = await tx.team.findMany({ where: { companyId }, select: { id: true, parentTeamId: true, status: true } })
  return new Map(rows.map((row) => [row.id, { parentId: row.parentTeamId, closed: row.status !== 'ACTIVE' }]))
}

export const tenantOf = (tools: CommandTools): string => (tools.context as { readonly tenantId: string }).tenantId

/** The stand-in: an active person of the unit's company. */
async function checkStandIn(tx: CommandTx, companyId: string, employeeId: string): Promise<void> {
  const person = await tx.employee.findUnique({ where: { id: employeeId }, select: { companyId: true, status: true } })
  if (!person || person.companyId !== companyId || person.status !== 'ACTIVE') refuse('STAND_IN_NOT_FOUND', UNIT_REFUSALS.STAND_IN_NOT_FOUND, 'standInEmployeeId')
}

/**
 * The customers a unit works for: parties of its company (or of the whole group). Those the writer cannot see stay as they are
 * (the window showed only the ones they see, so a save never drops another's); a party newly named is one the writer may see.
 */
async function worksForOf(tx: CommandTx, context: OfficeContext, companyId: string, sent: readonly string[], current: readonly string[]): Promise<string[]> {
  const actor = actorOf(context)
  const ids = [...new Set([...sent, ...current])]
  const parties = new Map((ids.length === 0 ? [] : await tx.party.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true } })).map((party) => [party.id, party]))
  const seen = (partyId: string) => {
    const party = parties.get(partyId)
    return !!party && can(actor, PARTIES_VIEW, { companyId: party.companyId ?? companyId, partyId })
  }
  for (const partyId of sent) {
    const party = parties.get(partyId)
    if (!party || (party.companyId !== null && party.companyId !== companyId) || (!current.includes(partyId) && !seen(partyId))) refuse('WORKS_FOR_UNKNOWN', UNIT_REFUSALS.WORKS_FOR_UNKNOWN, 'worksForPartyIds')
  }
  const kept = current.filter((partyId) => !seen(partyId) && !sent.includes(partyId))
  return [...sent, ...kept]
}

const parentNameOf = async (tx: CommandTx, parentId: string | null): Promise<string | null> => (parentId ? ((await tx.team.findUnique({ where: { id: parentId }, select: { name: true } }))?.name ?? null) : null)

/** What the profile window may send (create and change). */
export interface ProfileBody {
  readonly kindWord?: string | null | undefined
  readonly pictureKind?: 'LETTERS' | 'ICON' | undefined
  readonly pictureIcon?: string | null | undefined
  readonly pictureColour?: string | null | undefined
  readonly about?: string | null | undefined
  readonly worksForPartyIds?: readonly string[] | undefined
  readonly maxBaskets?: number | null | undefined
  readonly takesNewOrders?: boolean | undefined
  readonly takesOrders?: boolean | undefined
  readonly standInEmployeeId?: string | null | undefined
  readonly standInUntil?: BusinessDate | null | undefined
}

export interface CreateUnitBody extends ProfileBody {
  readonly siteId?: string | undefined
  readonly code?: string | undefined
  readonly name: string
  readonly parentId?: string | null | undefined
  readonly lineId?: string | null | undefined
}

/** POST /people/units. */
export async function createUnit(caller: CommandCaller, body: CreateUnitBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const kindWord = cleanUnitText(body.kindWord)
  const about = cleanUnitText(body.about)
  const pictureKind = body.pictureKind ?? 'LETTERS'
  const problems = unitFieldProblems(
    {
      name: body.name,
      ...(body.code !== undefined ? { code: body.code } : {}),
      kindWord,
      about,
      maxBaskets: body.maxBaskets ?? null,
      pictureKind,
      pictureIcon: body.pictureIcon ?? null,
      pictureColour: body.pictureColour ?? null,
      standInEmployeeId: body.standInEmployeeId ?? null,
      standInUntil: body.standInUntil ?? null,
      worksForPartyIds: body.worksForPartyIds ?? [],
    },
    todayOf(new Date()),
  )
  if (problems.length > 0) refuseAll(problems)
  const parentId = body.parentId ?? null
  const parent = parentId && isUuid(parentId) ? await caller.withClient((client) => readUnit(client, parentId)) : null
  if (parentId && (!parent || !may(context, PEOPLE_VIEW, parent))) refuse('PARENT_NOT_FOUND', UNIT_REFUSALS.PARENT_NOT_FOUND, 'parentId')
  const siteId = body.siteId ?? parent?.siteId
  if (!siteId) return refuse('SITE_NEEDED', UNIT_REFUSALS.SITE_NEEDED, 'siteId')
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, status: true, name: true } }))
  if (!site) throw bodyIssue('siteId', 'Not a site of the group.')
  assertMayWrite(context, PEOPLE_STRUCTURE_MANAGE, { companyId: site.companyId, siteId: site.id }, MANAGE_WORDS)
  if (parent && parent.companyId !== site.companyId) refuse('PARENT_OTHER_COMPANY', UNIT_REFUSALS.PARENT_OTHER_COMPANY, 'parentId')
  const id = newId()
  const name = body.name.trim()
  const { result, replayed } = await command(caller, { name: UNIT_ACTIONS.create, idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockStructure(tx, tenantOf(tools))
    if (site.status !== 'ACTIVE') refuse('SITE_ARCHIVED', UNIT_REFUSALS.SITE_ARCHIVED, 'siteId')
    if (body.lineId) {
      const line = await tx.line.findUnique({ where: { id: body.lineId }, select: { siteId: true, status: true } })
      if (!line || line.siteId !== site.id || line.status !== 'ACTIVE') refuse('LINE_NOT_OF_SITE', "A unit's line is an active line of its site.", 'lineId')
    }
    const taken = new Set((await tx.team.findMany({ where: { siteId: site.id }, select: { code: true } })).map((row) => row.code))
    const code = body.code !== undefined ? cleanStructureCode(body.code) : codeFromName(name, taken)
    if (taken.has(code)) refuse('CODE_TAKEN', UNIT_REFUSALS.CODE_TAKEN, 'code')
    if (parentId) {
      const problems = moveProblems(id, parentId, await treeOf(tx, site.companyId))
      if (problems.length > 0) refuseAll(problems)
    }
    if (body.standInEmployeeId) await checkStandIn(tx, site.companyId, body.standInEmployeeId)
    const worksFor = body.worksForPartyIds && body.worksForPartyIds.length > 0 ? await worksForOf(tx, context, site.companyId, body.worksForPartyIds, []) : []
    await tx.team.create({
      data: {
        id,
        companyId: site.companyId,
        siteId: site.id,
        lineId: body.lineId ?? null,
        code,
        name,
        parentTeamId: parentId,
        kindWord,
        about,
        pictureKind,
        pictureIcon: body.pictureIcon ?? null,
        pictureColour: body.pictureColour ?? null,
        maxBaskets: body.maxBaskets ?? null,
        standInEmployeeId: body.standInEmployeeId ?? null,
        standInUntil: body.standInUntil ? dateOf(body.standInUntil) : null,
        ...(worksFor.length > 0 ? { worksForPartyIds: worksFor } : {}),
        ...(body.takesOrders !== undefined ? { takesOrders: body.takesOrders } : {}),
        ...(body.takesNewOrders !== undefined ? { takesNewOrders: body.takesNewOrders } : {}),
        createdAt: now,
        updatedAt: now,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    })
    tools.audit({ action: UNIT_ACTIONS.create, recordType: 'Team', recordId: id, companyId: site.companyId, siteId: site.id, after: { code, name, kindWord, parentId, parentName: await parentNameOf(tx, parentId), takesOrders: body.takesOrders ?? true } })
    tools.emit({ type: 'team.changed', subject: id, companyId: site.companyId, siteId: site.id, payload: { teamId: id, code, change: 'CREATED', employeeIds: [] } })
    return { unit: await unitRecordView(tx, context, (await readUnit(tx, id))!) }
  })
  return { ...result, replayed }
}

/**
 * The stand-in's last day after a change: the one sent; else none when the stand-in is cleared or another person stands in (a new
 * stand-in starts without an end until one is said); else the one there. (Sent without a stand-in: refused, STAND_IN_UNTIL_ALONE.)
 */
function standInUntilOf(body: Pick<ProfileBody, 'standInEmployeeId' | 'standInUntil'>, unit: Pick<UnitRow, 'standInEmployeeId' | 'standInUntil'>): BusinessDate | null {
  if (body.standInUntil !== undefined) return body.standInUntil
  if (body.standInEmployeeId !== undefined && body.standInEmployeeId !== unit.standInEmployeeId) return null
  return dayOrNull(unit.standInUntil)
}

export interface UpdateUnitBody extends ProfileBody {
  readonly version: number
  readonly name?: string | undefined
}

/** PATCH /people/units/:unitId: only the fields sent change; a save that changes nothing moves no version. */
export async function updateUnit(caller: CommandCaller, unitId: string, body: UpdateUnitBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  await writableUnit(caller, context, unitId)
  const { result } = await command(caller, { name: UNIT_ACTIONS.update, idempotencyKey, input: { unitId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const unit = await lockUnit(tx, unitId)
    assertVersion('unit', unit.version, body.version)
    if (unit.status !== 'ACTIVE') refuse('UNIT_CLOSED', UNIT_REFUSALS.UNIT_CLOSED)
    const next = {
      name: body.name !== undefined ? body.name.trim() : unit.name,
      kindWord: body.kindWord !== undefined ? cleanUnitText(body.kindWord) : unit.kindWord,
      about: body.about !== undefined ? cleanUnitText(body.about) : unit.about,
      pictureKind: body.pictureKind ?? unit.pictureKind,
      pictureIcon: body.pictureIcon !== undefined ? body.pictureIcon : unit.pictureIcon,
      pictureColour: body.pictureColour !== undefined ? body.pictureColour : unit.pictureColour,
      maxBaskets: body.maxBaskets !== undefined ? body.maxBaskets : unit.maxBaskets,
      takesNewOrders: body.takesNewOrders ?? unit.takesNewOrders,
      takesOrders: body.takesOrders ?? unit.takesOrders,
      standInEmployeeId: body.standInEmployeeId !== undefined ? body.standInEmployeeId : unit.standInEmployeeId,
      standInUntil: standInUntilOf(body, unit),
    }
    const today = todayOf(now)
    const problems = unitFieldProblems(
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kindWord !== undefined ? { kindWord: next.kindWord } : {}),
        ...(body.about !== undefined ? { about: next.about } : {}),
        ...(body.maxBaskets !== undefined ? { maxBaskets: next.maxBaskets } : {}),
        ...(body.pictureKind !== undefined || body.pictureIcon !== undefined || body.pictureColour !== undefined ? { pictureKind: next.pictureKind, pictureIcon: next.pictureIcon, pictureColour: next.pictureColour } : {}),
        ...(body.standInEmployeeId !== undefined || body.standInUntil !== undefined ? { standInEmployeeId: next.standInEmployeeId, standInUntil: next.standInUntil } : {}),
        ...(body.worksForPartyIds !== undefined ? { worksForPartyIds: body.worksForPartyIds } : {}),
      },
      body.standInUntil !== undefined && next.standInUntil !== dayOrNull(unit.standInUntil) ? today : undefined,
    )
    if (problems.length > 0) refuseAll(problems)
    if (body.standInEmployeeId && body.standInEmployeeId !== unit.standInEmployeeId) await checkStandIn(tx, unit.companyId, body.standInEmployeeId)
    const worksFor = body.worksForPartyIds !== undefined ? await worksForOf(tx, context, unit.companyId, body.worksForPartyIds, unit.worksForPartyIds) : unit.worksForPartyIds

    const data: Prisma.TeamUncheckedUpdateInput = {}
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    const put = (key: string, was: unknown, will: unknown, write: () => void) => {
      if (JSON.stringify(was) === JSON.stringify(will)) return
      before[key] = was
      after[key] = will
      write()
    }
    put('name', unit.name, next.name, () => (data.name = next.name))
    put('kindWord', unit.kindWord, next.kindWord, () => (data.kindWord = next.kindWord))
    put('about', unit.about, next.about, () => (data.about = next.about))
    put('pictureKind', unit.pictureKind, next.pictureKind, () => (data.pictureKind = next.pictureKind))
    put('pictureIcon', unit.pictureIcon, next.pictureIcon, () => (data.pictureIcon = next.pictureIcon))
    put('pictureColour', unit.pictureColour, next.pictureColour, () => (data.pictureColour = next.pictureColour))
    put('maxBaskets', unit.maxBaskets, next.maxBaskets, () => (data.maxBaskets = next.maxBaskets))
    put('takesNewOrders', unit.takesNewOrders, next.takesNewOrders, () => (data.takesNewOrders = next.takesNewOrders))
    put('takesOrders', unit.takesOrders, next.takesOrders, () => (data.takesOrders = next.takesOrders))
    put('standInEmployeeId', unit.standInEmployeeId, next.standInEmployeeId, () => (data.standInEmployeeId = next.standInEmployeeId))
    put('standInUntil', dayOrNull(unit.standInUntil), next.standInUntil, () => (data.standInUntil = next.standInUntil ? dateOf(next.standInUntil) : null))
    put('worksForPartyIds', [...unit.worksForPartyIds].sort(), [...worksFor].sort(), () => (data.worksForPartyIds = worksFor))

    const changed = Object.keys(data).length > 0
    if (changed) {
      await tx.team.update({ where: { id: unit.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.emit({ type: 'team.changed', subject: unit.id, companyId: unit.companyId, siteId: unit.siteId, payload: { teamId: unit.id, code: unit.code, change: 'EDITED', employeeIds: [] } })
    }
    tools.audit({ action: UNIT_ACTIONS.update, recordType: 'Team', recordId: unit.id, companyId: unit.companyId, siteId: unit.siteId, before: changed ? before : undefined, after: changed ? after : { unchanged: true } })
    return { unit: await unitRecordView(tx, context, (await readUnit(tx, unit.id))!) }
  })
  return result
}

/** POST /people/units/:unitId/move: under another unit of its company (or to the top), checked against the whole tree first. */
export async function moveUnit(caller: CommandCaller, unitId: string, body: { readonly version: number; readonly parentId: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await writableUnit(caller, context, unitId)
  if (body.parentId !== null) {
    const parentId = body.parentId
    const parent = await caller.withClient((client) => readUnit(client, parentId))
    if (!parent || !may(context, PEOPLE_VIEW, parent)) refuse('PARENT_NOT_FOUND', UNIT_REFUSALS.PARENT_NOT_FOUND, 'parentId')
    assertMayWrite(context, PEOPLE_STRUCTURE_MANAGE, parent!, MANAGE_WORDS)
  }
  const { result } = await command(caller, { name: UNIT_ACTIONS.move, idempotencyKey, input: { unitId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockStructure(tx, tenantOf(tools))
    const unit = await lockUnit(tx, unitId)
    assertVersion('unit', unit.version, body.version)
    if (unit.status !== 'ACTIVE') refuse('UNIT_CLOSED', UNIT_REFUSALS.UNIT_CLOSED)
    if (body.parentId !== null) {
      const parent = await readUnit(tx, body.parentId)
      if (parent && parent.companyId !== unit.companyId) refuse('PARENT_OTHER_COMPANY', UNIT_REFUSALS.PARENT_OTHER_COMPANY, 'parentId')
    }
    const problems = moveProblems(unit.id, body.parentId, await treeOf(tx, unit.companyId))
    if (problems.length > 0) refuseAll(problems)
    if (unit.parentTeamId === body.parentId) {
      tools.audit({ action: UNIT_ACTIONS.move, recordType: 'Team', recordId: unit.id, companyId: unit.companyId, siteId: unit.siteId, after: { unchanged: true } })
      return { unit: await unitRecordView(tx, context, unit) }
    }
    await tx.team.update({ where: { id: unit.id }, data: { parentTeamId: body.parentId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: UNIT_ACTIONS.move,
      recordType: 'Team',
      recordId: unit.id,
      companyId: unit.companyId,
      siteId: unit.siteId,
      before: { parentId: unit.parentTeamId, parentName: await parentNameOf(tx, unit.parentTeamId) },
      after: { parentId: body.parentId, parentName: await parentNameOf(tx, body.parentId) },
    })
    tools.emit({ type: 'team.changed', subject: unit.id, companyId: unit.companyId, siteId: unit.siteId, payload: { teamId: unit.id, code: unit.code, change: 'EDITED', employeeIds: [] } })
    return { unit: await unitRecordView(tx, context, (await readUnit(tx, unit.id))!) }
  })
  return result
}

/** What still sits on a unit (the guard counts a membership that ends today or later as someone in it). */
export async function closeFactsOf(tx: CommandTx, unitId: string, today: BusinessDate) {
  // One after the other: the queries of one transaction run on its one connection.
  const units = await tx.team.count({ where: { parentTeamId: unitId, status: 'ACTIVE' } })
  const people = await tx.teamMember.count({ where: { teamId: unitId, OR: [{ until: null }, { until: { gte: dateOf(today) } }] } })
  const openOrders = await tx.orderTeam.count({ where: { teamId: unitId, endedAt: null, salesOrder: { status: { in: [...OPEN_ORDER_STATES] } } } })
  return { units, people, openOrders }
}

/** POST /people/units/:unitId/close: refused while it has people, units under it or orders in work (the words say what to move first); then today's archive. */
export async function closeUnit(caller: CommandCaller, unitId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await writableUnit(caller, context, unitId)
  const { result } = await command(caller, { name: UNIT_ACTIONS.close, idempotencyKey, input: { unitId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockStructure(tx, tenantOf(tools))
    const unit = await lockUnit(tx, unitId)
    assertVersion('unit', unit.version, body.version)
    if (unit.status !== 'ACTIVE') refuse('UNIT_CLOSED', UNIT_REFUSALS.UNIT_CLOSED)
    const blockers = closeBlockers(await closeFactsOf(tx, unit.id, todayOf(now)))
    if (blockers.length > 0) refuseAll(blockers)
    await tx.team.update({ where: { id: unit.id }, data: { status: 'ARCHIVED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: UNIT_ACTIONS.close, recordType: 'Team', recordId: unit.id, companyId: unit.companyId, siteId: unit.siteId, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    tools.emit({ type: 'team.changed', subject: unit.id, companyId: unit.companyId, siteId: unit.siteId, payload: { teamId: unit.id, code: unit.code, change: 'ARCHIVED', employeeIds: [] } })
    return { unit: await unitRecordView(tx, context, (await readUnit(tx, unit.id))!) }
  })
  return result
}
