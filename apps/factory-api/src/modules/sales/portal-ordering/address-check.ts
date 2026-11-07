import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { checkProblem, refuseReasonProblem, type AddressApproval } from '@nexus/factory-domain/parties/address-approval'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { ADDRESS_COLUMNS, addressFieldsOf, lockParty, PARTY_SCOPE } from '../../parties/store'
import { officeContextOf } from '../orders/access'

/**
 * The office's check of the delivery addresses customers add in the portal (B-W2b-F13b on the wave-23 schema; design
 * portal.customer.neworder "Add a new address (waits for our approval)", home.approvals). An address a customer adds waits
 * (PartyAddress.approvalStatus WAITING): no quote, order or shipment uses it until the office approves it. Whoever takes the
 * customer's orders checks it (orders.view to see, orders.manage to decide, over the customer's company and party):
 *
 *   GET  /sales/delivery-addresses?state=&partyId=      the addresses in the check: WAITING (active: one the customer took
 *                                                       back has nothing to check), APPROVED, REFUSED or ALL; oldest first
 *   POST /sales/delivery-addresses/:addressId/approve   APPROVED (when, by whom): orders and shipments may use it
 *   POST /sales/delivery-addresses/:addressId/refuse    REFUSED with the reason the customer reads; archived for good
 *
 * Accepting a customer's order request (./office.ts) or change request (../change-requests/office.ts) that names a WAITING
 * address approves it in the same command (`approveWaitingInCommand`): the office decides the request and the address
 * together. Each decision takes the party's lock (the portal's own address changes take it first too), compares the
 * address's version, writes an audit row on the address and on the party, and party.addresses_changed (the customer's
 * record, Home › Approvals). factory-db's guard holds the same rules for every login. The routes run the decisions on the
 * app's clock (`clock`), the one the portal's writes run on, so a decision is never "before it was asked" (decidedAt ≥
 * requestedAt, the guard).
 */

const LIST_MAX = 200

export const CHECK_STATES = ['WAITING', 'APPROVED', 'REFUSED', 'ALL'] as const
export type CheckState = (typeof CHECK_STATES)[number]

const CHECK_COLUMNS = {
  ...ADDRESS_COLUMNS,
  requestedAt: true,
  requestedByUserId: true,
  decidedAt: true,
  decidedById: true,
  refuseReason: true,
  party: { select: { id: true, code: true, legalName: true, companyId: true } },
} as const satisfies Prisma.PartyAddressSelect
type CheckRow = Prisma.PartyAddressGetPayload<{ select: typeof CHECK_COLUMNS }>

const scopeOf = (party: { readonly id: string; readonly companyId: string | null }) => (party.companyId ? { companyId: party.companyId, partyId: party.id } : { partyId: party.id })

async function namesOf(caller: CommandCaller, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return caller.withClient(async (client) => new Map((await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName])))
}

function viewOf(context: OfficeContext, row: CheckRow, names: ReadonlyMap<string, string>) {
  return {
    id: row.id,
    party: { id: row.party.id, code: row.party.code, name: row.party.legalName },
    ...addressFieldsOf(row),
    kinds: [...row.kinds],
    status: row.status,
    approval: {
      status: row.approvalStatus as AddressApproval,
      requestedAt: row.requestedAt ? toUtcIso(row.requestedAt) : null,
      requestedBy: row.requestedByUserId ? (names.get(row.requestedByUserId) ?? null) : null,
      decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
      decidedBy: row.decidedById ? (names.get(row.decidedById) ?? null) : null,
      refuseReason: row.refuseReason,
    },
    version: row.version,
    may: { decide: checkProblem(row) === null && can(actorOf(context), ORDERS_MANAGE, scopeOf(row.party)) },
  }
}

export async function listAddressChecks(caller: CommandCaller, query: { readonly state: CheckState; readonly partyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), ORDERS_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput
  const state: Prisma.PartyAddressWhereInput = query.state === 'ALL' ? { approvalStatus: { not: null } } : query.state === 'WAITING' ? { approvalStatus: 'WAITING', status: 'ACTIVE' } : { approvalStatus: query.state }
  const rows = await caller.withClient((client) =>
    client.partyAddress.findMany({ where: { AND: [state, { party: scope }, ...(query.partyId ? [{ partyId: query.partyId }] : [])] }, select: CHECK_COLUMNS, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }], take: LIST_MAX }),
  )
  const names = await namesOf(caller, rows.flatMap((row) => [row.requestedByUserId, row.decidedById]))
  return { addresses: rows.map((row) => viewOf(context, row, names)) }
}

/** The address in the check as the caller may decide it: 404 when it cannot see it, 403 when it may not decide. */
async function decidable(caller: CommandCaller, addressId: string): Promise<{ context: OfficeContext; row: CheckRow }> {
  const context = officeContextOf(caller)
  const row = isUuid(addressId) ? await caller.withClient((client) => client.partyAddress.findUnique({ where: { id: addressId }, select: CHECK_COLUMNS })) : null
  if (!row || row.approvalStatus === null || !can(actorOf(context), ORDERS_VIEW, scopeOf(row.party))) throw new NotFoundError('Delivery address not found.')
  if (!can(actorOf(context), ORDERS_MANAGE, scopeOf(row.party))) throw new ForbiddenError("Checking a customer's delivery addresses needs orders.manage for that customer.")
  const problem = checkProblem(row)
  if (problem) throw new InvalidStateError(problem)
  return { context, row }
}

