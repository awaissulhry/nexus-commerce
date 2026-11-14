import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../sales/quotes/preview'
import { processCarrier } from '../labels/carrier'
import { bookReturnLabelContract, cancelReturnLabelContract, downloadReturnLabelContract, makeReturnLabelContract, returnLabelPageContract, returnLabelPdfContract, returnLabelsContract } from './contract'
import { bookFromLink, downloadFromLink, returnLabelPage } from './link'
import { manifest } from './manifest'
import { cancelReturnLabel, getReturnLabels, makeReturnLabel, returnLabelPdf } from './office'

/**
 * Return labels (B-W2b-398; LOG-112): the office's labels of a return (made now or offered by link, withdrawn, the PDF the
 * Return label PDF window prints) and the customer's page by link (book it when the goods go, download it). The worker marks
 * a booked label used when the goods reach the dock (used.ts, in background.ts).
 */
export default defineRoutes('shipping.return-labels', manifest, async (app) => {
  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }
  const runtime = () => ({ carrier: processCarrier(), files: processFiles() })

  app.get('/sales/returns/:returnId/return-labels', { schema: returnLabelsContract }, async (request) => getReturnLabels(request, request.params.returnId))

  app.post('/sales/returns/:returnId/return-labels', { schema: makeReturnLabelContract }, async (request, reply) =>
    reply.code(201).send(await makeReturnLabel(runtime(), request, request.params.returnId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/sales/returns/:returnId/return-labels/:labelId/cancel', { schema: cancelReturnLabelContract }, async (request) =>
    cancelReturnLabel(request, request.params.returnId, request.params.labelId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/sales/returns/:returnId/return-labels/:labelId/pdf', { schema: returnLabelPdfContract }, async (request, reply) => {
    const { body, fileName } = await returnLabelPdf(processFiles(), request, request.params.returnId, request.params.labelId)
    return reply.headers({ 'content-type': 'application/pdf', 'content-disposition': inlineDisposition(fileName), 'cache-control': 'no-store' }).send(body)
  })

  app.get('/link/return-label', { schema: returnLabelPageContract, config: limited }, async (request) => returnLabelPage(request))

  app.post('/link/return-label/book', { schema: bookReturnLabelContract, config: limited }, async (request) => bookFromLink(runtime(), request, idempotencyKeyFrom(request)))

  app.post('/link/return-label/download', { schema: downloadReturnLabelContract, config: limited }, async (request) => downloadFromLink(processFiles(), request, idempotencyKeyFrom(request)))
})
