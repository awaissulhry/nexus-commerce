import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { SUPPLIER_CHANGES_DECIDE } from '@nexus/factory-domain/purchasing/portal-profile/permissions'
import { profileRefuseProblems, staleProblems, type PlannedChange } from '@nexus/factory-domain/purchasing/portal-profile/profile'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../../platform/files/files'
import { bumpVersion, insertAddress, insertContact } from '../../parties/store'
import { currentProfileOf, requestView } from './profile'
import { ACTIONS, LOOK_BACK_DAYS, lockSupplier, partyOfRequest, partyRequests, recentRequests, type ChangeRequest } from './store'

/**
 * The buyer's check of a supplier's change of its addresses and contacts (B-W2b-189; SCM-097; design portal.supplier.profile
 * "changes go to the buyer for a check", home.approvals "every request that needs my yes"):
 *
 *   GET  /purchasing/supplier-changes?partyId=&state=OPEN|ALL     the requests of the suppliers the person may decide, each
 *                                                                change old → new in words
 *   POST /purchasing/supplier-changes/:requestId/approve          the changes apply now, as the parties module writes them
 *                                                                (an address or contact added, changed, archived), each row
 *                                                                at the version the supplier saw — one that changed since
 *                                                                stops the approval (409 in words: refuse it, the supplier
 *                                                                sends it again)
 *   POST /purchasing/supplier-changes/:requestId/refuse {reason}  nothing changes; the supplier reads why
 *
 * purchasing.supplierChanges.decide over the request's company and party (administrator, buyer). Each decision is ONE command
 * with the supplier's row locked (the request is decided once); Home › Approvals lists the open ones
 * (modules/insights/sources/supplier-changes.ts).
 */

const DAY_MS = 86_400_000
/** The audit action of each row the approval writes (the party's history: "applied from the supplier's request"). */
const APPLY = 'supplierProfile.applyChange'

function viewer(caller: CommandCaller) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new NotFoundError('Request not found.')
  return { context, actor: actorOf(context) }
}

async function personName(client: Pick<FactoryClient, 'user'>, id: string): Promise<string | null> {
  return (await client.user.findUnique({ where: { id }, select: { displayName: true } }))?.displayName ?? null
}

