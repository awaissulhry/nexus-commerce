import type { FastifyRequest } from 'fastify'
import { SHIPPING_MANAGE } from '@nexus/factory-domain/shipping/permissions'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { officeContextOf } from '../access'
import { officeShipment } from '../shipments/shipments'
import { getNotice, sendNotice } from './notices'

/** POST /shipping/shipments/:shipmentId/notice — Send again (shipping.manage): the notice by hand to the customer's orders contacts. */
export async function sendNoticeFromOffice(request: FastifyRequest, shipmentId: string, body: { readonly contactIds?: readonly string[] | undefined }, idempotencyKey: string | undefined) {
  const context = officeContextOf(request)
  const auth = officeAuthOf(request.server)
  const shipment = await officeShipment(request, shipmentId, SHIPPING_MANAGE)
  const user = await request.withClient((client) => client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } }))
  const outcome = await sendNotice({
    caller: request,
    delivery: systemCallerOf(request)(context.tenantId),
    email: processEmail(),
    clock: auth.clock,
    shipmentId: shipment.id,
    automatic: false,
    contactIds: body.contactIds,
    sender: user ? { userId: context.actorId, name: user.displayName, email: user.email } : null,
    idempotencyKey,
  })
  return { sent: outcome.sent, failed: outcome.failed, skipped: [...outcome.skipped], notice: await getNotice(request, shipment.id) }
}
