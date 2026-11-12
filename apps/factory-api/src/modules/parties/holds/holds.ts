import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { HOLD_REASONS, holdsInForceFor, holdWordsProblem, REASON_WORDS, type HoldReason } from '@nexus/factory-domain/parties/holds/holds'
import { PARTIES_HOLD } from '@nexus/factory-domain/parties/holds/permissions'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { isCustomer, type PartyRole } from '@nexus/factory-domain/parties/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMayWrite, contextOf, isUniqueViolation, lockParty, readParty } from '../store'

/**
 * A customer's account on hold (B-W2b-290; SAL-023; design sales.customers record › Tax & terms › Hold; rules
 * factory-domain parties/holds): placed for one company or every company with a reason and words, released with words;
 * the rows are the history (factory-db PartyHold, never edited or removed). parties.view reads them; parties.hold places
 * and releases, over the party and the company named (a hold of every company: a grant over every company, as a
 * tenant-wide party's write). What it stops is read by the other modules through ./stops.ts.
 *
 * The record's Hold card shows the holds in force first, then the released ones, with who and when, and the accepted
 * quotes whose order waits for the release (the order of an accepted quote is not made while a hold is in force:
 * sales/orders make.ts; the office makes it with POST /sales/orders once the hold is released).
 */

export const HOLD_COLUMNS = {
  id: true,
  partyId: true,
  companyId: true,
  reason: true,
  words: true,
  placedAt: true,
  placedById: true,
  releasedAt: true,
  releasedById: true,
  releaseWords: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.PartyHoldSelect
export type HoldRow = Prisma.PartyHoldGetPayload<{ select: typeof HOLD_COLUMNS }>

type Reader = FactoryClient | CommandTx

/** The holds of a party in force for a record of `companyId` (its company's, and every company's). */
export async function holdsInForce(db: Reader, partyId: string, companyId: string): Promise<HoldRow[]> {
  const rows = await db.partyHold.findMany({ where: { partyId, releasedAt: null }, select: HOLD_COLUMNS, orderBy: [{ placedAt: 'asc' }, { id: 'asc' }] })
  return holdsInForceFor(rows, companyId)
}

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

function holdViewOf(row: HoldRow, names: ReadonlyMap<string, string>, companies: ReadonlyMap<string, { code: string; name: string }>) {
  return {
    id: row.id,
    companyId: row.companyId,
    company: row.companyId ? (companies.get(row.companyId) ?? null) : null,
    reason: row.reason as HoldReason,
    reasonWords: REASON_WORDS[row.reason as HoldReason],
    words: row.words,
    inForce: row.releasedAt === null,
    placedAt: toUtcIso(row.placedAt),
    /** null: placed by the system (a credit check, B-W2b-304). */
    placedBy: row.placedById ? (names.get(row.placedById) ?? null) : null,
    releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
    releasedBy: row.releasedById ? (names.get(row.releasedById) ?? null) : null,
    releaseWords: row.releaseWords,
    version: row.version,
  }
}

/** The accepted quote versions of the party (of `companyIds`) that have no order yet: they wait for a release (or a PO number). */
async function ordersWaitingOf(db: Reader, partyId: string, companyIds: readonly string[]) {
  const versions = await db.quoteVersion.findMany({ where: { partyId, status: 'ACCEPTED', salesOrders: { none: {} }, quote: { companyId: { in: [...companyIds] } } }, select: { id: true, revision: true, quote: { select: { id: true, number: true, companyId: true, customerRef: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50 })
  return versions.map((version) => ({ quoteId: version.quote.id, number: version.quote.number, revision: version.revision, quoteVersionId: version.id, companyId: version.quote.companyId, customerRef: version.quote.customerRef }))
}

/** The party's holds as the record's Hold card reads them. */
export async function holdsOf(db: Reader, context: OfficeContext, partyId: string) {
  const party = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: { id: true, code: true, companyId: true } })
  const actor = actorOf(context)
  const visible = (await db.company.findMany({ where: { ...(party.companyId ? { id: party.companyId } : {}) }, select: { id: true, code: true, legalName: true, tradeName: true }, orderBy: [{ code: 'asc' }] })).filter((company) => can(actor, PARTIES_VIEW, { companyId: company.id, partyId }))
  const companies = new Map(visible.map((company) => [company.id, { code: company.code, name: company.tradeName ?? company.legalName }]))
  const rows = (await db.partyHold.findMany({ where: { partyId }, select: HOLD_COLUMNS, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }] })).filter((row) => row.companyId === null || companies.has(row.companyId))
  const names = await namesOf(db, rows.flatMap((row) => [row.placedById, row.releasedById]))
  const views = rows.map((row) => holdViewOf(row, names, companies))
  return {
    partyId: party.id,
    code: party.code,
    onHold: views.some((view) => view.inForce),
    holds: [...views.filter((view) => view.inForce), ...views.filter((view) => !view.inForce)],
    ordersWaiting: await ordersWaitingOf(db, partyId, [...companies.keys()]),
    mayPlace: [...companies.keys()].some((companyId) => can(actor, PARTIES_HOLD, { companyId, partyId })),
    reasons: HOLD_REASONS.map((reason) => ({ reason, words: REASON_WORDS[reason] })),
  }
}
export type PartyHoldsView = Awaited<ReturnType<typeof holdsOf>>

