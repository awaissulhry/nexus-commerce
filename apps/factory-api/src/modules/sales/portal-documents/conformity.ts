import type { FastifyInstance, FastifyRequest } from 'fastify'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { classificationOf } from '@nexus/factory-domain/product/compliance/rules'
import { certificateFor, certificateValidOn, RECEIVED_WORDS, receivedStateOf, type CertificateFacts } from '@nexus/factory-domain/sales/portal-documents/conformity'
import { fingerprintOf, matchesSearch, type PortalDocumentKind } from '@nexus/factory-domain/sales/portal-documents/library'
import { styleFactsOf } from '../../product/compliance/read'
// B-W2b-166: the public DoC's address of a style and of each batch received (what a store or a retailer links to).
import { publicDocAddress, publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { processEmail } from '../../../platform/email-out/service'
import { readLibrary, visibleEntries, type LibraryEntry } from './library'
import { coveringCertificates, frozenRevisions, readCertificates, readOrderLines, readOrders, readShipmentLines, readShipmentsThatLeft, readStyles, type CertificateRow } from './store'

/**
 * Conformity per style received (B-W2b-178; SAL-087, QHS-111; design portal.customer.documents "Conformity per style you
 * received"): for each style the customer received, per shipment that left, what travelled with it — the EU declaration
 * of conformity and the user information of the style revision the work orders froze (the copies on the shipment, B-W1-49)
 * — the EU type-examination certificate valid on the shipping date (the one the declaration cites, else one covering the
 * style: notified body, number, standard, class, validity; its PDF is the office's, not shared), and the shipment's quality
 * documents shared with the customer (certificate of conformity, inspection and test reports, B-W2b-123).
 *
 * Read: the party's shipments that left, their lines and order lines in the party's scope; the work orders' frozen
 * revisions, the styles' PPE facts and the certificates in the tenant's scope as the person, for exactly those.
 */

const SHIPMENT_QUALITY_KINDS: readonly PortalDocumentKind[] = ['CERTIFICATE_OF_CONFORMITY', 'INSPECTION_REPORT', 'TEST_REPORT']

const ref = (entry: LibraryEntry) => ({ id: entry.id, kind: entry.kind, title: entry.title, version: entry.version, language: entry.language, fingerprint: fingerprintOf(entry.sha256), new: entry.isNew })

const certificateFacts = (row: CertificateRow): CertificateFacts => ({
  id: row.id,
  number: row.number,
  standard: row.standard,
  ppeClass: row.ppeClass,
  notifiedBodyName: row.notifiedBodyName,
  notifiedBodyNumber: row.notifiedBodyNumber,
  validFrom: row.validFrom.toISOString().slice(0, 10),
  validTo: row.validTo.toISOString().slice(0, 10),
  status: row.status,
  statusChangedOn: row.statusChangedAt ? businessDate(row.statusChangedAt) : null,
})

/** GET /portal/customer-documents/conformity */
export async function conformityPerStyle(app: FastifyInstance, request: FastifyRequest, query: { readonly q?: string | undefined }, now: Date) {
  const library = await readLibrary(app, request, now)
  const companyId = library.reader.session.company.id
  const own = await request.withClient(async (client) => {
    const shipments = await readShipmentsThatLeft(client, companyId)
    const lines = await readShipmentLines(client, shipments.map((row) => row.id))
    const orderLines = await readOrderLines(client, [...new Set(lines.map((line) => line.salesOrderLineId))])
    const orders = await readOrders(client, [...new Set(shipments.map((row) => row.salesOrderId))])
    return { shipments, lines, orderLines, orders }
  })
  const documents = visibleEntries(library).filter((entry) => entry.group === 'CONFORMITY' && entry.replacedById === null)
  const citedIds = [...new Set(documents.flatMap((entry) => (entry.compliance?.certificateId ? [entry.compliance.certificateId] : [])))]
  const styleOfLine = new Map(own.orderLines.map((line) => [line.id, line.styleId]))
  const tenant = await library.reader.inTenant(async (client) => {
    const revisions = await frozenRevisions(client, [...new Set(own.lines.map((line) => line.workOrderId))])
    const styleIds = [...new Set(own.orderLines.map((line) => line.styleId))]
    const styles = await readStyles(client, styleIds)
    const cited = await readCertificates(client, citedIds)
    const covering = await coveringCertificates(client, styleIds)
    // B-W2b-166: the batch numbers of the work orders the garments came from (printed on every garment label).
    const workOrderIds = [...new Set(own.lines.map((line) => line.workOrderId))]
    const batches = workOrderIds.length > 0 ? await client.workOrder.findMany({ where: { id: { in: workOrderIds }, batchNumber: { not: null } }, select: { id: true, batchNumber: true } }) : []
    return { revisions, styles, cited, covering, batches }
  })
  const batchOf = new Map(tenant.batches.map((row) => [row.id, row.batchNumber!]))
  const webOrigin = processEmail().webOrigin
  const citedOf = new Map(tenant.cited.map((row) => [row.id, certificateFacts(row)]))
  const orderOf = new Map(own.orders.map((row) => [row.id, row]))

  // Garments per style × shipment × frozen revision.
  const received = new Map<string, { styleId: string; shipmentId: string; revision: number | null; pieces: number; workOrderIds: Set<string> }>()
  for (const line of own.lines) {
    const styleId = styleOfLine.get(line.salesOrderLineId)
    if (!styleId) continue
    const revision = tenant.revisions.get(line.workOrderId) ?? null
    const key = `${styleId}|${line.shipmentId}|${revision ?? 'none'}`
    const row = received.get(key) ?? { styleId, shipmentId: line.shipmentId, revision, pieces: 0, workOrderIds: new Set<string>() }
    row.pieces += line.quantity
    row.workOrderIds.add(line.workOrderId)
    received.set(key, row)
  }

  const styles = tenant.styles
    .filter((style) => matchesSearch(query.q, [style.code, style.name]))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((style) => {
      const classification = classificationOf(styleFactsOf(style))
      const rows = [...received.values()]
        .filter((row) => row.styleId === style.id)
        .flatMap((row) => {
          const shipment = own.shipments.find((entry) => entry.id === row.shipmentId)
          return shipment?.shippedAt ? [{ row, shipment, shippedOn: businessDate(shipment.shippedAt) }] : []
        })
        .sort((a, b) => b.shippedOn.localeCompare(a.shippedOn) || b.shipment.number.localeCompare(a.shipment.number))
        .map(({ row, shipment, shippedOn }) => {
          const onShipment = documents.filter((entry) => entry.shipmentId === shipment.id)
          const ofStyle = (kind: PortalDocumentKind) =>
            onShipment.find((entry) => entry.kind === kind && (entry.compliance ? entry.compliance.styleId === style.id && (row.revision === null || entry.compliance.revision === row.revision) : entry.style?.id === style.id)) ?? null
          const declaration = ofStyle('DECLARATION_OF_CONFORMITY')
          const userInformation = ofStyle('USER_INFORMATION')
          const cited = declaration?.compliance?.certificateId ? (citedOf.get(declaration.compliance.certificateId) ?? null) : null
          const certificate = classification.certificateRequired ? certificateFor(cited, (tenant.covering.get(style.id) ?? []).map(certificateFacts), shippedOn) : null
          const certificateValid = certificate !== null && certificateValidOn(certificate, shippedOn)
          const state = receivedStateOf({ ppe: classification.isPpe, certificateRequired: classification.certificateRequired, declaration: declaration !== null, userInformation: userInformation !== null, certificateValid })
          const order = orderOf.get(shipment.salesOrderId)
          return {
            shipment: { id: shipment.id, number: shipment.number },
            order: order ? { id: order.id, number: order.number, customerRef: order.customerRef } : null,
            shippedOn,
            revision: row.revision,
            pieces: row.pieces,
            state,
            words: RECEIVED_WORDS[state],
            declaration: declaration ? ref(declaration) : null,
            userInformation: userInformation ? ref(userInformation) : null,
            certificate: certificate
              ? {
                  number: certificate.number,
                  standard: certificate.standard,
                  ppeClass: certificate.ppeClass,
                  notifiedBody: { name: certificate.notifiedBodyName, number: certificate.notifiedBodyNumber },
                  validFrom: certificate.validFrom,
                  validTo: certificate.validTo,
                  validOnShippingDate: certificateValid,
                }
              : null,
            reports: onShipment.filter((entry) => SHIPMENT_QUALITY_KINDS.includes(entry.kind)).map(ref),
            // B-W2b-166: the batches of these garments, each with the public DoC address its labels' QR holds.
            batches: [...row.workOrderIds]
              .flatMap((workOrderId) => (batchOf.has(workOrderId) ? [{ number: batchOf.get(workOrderId)!, publicDocAddress: publicDocAddress(webOrigin, publicDocCodeOf(workOrderId)) }] : []))
              .sort((a, b) => a.number.localeCompare(b.number)),
          }
        })
      return {
        style: { code: style.code, name: style.name },
        ppe: classification.isPpe,
        certificateRequired: classification.certificateRequired,
        standard: classification.standard,
        ppeClass: classification.ppeClass,
        // B-W2b-166: the style's public DoC address (its current declaration and the earlier ones), for PPE.
        publicDocAddress: classification.isPpe ? publicDocAddress(webOrigin, publicDocCodeOf(style.id)) : null,
        received: rows,
      }
    })
    .filter((style) => style.received.length > 0)
  return { asOf: toUtcIso(now), count: styles.length, styles, live: { events: ['partner_notification.created'] } }
}
