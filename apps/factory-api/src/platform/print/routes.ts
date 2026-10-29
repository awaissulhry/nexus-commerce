import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { attachmentDisposition } from '../files/rules'
import {
  createPrinterContract,
  getJobContract,
  labelPdfContract,
  listJobsContract,
  listPrintersContract,
  listStationPrintersContract,
  queueDocumentContract,
  queueLabelContract,
  retryJobContract,
  setStationPrinterContract,
  updatePrinterContract,
} from './contract'
import { getJob, listJobs, queueDocument, queueLabel, retryJob } from './jobs'
import { labelPdf } from './labels'
import { manifest } from './manifest'
import { createPrinter, listPrinters, updatePrinter } from './printers'
import { listStationPrinters, setStationPrinter } from './stations'

/**
 * Printing (platform part; plan A1 §3.9, GAP-007): the printers of each site, print jobs for labels (ZPL) and
 * documents (PDF) through the site's print relay, their queue, sending a failed one again, and the label PDF for the
 * browser when a site has no label printer, and each station's label printer (MES-184). The worker hands queued jobs to
 * the relay (handler.ts).
 */
export default defineRoutes('print', manifest, async (app) => {
  app.get('/print/printers', { schema: listPrintersContract }, async (request) => ({ printers: await listPrinters(request, request.query) }))

  app.post('/print/printers', { schema: createPrinterContract }, async (request, reply) => {
    return reply.code(201).send({ printer: await createPrinter(request, request.body, idempotencyKeyFrom(request)) })
  })

  app.patch('/print/printers/:printerId', { schema: updatePrinterContract }, async (request) => ({
    printer: await updatePrinter(request, request.params.printerId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/print/stations', { schema: listStationPrintersContract }, async (request) => ({ stations: await listStationPrinters(request, request.query) }))

  app.put('/print/stations/:stationId/label-printer', { schema: setStationPrinterContract }, async (request) =>
    setStationPrinter(request, request.params.stationId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/print/jobs/label', { schema: queueLabelContract }, async (request, reply) => {
    return reply.code(201).send({ job: await queueLabel(request, request.body, idempotencyKeyFrom(request)) })
  })

  app.post('/print/jobs/document', { schema: queueDocumentContract }, async (request, reply) => {
    return reply.code(201).send({ job: await queueDocument(request, request.body, idempotencyKeyFrom(request)) })
  })

  app.get('/print/jobs', { schema: listJobsContract }, async (request) => ({ jobs: await listJobs(request, request.query) }))

  app.get('/print/jobs/:jobId', { schema: getJobContract }, async (request) => ({ job: await getJob(request, request.params.jobId) }))

  app.post('/print/jobs/:jobId/retry', { schema: retryJobContract }, async (request) => ({
    job: await retryJob(request, request.params.jobId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/print/labels/pdf', { schema: labelPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await labelPdf(request, request.body)
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
})
