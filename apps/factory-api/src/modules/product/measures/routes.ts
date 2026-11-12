import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addSpecPointsContract,
  announcePictureContract,
  clearPictureContract,
  completePictureContract,
  createPomContract,
  getPomContract,
  getSpecContract,
  listPomsContract,
  lookAtPictureContract,
  pomStatusContract,
  specCellsContract,
  specMoveContract,
  specPointsContract,
  startSpecContract,
  updatePomContract,
  updateSpecContract,
} from './contract'
import { manifest } from './manifest'
import { announcePicture, clearPicture, completePicture, lookAtPicture } from './picture'
import { createPom, getPom, listPoms, setPomStatus, updatePom } from './points'
import { addSpecPoints, approveSpec, archiveSpec, getSpec, removeSpecPoints, reorderSpecPoints, reopenSpec, startSpec, updateSpec, writeSpecCells } from './spec'
// B-W2b-283 (FU1:03): the measurement templates, listed for pickers.
import { listTemplates, listTemplatesContract } from './templates'

/**
 * Points of measure and the measurement spec (product module, B-W2b-224; PRD-049, PRD-052, PRD-062, PRD-063, PRD-069;
 * design products.sizes "Points of measure" and products.styles › Sizes & measurements › "Measurement spec"): the
 * library of body and garment points with how to measure each and its picture, and per draft style revision the garment
 * measures each size must have (nominal, tolerance under and over), typed for the base size, graded by a rule
 * (../grading), edited, approved. The final inspection's size check reads the approved spec of the work order's revision
 * (modules/quality/final/size-spec.ts); a copied revision copies it (./copy.ts).
 */
export default defineRoutes('product.measures', manifest, async (app) => {
  app.get('/product/points-of-measure', { schema: listPomsContract }, async (request) => listPoms(request, request.query))
  app.post('/product/points-of-measure', { schema: createPomContract }, async (request, reply) => reply.code(201).send({ point: await createPom(request, request.body, idempotencyKeyFrom(request)) }))
  app.get('/product/points-of-measure/:pomId', { schema: getPomContract }, async (request) => ({ point: await getPom(request, request.params.pomId) }))
  app.patch('/product/points-of-measure/:pomId', { schema: updatePomContract }, async (request) => ({ point: await updatePom(request, request.params.pomId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/points-of-measure/status', { schema: pomStatusContract }, async (request) => setPomStatus(request, request.body, idempotencyKeyFrom(request)))
  app.post('/product/points-of-measure/:pomId/picture', { schema: announcePictureContract }, async (request, reply) =>
    reply.code(201).send(await announcePicture(request, request.params.pomId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/product/points-of-measure/:pomId/picture/:fileId/complete', { schema: completePictureContract }, async (request) =>
    completePicture(request, request.params.pomId, request.params.fileId, idempotencyKeyFrom(request)),
  )
  app.get('/product/points-of-measure/:pomId/picture', { schema: lookAtPictureContract }, async (request) => lookAtPicture(request, request.params.pomId))
  app.delete('/product/points-of-measure/:pomId/picture', { schema: clearPictureContract }, async (request) => ({ point: await clearPicture(request, request.params.pomId, request.query.version, idempotencyKeyFrom(request)) }))
  // B-W2b-283 (FU1:03).
  app.get('/product/measurement-templates', { schema: listTemplatesContract }, async (request) => listTemplates(request, request.query))

  app.get('/product/styles/:styleId/revisions/:revisionId/measurement-spec', { schema: getSpecContract }, async (request) => ({ spec: await getSpec(request, request.params.styleId, request.params.revisionId) }))
  app.post('/product/styles/:styleId/revisions/:revisionId/measurement-spec', { schema: startSpecContract }, async (request, reply) =>
    reply.code(201).send({ spec: await startSpec(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/product/styles/:styleId/revisions/:revisionId/measurement-spec', { schema: updateSpecContract }, async (request) => ({ spec: await updateSpec(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
  app.put('/product/styles/:styleId/revisions/:revisionId/measurement-spec/cells', { schema: specCellsContract }, async (request) => ({ spec: await writeSpecCells(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/styles/:styleId/revisions/:revisionId/measurement-spec/points', { schema: addSpecPointsContract }, async (request) => ({ spec: await addSpecPoints(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/styles/:styleId/revisions/:revisionId/measurement-spec/points/remove', { schema: specPointsContract }, async (request) => ({ spec: await removeSpecPoints(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
  app.put('/product/styles/:styleId/revisions/:revisionId/measurement-spec/points/order', { schema: specPointsContract }, async (request) => ({ spec: await reorderSpecPoints(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/styles/:styleId/revisions/:revisionId/measurement-spec/approve', { schema: specMoveContract }, async (request) => ({ spec: await approveSpec(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/styles/:styleId/revisions/:revisionId/measurement-spec/reopen', { schema: specMoveContract }, async (request) => ({ spec: await reopenSpec(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/styles/:styleId/revisions/:revisionId/measurement-spec/archive', { schema: specMoveContract }, async (request) => ({ spec: await archiveSpec(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
})