/** GET /purchasing/supplier-changes. */
export async function listSupplierChanges(caller: CommandCaller, query: { readonly partyId?: string | undefined; readonly state?: 'OPEN' | 'ALL' | undefined }, now: Date) {
  const { actor } = viewer(caller)
  if (query.partyId !== undefined && !isUuid(query.partyId)) throw new ValidationError('The supplier is not valid.', [{ path: 'querystring/partyId', message: 'A party id.' }])
  return caller.withClient(async (client) => {
    const requests = (await recentRequests(client, new Date(now.getTime() - LOOK_BACK_DAYS * DAY_MS), query.partyId))
      .filter((entry) => can(actor, SUPPLIER_CHANGES_DECIDE, { companyId: entry.companyId, partyId: entry.partyId }))
      .filter((entry) => query.state === 'ALL' || entry.state === 'OPEN')
      .reverse()
    const parties = new Map(
      (requests.length === 0 ? [] : await client.party.findMany({ where: { id: { in: [...new Set(requests.map((entry) => entry.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row] as const),
    )
    return {
      requests: requests.map((entry) => ({ ...requestView(entry), party: { id: entry.partyId, code: parties.get(entry.partyId)?.code ?? '', name: parties.get(entry.partyId)?.legalName ?? '' }, companyId: entry.companyId })),
      counts: { open: requests.filter((entry) => entry.state === 'OPEN').length },
    }
  })
}

/** The request as the person may decide it (else not found), still open. */
async function decidable(caller: CommandCaller, requestId: string): Promise<ChangeRequest> {
  const { actor } = viewer(caller)
  if (!isUuid(requestId)) throw new NotFoundError('Request not found.')
  const found = await caller.withClient(async (client) => {
    const partyId = await partyOfRequest(client, requestId)
    return partyId ? (await partyRequests(client, partyId)).find((entry) => entry.requestId === requestId) : undefined
  })
  if (!found || !can(actor, SUPPLIER_CHANGES_DECIDE, { companyId: found.companyId, partyId: found.partyId })) throw new NotFoundError('Request not found.')
  return found
}

function refusalOf(state: ChangeRequest['state']): string {
  if (state === 'APPROVED') return 'This request was approved already.'
  if (state === 'REFUSED') return 'This request was refused already.'
  return 'The supplier withdrew this request.'
}

/** Inside a decision: the supplier's row locked, then the request as it is now (still open). */
async function stillOpen(tools: CommandTools, found: ChangeRequest): Promise<ChangeRequest> {
  const party = await lockSupplier(tools.tx, found.partyId)
  if (party.status === 'ARCHIVED') throw new InvalidStateError('This supplier is archived: restore it before changing its addresses or contacts.')
  const now = (await partyRequests(tools.tx, found.partyId)).find((entry) => entry.requestId === found.requestId)
  if (!now) throw new NotFoundError('Request not found.')
  if (now.state !== 'OPEN') throw new InvalidStateError(refusalOf(now.state))
  return now
}

/** One change written as the parties module writes it (its own audit rows on the row and on the party). */
async function apply(tools: CommandTools, party: { readonly id: string; readonly companyId: string | null }, change: PlannedChange): Promise<string> {
  const { tx } = tools
  const onParty = (what: 'address' | 'contact', before: unknown, after: unknown) =>
    tools.audit({ action: APPLY, recordType: 'Party', recordId: party.id, companyId: party.companyId, ...(before === null ? {} : { before: { [what]: before } }), after: { [what]: after, bySupplierRequest: true } })
  if (change.target === 'ADDRESS') {
    if (change.op === 'ADD') {
      const id = await insertAddress(tools, party, change.after, { isDefaultBillTo: false, isDefaultShipTo: false }, APPLY)
      onParty('address', null, { id, ...change.after })
      return id
    }
    await bumpVersion(tx, 'address', change.id, change.version)
    if (change.op === 'REMOVE') {
      await tx.partyAddress.update({ where: { id: change.id }, data: { status: 'ARCHIVED', isDefaultBillTo: false, isDefaultShipTo: false }, select: { id: true } })
      tools.audit({ action: APPLY, recordType: 'PartyAddress', recordId: change.id, companyId: party.companyId, before: { ...change.before, status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
      onParty('address', { id: change.id, ...change.before }, { id: change.id, status: 'ARCHIVED' })
      return change.id
    }
    const { kinds: _kinds, ...fields } = change.after
    await tx.partyAddress.update({ where: { id: change.id }, data: fields, select: { id: true } })
    tools.audit({ action: APPLY, recordType: 'PartyAddress', recordId: change.id, companyId: party.companyId, before: change.before, after: change.after })
    onParty('address', { id: change.id, ...change.before }, { id: change.id, ...change.after })
    return change.id
  }
  if (change.op === 'ADD') {
    const id = await insertContact(tools, party, change.after, APPLY)
    onParty('contact', null, { id, ...change.after })
    return id
  }
  await bumpVersion(tx, 'contact', change.id, change.version)
  if (change.op === 'REMOVE') {
    await tx.partyContact.update({ where: { id: change.id }, data: { status: 'ARCHIVED' }, select: { id: true } })
    tools.audit({ action: APPLY, recordType: 'PartyContact', recordId: change.id, companyId: party.companyId, before: { ...change.before, status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    onParty('contact', { id: change.id, ...change.before }, { id: change.id, status: 'ARCHIVED' })
    return change.id
  }
  await tx.partyContact.update({ where: { id: change.id }, data: { ...change.after, roles: [...change.after.roles] }, select: { id: true } })
  tools.audit({ action: APPLY, recordType: 'PartyContact', recordId: change.id, companyId: party.companyId, before: change.before, after: change.after })
  onParty('contact', { id: change.id, ...change.before }, { id: change.id, ...change.after })
  return change.id
}

/** POST /purchasing/supplier-changes/:requestId/approve. */
export async function approveSupplierChange(caller: CommandCaller, requestId: string, idempotencyKey?: string) {
  const { context } = viewer(caller)
  const found = await decidable(caller, requestId)
  if (found.state !== 'OPEN') throw new InvalidStateError(refusalOf(found.state))
  await command(caller, { name: 'supplierProfile.approveChange', idempotencyKey, input: { requestId } }, async (tools) => {
    const open = await stillOpen(tools, found)
    const party = await tools.tx.party.findUniqueOrThrow({ where: { id: open.partyId }, select: { id: true, companyId: true, code: true } })
    const stale = staleProblems(open.changes, await currentProfileOf(tools.tx, open.partyId))
    if (stale.length > 0) throw new ConflictError(`This request cannot apply as sent: ${stale.join('; ')}. Refuse it, and the supplier sends it again.`)
    const addressIds: string[] = []
    const contactIds: string[] = []
    for (const change of open.changes) (change.target === 'ADDRESS' ? addressIds : contactIds).push(await apply(tools, party, change))
    const byName = await personName(tools.tx, context.actorId)
    tools.audit({ action: ACTIONS.approve, recordType: 'Party', recordId: open.partyId, companyId: open.companyId, after: { requestId, byName, addressIds, contactIds } })
    if (addressIds.length > 0) tools.emit({ type: 'party.addresses_changed', subject: party.id, companyId: party.companyId, payload: { partyId: party.id, code: party.code, addressIds } })
    if (contactIds.length > 0) tools.emit({ type: 'party.contacts_changed', subject: party.id, companyId: party.companyId, payload: { partyId: party.id, code: party.code, contactIds } })
    tools.emit({ type: 'supplier_profile.change_decided', subject: requestId, companyId: open.companyId, payload: { requestId, partyId: open.partyId, outcome: 'APPROVED' } })
    return { requestId }
  })
  return { request: requestView((await caller.withClient((client) => partyRequests(client, found.partyId))).find((entry) => entry.requestId === requestId)!) }
}

/** POST /purchasing/supplier-changes/:requestId/refuse. */
export async function refuseSupplierChange(caller: CommandCaller, requestId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  const { context } = viewer(caller)
  const problems = profileRefuseProblems(body.reason)
  if (problems.length > 0) throw new ValidationError('The refusal is not valid.', problems)
  const found = await decidable(caller, requestId)
  if (found.state !== 'OPEN') throw new InvalidStateError(refusalOf(found.state))
  const reason = body.reason.trim()
  await command(caller, { name: 'supplierProfile.refuseChange', idempotencyKey, input: { requestId, reason } }, async (tools) => {
    const open = await stillOpen(tools, found)
    const byName = await personName(tools.tx, context.actorId)
    tools.audit({ action: ACTIONS.refuseChange, recordType: 'Party', recordId: open.partyId, companyId: open.companyId, reason, after: { requestId, byName } })
    tools.emit({ type: 'supplier_profile.change_decided', subject: requestId, companyId: open.companyId, payload: { requestId, partyId: open.partyId, outcome: 'REFUSED' } })
    return { requestId }
  })
  return { request: requestView((await caller.withClient((client) => partyRequests(client, found.partyId))).find((entry) => entry.requestId === requestId)!) }
}
