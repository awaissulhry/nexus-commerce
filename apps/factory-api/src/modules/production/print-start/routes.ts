import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { printAndStartContract, printStartPreviewContract } from './contract'
import { manifest } from './manifest'
import { printStartPreview } from './preview'
import { printAndStart } from './start'

/**
 * "Print and start the work" (owb- order workflow, S3 ss2 step 2.2): what it would do now, and the ONE command that makes the
 * missing work orders, releases them, makes the baskets where the site makes them at print and records the FIRST print. "Print
 * again" and the print sheet are ../prints.
 */
export default defineRoutes('production.printStart', manifest, async (app) => {
  app.get('/production/orders/:orderId/print-start', { schema: printStartPreviewContract }, async (request) => printStartPreview(request, request.params.orderId))

  app.post('/production/orders/:orderId/print-and-start', { schema: printAndStartContract }, async (request) => printAndStart(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
})
