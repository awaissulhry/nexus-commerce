import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { anyOf, can, holds, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_STRUCTURES_MANAGE, PRODUCTION_STRUCTURES_RULES } from '@nexus/factory-domain/production/structures/permissions'
import { STRUCTURE_REFUSALS } from '@nexus/factory-domain/production/structures/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { refuse } from '../../people/employees/access'
import { officeContextOf } from '../../sales/orders/access'
import { companyOf, readsAt, structureRows, structuresByIds, structuresWhere, type StructureRecord } from './facts'

/**
 * Order structures (owb-ss6 step 6.2; build/briefs/owb-ss6.md § Shape; design § 5zj C planModal): a named way to handle an order —
 * its steps "as the product says" (v1), its teams (open teams of its company; the first is in charge when it gives them), its
 * office people (active office users). Kept by the production manager (production.structures.manage), read by holders of .manage
 * or .rules; closed and opened again, never deleted. One audit row per change (recordType OrderStructure).
 *
 *   GET   /production/order-structures                 the screen's company's structures (open first), may.manage
 *   POST  /production/order-structures                 a new one (the screen's company, else its first team's)
 *   PATCH /production/order-structures/:structureId    name, teams, people, note (an open one only)
 *   POST  /production/order-structures/:structureId/close | reopen
 *
 * Refusals are 409s in words with `refusal/<CODE>` (STRUCTURE_REFUSALS): NAME_TAKEN, TEAM_NOT_OPEN, PERSON_NOT_OFFICE,
 * STRUCTURE_CLOSED, STRUCTURE_ALREADY_CLOSED, STRUCTURE_ALREADY_OPEN. The guards (OrderStructure_guard) are the last word.
 */

const RECORD = 'OrderStructure'
const NOT_FOUND = 'Order structure not found.'
const NOT_KEEPER = 'You may read the order structures but not change them: the production manager keeps them.'

/** A blank note is none. */
const noteOf = (note: string | null | undefined): string | null => (note === undefined || note === null || note.trim() === '' ? null : note.trim())

/** One structure the caller reads (else 404) and keeps (else 403). */
async function keptStructure(caller: CommandCaller, context: OfficeContext, structureId: string): Promise<StructureRecord> {
  const structure = (await caller.withClient((client) => structuresByIds(client, [structureId]))).get(structureId)
  if (!structure || !readsAt(context, structure)) throw new NotFoundError(NOT_FOUND)
  if (!can(actorOf(context), PRODUCTION_STRUCTURES_MANAGE, { companyId: structure.companyId })) throw new ForbiddenError(NOT_KEEPER)
  return structure
}

/** One structure's change at a time per company (the open names are compared, then written). */
const lockCompany = (tx: CommandTx, companyId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.order-structures|${companyId}`}::text, 0))`

/**
 * What is wrong with a structure's name, teams and people (refused in words, first problem first): the name free among the
 * company's open structures; each team of the company and open (one already named may since have closed); each person an
 * office user, active (one already named may since have left).
 */
async function checkStructure(tx: CommandTx, companyId: string, next: { readonly name: string; readonly teamIds: readonly string[]; readonly peopleUserIds: readonly string[] }, before: StructureRecord | null): Promise<void> {
  const taken = await tx.orderStructure.findFirst({ where: { companyId, closedAt: null, name: { equals: next.name, mode: 'insensitive' }, ...(before ? { NOT: { id: before.id } } : {}) }, select: { id: true } })
  if (taken) refuse('NAME_TAKEN', STRUCTURE_REFUSALS.NAME_TAKEN, 'name')
  const teams = next.teamIds.length === 0 ? [] : await tx.team.findMany({ where: { id: { in: [...next.teamIds] } }, select: { id: true, companyId: true, status: true } })
  for (const teamId of next.teamIds) {
    const team = teams.find((row) => row.id === teamId)
    if (!team || team.companyId !== companyId || (team.status !== 'ACTIVE' && !(before?.teamIds ?? []).includes(teamId))) refuse('TEAM_NOT_OPEN', STRUCTURE_REFUSALS.TEAM_NOT_OPEN, 'teamIds')
  }
  const people = next.peopleUserIds.length === 0 ? [] : await tx.user.findMany({ where: { id: { in: [...next.peopleUserIds] } }, select: { id: true, status: true, audience: true } })
  for (const userId of next.peopleUserIds) {
    const person = people.find((row) => row.id === userId)
    if (!person || person.audience !== 'OFFICE' || (person.status !== 'ACTIVE' && !(before?.peopleUserIds ?? []).includes(userId))) refuse('PERSON_NOT_OFFICE', STRUCTURE_REFUSALS.PERSON_NOT_OFFICE, 'peopleUserIds')
  }
}

/** The row of one structure, read in the command's transaction. */
async function rowOf(tx: CommandTx, structureId: string) {
  const structure = (await structuresByIds(tx, [structureId])).get(structureId)!
  return (await structureRows(tx, [structure]))[0]!
}

const audited = (structure: Pick<StructureRecord, 'name' | 'teamIds' | 'peopleUserIds' | 'note'>) => ({ name: structure.name, teamIds: [...structure.teamIds], peopleUserIds: [...structure.peopleUserIds], note: structure.note })

/** GET /production/order-structures. */
export async function listStructures(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!holds(actor, PRODUCTION_STRUCTURES_MANAGE) && !holds(actor, PRODUCTION_STRUCTURES_RULES)) throw new ForbiddenError()
  return caller.withClient(async (client) => {
    const columns = { company: 'companyId' } as const
    const scope = anyOf([scopeWhere(actor, PRODUCTION_STRUCTURES_MANAGE, columns), scopeWhere(actor, PRODUCTION_STRUCTURES_RULES, columns)]) as Prisma.OrderStructureWhereInput
    const where: Prisma.OrderStructureWhereInput = context.companyId ? { AND: [scope, { companyId: context.companyId }] } : scope
    const structures = await structuresWhere(client, where)
    const ordered = [...structures.filter((structure) => !structure.closed), ...structures.filter((structure) => structure.closed)]
    return {
      structures: await structureRows(client, ordered),
      may: { manage: context.companyId ? can(actor, PRODUCTION_STRUCTURES_MANAGE, { companyId: context.companyId }) : holds(actor, PRODUCTION_STRUCTURES_MANAGE) },
    }
  })
}

