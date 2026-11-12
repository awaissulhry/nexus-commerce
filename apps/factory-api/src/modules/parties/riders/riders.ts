import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PARTIES_MANAGE, PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { teamProblem, type RiderFacts } from '@nexus/factory-domain/parties/riders/riders'
import type { PartyKind, PartyRole, PartyStatus } from '@nexus/factory-domain/parties/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMayWrite, contextOf, PARTY_SCOPE, readParty } from '../store'

/**
 * Riders under a team or dealer (B-W2b-290; SAL-021; design sales.customers "Riders (people, W2b)", record › Overview
 * "Measurement profiles (riders, W2b)"; rules factory-domain parties/riders): a rider is a PERSON party (made with W1's
 * POST /parties, kind PERSON, the customer role) put under a team or dealer, an ORGANISATION customer (factory-db
 * Party.teamPartyId). parties.view reads a team's riders and a rider's team; parties.manage on the rider puts it under a
 * team, moves it or takes it off (the team only needs to be visible). The rider's version guards the change (its row, as
 * W1's PATCH /parties/:id), and the database holds the same rules (Party_team_check).
 */

const RIDER_COLUMNS = { id: true, code: true, kind: true, legalName: true, tradeName: true, roles: true, status: true, companyId: true, teamPartyId: true, country: true, language: true, version: true, updatedAt: true } as const
type Reader = FactoryClient | CommandTx

const factsOf = (row: { id: string; code: string; kind: string; roles: readonly string[]; status: string; companyId: string | null }): RiderFacts => ({
  id: row.id,
  code: row.code,
  kind: row.kind as PartyKind,
  roles: row.roles as PartyRole[],
  status: row.status as PartyStatus,
  companyId: row.companyId,
})

/** A team's riders (those the caller may see), or a rider's team, with each rider's measurement profiles. */
export async function ridersOf(db: Reader, context: OfficeContext, partyId: string) {
  const party = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: RIDER_COLUMNS })
  const actor = actorOf(context)
  const team = party.teamPartyId ? await db.party.findUnique({ where: { id: party.teamPartyId }, select: RIDER_COLUMNS }) : null
  const riders = await db.party.findMany({ where: { AND: [{ teamPartyId: partyId }, scopeWhere(actor, PARTIES_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput] }, select: RIDER_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const profiles = riders.length > 0 ? await db.measurementProfile.groupBy({ by: ['partyId'], where: { partyId: { in: riders.map((rider) => rider.id) } }, _count: { _all: true } }) : []
  const counts = new Map(profiles.map((row) => [row.partyId, row._count._all]))
  return {
    partyId: party.id,
    code: party.code,
    kind: party.kind as PartyKind,
    /** This party's team, when it is a rider (and the team is one the caller may see). */
    team: team && can(actor, PARTIES_VIEW, { companyId: team.companyId, partyId: team.id }) ? { id: team.id, code: team.code, legalName: team.legalName, status: team.status } : null,
    riders: riders.map((rider) => ({
      id: rider.id,
      code: rider.code,
      legalName: rider.legalName,
      tradeName: rider.tradeName,
      status: rider.status,
      country: rider.country,
      language: rider.language,
      measurementProfiles: counts.get(rider.id) ?? 0,
      version: rider.version,
      updatedAt: toUtcIso(rider.updatedAt),
    })),
    version: party.version,
  }
}
export type RidersView = Awaited<ReturnType<typeof ridersOf>>

function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** GET /parties/:partyId/riders (parties.view). */
export async function getRiders(caller: CommandCaller, partyId: string): Promise<{ riders: RidersView }> {
  const context = officeOf(caller)
  await readParty(caller, partyId)
  return caller.withClient(async (client) => ({ riders: await ridersOf(client, context, partyId) }))
}

/**
 * PUT /parties/:partyId/team (parties.manage on the rider): the rider under a team or dealer (`teamPartyId`), moved to
 * another, or taken off (null). `version`: the rider's.
 */
export async function setTeam(caller: CommandCaller, partyId: string, body: { readonly version: number; readonly teamPartyId: string | null }, idempotencyKey?: string): Promise<{ riders: RidersView }> {
  const context = officeOf(caller)
  const rider = await readParty(caller, partyId)
  assertMayWrite(context, PARTIES_MANAGE, rider)
  const team = body.teamPartyId === null ? null : isUuid(body.teamPartyId) ? await caller.withClient((client) => client.party.findUnique({ where: { id: body.teamPartyId! }, select: RIDER_COLUMNS })) : null
  if (body.teamPartyId !== null && (!team || !can(actorOf(context), PARTIES_VIEW, { companyId: team.companyId, partyId: team.id }))) {
    throw new ValidationError('Not a team or dealer you may see.', [{ path: 'body/teamPartyId', message: 'Expected a customer organisation.' }])
  }
  if (team) {
    const problem = teamProblem(factsOf(rider), factsOf(team))
    if (problem) throw new ValidationError(problem, [{ path: 'body/teamPartyId', message: problem }])
  }
  await command(caller, { name: 'parties.setTeam', idempotencyKey, input: { partyId, ...body }, record: { type: 'Party', id: partyId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.party.findUniqueOrThrow({ where: { id: partyId }, select: { teamPartyId: true } })
    // A team that gains a rider is held FOR SHARE: a kind change of it waits, then the database refuses it in words.
    if (team) await tx.$queryRaw`SELECT id FROM "Party" WHERE id = ${team.id}::uuid FOR SHARE`
    if (current.teamPartyId !== (team?.id ?? null)) await tx.party.update({ where: { id: partyId }, data: { teamPartyId: team?.id ?? null, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'parties.setTeam', recordType: 'Party', recordId: partyId, companyId: rider.companyId, before: { teamPartyId: current.teamPartyId }, after: { teamPartyId: team?.id ?? null } })
    tools.emit({ type: 'party.team_changed', subject: partyId, companyId: rider.companyId, payload: { partyId, code: rider.code, teamPartyId: team?.id ?? null, previousTeamPartyId: current.teamPartyId } })
    return { id: partyId }
  })
  return getRiders(caller, partyId)
}
