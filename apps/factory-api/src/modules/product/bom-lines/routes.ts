import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { readRevisionFor } from '../bom/store'
import { addAlternate, orderAlternates, removeAlternate, updateAlternate } from './alternates'
import { addAlternateContract, changeSupplyContract, getDepthContract, orderAlternatesContract, removeAlternateContract, setOutputContract, setSupplyContract, updateAlternateContract } from './contract'
import { manifest } from './manifest'
import { setOutput } from './output'
import { depthViewOf, loadDepth } from './store'
import { changeSupply, setSupply } from './supply'

/**
 * BOM lines in depth (product module, B-W2b-228; features PRD-083, PRD-084, PRD-099, PRD-108): a line's alternates first
 * choice first with when each may be used and the certificate check a PPE component needs; the customer or brand that sends
 * a line's material (no cost: costing leaves it out; no purchase: planning's demand leaves it out); the lines marked for the
 * workshop, which make a subcontract order's kit (purchasing/subcontracting/kit-lines.ts); what the BOM makes (PCS, PAIR or
 * SET). W1's BOM routes keep the lines (product/bom); B-W2b-223's structure routes keep sections, groups and sub-assemblies.
 */
export default defineRoutes('product.bom-lines', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/bom/depth', { schema: getDepthContract }, async (request) => {
    const { style, revision } = await readRevisionFor(request, request.params.styleId, request.params.revisionId)
    return { depth: await request.withClient(async (client) => depthViewOf(await loadDepth(client, style, revision))) }
  })

  app.post('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/alternates', { schema: addAlternateContract }, async (request, reply) =>
    reply.code(201).send({ depth: await addAlternate(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/alternates/:alternateId', { schema: updateAlternateContract }, async (request) => ({
    depth: await updateAlternate(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.params.alternateId, request.body, idempotencyKeyFrom(request)),
  }))

  app.delete('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/alternates/:alternateId', { schema: removeAlternateContract }, async (request) => ({
    depth: await removeAlternate(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.params.alternateId, request.query.version, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/alternate-order', { schema: orderAlternatesContract }, async (request) => ({
    depth: await orderAlternates(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/supply', { schema: setSupplyContract }, async (request) => ({
    depth: await setSupply(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/bom/supply/change', { schema: changeSupplyContract }, async (request) => ({
    depth: await changeSupply(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/bom/output', { schema: setOutputContract }, async (request) => ({
    depth: await setOutput(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))
})
