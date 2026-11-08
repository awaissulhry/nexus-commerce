import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { holds } from '@nexus/factory-domain/core/permissions'
import { approvalView, defaultProblem } from '@nexus/factory-domain/parties/address-approval'
import { checkAddress } from '@nexus/factory-domain/parties/addresses'
import { PORTAL_ADDRESSES_MANAGE } from '@nexus/factory-domain/sales/portal-ordering/permissions'
import type { CommandTools } from '../../../core/command'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { portalOf } from '../../../platform/auth/portal/service'
import { ADDRESS_COLUMNS, addressFieldsOf, clearDefault, lockParty, touchParty } from '../../parties/store'

/**
 * Delivery addresses self-service (B-W2b-190, SAL-079; design portal.customer.account › Delivery addresses, the
 * neworder's "Add a new address"). The customer's people read their organisation's delivery (SHIP_TO) addresses
 * (portal.addresses.view); its admin adds one, archives one and chooses the default (portal.addresses.manage).
 *
 *   GET  /portal/addresses                        the party's delivery addresses, active first: who added each (a
 *                                                 colleague's name, or "the factory"), the default mark, the status
 *   POST /portal/addresses                        a new SHIP_TO address that waits for the office's check (B-W2b-F13b,
 *                                                 wave 23): never the default, no order uses it until approved
 *   POST /portal/addresses/:addressId/archive     archived (it stops being the default; requests already sent keep it)
 *   POST /portal/addresses/:addressId/default     the default delivery address
 *
 * A change runs in the tenant's office scope as the portal person (as the partner admin's colleague changes do,
 * B-W2b-162; the partner role may insert only a waiting address and never archive or choose a default), after the checks
 * here: the party is the session's, the address is one of its delivery addresses. It takes the party's lock first (the
 * parties module's helpers clear the old default and move the party's version), createdById names the partner person; the
 * audit rows (on the address and on the party) say `byPartner`, and party.addresses_changed tells the office's customer
 * record. The factory sees who did on the customer's record and in its history. B-W2b-F13b (wave 23): an address the admin adds WAITS for the office's check
 * (PartyAddress.approvalStatus, requestedAt, requestedByUserId — the partner-visible "added by"); the office approves or
 * refuses it (./address-check.ts, Home › Approvals), or accepting a request that names it approves it. The list shows the
 * check and, refused, the reason; a waiting address is never the default.
 */

export interface PortalAddressBody {
  readonly name?: string | null | undefined
  readonly line1: string
  readonly line2?: string | null | undefined
  readonly postalCode: string
  readonly city: string
  readonly province?: string | null | undefined
  readonly country: string
  readonly contactName?: string | null | undefined
  readonly phone?: string | null | undefined
  readonly deliveryNotes?: string | null | undefined
  readonly isDefault?: boolean | undefined
}

const contextOf = (app: FastifyInstance, request: FastifyRequest, session: PortalSession) => portalOf(app).auth.contextFor(request, session.tenantId, session.userId)

