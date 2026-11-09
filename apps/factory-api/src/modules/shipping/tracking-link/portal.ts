import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ForbiddenError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { SHOWN_SHIPMENT_STATUSES } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { makeHeld, MAKE_HELD_WORDS } from '@nexus/factory-domain/shipping/tracking-link/rules'
import type { CommandCaller } from '../../../core/command'
import { portalOf } from '../../../platform/auth/portal/service'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { partnerOrder, portalReader } from '../../sales/portal-orders/access'
import { readShipment } from '../store'
import { makeTrackingLinks } from './make'

/**
 * "Copy tracking link" in the portal (B-W2b-170; design portal.customer.orders › Shipments: "copies the branded tracking
 * page (links.tracking) to share with a store"): POST /portal/sales-orders/:orderId/shipments/:shipmentId/tracking-link
 * (partner, portal.salesOrders.view, the party's scope). The order is the party's in the portal's company (read in the
 * partner scope, else 404); the shipment is one of that order the customer sees (packed, on the way, delivered, back);
 * an office preview changes nothing (403). ONE command as the person in the tenant's office scope (the partner role makes
 * no link): a tracking link to pass on, at most ten live per shipment; its address is in this answer only.
 */

/** A view of the request in another context (the person in the tenant's office scope): `withClient` and command() follow it. */
function asCaller(request: FastifyRequest, context: NonNullable<FastifyRequest['factoryContext']>): CommandCaller {
  const view = Object.create(request) as FastifyRequest
  view.factoryContext = context
  return view
}

export async function copyFromPortal(app: FastifyInstance, request: FastifyRequest, orderId: string, shipmentId: string, idempotencyKey: string | undefined) {
  const reader = portalReader(app, request)
  const { session } = reader
  if (session.preview) throw new ForbiddenError('A preview of the portal changes nothing.')
  const order = await partnerOrder(request, reader, orderId)
  const shipment = await reader.inTenant((client) => readShipment(client, shipmentId))
  if (!shipment || shipment.salesOrderId !== order.id || shipment.partyId !== session.partyId || shipment.companyId !== session.company.id || !SHOWN_SHIPMENT_STATUSES.includes(shipment.status)) {
    throw new NotFoundError('Shipment not found.')
  }
  const auth = officeAuthOf(app)
  const held = makeHeld(shipment, auth.clock.now())
  if (held) throw new InvalidStateError(MAKE_HELD_WORDS[held])
  const person = asCaller(request, portalOf(app).auth.contextFor(request, session.tenantId, session.userId))
  const made = await makeTrackingLinks({
    caller: person,
    delivery: systemCallerOf(request)(session.tenantId),
    email: processEmail(),
    clock: auth.clock,
    linkUrl: (token) => auth.link('/l', token),
    shipment,
    via: 'PORTAL',
    to: [],
    sender: null,
    createdById: session.userId,
    idempotencyKey,
  })
  const link = made.links[0]
  if (!link) throw new InvalidStateError('No tracking link was made: try again.')
  return { link: { id: link.id, expiresAt: link.expiresAt }, url: made.url }
}
