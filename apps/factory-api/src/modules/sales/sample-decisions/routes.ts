import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addCommentContract,
  createSwatchContract,
  decideRoundContract,
  decideSwatchContract,
  listSwatchesContract,
  nextRoundContract,
  readApprovalContract,
  readFitContract,
  removeCommentContract,
  removeSwatchContract,
  saveFitContract,
  testResultContract,
  updateCommentContract,
  updateSwatchContract,
} from './contract'
import { decideRound, nextRound, readApproval, recordTestResult } from './decisions'
import { addComment, readFit, removeComment, saveFit, updateComment } from './fit'
import { manifest } from './manifest'
import { createSwatch, decideSwatch, listSwatches, removeSwatch, updateSwatch } from './swatches'

/**
 * Sample decisions (B-W2b-252): ./decisions.ts (the Approval tab, the office's decision, the next round after a rejection, a
 * CE test sample's result and certificate), ./fit.ts (the fit measured against the spec, fit comments), ./swatches.ts
 * (leather and colour swatches), ./approvals.ts (the brand's answer by link or portal becomes the decision: the approvals
 * engine's adapters for SampleRound and SampleSwatch).
 */
export default defineRoutes('sales.sample-decisions', manifest, async (app) => {
  app.get('/sales/samples/rounds/:roundId/approval', { schema: readApprovalContract }, async (request) => readApproval(request, request.params.roundId))
  app.post('/sales/samples/rounds/:roundId/decision', { schema: decideRoundContract }, async (request) => decideRound(request, request.params.roundId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/samples/rounds/:roundId/next-round', { schema: nextRoundContract }, async (request, reply) =>
    reply.code(201).send({ round: await nextRound(request, request.params.roundId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.post('/sales/samples/rounds/:roundId/test-result', { schema: testResultContract }, async (request) => recordTestResult(request, request.params.roundId, request.body, idempotencyKeyFrom(request)))
  app.get('/sales/samples/rounds/:roundId/fit', { schema: readFitContract }, async (request) => readFit(request, request.params.roundId))
  app.put('/sales/samples/rounds/:roundId/fit', { schema: saveFitContract }, async (request) => saveFit(request, request.params.roundId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/samples/rounds/:roundId/comments', { schema: addCommentContract }, async (request, reply) =>
    reply.code(201).send({ comment: await addComment(request, request.params.roundId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/sales/samples/comments/:commentId', { schema: updateCommentContract }, async (request) => ({ comment: await updateComment(request, request.params.commentId, request.body, idempotencyKeyFrom(request)) }))
  app.delete('/sales/samples/comments/:commentId', { schema: removeCommentContract }, async (request) => removeComment(request, request.params.commentId, request.query.version, idempotencyKeyFrom(request)))
  app.get('/sales/samples/swatches', { schema: listSwatchesContract }, async (request) => listSwatches(request, request.query))
  app.post('/sales/samples/swatches', { schema: createSwatchContract }, async (request, reply) => reply.code(201).send({ swatch: await createSwatch(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/sales/samples/swatches/:swatchId', { schema: updateSwatchContract }, async (request) => ({ swatch: await updateSwatch(request, request.params.swatchId, request.body, idempotencyKeyFrom(request)) }))
  app.delete('/sales/samples/swatches/:swatchId', { schema: removeSwatchContract }, async (request) => removeSwatch(request, request.params.swatchId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/sales/samples/swatches/:swatchId/decision', { schema: decideSwatchContract }, async (request) => ({ swatch: await decideSwatch(request, request.params.swatchId, request.body, idempotencyKeyFrom(request)) }))
})