export async function listAddresses(app: FastifyInstance, request: FastifyRequest) {
  const session = portalSessionOf(request)
  const p = portalOf(app)
  // Who asked for an address is requestedByUserId (wave 23, partner-visible); an address added before the check existed
  // names its author only in createdById, hidden from the partner role: so the list is read in the office scope as the person.
  const rows = await p.auth.inTenant(session.tenantId, session.userId, (db) =>
    db.partyAddress.findMany({
      where: { partyId: session.partyId, kinds: { has: 'SHIP_TO' } },
      select: { ...ADDRESS_COLUMNS, createdById: true, requestedByUserId: true, requestedAt: true, decidedAt: true, refuseReason: true },
      orderBy: [{ status: 'asc' }, { isDefaultShipTo: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }),
  )
  const authorOf = (row: { readonly requestedByUserId: string | null; readonly createdById: string | null }) => row.requestedByUserId ?? row.createdById
  const authorIds = [...new Set(rows.flatMap((row) => (authorOf(row) ? [authorOf(row)!] : [])))]
  const colleagues = authorIds.length === 0 ? [] : await p.auth.inTenant(session.tenantId, session.userId, (db) => db.user.findMany({ where: { id: { in: authorIds }, partyId: session.partyId, audience: 'PARTNER' }, select: { id: true, displayName: true } }))
  return {
    addresses: rows.map((row) => {
      const colleague = colleagues.find((user) => user.id === authorOf(row))
      return {
        id: row.id,
        ...addressFieldsOf(row),
        isDefault: row.isDefaultShipTo,
        status: row.status,
        version: row.version,
        createdAt: toUtcIso(row.createdAt),
        /** Who added it: a colleague of the organisation (named), or the factory. */
        addedBy: colleague ? { kind: 'COLLEAGUE' as const, name: colleague.displayName, you: colleague.id === session.userId } : { kind: 'FACTORY' as const, name: null, you: false },
        /** Our check of an address the organisation added (null: one of the factory's own): waiting, approved, or refused with the reason. */
        approval: approvalView(row),
        requestedAt: row.requestedAt ? toUtcIso(row.requestedAt) : null,
        decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
      }
    }),
    /** The person may add, archive and choose the default (the customer's admin). */
    canManage: holds(actorOf(requireContext(request)), PORTAL_ADDRESSES_MANAGE) && !session.preview,
  }
}

async function ownAddress(tools: CommandTools, session: PortalSession, addressId: string, version: number) {
  const row = isUuid(addressId) ? await tools.tx.partyAddress.findUnique({ where: { id: addressId }, select: ADDRESS_COLUMNS }) : null
  if (!row || row.partyId !== session.partyId || !row.kinds.includes('SHIP_TO')) throw new NotFoundError('Address not found.')
  if (row.version !== version) throw new ConflictError(`This address changed since you read it (now version ${row.version}). Read it again.`)
  return row
}

export async function addAddress(app: FastifyInstance, request: FastifyRequest, body: PortalAddressBody, idempotencyKey?: string) {
  const session = portalSessionOf(request)
  const outcome = checkAddress({ ...body, kinds: ['SHIP_TO'] })
  if (!outcome.ok) throw new ValidationError('The address is not valid.', outcome.issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
  // A new address waits for our check: never the default until approved (the database refuses a waiting default too).
  if (body.isDefault === true) throw new ValidationError(defaultProblem('WAITING')!, [{ path: 'body/isDefault', message: defaultProblem('WAITING')! }])
  const p = portalOf(app)
  const { result } = await p.auth.command(contextOf(app, request, session), { name: 'portalOrdering.addAddress', idempotencyKey, input: { ...body, sessionId: session.id } }, async (tools) => {
    const { tx, now } = tools
    const party = await lockParty(tx, session.partyId)
    if (party.status === 'ARCHIVED' || party.status === 'BLOCKED') throw new InvalidStateError('Your organisation cannot change its addresses now: ask the factory.')
    const id = newId()
    const address = { ...outcome.address, kinds: ['SHIP_TO' as const] }
    // WAITING with who asked and when (an active person of the party: the database checks it); written in the office scope
    // as the person, so createdById names them as well.
    await tx.partyAddress.create({
      data: { id, partyId: session.partyId, ...address, isDefaultBillTo: false, isDefaultShipTo: false, approvalStatus: 'WAITING', requestedAt: now, requestedByUserId: session.userId, createdAt: now, updatedAt: now, createdById: session.userId },
      select: { id: true },
    })
    tools.audit({ recordType: 'PartyAddress', recordId: id, companyId: party.companyId, after: { partyId: session.partyId, ...address, isDefaultBillTo: false, isDefaultShipTo: false, approvalStatus: 'WAITING', byPartner: true } })
    tools.audit({ recordType: 'Party', recordId: session.partyId, companyId: party.companyId, after: { address: { id, ...address, isDefaultShipTo: false, approvalStatus: 'WAITING' }, byPartner: true } })
    tools.emit({ type: 'party.addresses_changed', subject: session.partyId, companyId: party.companyId, payload: { partyId: session.partyId, code: party.code, addressIds: [id] } })
    return { id }
  })
  return { address: (await listAddresses(app, request)).addresses.find((address) => address.id === result.id)! }
}

export async function archiveAddress(app: FastifyInstance, request: FastifyRequest, addressId: string, version: number, idempotencyKey?: string) {
  const session = portalSessionOf(request)
  const p = portalOf(app)
  await p.auth.command(contextOf(app, request, session), { name: 'portalOrdering.archiveAddress', idempotencyKey, input: { addressId, version, sessionId: session.id } }, async (tools) => {
    const party = await lockParty(tools.tx, session.partyId)
    const row = await ownAddress(tools, session, addressId, version)
    if (row.status === 'ARCHIVED') throw new InvalidStateError('This address is archived already.')
    const kinds = row.kinds.filter((kind) => kind !== 'SHIP_TO')
    // An address the factory also uses for invoices or as the registered office keeps those uses: only its delivery use ends.
    const archive = kinds.length === 0
    await tools.tx.partyAddress.update({ where: { id: row.id }, data: archive ? { status: 'ARCHIVED', isDefaultShipTo: false, version: { increment: 1 } } : { kinds, isDefaultShipTo: false, version: { increment: 1 } }, select: { id: true } })
    if (row.isDefaultShipTo) await touchParty(tools.tx, session.partyId)
    const before = { status: row.status, kinds: row.kinds, isDefaultShipTo: row.isDefaultShipTo }
    const after = archive ? { status: 'ARCHIVED', kinds: row.kinds, isDefaultShipTo: false } : { status: row.status, kinds, isDefaultShipTo: false }
    tools.audit({ recordType: 'PartyAddress', recordId: row.id, companyId: party.companyId, before, after: { ...after, byPartner: true } })
    tools.audit({ recordType: 'Party', recordId: session.partyId, companyId: party.companyId, before: { address: { id: row.id, ...before } }, after: { address: { id: row.id, ...after }, byPartner: true } })
    tools.emit({ type: 'party.addresses_changed', subject: session.partyId, companyId: party.companyId, payload: { partyId: session.partyId, code: party.code, addressIds: [row.id] } })
    return null
  })
  return listAddresses(app, request)
}

export async function defaultAddress(app: FastifyInstance, request: FastifyRequest, addressId: string, version: number, idempotencyKey?: string) {
  const session = portalSessionOf(request)
  const p = portalOf(app)
  await p.auth.command(contextOf(app, request, session), { name: 'portalOrdering.defaultAddress', idempotencyKey, input: { addressId, version, sessionId: session.id } }, async (tools) => {
    const party = await lockParty(tools.tx, session.partyId)
    const row = await ownAddress(tools, session, addressId, version)
    if (row.status !== 'ACTIVE') throw new InvalidStateError('An archived address cannot be the default.')
    const waiting = defaultProblem(row.approvalStatus)
    if (waiting) throw new InvalidStateError(waiting)
    if (row.isDefaultShipTo) return null
    const cleared = await clearDefault(tools.tx, session.partyId, 'isDefaultShipTo', row.id)
    await tools.tx.partyAddress.update({ where: { id: row.id }, data: { isDefaultShipTo: true, version: { increment: 1 } }, select: { id: true } })
    await touchParty(tools.tx, session.partyId)
    tools.audit({ recordType: 'Party', recordId: session.partyId, companyId: party.companyId, before: { shipToAddressId: cleared[0] ?? null }, after: { shipToAddressId: row.id, byPartner: true } })
    tools.emit({ type: 'party.addresses_changed', subject: session.partyId, companyId: party.companyId, payload: { partyId: session.partyId, code: party.code, addressIds: [row.id, ...cleared] } })
    return null
  })
  return listAddresses(app, request)
}
