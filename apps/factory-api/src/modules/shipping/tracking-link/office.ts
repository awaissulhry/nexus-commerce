import type { FastifyRequest } from 'fastify'
import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { makeHeld, MAKE_HELD_WORDS, TRACKING_NOTES, trackingEndsAt, viaOfNote } from '@nexus/factory-domain/shipping/tracking-link/rules'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { command, type CommandCaller } from '../../../core/command'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { emailOrThrow } from '../../../platform/auth/users/email'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { mayOn, officeContextOf } from '../access'
import { officeShipment } from '../shipments/shipments'
import type { ShipmentHeader } from '../store'
import { makeTrackingLinks, type Recipient } from './make'

/**
 * The office's side of the tracking page (B-W2b-170; design warehouse.shipments page.conn "the tracking link
 * (links.tracking)"; the shipment record's Tracking & delivery tab). The shipment is checked with can() on its company,
 * site and party (shipping.view to see it, else 404; the route's permission, else 403):
 *
 *   read     who the link goes to by default (the customer's ACTIVE ORDERS contacts with an address), the links made
 *            (to whom, how, until when, last opened, withdrawn; never a token), the public search's one-day links as a
 *            count, and why no link can be made now
 *   make     (shipping.manage) mail it to the default contacts, some contacts or one address; or one link to pass on, its
 *            address in this answer only
 *   revoke   (shipping.manage) a tracking link of this shipment opens nothing from now on
 */

const LINK_SELECT = { id: true, email: true, note: true, expiresAt: true, maxUses: true, uses: true, lastUsedAt: true, revokedAt: true, createdAt: true, createdById: true } as const

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

