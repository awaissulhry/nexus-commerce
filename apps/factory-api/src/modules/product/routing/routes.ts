import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { compareRoutings } from './compare'
import { addStepsContract, compareRoutingContract, copyStepsContract, getRoutingContract, removeStepContract, reorderStepsContract, updateStepContract } from './contract'
import { manifest } from './manifest'
import { addSteps, copyRoutingSteps, removeStep, reorderSteps, updateStep } from './steps'
import { loadRouting, readRevisionFor, routingViewOf } from './store'

/**
 * One routing per style revision (product module, B-W1-14; A2 SCR-043; features PRD-110, PRD-111): the operations that
 * make the garment, in order, each a copy of a library operation (modules/product/operations) with its standard minutes
 * for this style and whether the floor scans it; the minutes per garment, per size and per kind of work centre; the
 * steps of a released routing copied in; two revisions compared. Edited only while the revision is a DRAFT; the
 * revision's copy, release and obsolete are the BOM routes' (B-W1-13), and they carry the routing with them.
 */
export default defineRoutes('product.routing', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/routing', { schema: getRoutingContract }, async (request) => {
    const { style, revision } = await readRevisionFor(request, request.params.styleId, request.params.revisionId)
    return { routing: routingViewOf(await request.withClient((client) => loadRouting(client, style, revision))) }
  })

  app.post('/product/styles/:styleId/revisions/:revisionId/routing/steps', { schema: addStepsContract }, async (request, reply) =>
    reply.code(201).send({ routing: await addSteps(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId', { schema: updateStepContract }, async (request) => ({
    routing: await updateStep(request, request.params.styleId, request.params.revisionId, request.params.stepId, request.body, idempotencyKeyFrom(request)),
  }))

  app.delete('/product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId', { schema: removeStepContract }, async (request) => ({
    routing: await removeStep(request, request.params.styleId, request.params.revisionId, request.params.stepId, request.query.version, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/routing/order', { schema: reorderStepsContract }, async (request) => ({
    routing: await reorderSteps(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/routing/copy', { schema: copyStepsContract }, async (request) => ({
    routing: await copyRoutingSteps(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/product/styles/:styleId/routing/compare', { schema: compareRoutingContract }, async (request) => ({
    diff: await compareRoutings(request, request.params.styleId, request.query),
  }))
})
