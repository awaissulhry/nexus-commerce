import { RENEW_ANSWER } from '@nexus/factory-domain/shipping/documents/documents'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processEmail } from '../../../platform/email-out/service'
import { processFiles } from '../../../platform/files/service'
import {
  announcePaperContract,
  attachContract,
  completeEvidenceContract,
  completePaperContract,
  documentsContract,
  evidenceContract,
  evidenceNeededContract,
  linkDocumentsContract,
  linkDownloadContract,
  renewContract,
  reopenEvidenceContract,
  sendLinkContract,
} from './contract'
import { announcePaper, completeEvidence, completePaper, getEvidence, reopenEvidence, setEvidenceNeeded } from './evidence'
import { linkTokenOf, renewDocumentLink } from './link'
import { manifest } from './manifest'
import { attachFromOffice, getDocuments, sendFromOffice } from './office'
import { downloadLinkDocument, linkDocumentsOf } from './session'

/**
 * A shipment's documents (B-W1-49; PLAN §4.7 14-ship "DoC by link"; Reg. (EU) 2016/425 art. 8(8)):
 *
 * GET  /shipping/shipments/:shipmentId/documents          office: the DDT, the DoC and leaflet per style revision, the
 *                                                         packing list, their states, the shipping checks, the links
 * POST /shipping/shipments/:shipmentId/documents/attach   office: copy what travels onto the shipment for its party
 * POST /shipping/shipments/:shipmentId/documents/link     office: attach, then mail the party a link (again: a resend)
 * GET  /shipping/link/documents                           link: the shipment's shared documents
 * POST /shipping/link/documents/:fileId/download          link (Idempotency-Key): one of them, logged, presigned 60 s
 * POST /shipping/link/renew                               public (the token in x-factory-link): "Ask for a new link",
 *                                                         one answer whatever the token; a new link only to the
 *                                                         address on file
 *
 * When the goods leave, the worker's handler attaches the documents and mails the link (handler.ts, in background.ts).
 */
export default defineRoutes('shipping.documents', manifest, async (app) => {
  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/shipping/shipments/:shipmentId/documents', { schema: documentsContract }, async (request) => getDocuments(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/documents/attach', { schema: attachContract }, async (request) =>
    attachFromOffice(processFiles(), request, request.params.shipmentId, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/shipments/:shipmentId/documents/link', { schema: sendLinkContract }, async (request, reply) =>
    reply.code(201).send(await sendFromOffice(processFiles(), processEmail(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/shipping/link/documents', { schema: linkDocumentsContract, config: limited }, async (request) => linkDocumentsOf(request))

  app.post('/shipping/link/documents/:fileId/download', { schema: linkDownloadContract, config: limited }, async (request) =>
    downloadLinkDocument(processFiles(), request, request.params.fileId, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/link/renew', { schema: renewContract, config: limited }, async (request, reply) => {
    const auth = officeAuthOf(app)
    const token = linkTokenOf(request)
    // The work runs after the answer: neither what it says nor when it comes tells anything about the token.
    auth.afterAnswer(async () => {
      const outcome = await renewDocumentLink(processEmail(), request, token)
      request.log.info({ outcome }, 'a new documents link was asked for')
    }, request.log)
    return reply.code(202).send({ status: 'requested' as const, message: RENEW_ANSWER })
  })

  // B-W2a-48 (LOG-090): intra-EU transport evidence.
  app.get('/shipping/shipments/:shipmentId/evidence', { schema: evidenceContract }, async (request) => getEvidence(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/evidence/papers', { schema: announcePaperContract }, async (request, reply) =>
    reply.code(201).send(await announcePaper(processFiles(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/shipping/shipments/:shipmentId/evidence/papers/:fileId/complete', { schema: completePaperContract }, async (request) =>
    completePaper(processFiles(), request, request.params.shipmentId, request.params.fileId, request.body ?? {}, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/shipments/:shipmentId/evidence/complete', { schema: completeEvidenceContract }, async (request) => completeEvidence(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/evidence/reopen', { schema: reopenEvidenceContract }, async (request) => reopenEvidence(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/evidence/needed', { schema: evidenceNeededContract }, async (request) => setEvidenceNeeded(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))
})
