import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import { isDocumentLanguage, type DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { QUALITY_DOCUMENTS_MAKE } from '@nexus/factory-domain/quality/inspection-docs/permissions'
import { certificateFingerprintText, certificateProblems, conformityCertificate, type CellCover, type CertificateInput, type CertificateLine } from '@nexus/factory-domain/quality/inspection-docs/documents'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import type { FilesRuntime } from '../../../platform/files/service'
import { readDocuments } from '../../shipping/documents/read'
import { officeShipment } from '../../shipping/shipments/shipments'
import type { ShipmentHeader } from '../../shipping/store'
import { officeContextOf } from '../../shipping/access'
import { namesOf } from '../amendments/records'
import { shippedOfCell, type Reader } from '../final/store'
import { renderQualityDocument } from './pdf'
import { keepVersionInCommand, keptVersionView, prepareVersion, type DocumentRecord } from './versions'

/**
 * The certificate of conformity of a shipment (B-W2b-123; QHS-059 "a customer ask, not law"): our statement that the
 * garments of the shipment were made to the order and the style, passed final inspection and were released, with each
 * cell's work order, final inspections and releases, and the EU declarations of conformity of its PPE styles. A
 * GeneratedDocument CERTIFICATE_OF_CONFORMITY of the Shipment. Office only; shipping.view over the shipment to read it,
 * quality.documents.make to keep a version (who keeps it issues it: their name is on it).
 *
 *   GET  /quality/shipments/:shipmentId/certificate?language=     the PDF with the "preview" banner, made in memory
 *   GET  /quality/shipments/:shipmentId/certificates              the versions kept, where they are shared, what holds one
 *   POST /quality/shipments/:shipmentId/certificates {language?}  keeps a version (./versions.ts): same contents → the newest
 *
 * It is made of a PACKED, SHIPPED or DELIVERED shipment with garments, every garment of whose cells on shipments stands
 * released (releases less reversals): never of goods whose release was reversed (refused in words, 409). No price, cost or
 * pay figure. The language: asked, else the order's (Italian or English), else the customer's, else Italian. The
 * company's letterhead must be complete (c.c. art. 2250).
 */

export const CERTIFICATE_KIND = 'CERTIFICATE_OF_CONFORMITY' as const

const refused = (issues: readonly Issue[], message: string) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : message, [...issues])

export const certificateRecordOf = (shipment: ShipmentHeader): DocumentRecord => ({ recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, number: shipment.number })

async function languageOf(db: Reader, shipment: ShipmentHeader, asked: DocumentLanguage | undefined): Promise<DocumentLanguage> {
  if (asked) return asked
  const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { language: true } })
  if (isDocumentLanguage(order?.language)) return order.language
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { language: true } })
  return isDocumentLanguage(party?.language) ? party.language : 'it'
}

