import type { FastifyRequest } from 'fastify'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { matchesLinkHash, parseLinkToken } from '@nexus/factory-domain/links/token'
import { makeHeld, TRACKING_LINK, TRACKING_NOTES, trackingEndsAt } from '@nexus/factory-domain/shipping/tracking-link/rules'
import { SYSTEM_ACTOR_ID, type RequestContext } from '../../../core/context'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { systemContext } from '../../../platform/outbox/system'
import { readShipment } from '../store'
import { makeTrackingLinks } from './make'

/**
 * "Ask for a new link" on a dead tracking link (B-W2b-170; B-W2b-163's public POST /link/renew dispatches here through
 * registerLinkRenewer('SHIPMENT_TRACK', 'Shipment')), after the one answer. Every refusal is silent and logged by its code:
 * a new link is mailed only to the address the dead one went to, only while it is an ACTIVE contact of the customer, only
 * for a link that expired or whose page ended (never a withdrawn one, never one found by the public search, never one with
 * no address), only while a link can still be made for the shipment, not twice in ten minutes.
 */

function asContext(request: FastifyRequest, context: RequestContext): FastifyRequest {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

export async function renewTrackingLink(email: EmailRuntime, request: FastifyRequest, header: unknown): Promise<string> {
  const token = parseLinkToken(typeof header === 'string' ? header.trim() : undefined)
  if (!token) return 'NOT_A_TOKEN'
  const auth = officeAuthOf(request.server)
  const now = auth.clock.now()
  const system = asContext(request, systemContext(token.tenantId, String(request.id)))
  const found = await system.withClient(async (client) => {
    const link = await client.oneOffLink.findUnique({
      where: { id: token.linkId },
      select: { id: true, partyId: true, purpose: true, recordType: true, recordId: true, tokenHash: true, email: true, note: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true },
    })
    if (!link || link.partyId !== token.partyId || !matchesLinkHash(token, link.tokenHash) || link.purpose !== 'SHIPMENT_TRACK' || link.recordType !== 'Shipment') return null
    const shipment = await readShipment(client, link.recordId)
    const contact = link.email ? await client.partyContact.findFirst({ where: { partyId: link.partyId, status: 'ACTIVE', email: { equals: link.email, mode: 'insensitive' } }, select: { id: true, language: true } }) : null
    const recent = link.email ? await client.oneOffLink.count({ where: { recordType: 'Shipment', recordId: link.recordId, purpose: 'SHIPMENT_TRACK', email: link.email, createdAt: { gt: new Date(now.getTime() - TRACKING_LINK.renewCoalesceMs) } } }) : 0
    return { link, shipment, contact, recent }
  })
  if (!found) return 'UNKNOWN'
  const { link, shipment, contact } = found
  if (link.revokedAt !== null) return 'WITHDRAWN'
  if (link.note === TRACKING_NOTES.SEARCH || !link.email) return 'NO_ADDRESS'
  if (!shipment || shipment.partyId !== link.partyId) return 'SHIPMENT_GONE'
  const live = linkState(link, now) === 'LIVE' && trackingEndsAt(link.expiresAt, shipment).getTime() > now.getTime()
  if (live) return 'STILL_LIVE'
  if (makeHeld(shipment, now)) return 'ENDED'
  if (!contact) return 'ADDRESS_NOT_ON_FILE'
  if (found.recent > 0) return 'ASKED_RECENTLY'
  try {
    const made = await makeTrackingLinks({
      caller: system,
      delivery: system,
      email,
      clock: auth.clock,
      linkUrl: (value) => auth.link('/l', value),
      shipment,
      via: 'RENEWED',
      to: [{ email: link.email.trim().toLowerCase(), contactId: contact.id, language: contact.language }],
      sender: null,
      createdById: SYSTEM_ACTOR_ID,
      renewalOfId: link.id,
    })
    return made.links.length > 0 ? 'SENT' : 'ASKED_RECENTLY'
  } catch (error) {
    if (error instanceof InvalidStateError) return 'ENDED'
    throw error
  }
}
