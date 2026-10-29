import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addColourway, updateColourway } from './colourways'
import {
  addColourwayContract,
  addSizesContract,
  createRevisionContract,
  createScaleContract,
  createStyleContract,
  garmentTrackingContract,
  generateSkusContract,
  getScaleContract,
  getStyleContract,
  listColoursContract,
  listRevisionsContract,
  listScalesContract,
  listStylesContract,
  reorderSizesContract,
  scaleStatusContract,
  styleStatusContract,
  updateColourwayContract,
  updateScaleContract,
  updateSizeContract,
  updateSkuContract,
  updateStyleContract,
} from './contract'
import { listColours } from './colours'
import { manifest } from './manifest'
import { createRevision, listRevisions } from './revisions'
import { addSizes, createScale, getScale, listScales, moveScale, reorderSizes, updateScale, updateSize } from './scales'
import { generateSkus, updateSku } from './skus'
import { createStyle, getStyle, listStyles, moveStyle, setGarmentTracking, updateStyle } from './styles'

/**
 * Styles, colourways, size scales and the colour x size SKU matrix (product module, B-W1-11; A2 SCR-040, SCR-041,
 * SCR-049; features PRD-001, PRD-002, PRD-004, PRD-005, PRD-022, PRD-047, PRD-048, PRD-270). The BOM and the routing
 * of a revision are later steps (B-W1-13, B-W1-14); this step makes the revision's DRAFT shell.
 */
export default defineRoutes('product.styles', manifest, async (app) => {
  app.get('/product/styles', { schema: listStylesContract }, async (request) => listStyles(request, request.query))

  app.get('/product/styles/:styleId', { schema: getStyleContract }, async (request) => ({ style: await getStyle(request, request.params.styleId) }))

  app.post('/product/styles', { schema: createStyleContract }, async (request, reply) =>
    reply.code(201).send({ style: await createStyle(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/styles/:styleId', { schema: updateStyleContract }, async (request) => ({
    style: await updateStyle(request, request.params.styleId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/archive', { schema: styleStatusContract }, async (request) => ({
    style: await moveStyle(request, request.params.styleId, 'archive', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/reactivate', { schema: styleStatusContract }, async (request) => ({
    style: await moveStyle(request, request.params.styleId, 'reactivate', request.body, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/garment-tracking', { schema: garmentTrackingContract }, async (request) => ({
    style: await setGarmentTracking(request, request.params.styleId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/colourways', { schema: addColourwayContract }, async (request, reply) =>
    reply.code(201).send({ style: await addColourway(request, request.params.styleId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/styles/:styleId/colourways/:colourwayId', { schema: updateColourwayContract }, async (request) => ({
    style: await updateColourway(request, request.params.styleId, request.params.colourwayId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/skus/generate', { schema: generateSkusContract }, async (request) =>
    generateSkus(request, request.params.styleId, request.body, idempotencyKeyFrom(request)),
  )

  app.patch('/product/styles/:styleId/skus/:skuId', { schema: updateSkuContract }, async (request) => ({
    style: await updateSku(request, request.params.styleId, request.params.skuId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/product/styles/:styleId/revisions', { schema: listRevisionsContract }, async (request) => ({ revisions: await listRevisions(request, request.params.styleId) }))

  app.post('/product/styles/:styleId/revisions', { schema: createRevisionContract }, async (request, reply) =>
    reply.code(201).send({ revision: await createRevision(request, request.params.styleId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.get('/product/colours', { schema: listColoursContract }, async (request) => listColours(request, request.query))

  app.get('/product/size-scales', { schema: listScalesContract }, async (request) => listScales(request, request.query))

  app.get('/product/size-scales/:scaleId', { schema: getScaleContract }, async (request) => ({ scale: await getScale(request, request.params.scaleId) }))

  app.post('/product/size-scales', { schema: createScaleContract }, async (request, reply) =>
    reply.code(201).send({ scale: await createScale(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/size-scales/:scaleId', { schema: updateScaleContract }, async (request) => ({
    scale: await updateScale(request, request.params.scaleId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/size-scales/:scaleId/sizes', { schema: addSizesContract }, async (request, reply) =>
    reply.code(201).send({ scale: await addSizes(request, request.params.scaleId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.put('/product/size-scales/:scaleId/order', { schema: reorderSizesContract }, async (request) => ({
    scale: await reorderSizes(request, request.params.scaleId, request.body, idempotencyKeyFrom(request)),
  }))

  app.patch('/product/size-scales/:scaleId/sizes/:sizeId', { schema: updateSizeContract }, async (request) => ({
    scale: await updateSize(request, request.params.scaleId, request.params.sizeId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/size-scales/:scaleId/archive', { schema: scaleStatusContract }, async (request) => ({
    scale: await moveScale(request, request.params.scaleId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/size-scales/:scaleId/reactivate', { schema: scaleStatusContract }, async (request) => ({
    scale: await moveScale(request, request.params.scaleId, 'ACTIVE', request.body, idempotencyKeyFrom(request)),
  }))
})
