import type { DdtSourceType } from '@nexus/factory-domain/shipping/ddt/sources'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import {
  cancelDdtContract,
  downloadPdfContract,
  getDdtContract,
  issueContract,
  listDdtsContract,
  previewContract,
  previewPdfContract,
  printPdfContract,
  shipContract,
  sourceIssueContract,
  sourcePreviewContract,
  sourcePreviewPdfContract,
} from './contract'
import { cancelDdt, downloadDdtPdf, getDdt, issueDdt, listDdts, previewDdt, previewDdtPdf, printDdt, shipShipment } from './ddt'
import { manifest } from './manifest'
import { issueSourceDdt, previewSourceDdt, previewSourceDdtPdf } from './sources'

/**
 * The DDT of a shipment (B-W1-47; LOG-054; DPR 472/1996; A2 SCR-067): preview it (no number used, also as a PDF with
 * the "sample" banner), issue it (a gapless number of the company's DDT series for the year; with `ship` the goods leave
 * in the same command), ship a packed shipment that has its DDT, read and list DDTs, download or print again the PDF
 * (FISCAL_ARCHIVE), cancel a DDT with its reason. Labels and tracking are B-W1-48's; the DoC link B-W1-49's.
 *
 * B-W2a-17 (LOG-056): a DDT for another reason, for the goods of a source record (a subcontract order's kit, a supplier
 * claim's return, a repair's way back, an RMA's goods sent back unchanged): preview it (also as a PDF) and issue it under
 * /shipping/ddt-sources/:sourceType/:sourceId; the record, list, PDF and cancel routes below take it like a shipment's.
 */
export default defineRoutes('shipping.ddt', manifest, async (app) => {
  app.post('/shipping/shipments/:shipmentId/ddt/preview', { schema: previewContract }, async (request) => previewDdt(request, request.params.shipmentId, request.body))

  app.post('/shipping/shipments/:shipmentId/ddt/preview/pdf', { schema: previewPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await previewDdtPdf(request, request.params.shipmentId, request.body)
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/shipping/shipments/:shipmentId/ddt', { schema: issueContract }, async (request, reply) =>
    reply.code(201).send(
      await issueDdt(processFiles(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'the DDT is issued; its PDF was not stored')),
    ),
  )

  app.post('/shipping/shipments/:shipmentId/ship', { schema: shipContract }, async (request) => shipShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.get('/shipping/ddts', { schema: listDdtsContract }, async (request) => listDdts(request, request.query))

  app.get('/shipping/ddts/:ddtId', { schema: getDdtContract }, async (request) => getDdt(request, request.params.ddtId))

  app.get('/shipping/ddts/:ddtId/pdf', { schema: downloadPdfContract }, async (request) => downloadDdtPdf(processFiles(), { caller: request, system: systemCallerOf(request) }, request.params.ddtId))

  app.post('/shipping/ddts/:ddtId/pdf', { schema: printPdfContract }, async (request, reply) => {
    const { file, created } = await printDdt(processFiles(), request, request.params.ddtId)
    return reply.code(created ? 201 : 200).send({ file })
  })

  app.post('/shipping/ddts/:ddtId/cancel', { schema: cancelDdtContract }, async (request) => cancelDdt(request, request.params.ddtId, request.body, idempotencyKeyFrom(request)))

  // B-W2a-17: a DDT for another reason.
  const sourceOf = (params: { sourceType: DdtSourceType; sourceId: string }) => ({ type: params.sourceType, id: params.sourceId })
  app.post('/shipping/ddt-sources/:sourceType/:sourceId/ddt/preview', { schema: sourcePreviewContract }, async (request) => previewSourceDdt(request, sourceOf(request.params), request.body))

  app.post('/shipping/ddt-sources/:sourceType/:sourceId/ddt/preview/pdf', { schema: sourcePreviewPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await previewSourceDdtPdf(request, sourceOf(request.params), request.body)
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/shipping/ddt-sources/:sourceType/:sourceId/ddt', { schema: sourceIssueContract }, async (request, reply) =>
    reply.code(201).send(
      await issueSourceDdt(processFiles(), request, sourceOf(request.params), request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'the DDT is issued; its PDF was not stored')),
    ),
  )
})
