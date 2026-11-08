import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Prisma } from '@nexus/factory-db'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PORTAL_SUPPLIER_PROFILE_CHANGE } from '@nexus/factory-domain/purchasing/portal-profile/permissions'
import {
  changeSentence,
  changeSummary,
  MAX_PROFILE_CHANGES,
  planProfileChange,
  SUPPLIER_ADDRESS_KINDS,
  SUPPLIER_CONTACT_ROLES,
  touchedKeysOf,
  type CurrentProfile,
  type PlannedChange,
  type ProfileChangeInput,
} from '@nexus/factory-domain/purchasing/portal-profile/profile'
import type { CommandTx } from '../../../core/command'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { portalOf } from '../../../platform/auth/portal/service'
import { systemCallerOf } from '../../../platform/files/files'
import { addressFieldsOf, ADDRESS_COLUMNS, contactFieldsOf, CONTACT_COLUMNS } from '../../parties/store'
import { ACTIONS, iso, keyFor, lockSupplier, partyRequests, requestById, type ChangeRequest } from './store'

/**
 * A supplier's company profile in the portal (B-W2b-189; SCM-097 "Profile self-service"; design portal.supplier.profile ›
 * Company, Contacts; "a change goes to the buyer in Home › Approvals and applies only on their yes"):
 *
 *   GET  /portal/supplier-profile                          the company as we hold it (legal name and VAT read-only), its
 *                                                          active addresses and contacts, the changes waiting for our check
 *                                                          ("Waiting for our check since 28 Oct") and our last answers
 *   POST /portal/supplier-profile/changes                  up to 20 changes of its addresses and contacts (and, since W2b
 *                                                          schema wave 23, its website), checked with the parties module's
 *                                                          rules; NOTHING changes on our side: they wait for the buyer
 *                                                          (./decide.ts). Two open requests never touch one row.
 *   POST /portal/supplier-profile/changes/:requestId/withdraw   the supplier takes an open request back
 *
 * Reading needs portal.supplierProfile.view (every supplier and workshop role), sending portal.supplierProfile.change (their
 * Admin); never an office preview. The writes run as the partner person in the office scope (the partner role writes no
 * audit row of the party's and reads none: B-W2b-162's pattern, `byPartner`): a request is a PartyChangeRequest row (W2b
 * schema wave 23; ./store.ts), inserted with the party's row locked (one open request per row), withdrawn by the row's own
 * compare-and-set. Bank details are not here (SCM-007, W2b-5); the portal users are /portal/colleagues (B-W2b-162).
 */

export const PROFILE_LIVE_EVENTS = ['supplier_profile.change_requested', 'supplier_profile.change_withdrawn', 'supplier_profile.change_decided', 'party.addresses_changed', 'party.contacts_changed'] as const
const DECIDED_SHOWN = 5

/** The party's rows now (every status: a change names the version it saw) and its website (W2b wave 23). */
export async function currentProfileOf(client: Pick<FactoryClient | CommandTx, 'party' | 'partyAddress' | 'partyContact'>, partyId: string): Promise<CurrentProfile> {
  const party = await client.party.findUnique({ where: { id: partyId }, select: { id: true, website: true } })
  const addresses = await client.partyAddress.findMany({ where: { partyId }, select: ADDRESS_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 })
  const contacts = await client.partyContact.findMany({ where: { partyId }, select: CONTACT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 })
  return {
    addresses: addresses.map((row) => ({ id: row.id, version: row.version, status: row.status, fields: addressFieldsOf(row), isDefaultBillTo: row.isDefaultBillTo, isDefaultShipTo: row.isDefaultShipTo })),
    contacts: contacts.map((row) => ({ id: row.id, version: row.version, status: row.status, fields: contactFieldsOf(row) })),
    ...(party ? { company: { id: party.id, website: party.website } } : {}),
  }
}

/** A request as the supplier and the buyer read it: each change old → new, with its sentence. */
export function requestView(request: ChangeRequest) {
  return {
    requestId: request.requestId,
    state: request.state,
    sentAt: iso(request.at)!,
    sentBy: request.personName,
    summary: request.summary,
    note: request.note,
    changes: request.changes.map((change: PlannedChange) => ({
      target: change.target,
      op: change.op,
      id: change.id,
      version: change.version,
      before: change.before as Record<string, unknown> | null,
      after: change.after as Record<string, unknown> | null,
      changed: [...change.changed] as string[],
      sentence: changeSentence(change),
    })),
    decidedAt: iso(request.decidedAt),
    decidedBy: request.decidedByName,
    reason: request.reason,
  }
}

