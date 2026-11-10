import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createPrepackContract, getPrepackContract, getStylePrepacksContract, prepackStatusContract, updatePrepackContract } from './contract'
import { manifest } from './manifest'
import { createPrepack, getPrepack, getStylePrepacks, setPrepackStatus, updatePrepack } from './prepacks'

/**
 * Prepacks (product module, B-W2b-233; PRD-055; design products.styles › Sizes & measurements › "Prepacks"): fixed mixes of
 * pieces per size (and colourway) that dealers order as one unit, for one style or for every style of a size scale. Not a
 * part of a revision. W2b-5's order lines read them (GET /product/prepacks/:prepackId: the lines, pieces per size and
 * whether the style can sell the pack).
 */
export default defineRoutes('product.prepacks', manifest, async (app) => {
  app.get('/product/styles/:styleId/prepacks', { schema: getStylePrepacksContract }, async (request) => ({ prepacks: await getStylePrepacks(request, request.params.styleId) }))
  app.post('/product/styles/:styleId/prepacks', { schema: createPrepackContract }, async (request, reply) =>
    reply.code(201).send({ prepack: await createPrepack(request, request.params.styleId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.get('/product/prepacks/:prepackId', { schema: getPrepackContract }, async (request) => ({ prepack: await getPrepack(request, request.params.prepackId) }))
  app.patch('/product/prepacks/:prepackId', { schema: updatePrepackContract }, async (request) => ({ prepack: await updatePrepack(request, request.params.prepackId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/prepacks/status', { schema: prepackStatusContract }, async (request) => ({ prepacks: await setPrepackStatus(request, request.body, idempotencyKeyFrom(request)) }))
})
