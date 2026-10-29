import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { documentTitle, retainedFiles, retainUntilFor, toAttach, type ShipmentDocument } from '@nexus/factory-domain/shipping/documents/documents'
import type { ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import type { CommandCaller } from '../../../core/command'
import { prepareFileCopy, recordGeneratedFile, retainFilesInCommand } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { tenantOf } from '../cells'
import { readShipment, type ShipmentHeader } from '../store'
import { documentsClock, documentsCommand, lockShipmentDocuments, readDocuments } from './read'

/**
 * Attaching a shipment's documents (B-W1-49; LOG-020; Reg. (EU) 2016/425 art. 8(8), 8(3)): every document that travels by
 * the party's link and is on file but not copied yet — the DDT's PDF, each style revision's DoC and leaflet in the
 * buyer's language (or its fallback) — is COPIED onto the shipment, shared with its party (PARTNER and LINK): a DoC
 * serves every customer of the style, so its own file stays the office's, and the copy is the evidence of what
 * travelled with these goods. Then every travelling file, the sources and the copies, is kept until ten years after
 * the goods left (now, before they leave; the attach at shipping moves it to the ship date).
 *
 *   1. outside any transaction: the documents read, and a copy prepared per file to attach (platform/files
 *      prepareFileCopy: the source's bytes checked against its SHA-256 and put under a new key, files.read + files.put)
 *   2. ONE command: the shipment's documents lock (an advisory lock per shipment: the office's attach and the ship
 *      handler's queue, and the second finds the first's copies), the documents read again, each prepared copy whose
 *      content is still missing recorded (recordGeneratedFile: AVAILABLE, audited, file.available), the retention moved
 *      (retainFilesInCommand), one audit row on the shipment and the event shipment.documents_attached
 *
 * Idempotent: a document is attached when a file with its bytes is on the shipment, shared with the party; attaching
 * again copies nothing. A prepared copy that lost a race stays in the store unnamed (never listed, never downloadable).
 * The shipment's version does not move: its row is not written.
 */

const ATTACHABLE: readonly ShipmentStatus[] = ['PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED']

/** Why the documents cannot be attached now, or null. */
export function attachStateProblem(status: ShipmentStatus): string | null {
  if (ATTACHABLE.includes(status)) return null
  return status === 'CANCELLED' ? 'The shipment is cancelled: its documents travel nowhere.' : 'The shipment is a DRAFT: its documents are attached once it is packed (its lines can still change).'
}

/** The copy's file name: the document's title (a DDT number holds a slash, which a file name may not). */
const copyName = (document: ShipmentDocument): string => `${documentTitle(document).replace(/[\\/]/g, '-')}.pdf`

/** The command found nothing to copy or keep longer: it writes nothing (and so audits nothing). */
class NothingToAttach extends Error {}

export interface AttachResult {
  readonly attached: number
  readonly retained: number
  readonly copies: readonly { readonly fileId: string; readonly sourceFileId: string; readonly kind: string }[]
}

export async function attachDocuments(
  files: FilesRuntime,
  caller: CommandCaller,
  shipment: ShipmentHeader,
  options: { readonly idempotencyKey?: string | undefined; readonly causationId?: string | undefined } = {},
): Promise<AttachResult> {
  const problem = attachStateProblem(shipment.status)
  if (problem) throw new InvalidStateError(problem)
  const before = await caller.withClient((client) => readDocuments(client, shipment))
  const retainUntil = retainUntilFor(shipment.shippedAt, documentsClock().now())
  const prepared: { document: ShipmentDocument; copy: Awaited<ReturnType<typeof prepareFileCopy>> }[] = []
  for (const document of toAttach(before.documents.documents)) {
    const copy = await prepareFileCopy(files, caller, document.source!.id, {
      companyId: shipment.companyId,
      recordType: 'Shipment',
      recordId: shipment.id,
      kind: 'DOCUMENT',
      originalName: copyName(document),
      visibility: ['PARTNER', 'LINK'],
      partyId: shipment.partyId,
      retainUntil,
    })
    prepared.push({ document, copy })
  }

  const spec = { name: 'shipping.attachDocuments' as const, idempotencyKey: options.idempotencyKey, input: { shipmentId: shipment.id }, ...(options.causationId ? { causationId: options.causationId } : {}) }
  try {
    const { result } = await documentsCommand(caller, spec, async (tools): Promise<AttachResult> => {
      await lockShipmentDocuments(tools.tx, tenantOf(tools.context), shipment.id)
      const current = await readShipment(tools.tx, shipment.id)
      if (!current) throw new InvalidStateError('The shipment is gone.')
      const stateProblem = attachStateProblem(current.status)
      if (stateProblem) throw new InvalidStateError(stateProblem)
      const { documents } = await readDocuments(tools.tx, current)
      const missing = new Set(toAttach(documents.documents).map((document) => document.source!.sha256))
      const copies: { fileId: string; sourceFileId: string; kind: string }[] = []
      for (const { document, copy } of prepared) {
        if (!missing.delete(copy.sha256)) continue
        const file = await recordGeneratedFile(tools, copy, {
          action: 'shipping.attachDocument',
          details: {
            shipmentId: current.id,
            documentKind: document.kind,
            documentId: document.documentId,
            sourceFileId: copy.sourceFileId,
            styleCode: document.style?.code ?? null,
            revision: document.style?.revision ?? null,
            language: document.language,
          },
        })
        copies.push({ fileId: file.id, sourceFileId: copy.sourceFileId, kind: document.kind })
      }
      const after = copies.length > 0 ? (await readDocuments(tools.tx, current)).documents : documents
      const until = retainUntilFor(current.shippedAt, tools.now)
      const retained = await retainFilesInCommand(tools, retainedFiles(after.documents), until, `Travelled with shipment ${current.number}: kept ten years after it left (Reg. (EU) 2016/425 art. 8(3)).`)
      if (copies.length === 0 && retained.length === 0) throw new NothingToAttach()
      tools.audit({
        recordType: 'Shipment',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        after: { attached: copies.length, copies, retained: retained.length, retainUntil: toUtcIso(until), missing: after.counts.missing },
      })
      if (copies.length > 0) {
        tools.emit({
          type: 'shipment.documents_attached',
          subject: current.id,
          companyId: current.companyId,
          siteId: current.siteId,
          payload: { shipmentId: current.id, number: current.number, attached: copies.length, missing: after.counts.missing },
        })
      }
      return { attached: copies.length, retained: retained.length, copies }
    })
    return result
  } catch (error) {
    // Everything was attached and kept already: nothing written, nothing audited.
    if (error instanceof NothingToAttach) return { attached: 0, retained: 0, copies: [] }
    throw error
  }
}
