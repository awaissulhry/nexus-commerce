import { defineRoutes } from '../../../core/manifest'
import { attachmentDisposition } from '../../../platform/files/rules'
import { appClock } from '../../../platform/portal/tasks/clock'
import { listContract, orderContract } from './contract'
import { manifest } from './manifest'
import { productionCsv, productionList, productionOrder } from './read'

/**
 * B-PR-18: the customer's own production in its portal (production plan §4, §5; design 06-tree B.1 My production, B.2 Order ›
 * Status & progress; the screens are F-PR-11 and F-PR-12a/b). Reads only; see ./read.ts.
 */
export default defineRoutes('portal-production', manifest, async (app) => {
  app.get('/portal/production', { schema: listContract }, async (request, reply) => {
    if (request.query.format === 'csv') {
      // "Export": every own row of the chip and search, written here in the partner's scope (never the export job).
      // A Buffer leaves as it is (the 200 schema serializes the JSON answer only); `never`: the handler's typed answer is the JSON's.
      const file = await productionCsv(app, request, request.query, appClock(app).now())
      return reply.type(file.contentType).header('content-disposition', attachmentDisposition(file.fileName)).header('cache-control', 'no-store').send(Buffer.from(file.bytes)) as never
    }
    return productionList(app, request, request.query, appClock(app).now())
  })

  app.get('/portal/production/:orderId', { schema: orderContract }, async (request) => productionOrder(app, request, request.params.orderId, appClock(app).now()))
})
