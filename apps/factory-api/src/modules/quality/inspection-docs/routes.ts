import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processEmail } from '../../../platform/email-out/service'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../inventory/receipts/report'
import { makeCertificate, previewCertificate } from './certificate'
import {
  certificatesContract,
  makeCertificateContract,
  makeReportContract,
  previewCertificateContract,
  previewReportContract,
  reportsContract,
  shareCertificateContract,
  shareReportContract,
} from './contract'
import { manifest } from './manifest'
import { makeReport, previewReport } from './report'
import { certificatesOf, reportsOf, shareCertificate, shareReport } from './share'

/**
 * The quality documents for a customer (B-W2b-123): a signed final inspection's report (./report.ts) and a shipment's
 * certificate of conformity (./certificate.ts) as a preview PDF and kept versions (./versions.ts), and a kept version put
 * on a shipment's existing documents link (./share.ts).
 */
export default defineRoutes('quality.inspectionDocs', manifest, async (app) => {
  app.get('/quality/inspections/:inspectionId/report', { schema: previewReportContract }, async (request, reply) => {
    const { pdf, fileName } = await previewReport(processFiles(), request, request.params.inspectionId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.get('/quality/inspections/:inspectionId/reports', { schema: reportsContract }, async (request) => reportsOf(request, request.params.inspectionId))
  app.post('/quality/inspections/:inspectionId/reports', { schema: makeReportContract }, async (request, reply) =>
    reply.code(201).send(await makeReport(processFiles(), request, request.params.inspectionId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/quality/inspections/:inspectionId/reports/share', { schema: shareReportContract }, async (request, reply) =>
    reply.code(201).send(await shareReport(processFiles(), processEmail(), request, request.params.inspectionId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/quality/shipments/:shipmentId/certificate', { schema: previewCertificateContract }, async (request, reply) => {
    const { pdf, fileName } = await previewCertificate(request, request.params.shipmentId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.get('/quality/shipments/:shipmentId/certificates', { schema: certificatesContract }, async (request) => certificatesOf(request, request.params.shipmentId))
  app.post('/quality/shipments/:shipmentId/certificates', { schema: makeCertificateContract }, async (request, reply) =>
    reply.code(201).send(await makeCertificate(processFiles(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/quality/shipments/:shipmentId/certificates/share', { schema: shareCertificateContract }, async (request, reply) =>
    reply.code(201).send(await shareCertificate(processFiles(), processEmail(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )
})
