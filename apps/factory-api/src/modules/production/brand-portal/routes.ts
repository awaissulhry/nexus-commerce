import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { attachmentDisposition } from '../../../platform/files/rules'
import { appClock } from '../../../platform/portal/tasks/clock'
import { listContract, markUrgencyContract, orderContract, reportProblemContract, undoUrgencyContract, urgentOrderContract } from './contract'
import { manifest } from './manifest'
import { productionCsv, productionList, productionOrder } from './read'
import { reportProblem } from './problems' // B-PR-45
import { markUrgency, orderUrgent, undoUrgency } from './urgency'

/**
 * B-PR-18: the customer's own production in its portal (production plan §4, §5; design 06-tree B.1 My production, B.2 Order ›
 * Status & progress; the screens are F-PR-11 and F-PR-12a/b). Reads only; see ./read.ts. B-PR-22a adds the customer's urgency
 * commands (./urgency.ts).
 */
export default defineRoutes('portal-production', manifest, async (app) => {
  app.get('/portal/production', { schema: listContract }, async (request, reply) => {
    if (request.query.format === 'csv') {
      // "Export": every own row of the chip and search, written here in the partner's scope (never the export job). The
      // contract's 200 is the list or the file's bytes; a Buffer leaves as it is (only the JSON answer is serialized).
      const file = await productionCsv(app, request, request.query, appClock(app).now())
      return reply.type(file.contentType).header('content-disposition', attachmentDisposition(file.fileName)).header('cache-control', 'no-store').send(Buffer.from(file.bytes))
    }
    return productionList(app, request, request.query, appClock(app).now())
  })

  app.get('/portal/production/:orderId', { schema: orderContract }, async (request) => productionOrder(app, request, request.params.orderId, appClock(app).now()))

  // B-PR-22a: the customer's urgency (./urgency.ts).
  app.post('/portal/production/urgency', { schema: markUrgencyContract }, async (request) => markUrgency(app, request, request.body, idempotencyKeyFrom(request)))

  app.put('/portal/production/urgent-order', { schema: urgentOrderContract }, async (request) => orderUrgent(app, request, request.body, idempotencyKeyFrom(request)))

  app.post('/portal/production/urgency/undo', { schema: undoUrgencyContract }, async (request) => undoUrgency(app, request, request.body, idempotencyKeyFrom(request)))

  // B-PR-45: "Report a problem" (./problems.ts).
  app.post('/portal/production/problems', { schema: reportProblemContract }, async (request) => reportProblem(app, request, request.body, idempotencyKeyFrom(request)))
})
