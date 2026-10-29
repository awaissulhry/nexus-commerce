import type { FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkDocuments } from '@nexus/factory-domain/shipping/documents/documents'
import { downloadFile, getFile, systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { readShipment } from '../store'
import { documentsCommand, readDocuments, sharedFilesOf } from './read'

/**
 * A party's link session on its shipment's documents (B-W1-49; A2 SCR-101; SAL-099, PLT-007). The link authenticator has
 * opened a live DOCUMENT_VIEW link of ONE Shipment of ONE party; any other link is the one 404 of every link that opens
 * nothing. Reading never uses the link (only POST /link/open counts an open).
 *
 *   list       in the link's OWN scope (the partner role: its party's wall), the shipment and its files shared with the
 *              party's links: exactly what the link lists. Then, in the tenant's system scope, what each of them is (the
 *              office's documents, matched by SHA-256): DDT, DoC, leaflet, or OTHER. A carrier label (a Parcel's file),
 *              the packing list and every office file are never shared with the party, so never listed.
 *   download   one of those files only: an audit row (who: the link; what: the file), then platform/files' own download
 *              (the link's files.read, its audience rule: shared with its party's links, of its record), presigned 60 s.
 */

function shipmentLinkOf(request: FastifyRequest): LinkSession {
  const link = linkSessionOf(request)
  if (link.purpose !== 'DOCUMENT_VIEW' || link.record.type !== 'Shipment') throw linkUnavailable()
  return link
}

/** The link's shipment and its shared files, read in the link's own scope; null when its wall hides the shipment. */
async function seenByLink(request: FastifyRequest, link: LinkSession) {
  return request.withClient(async (client) => {
    const shipment = await client.shipment.findUnique({ where: { id: link.record.id }, select: { id: true, number: true, status: true, shippedAt: true, deliveredAt: true } })
    if (!shipment) return null
    return { shipment, shared: await sharedFilesOf(client, { id: shipment.id, partyId: link.partyId }) }
  })
}

/** GET /shipping/link/documents: the shipment's documents the link shows. */
export async function linkDocumentsOf(request: FastifyRequest) {
  const link = shipmentLinkOf(request)
  const seen = await seenByLink(request, link)
  if (!seen) throw linkUnavailable()
  const system = systemCallerOf(request)(link.tenantId)
  const documents = await system.withClient(async (client) => {
    const shipment = await readShipment(client, link.record.id)
    return shipment ? (await readDocuments(client, shipment)).documents.documents : []
  })
  return {
    shipment: {
      number: seen.shipment.number,
      status: seen.shipment.status,
      shippedAt: seen.shipment.shippedAt ? toUtcIso(seen.shipment.shippedAt) : null,
      deliveredAt: seen.shipment.deliveredAt ? toUtcIso(seen.shipment.deliveredAt) : null,
    },
    link: { expiresAt: toUtcIso(link.expiresAt), usesLeft: Math.max(0, link.maxUses - link.uses) },
    documents: linkDocuments(seen.shared, documents).map((entry) => ({ ...entry, style: entry.style ? { ...entry.style } : null })),
  }
}

/** POST /shipping/link/documents/:fileId/download: one of the link's files, logged, then presigned (60 s). */
export async function downloadLinkDocument(files: FilesRuntime, request: FastifyRequest, fileId: string, idempotencyKey: string | undefined) {
  const link = shipmentLinkOf(request)
  const seen = await seenByLink(request, link)
  if (!seen) throw linkUnavailable()
  if (!seen.shared.some((file) => file.id === fileId)) throw new NotFoundError('File not found.')
  await documentsCommand(request, { name: 'shipping.downloadDocument', idempotencyKey, input: { fileId } }, async (tools) => {
    tools.audit({ recordType: 'StoredFile', recordId: fileId, companyId: link.companyId, after: { linkId: link.id, shipmentId: link.record.id } })
    return { fileId }
  })
  const callers = { caller: request, system: systemCallerOf(request) }
  return { file: await getFile(request, fileId), download: await downloadFile(files, callers, fileId) }
}
