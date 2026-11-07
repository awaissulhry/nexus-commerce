import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { registerLinkRenewer } from '../../../platform/links/renew'
import { publishAnswer, shareEightD } from '../../quality/complaints/portal/publish'
import { inlineDisposition } from '../quotes/preview'
import {
  authoriseContract,
  cancelReturnContract,
  casesContract,
  claimLinkContract,
  complaintContract,
  complaintPhotoContract,
  complaintPhotoDoneContract,
  complaintsContract,
  instructionsContract,
  linkCaseContract,
  linkClaimContract,
  linkInstructionsContract,
  linkOpenFileContract,
  linkPhotoContract,
  linkPhotoDoneContract,
  openFileContract,
  publishAnswerContract,
  rejectContract,
  reportComplaintContract,
  requestReturnContract,
  returnableContract,
  returnContract,
  returnPhotoContract,
  returnPhotoDoneContract,
  shareEightDContract,
  submitClaimContract,
  trackingClaimContract,
} from './contract'
import { claimFromTracking, linkClaim, linkClaimCase, linkClaimFile, linkClaimPhoto, linkClaimPhotoDone, linkInstructions, renewClaimLink, submitClaim } from './link'
import { manifest } from './manifest'
import { authoriseReturn, rejectReturn, sendClaimLink } from './office'
import {
  portalCancelReturn,
  portalCases,
  portalComplaint,
  portalComplaintPhoto,
  portalComplaintPhotoDone,
  portalComplaints,
  portalInstructions,
  portalOpenFile,
  portalReportComplaint,
  portalRequestReturn,
  portalReturn,
  portalReturnable,
  portalReturnPhoto,
  portalReturnPhotoDone,
} from './portal'

/**
 * Returns and complaints from outside (B-W2b-192; SAL-334 return request from the portal, SAL-424 complaint status in the
 * portal; follow-ups CO5:01 "Share with the customer" of the 8D, CO5:02 an answer published to the portal). The portal's
 * Returns & claims (./portal.ts), the claim link (./link.ts), the office's authorise / reject / claim link (./office.ts),
 * and the complaint's publish and 8D share (modules/quality/complaints/portal). The screens are B-W2b-197 (SCR-187) and
 * B-W2b-198 (SCR-197).
 */

// B-W2b-163's "Ask for a new link" for a dead claim link (module scope: once per process, as the platform's own map).
for (const recordType of ['Shipment', 'SalesOrder']) registerLinkRenewer('CLAIM', recordType, renewClaimLink)

const pdf = (fileName: string) => ({ 'content-type': 'application/pdf', 'content-disposition': inlineDisposition(fileName), 'cache-control': 'no-store' })

export default defineRoutes('portal-returns', manifest, async (app) => {
  // ---- the portal --------------------------------------------------------------------------------------------------------
  app.get('/portal/returns', { schema: casesContract }, async (request) => portalCases(app, request, request.query))
  app.get('/portal/returns/returnable', { schema: returnableContract }, async (request) => portalReturnable(app, request, request.query))
  app.post('/portal/returns', { schema: requestReturnContract }, async (request, reply) => reply.code(201).send(await portalRequestReturn(app, request, request.body, idempotencyKeyFrom(request))))
  app.post('/portal/returns/files/:fileId/open', { schema: openFileContract }, async (request) => portalOpenFile(processFiles(), app, request, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  app.get('/portal/returns/:returnId', { schema: returnContract }, async (request) => portalReturn(app, request, request.params.returnId))
  app.get('/portal/returns/:returnId/instructions', { schema: instructionsContract }, async (request, reply) => {
    const { pdf: body, fileName } = await portalInstructions(app, request, request.params.returnId, request.query.language)
    return reply.headers(pdf(fileName)).send(body)
  })
  app.post('/portal/returns/:returnId/cancel', { schema: cancelReturnContract }, async (request) => portalCancelReturn(app, request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/portal/returns/:returnId/photos', { schema: returnPhotoContract }, async (request, reply) =>
    reply.code(201).send(await portalReturnPhoto(processFiles(), app, request, request.params.returnId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/portal/returns/:returnId/photos/:fileId/complete', { schema: returnPhotoDoneContract }, async (request) => portalReturnPhotoDone(processFiles(), app, request, request.params.returnId, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/portal/complaints', { schema: reportComplaintContract }, async (request, reply) => reply.code(201).send(await portalReportComplaint(app, request, request.body, idempotencyKeyFrom(request))))
  app.get('/portal/complaints', { schema: complaintsContract }, async (request) => portalComplaints(app, request))
  app.get('/portal/complaints/:complaintId', { schema: complaintContract }, async (request) => portalComplaint(app, request, request.params.complaintId))
  app.post('/portal/complaints/:complaintId/photos', { schema: complaintPhotoContract }, async (request, reply) =>
    reply.code(201).send(await portalComplaintPhoto(processFiles(), app, request, request.params.complaintId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/portal/complaints/:complaintId/photos/:fileId/complete', { schema: complaintPhotoDoneContract }, async (request) =>
    portalComplaintPhotoDone(processFiles(), app, request, request.params.complaintId, request.params.fileId, idempotencyKeyFrom(request)),
  )

  // ---- the claim link ----------------------------------------------------------------------------------------------------
  app.get('/link/claim', { schema: linkClaimContract }, async (request) => linkClaim(app, request, request.query.language))
  app.post('/link/claim', { schema: submitClaimContract }, async (request, reply) => reply.code(201).send(await submitClaim(app, request, request.body, request.query.language)))
  app.get('/link/claim/cases/:caseType/:caseId', { schema: linkCaseContract }, async (request) => linkClaimCase(app, request, request.params.caseType, request.params.caseId))
  app.post('/link/claim/photos', { schema: linkPhotoContract }, async (request, reply) => reply.code(201).send(await linkClaimPhoto(processFiles(), request, request.body, idempotencyKeyFrom(request))))
  app.post('/link/claim/photos/:fileId/complete', { schema: linkPhotoDoneContract }, async (request) => linkClaimPhotoDone(processFiles(), request, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/link/claim/files/:fileId/open', { schema: linkOpenFileContract }, async (request) => linkClaimFile(processFiles(), app, request, request.params.fileId, request.body))
  app.get('/link/claim/returns/:returnId/instructions', { schema: linkInstructionsContract }, async (request, reply) => {
    const { pdf: body, fileName } = await linkInstructions(app, request, request.params.returnId, request.query.language)
    return reply.headers(pdf(fileName)).send(body)
  })
  app.post('/link/tracking/claim', { schema: trackingClaimContract }, async (request, reply) => reply.code(201).send(await claimFromTracking(app, request)))

  // ---- the office --------------------------------------------------------------------------------------------------------
  app.post('/sales/returns/:returnId/authorise', { schema: authoriseContract }, async (request) => authoriseReturn(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/returns/:returnId/reject', { schema: rejectContract }, async (request) => rejectReturn(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/claim-links', { schema: claimLinkContract }, async (request, reply) => reply.code(201).send(await sendClaimLink(request, request.body)))
  app.post('/quality/complaints/:complaintId/answer/publish', { schema: publishAnswerContract }, async (request) => publishAnswer(processFiles(), request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/complaints/:complaintId/share-eight-d', { schema: shareEightDContract }, async (request) => shareEightD(processFiles(), request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
})
