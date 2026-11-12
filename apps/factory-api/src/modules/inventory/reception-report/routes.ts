import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { reserveFromReport, sendReport } from './act'
import { reportContract, reserveContract, sendContract } from './contract'
import { manifest } from './manifest'
import { receptionReport } from './report'

/** The reception report (B-W2b-300; SCM-119): what a receipt serves, reserved in one step, sent to the buyer. */
export default defineRoutes('inventory.receptionReport', manifest, async (app) => {
  app.get('/inventory/receipts/:receiptId/reception-report', { schema: reportContract }, async (request) => receptionReport(request, request.params.receiptId))

  app.post('/inventory/receipts/:receiptId/reception-report/reserve', { schema: reserveContract }, async (request) => reserveFromReport(request, request.params.receiptId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/receipts/:receiptId/reception-report/send', { schema: sendContract }, async (request) => sendReport(request, request.params.receiptId, request.body, idempotencyKeyFrom(request)))
})