export function mayChange(request: FastifyRequest, session: PortalSession): boolean {
  if (session.preview) return false
  return can(actorOf(requireContext(request)), PORTAL_SUPPLIER_PROFILE_CHANGE, { companyId: session.company.id, partyId: session.partyId })
}

/** GET /portal/supplier-profile. */
export async function supplierProfile(request: FastifyRequest, now: Date) {
  const session = portalSessionOf(request)
  const today = businessDate(now)
  // The party's own rows in its scope (row-level security: its own); its change requests in the system scope, filtered to it.
  const own = await request.withClient(async (client) => {
    const party = await client.party.findUnique({ where: { id: session.partyId }, select: { id: true, code: true, kind: true, legalName: true, tradeName: true, country: true, language: true, status: true } })
    if (!party) throw new NotFoundError('Party not found.')
    const identity = await client.partyTaxIdentity.findFirst({ where: { partyId: session.partyId, validFrom: { lte: new Date(`${today}T00:00:00.000Z`) } }, orderBy: { validFrom: 'desc' }, select: { country: true, vatNumber: true, fiscalCode: true } })
    return { party, identity, profile: await currentProfileOf(client, session.partyId) }
  })
  const requests = await systemCallerOf(request)(session.tenantId).withClient((client) => partyRequests(client, session.partyId))
  const pending = requests.filter((entry) => entry.state === 'OPEN' && entry.companyId === session.company.id)
  const decided = requests.filter((entry) => entry.state !== 'OPEN' && entry.companyId === session.company.id).reverse().slice(0, DECIDED_SHOWN)
  const waiting = new Set(pending.flatMap((entry) => touchedKeysOf(entry.changes)))
  return {
    company: {
      code: own.party.code,
      legalName: own.party.legalName,
      tradeName: own.party.tradeName,
      country: own.party.country,
      vatNumber: own.identity?.vatNumber ?? null,
      fiscalCode: own.identity?.fiscalCode ?? null,
      // W2b wave 23: the supplier may change its website (a COMPANY change of a request).
      website: own.profile.company?.website ?? null,
      waiting: waiting.has(`company:${session.partyId}`),
    },
    addresses: own.profile.addresses
      .filter((row) => row.status === 'ACTIVE')
      .map((row) => ({ id: row.id, version: row.version, ...row.fields, kinds: [...row.fields.kinds], isDefaultBillTo: row.isDefaultBillTo, isDefaultShipTo: row.isDefaultShipTo, waiting: waiting.has(`address:${row.id}`) })),
    contacts: own.profile.contacts
      .filter((row) => row.status === 'ACTIVE')
      .map((row) => ({ id: row.id, version: row.version, ...row.fields, roles: [...row.fields.roles], waiting: waiting.has(`contact:${row.id}`) })),
    pending: pending.map(requestView),
    decided: decided.map(requestView),
    mayChange: mayChange(request, session),
    limits: { changes: MAX_PROFILE_CHANGES, addressKinds: [...SUPPLIER_ADDRESS_KINDS], contactRoles: [...SUPPLIER_CONTACT_ROLES] },
    live: { events: [...PROFILE_LIVE_EVENTS] },
  }
}

function assertMayChange(request: FastifyRequest, session: PortalSession): void {
  if (session.preview) throw new ForbiddenError('A preview reads the portal; it never sends changes for the supplier.')
  if (!mayChange(request, session)) throw new ForbiddenError('Your access lets you read your profile, not change it: ask your admin.')
}

const asPerson = (app: FastifyInstance, request: FastifyRequest, session: PortalSession) => {
  const p = portalOf(app)
  return { p, context: p.auth.contextFor(request, session.tenantId, session.userId) }
}

