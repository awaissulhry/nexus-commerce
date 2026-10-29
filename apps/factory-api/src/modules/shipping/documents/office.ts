import type { FastifyRequest } from 'fastify'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller } from '../../../core/command'
import { systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import type { EmailRuntime } from '../../../platform/email-out/service'
import { officeContextOf } from '../access'
import { officeShipment } from '../shipments/shipments'
import { attachDocuments } from './attach'
import { sendDocumentLinks } from './link'
import { documentsClock, documentsView } from './read'

/**
 * The office's routes on a shipment's documents (B-W1-49; A2 SCR-067 Documents tab "Declaration of Conformity and user
 * information"): the shipment is checked with can() on its company, site and party (shipping.view to see it, else 404;
 * the route's permission, else 403), then:
 *
 *   read     the documents with their states, the shipping checks and warnings, who the link goes to, the links made
 *   attach   (shipping.manage) copies what travels onto the shipment for its party (attach.ts)
 *   link     (shipping.manage) attaches first, then mails a link per address (link.ts); a second send is the "resend":
 *            a new link that replaces the address's older live one
 */

const viewOf = (caller: CommandCaller, shipmentId: string) =>
  officeShipment(caller, shipmentId, SHIPPING_VIEW).then((shipment) => caller.withClient((client) => documentsView(client, shipment, documentsClock().now())))

export async function getDocuments(caller: CommandCaller, shipmentId: string) {
  return { documents: await viewOf(caller, shipmentId) }
}

export async function attachFromOffice(files: FilesRuntime, caller: CommandCaller, shipmentId: string, idempotencyKey: string | undefined) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const result = await attachDocuments(files, caller, shipment, { idempotencyKey })
  return { attached: result.attached, retained: result.retained, documents: await viewOf(caller, shipmentId) }
}

export interface SendBody {
  readonly contactIds?: readonly string[] | undefined
  readonly expiresInDays?: number | undefined
}

export async function sendFromOffice(files: FilesRuntime, email: EmailRuntime, request: FastifyRequest, shipmentId: string, body: SendBody, idempotencyKey: string | undefined) {
  const context = officeContextOf(request)
  const shipment = await officeShipment(request, shipmentId, SHIPPING_MANAGE)
  const attached = await attachDocuments(files, request, shipment)
  const user = await request.withClient((client) => client.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } }))
  const sent = await sendDocumentLinks({
    email,
    caller: request,
    delivery: systemCallerOf(request)(context.tenantId),
    shipment,
    reason: 'OFFICE',
    to: body.contactIds ? { kind: 'contacts', contactIds: body.contactIds } : { kind: 'default' },
    expiresInDays: body.expiresInDays,
    sender: user ? { userId: context.actorId, name: user.displayName, email: user.email } : null,
    idempotencyKey,
  })
  return { links: [...sent.links], skipped: [...sent.skipped], attached: attached.attached, documents: await viewOf(request, shipmentId) }
}

