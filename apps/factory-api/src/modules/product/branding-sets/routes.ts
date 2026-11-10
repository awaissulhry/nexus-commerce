import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addSetFileContract, brandsContract, createSetContract, getSetContract, listSetsContract, setStatusContract, updateSetContract } from './contract'
import { manifest } from './manifest'
import { addSetFile, brandCandidates, createSet, getSet, listSets, setSetStatus, updateSet } from './sets'

/**
 * Products › Colours & artwork, the branding sets (product module, B-W2b-247; PRD-045; design products.colours
 * sec:colours.branding, pop:colours.branding): per private-label customer its logos, label artwork, packaging rules and brand
 * colours, linked to its styles. B-W2b-259's label lines and B-W2b-230's tech pack read the brand's ACTIVE set.
 */
export default defineRoutes('product.branding-sets', manifest, async (app) => {
  app.get('/product/branding-sets', { schema: listSetsContract }, async (request) => listSets(request, request.query))
  app.get('/product/branding-sets/brands', { schema: brandsContract }, async (request) => brandCandidates(request, request.query))
  app.get('/product/branding-sets/:setId', { schema: getSetContract }, async (request) => ({ set: await getSet(request, request.params.setId) }))
  app.post('/product/branding-sets', { schema: createSetContract }, async (request, reply) => reply.code(201).send({ set: await createSet(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/product/branding-sets/:setId', { schema: updateSetContract }, async (request) => ({ set: await updateSet(request, request.params.setId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/branding-sets/:setId/files', { schema: addSetFileContract }, async (request) => ({ set: await addSetFile(request, request.params.setId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/branding-sets/:setId/archive', { schema: setStatusContract }, async (request) => ({ set: await setSetStatus(request, request.params.setId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/branding-sets/:setId/restore', { schema: setStatusContract }, async (request) => ({ set: await setSetStatus(request, request.params.setId, 'ACTIVE', request.body, idempotencyKeyFrom(request)) }))
})