/** POST /production/order-structures. */
export async function createStructure(caller: CommandCaller, body: { readonly name: string; readonly teamIds: readonly string[]; readonly peopleUserIds: readonly string[]; readonly note?: string | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const teamIds = [...new Set(body.teamIds)]
  const peopleUserIds = [...new Set(body.peopleUserIds)]
  const companyId = await caller.withClient(async (client) => {
    const firstId = teamIds[0]
    const firstTeam = firstId ? await client.team.findUnique({ where: { id: firstId }, select: { companyId: true } }) : null
    return companyOf(client, context, [PRODUCTION_STRUCTURES_MANAGE], firstTeam?.companyId ?? null)
  })
  if (!can(actorOf(context), PRODUCTION_STRUCTURES_MANAGE, { companyId })) throw new ForbiddenError(NOT_KEEPER)
  return command(caller, { name: 'production.createOrderStructure', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockCompany(tx, companyId)
    const next = { name: body.name, teamIds, peopleUserIds, note: noteOf(body.note) }
    await checkStructure(tx, companyId, next, null)
    const id = newId()
    await tx.orderStructure.create({ data: { id, companyId, name: next.name, teamIds, peopleUserIds, note: next.note, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'production.createOrderStructure', recordType: RECORD, recordId: id, companyId, after: audited(next) })
    return rowOf(tx, id)
  })
}

/** PATCH /production/order-structures/:structureId. */
export async function updateStructure(
  caller: CommandCaller,
  structureId: string,
  body: { readonly version: number; readonly name?: string | undefined; readonly teamIds?: readonly string[] | undefined; readonly peopleUserIds?: readonly string[] | undefined; readonly note?: string | null | undefined },
  idempotencyKey?: string,
) {
  const context = officeContextOf(caller)
  const seen = await keptStructure(caller, context, structureId)
  const { result } = await command(caller, { name: 'production.updateOrderStructure', idempotencyKey, input: { structureId, ...body }, record: { type: 'OrderStructure', id: structureId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    await lockCompany(tx, seen.companyId)
    const before = (await structuresByIds(tx, [structureId])).get(structureId)!
    if (before.closed) refuse('STRUCTURE_CLOSED', STRUCTURE_REFUSALS.STRUCTURE_CLOSED)
    const next = {
      name: body.name ?? before.name,
      teamIds: body.teamIds ? [...new Set(body.teamIds)] : [...before.teamIds],
      peopleUserIds: body.peopleUserIds ? [...new Set(body.peopleUserIds)] : [...before.peopleUserIds],
      note: body.note === undefined ? before.note : noteOf(body.note),
    }
    await checkStructure(tx, before.companyId, next, before)
    await tx.orderStructure.update({ where: { id: structureId }, data: { name: next.name, teamIds: next.teamIds, peopleUserIds: next.peopleUserIds, note: next.note, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'production.updateOrderStructure', recordType: RECORD, recordId: structureId, companyId: before.companyId, before: audited(before), after: audited(next) })
    return rowOf(tx, structureId)
  })
  return result
}

/** POST /production/order-structures/:structureId/close and …/reopen: closed (no new rule or order by hand names it) or open again. */
export async function closeStructure(caller: CommandCaller, structureId: string, open: boolean, body: { readonly version?: number | undefined } | undefined, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await keptStructure(caller, context, structureId)
  const name = open ? 'production.reopenOrderStructure' : 'production.closeOrderStructure'
  const expected = body?.version
  const { result } = await command(caller, { name, idempotencyKey, input: { structureId, open, version: expected ?? null }, record: { type: 'OrderStructure', id: structureId, ...(expected !== undefined ? { expectedVersion: expected } : {}) } }, async (tools) => {
    const { tx, now } = tools
    await lockCompany(tx, seen.companyId)
    const before = (await structuresByIds(tx, [structureId])).get(structureId)!
    if (open && !before.closed) refuse('STRUCTURE_ALREADY_OPEN', STRUCTURE_REFUSALS.STRUCTURE_ALREADY_OPEN)
    if (!open && before.closed) refuse('STRUCTURE_ALREADY_CLOSED', STRUCTURE_REFUSALS.STRUCTURE_ALREADY_CLOSED)
    // Opened again: its name must still be free among the open structures.
    if (open) {
      const taken = await tx.orderStructure.findFirst({ where: { companyId: before.companyId, closedAt: null, name: { equals: before.name, mode: 'insensitive' }, NOT: { id: structureId } }, select: { id: true } })
      if (taken) refuse('NAME_TAKEN', STRUCTURE_REFUSALS.NAME_TAKEN, 'name')
    }
    await tx.orderStructure.update({ where: { id: structureId }, data: open ? { closedAt: null, closedById: null, updatedAt: now } : { closedAt: now, closedById: context.actorId, updatedAt: now }, select: { id: true } })
    tools.audit({ action: name, recordType: RECORD, recordId: structureId, companyId: before.companyId, before: { closed: before.closed }, after: { closed: !open } })
    return rowOf(tx, structureId)
  })
  return result
}
