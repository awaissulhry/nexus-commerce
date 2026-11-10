import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { appClock } from '../../../platform/portal/tasks/clock'
import { samplesPageContract, techPackDownloadContract } from './contract'
import { openTechPack } from './download'
import { manifest } from './manifest'
import { samplesPage } from './page'

/**
 * The brand's samples and tech packs (B-W2b-262; PRD-245; design portal.customer.samples, SCR-225; the screen is this step's
 * `/p/<party>/samples`):
 *
 *   GET  /portal/samples                                    what waits for the brand's decision, its own styles in
 *                                                           development and their stage, every round with its shipment
 *   POST /portal/samples/tech-packs/:documentId/download    a BRAND tech pack PDF of the brand's own style, logged,
 *                                                           presigned 60 s
 *
 * The decision itself is B-W2b-184's GET /portal/approvals/:id and POST /portal/approvals/:id/answer (B-W2b-252's adapters
 * settle it on the round or swatch).
 */
export default defineRoutes('portal-samples', manifest, async (app) => {
  app.get('/portal/samples', { schema: samplesPageContract }, async (request) => samplesPage(app, request, appClock(app).now()))

  app.post('/portal/samples/tech-packs/:documentId/download', { schema: techPackDownloadContract }, async (request) =>
    openTechPack(app, processFiles(), request, request.params.documentId, request.body, idempotencyKeyFrom(request)),
  )
})
