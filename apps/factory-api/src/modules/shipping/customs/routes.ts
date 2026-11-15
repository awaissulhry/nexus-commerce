import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../sales/quotes/preview'
import {
  brokerPackSwitchContract,
  commercialInvoiceContract,
  confirmExitContract,
  customsPaperPdfContract,
  customsSettingsContract,
  exportContract,
  nameInvoiceContract,
  openDeclarationContract,
  postalFormContract,
  recordMrnContract,
  removeDeclarationContract,
  setEoriContract,
} from './contract'
import { confirmExit, nameInvoice, openDeclaration, recordMrn, removeDeclaration } from './declarations'
import { getExport } from './export'
import { manifest } from './manifest'
import { customsPaperPdf, makeCommercialInvoice, makePostalForm } from './papers'
import { getCustomsSettings, setEori, switchBrokerPack } from './settings'

/**
 * Export and customs (B-W2b-409; LOG-086, LOG-087, LOG-088, LOG-089, LOG-095): the shipment's Export tab (its papers, its
 * declaration and the countdown to the proof's alert), the commercial invoice and the CN 22 / CN 23 with their PDFs, the
 * declaration's pack, MRN, invoice, exit and removal, the company's EORI and a site's broker-pack switch. The broker's pack
 * itself is modules/shipping/broker-pack; the missing proof's alert is the exception rules' EXIT_PROOF_MISSING (alerts.ts).
 */
export default defineRoutes('shipping.customs', manifest, async (app) => {
  const files = () => processFiles()

  app.get('/shipping/shipments/:shipmentId/export', { schema: exportContract }, async (request) => getExport(request, request.params.shipmentId, officeAuthOf(app).clock.now()))

  app.post('/shipping/shipments/:shipmentId/export/commercial-invoice', { schema: commercialInvoiceContract }, async (request, reply) => {
    const { status, document } = await makeCommercialInvoice(files(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))
    return reply.code(status).send({ document })
  })

  app.post('/shipping/shipments/:shipmentId/export/postal-form', { schema: postalFormContract }, async (request, reply) => {
    const { status, document } = await makePostalForm(files(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))
    return reply.code(status).send({ document })
  })

  app.get('/shipping/shipments/:shipmentId/export/documents/:documentId/pdf', { schema: customsPaperPdfContract }, async (request, reply) => {
    const { body, fileName } = await customsPaperPdf(files(), request, request.params.shipmentId, request.params.documentId)
    return reply.headers({ 'content-type': 'application/pdf', 'content-disposition': inlineDisposition(fileName), 'cache-control': 'no-store' }).send(body)
  })

  app.post('/shipping/shipments/:shipmentId/export/declaration', { schema: openDeclarationContract }, async (request, reply) =>
    reply.code(201).send(await openDeclaration(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/shipping/shipments/:shipmentId/export/declaration/mrn', { schema: recordMrnContract }, async (request) => recordMrn(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/export/declaration/invoice', { schema: nameInvoiceContract }, async (request) => nameInvoice(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/export/declaration/exit', { schema: confirmExitContract }, async (request) => confirmExit(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.delete('/shipping/shipments/:shipmentId/export/declaration', { schema: removeDeclarationContract }, async (request) => removeDeclaration(request, request.params.shipmentId, request.query, idempotencyKeyFrom(request)))

  app.get('/shipping/companies/:companyId/customs', { schema: customsSettingsContract }, async (request) => getCustomsSettings(request, request.params.companyId))

  app.put('/shipping/companies/:companyId/eori', { schema: setEoriContract }, async (request) => setEori(request, request.params.companyId, request.body, idempotencyKeyFrom(request)))

  app.put('/shipping/sites/:siteId/broker-pack', { schema: brokerPackSwitchContract }, async (request) =>
    switchBrokerPack(request, request.params.siteId, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
})
