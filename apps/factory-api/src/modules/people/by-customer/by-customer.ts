import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS, holds, reachesEveryParty } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { EXTRA_RIGHT_ROLE, extraRightsOf, PEOPLE_BY_CUSTOMER_RIGHT, roleWordsOf, type ExtraRight } from '@nexus/factory-domain/people/by-customer/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { liveAssignment } from '../../../platform/auth/roles/access'
import { liveAssignmentsOf } from '../../../platform/auth/roles/assignments'
import { assignRole, endAssignment } from '../../../platform/auth/roles/roles'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { officeContextOf } from '../../sales/orders/access'
import type { GivenRowView } from './contract'

/**
 * owb-of2 step 3 (order workflow, plan.md § 5f "People by customer", "Extra rights", § 5h "Give to every customer" / "Take out for every
 * customer…"; the base's pool table PartyOfficePerson, guard G11: one open row per customer and person, ended never deleted):
 *
 *   GET  /people/by-customer                                the office people who may be given (active office users) with their
 *                                                           main roles in words and their extra rights, the customers (a CUSTOMER
 *                                                           or BRAND party, active), who is given to whom (open rows) and `may`
 *   PUT  /people/by-customer/:partyId/:userId {given}       give the person to the customer, or take them out (an end)
 *   POST /people/by-customer/every-customer {userId, given} give the person to every customer (one already given is skipped), or
 *                                                           take them out of every customer
 *   PUT  /people/by-customer/extra/:userId {right, on}      give or end an extra right = the base's ready-made role of that right
 *                                                           (factory-domain people/by-customer EXTRA_RIGHT_ROLE), through TODAY's role
 *                                                           assignment code (platform/auth/roles assignRole / endAssignment: the
 *                                                           same checks, step-up and audit — never a new path)
 * The right of all four: the one that assigns roles today (`roles.assign`: the Owner and the Administrator). Each pool write is ONE
 * command with one audit row per row given or ended. The writes answer the open rows of what changed (the customer's, or the
 * person's) or the person's extra rights. No price field.
 */

type Reader = FactoryClient

export const NOT_AN_OFFICE_PERSON_WORDS = Object.freeze({
  en: 'Give an active person of the office to a customer.',
  it: 'Assegna a un cliente una persona attiva dell’ufficio.',
})
export const CUSTOMER_NOT_FOUND = 'Customer not found.'
export const EXTRA_NOT_SET_UP_WORDS = Object.freeze({
  en: 'This extra right is not set up yet: an administrator brings the ready-made roles up to date first (Admin › Roles).',
  it: 'Questo diritto extra non è ancora pronto: un amministratore aggiorna prima i ruoli pronti (Admin › Ruoli).',
})

const CUSTOMER_WHERE = { roles: { hasSome: ['CUSTOMER' as const, 'BRAND' as const] }, status: 'ACTIVE' as const }

/** The page mixes every customer: its right must reach every customer (a role limited to some customers is refused, naming none). */
function assertEveryCustomer(context: OfficeContext): void {
  if (!reachesEveryParty(actorOf(context), PEOPLE_BY_CUSTOMER_RIGHT)) throw new ForbiddenError(EVERY_PARTY_WORDS.en)
}

