import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../sales/quotes/preview'
import { brokerDownloadContract, brokerMrnContract, brokerPageContract, packContract, packLinkContract, packPdfContract } from './contract'
import { brokerPackPage, downloadPaper, submitMrn } from './link'
import { manifest } from './manifest'
import { getPack, packPdf, sendPackLink } from './pack'

/**
 * The document pack for the broker (B-W2b-409; LOG-097, LOG-088): the office reads the parts, downloads them as one PDF, or
 * sends them by a BROKER_PACK link (only while the site's switch is ON); the broker's page downloads each paper and types the
 * MRN back once.
 */
export default defineRoutes('shipping.broker-pack', manifest, async (app) => {
  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/shipping/shipments/:shipmentId/export/pack', { schema: packContract }, async (request) => getPack(request, request.params.shipmentId, request.query))

  app.get('/shipping/shipments/:shipmentId/export/pack/pdf', { schema: packPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await packPdf(processFiles(), request, request.params.shipmentId, request.query)
    return reply.headers({ 'content-type': 'application/pdf', 'content-disposition': inlineDisposition(fileName), 'cache-control': 'no-store' }).send(pdf)
  })

  app.post('/shipping/shipments/:shipmentId/export/pack/link', { schema: packLinkContract }, async (request, reply) =>
    reply.code(201).send(await sendPackLink(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/link/broker-pack', { schema: brokerPageContract, config: limited }, async (request) => brokerPackPage(request))

  app.post('/link/broker-pack/files/:fileId/download', { schema: brokerDownloadContract, config: limited }, async (request) =>
    downloadPaper(processFiles(), request, request.params.fileId, idempotencyKeyFrom(request)),
  )

  app.post('/link/broker-pack/mrn', { schema: brokerMrnContract, config: limited }, async (request) => submitMrn(request, request.body, idempotencyKeyFrom(request)))
})
