import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { getNoticeContract, sendNoticeContract } from './contract'
import { manifest } from './manifest'
import { getNotice } from './notices'
import { sendNoticeFromOffice } from './office'

/**
 * The shipping notice to the customer (B-W2b-398; LOG-061): read it (switch, why held, recipients, the mails with their
 * delivery state) and Send again. The worker sends it by itself when the goods leave (handler.ts, in background.ts).
 */
export default defineRoutes('shipping.notices', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/notice', { schema: getNoticeContract }, async (request) => getNotice(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/notice', { schema: sendNoticeContract }, async (request) => sendNoticeFromOffice(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))
})