async function givenRows(client: Reader, where: { partyId?: string; userId?: string }): Promise<GivenRowView[]> {
  const rows = await client.partyOfficePerson.findMany({ where: { ...where, endedAt: null }, select: { partyId: true, userId: true, createdAt: true, createdById: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const byIds = [...new Set(rows.flatMap((row) => (row.createdById ? [row.createdById] : [])))]
  const names = new Map(byIds.length > 0 ? (await client.user.findMany({ where: { id: { in: byIds } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]) : [])
  return rows.map((row) => ({ partyId: row.partyId, userId: row.userId, since: toUtcIso(row.createdAt), byName: row.createdById ? (names.get(row.createdById) ?? '') : '' }))
}

/** GET /people/by-customer (see the file's head). */
export async function peopleByCustomer(caller: CommandCaller) {
  const context = officeContextOf(caller)
  assertEveryCustomer(context)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const users = await client.user.findMany({ where: { audience: 'OFFICE', status: 'ACTIVE' }, select: { id: true, displayName: true }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }] })
    const roles = await liveAssignmentsOf(client, users.map((user) => user.id), now)
    const customers = await client.party.findMany({ where: CUSTOMER_WHERE, select: { id: true, code: true, legalName: true, tradeName: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    return {
      people: users.map((user) => {
        const held = roles.get(user.id) ?? []
        return { userId: user.id, name: user.displayName, roleWords: roleWordsOf(held), extra: extraRightsOf(held) }
      }),
      customers: customers.map((party) => ({ partyId: party.id, code: party.code, name: party.tradeName ?? party.legalName })),
      given: await givenRows(client, {}),
      may: { write: holds(actorOf(context), PEOPLE_BY_CUSTOMER_RIGHT) },
    }
  })
}

// ---- the pool's writes ---------------------------------------------------------------------------------------------------------

/** The person: an active office user (else 400 in words, at `path`). */
async function officePerson(tools: Pick<CommandTools, 'tx'>, userId: string, path: string): Promise<void> {
  const person = await tools.tx.user.findFirst({ where: { id: userId, audience: 'OFFICE', status: 'ACTIVE' }, select: { id: true } })
  if (!person) throw new ValidationError(NOT_AN_OFFICE_PERSON_WORDS.en, [{ path, message: NOT_AN_OFFICE_PERSON_WORDS.en }])
}

/** The company a pool row is kept under: the screen's company, else the tenant's first active one (the row says whose staff it is). */
async function companyOf(tools: Pick<CommandTools, 'tx'>, context: OfficeContext): Promise<string> {
  if (context.companyId) return context.companyId
  const company = await tools.tx.company.findFirst({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  if (!company) throw new InvalidStateError('The tenant has no active company.')
  return company.id
}

/** Gives the person to the customer unless already given (the partial unique index keeps one open row). True when a row was added. */
async function giveInCommand(tools: CommandTools, context: OfficeContext, companyId: string, partyId: string, userId: string): Promise<boolean> {
  const id = newId()
  const { count } = await tools.tx.partyOfficePerson.createMany({ data: [{ id, companyId, partyId, userId, createdById: context.actorId, createdAt: tools.now, updatedAt: tools.now }], skipDuplicates: true })
  if (count === 0) return false
  tools.audit({ action: 'people.byCustomer.give', recordType: 'PartyOfficePerson', recordId: id, companyId, after: { partyId, userId } })
  return true
}

/** Ends the person's open rows (of one customer, or of every customer). How many ended. */
async function endInCommand(tools: CommandTools, context: OfficeContext, where: { partyId?: string; userId: string }): Promise<number> {
  const open = await tools.tx.partyOfficePerson.findMany({ where: { ...where, endedAt: null }, select: { id: true, companyId: true, partyId: true, userId: true } })
  for (const row of open) {
    await tools.tx.partyOfficePerson.update({ where: { id: row.id }, data: { endedAt: tools.now, endedById: context.actorId, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'people.byCustomer.end', recordType: 'PartyOfficePerson', recordId: row.id, companyId: row.companyId, before: { partyId: row.partyId, userId: row.userId }, after: { ended: true } })
  }
  return open.length
}

/** PUT /people/by-customer/:partyId/:userId (see the file's head). */
export async function giveToCustomer(caller: CommandCaller, partyId: string, userId: string, body: { readonly given: boolean }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertEveryCustomer(context)
  await command(caller, { name: 'people.byCustomer.set', idempotencyKey, input: { partyId, userId, given: body.given } }, async (tools) => {
    const party = await tools.tx.party.findFirst({ where: { id: partyId, ...CUSTOMER_WHERE }, select: { id: true } })
    if (!party) throw new NotFoundError(CUSTOMER_NOT_FOUND)
    if (body.given) {
      await officePerson(tools, userId, 'params/userId')
      const changed = await giveInCommand(tools, context, await companyOf(tools, context), partyId, userId)
      if (!changed) tools.audit({ action: 'people.byCustomer.unchanged', recordType: 'Party', recordId: partyId, after: { userId, given: true } })
      return { changed }
    }
    const ended = await endInCommand(tools, context, { partyId, userId })
    if (ended === 0) tools.audit({ action: 'people.byCustomer.unchanged', recordType: 'Party', recordId: partyId, after: { userId, given: false } })
    return { changed: ended > 0 }
  })
  return { given: await caller.withClient((client) => givenRows(client, { partyId })) }
}

/** POST /people/by-customer/every-customer (see the file's head). */
export async function everyCustomer(caller: CommandCaller, body: { readonly userId: string; readonly given: boolean }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertEveryCustomer(context)
  await command(caller, { name: 'people.byCustomer.every', idempotencyKey, input: body }, async (tools) => {
    let changed = 0
    if (body.given) {
      await officePerson(tools, body.userId, 'body/userId')
      const companyId = await companyOf(tools, context)
      const already = new Set((await tools.tx.partyOfficePerson.findMany({ where: { userId: body.userId, endedAt: null }, select: { partyId: true } })).map((row) => row.partyId))
      for (const party of await tools.tx.party.findMany({ where: CUSTOMER_WHERE, select: { id: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })) {
        if (already.has(party.id)) continue
        if (await giveInCommand(tools, context, companyId, party.id, body.userId)) changed += 1
      }
    } else changed = await endInCommand(tools, context, { userId: body.userId })
    if (changed === 0) tools.audit({ action: 'people.byCustomer.unchanged', recordType: 'User', recordId: body.userId, after: { every: true, given: body.given } })
    return { changed }
  })
  return { given: await caller.withClient((client) => givenRows(client, { userId: body.userId })) }
}

// ---- the extra rights: today's role assignment, nothing new ------------------------------------------------------------------

/** PUT /people/by-customer/extra/:userId (see the file's head). */
export async function setExtraRight(app: FastifyInstance, request: FastifyRequest, userId: string, body: { readonly right: ExtraRight; readonly on: boolean }) {
  const auth = officeAuthOf(app)
  const now = serverClock.now()
  const found = await request.withClient(async (client) => {
    const person = await client.user.findFirst({ where: { id: userId, audience: 'OFFICE', status: 'ACTIVE' }, select: { id: true } })
    if (!person) throw new ValidationError(NOT_AN_OFFICE_PERSON_WORDS.en, [{ path: 'params/userId', message: NOT_AN_OFFICE_PERSON_WORDS.en }])
    const role = await client.role.findFirst({ where: { key: EXTRA_RIGHT_ROLE[body.right], system: true, audience: 'OFFICE' }, select: { id: true } })
    if (!role) throw new InvalidStateError(EXTRA_NOT_SET_UP_WORDS.en)
    const live = await client.roleAssignment.findMany({ where: { userId, roleId: role.id, ...liveAssignment(now) }, select: { id: true, version: true } })
    return { roleId: role.id, live }
  })
  if (body.on && found.live.length === 0) await assignRole(auth, request, userId, { roleId: found.roleId, allCompanies: true, companyIds: [], siteIds: [], partyIds: [] })
  if (!body.on) for (const assignment of found.live) await endAssignment(auth, request, assignment.id, { version: assignment.version })
  const held = await request.withClient(async (client) => (await liveAssignmentsOf(client, [userId], serverClock.now())).get(userId) ?? [])
  return { person: { userId, extra: extraRightsOf(held) } }
}