/** POST /portal/supplier-profile/changes: the request, waiting for the buyer. */
export async function requestProfileChange(app: FastifyInstance, request: FastifyRequest, body: ProfileChangeInput, idempotencyKey: string | undefined) {
  const session = portalSessionOf(request)
  assertMayChange(request, session)
  const { p, context } = asPerson(app, request, session)
  const { result } = await p.auth.command(context, { name: 'supplierProfile.requestChange', idempotencyKey, input: { partyId: session.partyId, ...body } }, async (tools) => {
    const party = await lockSupplier(tools.tx, session.partyId)
    if (party.status === 'ARCHIVED') throw new InvalidStateError('We no longer work with your company: write to us.')
    const plan = planProfileChange(body, await currentProfileOf(tools.tx, session.partyId))
    if (!plan.ok) throw new ValidationError('The changes are not valid.', [...plan.issues])
    // Two open requests never touch the same address, contact or website (the party's row is locked above).
    const open = (await partyRequests(tools.tx, session.partyId)).filter((entry) => entry.state === 'OPEN')
    const busy = new Set(open.flatMap((entry) => touchedKeysOf(entry.changes)))
    const clash = touchedKeysOf(plan.changes).find((key) => busy.has(key))
    if (clash) throw new ConflictError(`You already sent a change of ${clash.startsWith('address') ? 'this address' : clash.startsWith('contact') ? 'this contact' : 'your website'}: it waits for our check. Withdraw that request first, or wait for our answer.`)
    const requestId = newId()
    const summary = changeSummary(plan.changes)
    await tools.tx.partyChangeRequest.create({
      data: {
        id: requestId,
        companyId: session.company.id,
        partyId: session.partyId,
        requestedById: session.userId,
        requestedByName: session.person.displayName,
        changes: plan.changes as unknown as Prisma.InputJsonValue,
        summary,
        note: plan.note,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: session.userId,
      },
      select: { id: true },
    })
    tools.audit({
      action: ACTIONS.request,
      recordType: 'Party',
      recordId: session.partyId,
      companyId: session.company.id,
      after: { requestId, changes: plan.changes, summary, note: plan.note, byPartner: true, personId: session.userId, personName: session.person.displayName },
    })
    const addresses = plan.changes.filter((change) => change.target === 'ADDRESS').length
    const contacts = plan.changes.filter((change) => change.target === 'CONTACT').length
    tools.emit({ type: 'supplier_profile.change_requested', subject: requestId, companyId: session.company.id, payload: { requestId, partyId: session.partyId, addresses, contacts } })
    return { requestId }
  })
  const made = await systemCallerOf(request)(session.tenantId).withClient((client) => requestById(client, result.requestId))
  if (!made || made.partyId !== session.partyId) throw new NotFoundError('Request not found.')
  return { request: requestView(made) }
}

/** POST /portal/supplier-profile/changes/:requestId/withdraw. */
export async function withdrawProfileChange(app: FastifyInstance, request: FastifyRequest, requestId: string, idempotencyKey: string | undefined) {
  const session = portalSessionOf(request)
  assertMayChange(request, session)
  if (!isUuid(requestId)) throw new NotFoundError('Request not found.')
  const { p, context } = asPerson(app, request, session)
  const stateWords = (state: string): string => (state === 'WITHDRAWN' ? 'You withdrew this request already.' : 'We answered this request already.')
  await p.auth.command(context, { name: 'supplierProfile.withdrawChange', idempotencyKey: keyFor(idempotencyKey, 'withdraw'), input: { requestId } }, async (tools) => {
    const found = await requestById(tools.tx, requestId)
    if (!found || found.partyId !== session.partyId || found.companyId !== session.company.id) throw new NotFoundError('Request not found.')
    if (found.state !== 'OPEN') throw new InvalidStateError(stateWords(found.state))
    // OPEN → WITHDRAWN once: the row's compare-and-set (the version read here, + 1); no decider (the audit row names the person).
    const moved = await tools.tx.partyChangeRequest.updateMany({ where: { id: requestId, partyId: session.partyId, status: 'OPEN', version: found.version }, data: { status: 'WITHDRAWN', decidedAt: tools.now, version: found.version + 1 } })
    if (moved.count !== 1) {
      const now = await requestById(tools.tx, requestId)
      throw now && now.state !== 'OPEN' ? new InvalidStateError(stateWords(now.state)) : new ConflictError('This request changed since you read it: read your profile again.')
    }
    tools.audit({ action: ACTIONS.withdraw, recordType: 'Party', recordId: session.partyId, companyId: session.company.id, after: { requestId, byPartner: true, personId: session.userId } })
    tools.emit({ type: 'supplier_profile.change_withdrawn', subject: requestId, companyId: session.company.id, payload: { requestId, partyId: session.partyId } })
    return { requestId }
  })
  const withdrawn = await systemCallerOf(request)(session.tenantId).withClient((client) => requestById(client, requestId))
  return { request: requestView(withdrawn!) }
}
