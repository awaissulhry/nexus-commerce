import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { assignGtins } from './assign'
import { assignContract, createRangeContract, importContract, listRangesContract, rangeStatusContract, updateRangeContract } from './contract'
import { importGtins } from './import'
import { manifest } from './manifest'
import { createRange, listRanges, setRangeStatus, updateRange } from './ranges'

/**
 * GTINs in depth (B-W2b-227; PRD-006): GS1 ranges (./ranges.ts), GTINs from a range with a preview and a confirm
 * (./assign.ts, GATE-SPEND), a brand's own barcodes typed or imported (./import.ts). One SKU's barcode is still W1's
 * PATCH /product/styles/:styleId/skus/:skuId (styles/skus.ts), which now refuses a shipped SKU's change in words.
 */
export default defineRoutes('product.gtin', manifest, async (app) => {
  app.get('/product/gtin-ranges', { schema: listRangesContract }, async (request) => listRanges(request, request.query))
  app.post('/product/gtin-ranges', { schema: createRangeContract }, async (request, reply) => {
    const range = await createRange(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send({ range })
  })
  app.patch('/product/gtin-ranges/:rangeId', { schema: updateRangeContract }, async (request) => ({ range: await updateRange(request, request.params.rangeId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/gtin-ranges/:rangeId/archive', { schema: rangeStatusContract }, async (request) => ({
    range: await setRangeStatus(request, request.params.rangeId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/product/gtin-ranges/:rangeId/restore', { schema: rangeStatusContract }, async (request) => ({
    range: await setRangeStatus(request, request.params.rangeId, 'ACTIVE', request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/product/styles/:styleId/gtins/assign', { schema: assignContract }, async (request) => ({
    assignment: await assignGtins(request, request.params.styleId, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/product/gtins/import', { schema: importContract }, async (request) => ({ import: await importGtins(request, request.body, idempotencyKeyFrom(request)) }))
})