/** Inside a command: the address after the party's lock, at the version read and still to check. */
async function lockedForCheck(tx: CommandTx, addressId: string, partyId: string, version: number | null) {
  const party = await lockParty(tx, partyId)
  const row = await tx.partyAddress.findUniqueOrThrow({ where: { id: addressId }, select: { id: true, partyId: true, status: true, approvalStatus: true, version: true } })
  if (version !== null && row.version !== version) throw new ConflictError(`This address changed since you read it (now version ${row.version}). Read it again.`)
  return { party, row }
}

interface Decided {
  readonly tools: CommandTools
  readonly party: { readonly code: string; readonly companyId: string | null }
  readonly addressId: string
  readonly partyId: string
  readonly after: Record<string, unknown>
}

function recordDecision({ tools, party, addressId, partyId, after }: Decided): void {
  tools.audit({ recordType: 'PartyAddress', recordId: addressId, companyId: party.companyId, before: { approvalStatus: 'WAITING' }, after })
  tools.audit({ recordType: 'Party', recordId: partyId, companyId: party.companyId, before: { address: { id: addressId, approvalStatus: 'WAITING' } }, after: { address: { id: addressId, ...after } } })
  tools.emit({ type: 'party.addresses_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, addressIds: [addressId] } })
}

/**
 * Inside the caller's command: a WAITING, active address approved by the office person of the command, because a request
 * that names it is accepted (`because`: the request). True when it approved it; false when there was nothing to approve
 * (an address of the office's own, already approved, refused or taken back: the caller's own checks speak then).
 */
export async function approveWaitingInCommand(tools: CommandTools, addressId: string, because: { readonly type: string; readonly id: string; readonly number: string | null }): Promise<boolean> {
  const { tx, now } = tools
  const seen = await tx.partyAddress.findUnique({ where: { id: addressId }, select: { partyId: true, status: true, approvalStatus: true } })
  if (!seen || seen.approvalStatus !== 'WAITING' || seen.status !== 'ACTIVE') return false
  const { party, row } = await lockedForCheck(tx, addressId, seen.partyId, null)
  if (checkProblem(row) !== null) return false
  const actorId = (tools.context as OfficeContext).actorId
  await tx.partyAddress.update({ where: { id: addressId }, data: { approvalStatus: 'APPROVED', decidedAt: now, decidedById: actorId, version: { increment: 1 } }, select: { id: true } })
  recordDecision({ tools, party, addressId, partyId: row.partyId, after: { approvalStatus: 'APPROVED', with: because } })
  return true
}

async function viewAfter(caller: CommandCaller, addressId: string) {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => client.partyAddress.findUniqueOrThrow({ where: { id: addressId }, select: CHECK_COLUMNS }))
  return { address: viewOf(context, row, await namesOf(caller, [row.requestedByUserId, row.decidedById])) }
}

export async function approveAddress(caller: CommandCaller, addressId: string, body: { readonly version: number }, idempotencyKey?: string, clock: Clock = serverClock) {
  const { context, row: seen } = await decidable(caller, addressId)
  await runCommand(caller, { name: 'portalOrdering.approveAddress', idempotencyKey, input: { addressId, ...body } }, async (tools) => {
    const { party, row } = await lockedForCheck(tools.tx, addressId, seen.partyId, body.version)
    const problem = checkProblem(row)
    if (problem) throw new InvalidStateError(problem)
    await tools.tx.partyAddress.update({ where: { id: addressId }, data: { approvalStatus: 'APPROVED', decidedAt: tools.now, decidedById: context.actorId, version: { increment: 1 } }, select: { id: true } })
    recordDecision({ tools, party, addressId, partyId: row.partyId, after: { approvalStatus: 'APPROVED' } })
    return null
  }, { ...COMMAND_SETTINGS, clock })
  return viewAfter(caller, addressId)
}

export async function refuseAddress(caller: CommandCaller, addressId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string, clock: Clock = serverClock) {
  const words = refuseReasonProblem(body.reason)
  if (words) throw new ValidationError(words, [{ path: 'body/reason', message: words }])
  const { context, row: seen } = await decidable(caller, addressId)
  await runCommand(caller, { name: 'portalOrdering.refuseAddress', idempotencyKey, input: { addressId, ...body } }, async (tools) => {
    const { party, row } = await lockedForCheck(tools.tx, addressId, seen.partyId, body.version)
    const problem = checkProblem(row)
    if (problem) throw new InvalidStateError(problem)
    const reason = body.reason.trim()
    // Refused = archived for good, never a default (a WAITING address never was one).
    await tools.tx.partyAddress.update({ where: { id: addressId }, data: { approvalStatus: 'REFUSED', decidedAt: tools.now, decidedById: context.actorId, refuseReason: reason, status: 'ARCHIVED', version: { increment: 1 } }, select: { id: true } })
    recordDecision({ tools, party, addressId, partyId: row.partyId, after: { approvalStatus: 'REFUSED', status: 'ARCHIVED', refuseReason: reason } })
    return null
  }, { ...COMMAND_SETTINGS, clock })
  return viewAfter(caller, addressId)
}