/** The customer's ACTIVE ORDERS contacts with an address, one per address, by name. */
export async function recipientsOf(caller: CommandCaller, partyId: string) {
  const contacts = await caller.withClient((client) =>
    client.partyContact.findMany({ where: { partyId, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { id: true, name: true, email: true, language: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
  )
  const seen = new Set<string>()
  return contacts.flatMap((contact) => {
    const email = contact.email!.trim().toLowerCase()
    if (email === '' || seen.has(email)) return []
    seen.add(email)
    return [{ contactId: contact.id, name: contact.name, email, language: contact.language }]
  })
}

export async function trackingLinksView(caller: CommandCaller, shipment: ShipmentHeader, now: Date) {
  const context = officeContextOf(caller)
  const recipients = await recipientsOf(caller, shipment.partyId)
  const rows = await caller.withClient((client) =>
    client.oneOffLink.findMany({ where: { recordType: 'Shipment', recordId: shipment.id, purpose: 'SHIPMENT_TRACK' }, select: LINK_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 }),
  )
  const searches = rows.filter((row) => row.note === TRACKING_NOTES.SEARCH)
  return {
    shipment: { id: shipment.id, number: shipment.number, status: shipment.status, partyId: shipment.partyId },
    recipients: recipients.map(({ contactId, name, email }) => ({ contactId, name, email })),
    links: rows
      .filter((row) => row.note !== TRACKING_NOTES.SEARCH)
      .map((row) => {
        const endsAt = trackingEndsAt(row.expiresAt, shipment)
        const state = linkState(row, now)
        return {
          id: row.id,
          email: row.email,
          via: viaOfNote(row.note),
          state: state === 'LIVE' && endsAt.getTime() <= now.getTime() ? ('ENDED' as const) : state,
          createdAt: toUtcIso(row.createdAt),
          endsAt: toUtcIso(endsAt),
          lastOpenedAt: iso(row.lastUsedAt),
          revokedAt: iso(row.revokedAt),
          automatic: row.createdById === SYSTEM_ACTOR_ID,
        }
      }),
    searches: { count: searches.length, lastAt: searches[0] ? toUtcIso(searches[0].createdAt) : null },
    held: makeHeld(shipment, now),
    mayManage: mayOn(context, SHIPPING_MANAGE, shipment),
  }
}

export async function getTrackingLinks(request: FastifyRequest, shipmentId: string) {
  const shipment = await officeShipment(request, shipmentId, SHIPPING_VIEW)
  return { tracking: await trackingLinksView(request, shipment, officeAuthOf(request.server).clock.now()) }
}

export interface MakeBody {
  readonly send: boolean
  readonly contactIds?: readonly string[] | undefined
  readonly email?: string | undefined
  readonly language?: 'it' | 'en' | undefined
}

/** POST /shipping/shipments/:shipmentId/tracking-links */
export async function makeFromOffice(request: FastifyRequest, shipmentId: string, body: MakeBody, idempotencyKey: string | undefined) {
  const context = officeContextOf(request)
  const auth = officeAuthOf(request.server)
  const shipment = await officeShipment(request, shipmentId, SHIPPING_MANAGE)
  const held = makeHeld(shipment, auth.clock.now())
  if (held) throw new InvalidStateError(MAKE_HELD_WORDS[held])
  let to: Recipient[] = []
  if (body.send) {
    const recipients = await recipientsOf(request, shipment.partyId)
    if (body.email !== undefined) {
      const email = emailOrThrow(body.email, 'body/email')
      const contact = await request.withClient((client) => client.partyContact.findFirst({ where: { partyId: shipment.partyId, status: 'ACTIVE', email: { equals: email, mode: 'insensitive' } }, select: { id: true, language: true } }))
      to = [{ email, contactId: contact?.id ?? null, language: contact?.language ?? null }]
    } else if (body.contactIds) {
      const contacts = await request.withClient((client) => client.partyContact.findMany({ where: { id: { in: [...body.contactIds!] }, partyId: shipment.partyId }, select: { id: true, name: true, email: true, status: true, language: true } }))
      const issues = body.contactIds.flatMap((contactId, index) => {
        const contact = contacts.find((entry) => entry.id === contactId)
        if (!contact) return [{ path: `body/contactIds/${index}`, message: "Not a contact of the shipment's customer." }]
        if (contact.status !== 'ACTIVE') return [{ path: `body/contactIds/${index}`, message: `${contact.name} is not an active contact.` }]
        if (!contact.email) return [{ path: `body/contactIds/${index}`, message: `${contact.name} has no e-mail address.` }]
        return []
      })
      if (issues.length > 0) throw new ValidationError('The link cannot go to these contacts.', issues)
      const seen = new Set<string>()
      to = contacts.flatMap((contact) => {
        const email = contact.email!.trim().toLowerCase()
        if (seen.has(email)) return []
        seen.add(email)
        return [{ email, contactId: contact.id, language: contact.language }]
      })
    } else {
      to = recipients.map(({ email, contactId, language }) => ({ email, contactId, language }))
      if (to.length === 0) {
        throw new InvalidStateError('Nobody of the customer can receive the link: give the customer an active orders contact with an e-mail address, or pick an address, or take a link to pass on.')
      }
    }
  }
  const user = await request.withClient((client) => client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } }))
  const made = await makeTrackingLinks({
    caller: request,
    delivery: systemCallerOf(request)(context.tenantId),
    email: processEmail(),
    clock: auth.clock,
    linkUrl: (token) => auth.link('/l', token),
    shipment,
    via: 'OFFICE',
    to,
    language: body.language,
    sender: user ? { userId: context.actorId, name: user.displayName, email: user.email } : null,
    createdById: context.actorId,
    idempotencyKey,
  })
  if (made.links.length === 0 && made.skipped.length > 0) {
    throw new InvalidStateError("Every address bounced or complained (it is suppressed): correct it, then send the link.")
  }
  return { links: [...made.links], skipped: [...made.skipped], url: made.url, tracking: await trackingLinksView(request, shipment, auth.clock.now()) }
}

/** POST /shipping/shipments/:shipmentId/tracking-links/:linkId/revoke */
export async function revokeFromOffice(request: FastifyRequest, shipmentId: string, linkId: string, idempotencyKey: string | undefined) {
  const context = officeContextOf(request)
  const auth = officeAuthOf(request.server)
  const shipment = await officeShipment(request, shipmentId, SHIPPING_MANAGE)
  await command(request, { name: 'shipping.revokeTrackingLink', idempotencyKey, input: { shipmentId, linkId } }, async ({ tx, now, audit }) => {
    const link = await tx.oneOffLink.findFirst({ where: { id: linkId, recordType: 'Shipment', recordId: shipment.id, purpose: 'SHIPMENT_TRACK' }, select: { id: true, revokedAt: true } })
    if (!link) throw new ValidationError('Not a tracking link of this shipment.', [{ path: 'params/linkId', message: 'Not a tracking link of this shipment.' }])
    if (link.revokedAt !== null) return { linkId, revoked: false }
    await tx.oneOffLink.updateMany({ where: { id: link.id, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId } })
    audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: link.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { revokedAt: toUtcIso(now) }, reason: 'Withdrawn on the shipment.' })
    return { linkId, revoked: true }
  })
  return { tracking: await trackingLinksView(request, shipment, auth.clock.now()) }
}
