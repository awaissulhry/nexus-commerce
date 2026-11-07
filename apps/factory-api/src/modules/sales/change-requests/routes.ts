import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { appClock } from '../../../platform/portal/tasks/clock'
import { acceptContract, askContract, officeListContract, officeRecordContract, partnerListContract, refuseContract, rulesContract, saveSettingsContract, settingsContract, withdrawContract } from './contract'
import { manifest } from './manifest'
import { acceptRequest, officeList, officeRecord, refuseRequest } from './office'
import { askRequest, partnerList, portalRules, withdrawRequest } from './portal'
import { getCutoffs, saveCutoffs } from './settings'

/**
 * Change and cancel requests from the portal (B-W2b-183; SAL-077 change request from the portal, SAL-078 cancel request
 * with cut-off rules; design portal.customer.orders "Ask for a change" and "Ask to cancel", home.approvals, sales.orders ›
 * Changes). The customer asks (checked against the cut-off rules before and at the click) and may withdraw; the office
 * answers: accept runs W2a's amendment (or cancels the whole order), refuse says why. Home › Approvals reads the open ones
 * (modules/insights/sources/portal-change-requests.ts); the customer is told of the answer by e-mail
 * (platform/portal/notifications/rules/change-requests.ts). The screens are B-W2b-191's (portal) and a sales screen step's.
 */
export default defineRoutes('sales-change-requests', manifest, async (app) => {
  app.get('/portal/sales-orders/:orderId/change-requests/rules', { schema: rulesContract }, async (request) => portalRules(app, request, request.params.orderId, appClock(app).now()))

  app.get('/portal/sales-orders/:orderId/change-requests', { schema: partnerListContract }, async (request) => partnerList(app, request, request.params.orderId, appClock(app).now()))

  app.post('/portal/sales-orders/:orderId/change-requests', { schema: askContract }, async (request, reply) => reply.code(201).send(await askRequest(app, request, request.params.orderId, request.body, idempotencyKeyFrom(request))))

  app.post('/portal/sales-orders/:orderId/change-requests/:requestId/withdraw', { schema: withdrawContract }, async (request) => withdrawRequest(app, request, request.params.orderId, request.params.requestId, request.body.version, idempotencyKeyFrom(request)))

  app.get('/sales/change-requests', { schema: officeListContract }, async (request) => officeList(request, request.query, appClock(app).now()))

  app.get('/sales/change-requests/settings', { schema: settingsContract }, async (request) => getCutoffs(request, request.query))

  app.put('/sales/change-requests/settings', { schema: saveSettingsContract }, async (request) => saveCutoffs(request, request.body, idempotencyKeyFrom(request), appClock(app)))

  app.get('/sales/change-requests/:requestId', { schema: officeRecordContract }, async (request) => officeRecord(request, request.params.requestId, appClock(app).now()))

  app.post('/sales/change-requests/:requestId/accept', { schema: acceptContract }, async (request) => acceptRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request), appClock(app)))

  app.post('/sales/change-requests/:requestId/refuse', { schema: refuseContract }, async (request) => refuseRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request), appClock(app)))
})