function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** GET /parties/:partyId/holds (parties.view). */
export async function getHolds(caller: CommandCaller, partyId: string): Promise<{ holds: PartyHoldsView }> {
  const context = officeOf(caller)
  await readParty(caller, partyId)
  return caller.withClient(async (client) => ({ holds: await holdsOf(client, context, partyId) }))
}

/** parties.hold over the party, and over the company named (null: every company, as a tenant-wide write). */
function assertMayHold(context: OfficeContext, party: { id: string; companyId: string | null }, companyId: string | null): void {
  if (companyId === null) assertMayWrite(context, PARTIES_HOLD, party)
  else if (!can(actorOf(context), PARTIES_HOLD, { companyId, partyId: party.id })) throw new ForbiddenError()
}

export interface PlaceHoldBody {
  readonly companyId: string | null
  readonly reason: HoldReason
  readonly words: string
}

/** POST /parties/:partyId/holds (parties.hold): the account on hold for one company or every company, with its reason. */
export async function placeHold(caller: CommandCaller, partyId: string, body: PlaceHoldBody, idempotencyKey?: string): Promise<{ holds: PartyHoldsView }> {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  if (!isCustomer(party.roles as PartyRole[])) throw new InvalidStateError(`${party.code} is not a customer: an account hold stops a customer's orders and shipments.`)
  if (party.status === 'ARCHIVED') throw new InvalidStateError(`${party.code} is archived: reactivate it before putting it on hold.`)
  const companyId = body.companyId ?? null
  if (companyId !== null) {
    const company = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
    if (!company || !can(actorOf(context), PARTIES_VIEW, { companyId, partyId })) throw new ValidationError('Not a company you may see.', [{ path: 'body/companyId', message: 'Expected one of our companies, or none for every company.' }])
    if (party.companyId !== null && party.companyId !== companyId) throw new ValidationError(`${party.code} is a customer of one company only: put it on hold there.`, [{ path: 'body/companyId', message: "Its own company, or none." }])
  }
  assertMayHold(context, party, companyId)
  const problem = holdWordsProblem(body.words, 'place')
  if (problem) throw new ValidationError(problem.message, [{ path: `body/${problem.path}`, message: problem.message }])
  try {
    await command(caller, { name: 'parties.placeHold', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
      const { tx, now } = tools
      await lockParty(tx, partyId)
      const twin = await tx.partyHold.findFirst({ where: { partyId, companyId, reason: body.reason, releasedAt: null }, select: { id: true } })
      if (twin) throw sameHold(party.code, body.reason)
      const id = newId()
      await tx.partyHold.create({ data: { id, partyId, companyId, reason: body.reason, words: body.words.trim(), placedAt: now, placedById: context.actorId, createdById: context.actorId, createdAt: now, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'parties.placeHold', recordType: 'PartyHold', recordId: id, companyId, after: { partyId, companyId, reason: body.reason, words: body.words.trim() } })
      tools.emit({ type: 'party.hold_placed', subject: partyId, companyId, payload: { partyId, code: party.code, holdId: id, companyId, reason: body.reason } })
      return { id }
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw sameHold(party.code, body.reason)
    throw error
  }
  return getHolds(caller, partyId)
}

const sameHold = (code: string, reason: HoldReason) =>
  new DomainError('conflict', `${code} is on hold for ${REASON_WORDS[reason].en} there already: release that hold, or add your words to it by placing one for another reason.`, [{ path: 'body/reason', message: 'One hold in force per company and reason.' }])

/** POST /parties/:partyId/holds/:holdId/release (parties.hold): the hold released with words; the row stays as history. */
export async function releaseHold(caller: CommandCaller, partyId: string, holdId: string, body: { readonly version: number; readonly words: string }, idempotencyKey?: string): Promise<{ holds: PartyHoldsView }> {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  const hold = isUuid(holdId) ? await caller.withClient((client) => client.partyHold.findUnique({ where: { id: holdId }, select: HOLD_COLUMNS })) : null
  if (!hold || hold.partyId !== partyId || (hold.companyId !== null && !can(actorOf(context), PARTIES_VIEW, { companyId: hold.companyId, partyId }))) throw new NotFoundError('Hold not found.')
  if (hold.releasedAt !== null) throw new InvalidStateError('This hold was released already; the row stays as history.')
  assertMayHold(context, party, hold.companyId)
  const problem = holdWordsProblem(body.words, 'release')
  if (problem) throw new ValidationError(problem.message, [{ path: `body/${problem.path}`, message: problem.message }])
  await command(caller, { name: 'parties.releaseHold', idempotencyKey, input: { partyId, holdId, ...body }, record: { type: 'PartyHold', id: holdId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    await lockParty(tx, partyId)
    await tx.partyHold.update({ where: { id: holdId }, data: { releasedAt: now, releasedById: context.actorId, releaseWords: body.words.trim(), updatedAt: now }, select: { id: true } })
    const still = await tx.partyHold.count({ where: { partyId, releasedAt: null } })
    tools.audit({ action: 'parties.releaseHold', recordType: 'PartyHold', recordId: holdId, companyId: hold.companyId, before: { reason: hold.reason, words: hold.words }, after: { releasedAt: toUtcIso(now), releaseWords: body.words.trim() } })
    tools.emit({ type: 'party.hold_released', subject: partyId, companyId: hold.companyId, payload: { partyId, code: party.code, holdId, companyId: hold.companyId, reason: hold.reason as HoldReason, stillOnHold: still > 0 } })
    return { id: holdId }
  })
  return getHolds(caller, partyId)
}