/** The shipment's cells with what they hold here and on every shipment, what stands released, and the inspections and releases behind them. */
export async function certificateFacts(db: Reader, shipment: ShipmentHeader) {
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: shipment.id }, select: { workOrderId: true, workOrderSizeId: true, quantity: true } })
  const cellIds = [...new Set(lines.map((line) => line.workOrderSizeId))]
  const cells = cellIds.length === 0 ? [] : await db.workOrderSize.findMany({ where: { id: { in: cellIds } }, select: { id: true, size: true, workOrderId: true, colourwayId: true } })
  const colourways = new Map((cells.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.colourwayId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const orders = new Map((cells.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.workOrderId))] } }, select: { id: true, number: true, batchNumber: true, styleId: true, styleRevisionId: true } })).map((row) => [row.id, row]))
  const styles = new Map((orders.size === 0 ? [] : await db.style.findMany({ where: { id: { in: [...new Set([...orders.values()].map((order) => order.styleId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const revisionIds = [...new Set([...orders.values()].flatMap((order) => (order.styleRevisionId ? [order.styleRevisionId] : [])))]
  const revisions = new Map((revisionIds.length === 0 ? [] : await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision]))
  const releases = cellIds.length === 0 ? [] : await db.qualityRelease.findMany({ where: { workOrderSizeId: { in: cellIds } }, select: { id: true, number: true, workOrderSizeId: true, inspectionId: true, quantity: true }, orderBy: [{ releasedAt: 'asc' }, { id: 'asc' }] })
  const reversals = releases.length === 0 ? [] : await db.qualityReleaseReversal.findMany({ where: { releaseId: { in: releases.map((release) => release.id) } }, select: { releaseId: true, quantity: true } })
  const inspections = new Map((releases.length === 0 ? [] : await db.inspection.findMany({ where: { id: { in: [...new Set(releases.map((release) => release.inspectionId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
  const standing = (releaseId: string, quantity: number) => quantity - reversals.filter((reversal) => reversal.releaseId === releaseId).reduce((sum, reversal) => sum + reversal.quantity, 0)

  const certified: CertificateLine[] = []
  const covers: CellCover[] = []
  for (const cell of [...cells].sort((a, b) => (orders.get(a.workOrderId)?.number ?? '').localeCompare(orders.get(b.workOrderId)?.number ?? '') || a.size.localeCompare(b.size, undefined, { numeric: true }))) {
    const order = orders.get(cell.workOrderId)!
    const style = styles.get(order.styleId)
    const colourway = colourways.get(cell.colourwayId)
    const live = releases.filter((release) => release.workOrderSizeId === cell.id && standing(release.id, release.quantity) > 0)
    const label = `${style?.code ?? '-'} ${colourway?.code ?? ''} ${cell.size} (${order.number})`.replace(/\s+/g, ' ')
    const onShipment = lines.filter((line) => line.workOrderSizeId === cell.id).reduce((sum, line) => sum + line.quantity, 0)
    const shipped = await shippedOfCell(db, cell.id)
    covers.push({ label, onShipment, onShipments: shipped.packed + shipped.shipped, released: live.reduce((sum, release) => sum + standing(release.id, release.quantity), 0) })
    certified.push({
      style: { code: style?.code ?? '-', name: style?.name ?? '-', revision: order.styleRevisionId ? (revisions.get(order.styleRevisionId) ?? null) : null },
      colourway: colourway ? `${colourway.code} ${colourway.name}` : '-',
      size: cell.size,
      garments: onShipment,
      workOrder: order.number,
      batchNumber: order.batchNumber,
      inspections: [...new Set(live.map((release) => inspections.get(release.inspectionId) ?? '-'))],
      releases: live.map((release) => release.number ?? '-'),
    })
  }
  return { lines: certified, covers, problems: certificateProblems({ status: shipment.status, lines: lines.length, cells: covers }) }
}

/** The certificate composed and its PDF painter (refused in words when it cannot be issued now). */
async function composeCertificate(caller: CommandCaller, shipmentId: string, options: { readonly language?: DocumentLanguage | undefined; readonly sample: boolean; readonly issuerId: string | null }) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  const legal = await companyLegalOf(caller, shipment.companyId)
  const problems = legalProblems(legal)
  if (problems.length > 0) throw refused(problems, 'The certificate of conformity cannot be made as the company stands.')
  const { language, input } = await caller.withClient(async (db) => {
    const facts = await certificateFacts(db, shipment)
    if (facts.problems.length > 0) throw refused(facts.problems.map((message) => ({ path: 'held/NOT_CERTIFIABLE', message })), 'This shipment cannot have a certificate of conformity now.')
    const language = await languageOf(db, shipment, options.language)
    const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true } })
    const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, customerRef: true } })
    const ddt = await db.ddt.findFirst({ where: { shipmentId: shipment.id, cancellations: { none: {} } }, select: { number: true, documentDate: true }, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }] })
    const declarations = (await readDocuments(db, shipment)).documents.documents
      // Every PPE style's DoC: its number and language, or (number null) "not on file", never left out in silence.
      .filter((document) => document.kind === 'DECLARATION_OF_CONFORMITY' && document.state !== 'NOT_REQUIRED' && document.style !== null)
      .map((document) => ({ style: `${document.style!.code}${document.style!.revision === null ? '' : ` rev. ${document.style!.revision}`}`, number: document.source ? (document.number ?? document.source.originalName) : null, language: document.language ?? '-' }))
    const issuer = options.issuerId ? ((await namesOf(db, [options.issuerId])).get(options.issuerId) ?? null) : null
    const input: CertificateInput = {
      language,
      date: businessDate(serverClock.now()),
      company: { name: legalName(legal, language), lines: legalLines(legal, language), legal: legalFooter(legal, language) },
      shipment: { number: shipment.number, shippedOn: shipment.shippedAt ? businessDate(shipment.shippedAt) : null },
      customer: { name: party?.legalName ?? '-', vatNumber: null },
      order: order ? { number: order.number, customerRef: order.customerRef } : null,
      ddt: ddt ? { number: ddt.number, date: ddt.documentDate.toISOString().slice(0, 10) } : null,
      lines: facts.lines,
      declarations,
      issuer,
      sample: options.sample,
    }
    return { language, input }
  })
  const document = conformityCertificate(input)
  return { shipment, language, document, render: () => renderQualityDocument(document) }
}

/** GET …/certificate: the PDF as it would be kept, with the preview banner. */
export async function previewCertificate(caller: CommandCaller, shipmentId: string, query: { readonly language?: DocumentLanguage | undefined }) {
  officeContextOf(caller)
  const composed = await composeCertificate(caller, shipmentId, { language: query.language, sample: true, issuerId: null })
  return { pdf: await composed.render(), fileName: composed.document.fileName }
}

/** POST …/certificates: keeps a version in the name of who keeps it (see the file's comment). */
export async function makeCertificate(files: FilesRuntime, caller: CommandCaller, shipmentId: string, body: { readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  await officeShipment(caller, shipmentId, QUALITY_DOCUMENTS_MAKE)
  const composed = await composeCertificate(caller, shipmentId, { language: body.language, sample: false, issuerId: context.actorId })
  const record = certificateRecordOf(composed.shipment)
  const prepared = await prepareVersion(files, caller, record, CERTIFICATE_KIND, { fingerprintText: certificateFingerprintText(composed.document), language: composed.language, fileName: composed.document.fileName, render: composed.render })
  const kept = prepared.current
    ? { ...prepared.current, made: false }
    : (
        await command(caller, { name: 'quality.keepConformityCertificate', idempotencyKey, input: { shipmentId, ...body } }, async (tools) => {
          const version = await keepVersionInCommand(tools, record, CERTIFICATE_KIND, prepared)
          if (version.made) tools.emit({ type: 'conformity_certificate.made', subject: shipmentId, companyId: record.companyId, siteId: record.siteId, payload: { shipmentId, number: record.number, documentId: version.id, version: version.version, language: prepared.language } })
          return version
        })
      ).result
  return { certificate: await keptVersionView(caller, record, CERTIFICATE_KIND, kept.id), made: kept.made }
}
