import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { announceAnswerContract, answerContract, completeAnswerContract, getReviewContract, listReviewsContract, notifyContract, notNeededContract, styleChangesContract } from './contract'
import { manifest } from './manifest'
import { announceAnswer, completeAnswer, getReview, listReviews, notifyBody, notNeeded, recordAnswer, styleChanges } from './reviews'

/**
 * Changes to an approved type (B-W2a-66; PRD-285; Reg. (EU) 2016/425 Annex V 7.2): the reviews a revision's release opens
 * (detect.ts, called by the BOM's release), what the notified body was told and answered, and the style compliance tab's
 * "Changes that may need the notified body". While a review holds it, the revision's class label does not print
 * (classLabelHoldFor, asked by the garment label).
 */
export default defineRoutes('compliance.type-changes', manifest, async (app) => {
  app.get('/compliance/type-changes', { schema: listReviewsContract }, async (request) => listReviews(request, request.query))

  app.get('/compliance/type-changes/styles/:styleId', { schema: styleChangesContract }, async (request) => styleChanges(request, request.params.styleId, request.query.revisionId))

  app.get('/compliance/type-changes/:reviewId', { schema: getReviewContract }, async (request) => getReview(request, request.params.reviewId))

  app.post('/compliance/type-changes/:reviewId/notify', { schema: notifyContract }, async (request) => notifyBody(request, request.params.reviewId, request.body, idempotencyKeyFrom(request)))

  app.post('/compliance/type-changes/:reviewId/not-needed', { schema: notNeededContract }, async (request) => notNeeded(request, request.params.reviewId, request.body, idempotencyKeyFrom(request)))

  app.post('/compliance/type-changes/:reviewId/answer', { schema: answerContract }, async (request) => recordAnswer(request, request.params.reviewId, request.body, idempotencyKeyFrom(request)))

  app.post('/compliance/type-changes/:reviewId/answer-file', { schema: announceAnswerContract }, async (request, reply) => {
    return reply.code(201).send(await announceAnswer(request, request.params.reviewId, request.body, idempotencyKeyFrom(request)))
  })

  app.post('/compliance/type-changes/:reviewId/answer-file/:fileId/complete', { schema: completeAnswerContract }, async (request) =>
    completeAnswer(request, request.params.reviewId, request.params.fileId, idempotencyKeyFrom(request)),
  )
})
