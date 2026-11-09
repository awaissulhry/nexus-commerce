import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { registerLinkRenewer } from '../../../platform/links/renew'
import { makeLinksContract, paperDownloadContract, portalLinkContract, revokeLinkContract, searchContract, trackingLinksContract, trackingPageContract } from './contract'
import { manifest } from './manifest'
import { getTrackingLinks, makeFromOffice, revokeFromOffice } from './office'
import { copyFromPortal } from './portal'
import { renewTrackingLink } from './renew'
import { searchTracking } from './search'
import { downloadPaper, trackingPage } from './session'

/**
 * Track an order (B-W2b-170; LOG-062; design links.tracking, SCR-194):
 *
 * GET  /shipping/shipments/:shipmentId/tracking-links                office: who gets it, the links made, why none now
 * POST /shipping/shipments/:shipmentId/tracking-links                office: mail it, or one link to pass on (its address once)
 * POST /shipping/shipments/:shipmentId/tracking-links/:linkId/revoke office: a tracking link opens nothing from now on
 * GET  /link/tracking                                                link: the tracking page (codes, no money, no street)
 * POST /link/tracking/papers/:fileId/download                        link (Idempotency-Key): a paper, logged, presigned 60 s
 * POST /portal/sales-orders/:orderId/shipments/:shipmentId/tracking-link  partner: "Copy tracking link"
 * POST /tracking/search                                              PUBLIC: order reference + postcode; one answer for a miss
 *
 * "Report a problem" on the page is B-W2b-192's POST /link/tracking/claim. "Ask for a new link" on a dead tracking link is
 * B-W2b-163's POST /link/renew, which hands it to renewTrackingLink (registered below). When the goods leave, the worker
 * mails the link (handler.ts, in background.ts).
 */
registerLinkRenewer('SHIPMENT_TRACK', 'Shipment', renewTrackingLink)

export default defineRoutes('shipping.tracking-link', manifest, async (app) => {
  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/shipping/shipments/:shipmentId/tracking-links', { schema: trackingLinksContract }, async (request) => getTrackingLinks(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/tracking-links', { schema: makeLinksContract }, async (request, reply) =>
    reply.code(201).send(await makeFromOffice(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/shipping/shipments/:shipmentId/tracking-links/:linkId/revoke', { schema: revokeLinkContract }, async (request) =>
    revokeFromOffice(request, request.params.shipmentId, request.params.linkId, idempotencyKeyFrom(request)),
  )

  app.get('/link/tracking', { schema: trackingPageContract, config: limited }, async (request) => trackingPage(request))

  app.post('/link/tracking/papers/:fileId/download', { schema: paperDownloadContract, config: limited }, async (request) => downloadPaper(request, request.params.fileId, idempotencyKeyFrom(request)))

  app.post('/portal/sales-orders/:orderId/shipments/:shipmentId/tracking-link', { schema: portalLinkContract }, async (request, reply) =>
    reply.code(201).send(await copyFromPortal(app, request, request.params.orderId, request.params.shipmentId, idempotencyKeyFrom(request))),
  )

  app.post('/tracking/search', { schema: searchContract, config: limited }, async (request, reply) => searchTracking(app, request, reply, request.body))
})
