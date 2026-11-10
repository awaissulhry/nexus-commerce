import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addArtwork, approveArtwork, readLabelArtwork, removeArtwork, retireArtwork } from './artwork'
import { artworkActContract, artworkAddContract, artworkReadContract, artworkRemoveContract, labelLinesReadContract, labelLinesRefreshContract, reconciliationContract, spoiledContract } from './contract'
// B-W2b-254's one gate: this step's checks plugged in by name (label.artwork, label.reconciliation).
import './gate-plug'
import { readLabelLines, refreshLabelLines } from './lines'
import { manifest } from './manifest'
import { logSpoiledLabels, readReconciliation } from './reconciliation'

/**
 * Label artwork, label lines in the BOM and the label reconciliation (B-W2b-259; PRD-347, PRD-088, MES-140): a label
 * revision's artwork versions (add a draft proof, approve by a second person, retire, remove a draft), a draft style
 * revision's label and packaging lines made by the rules (read the plan, refresh), and a work order's reconciliation with
 * Log spoiled labels (floor and office). Every write is one command; a repeated Idempotency-Key answers from its receipt.
 */
export default defineRoutes('compliance.label-artwork', manifest, async (app) => {
  app.get('/compliance/label-artwork/templates/:templateId', { schema: artworkReadContract }, async (request) => ({ artwork: await readLabelArtwork(request, request.params.templateId) }))

  app.post('/compliance/label-artwork/templates/:templateId/versions', { schema: artworkAddContract }, async (request, reply) => {
    const result = await addArtwork(request, request.params.templateId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send({ artwork: result.artwork })
  })

  app.post('/compliance/label-artwork/versions/:artworkId/approve', { schema: artworkActContract }, async (request) => ({ artwork: await approveArtwork(request, request.params.artworkId, request.body, idempotencyKeyFrom(request)) }))

  app.post('/compliance/label-artwork/versions/:artworkId/retire', { schema: artworkActContract }, async (request) => ({ artwork: await retireArtwork(request, request.params.artworkId, request.body, idempotencyKeyFrom(request)) }))

  app.delete('/compliance/label-artwork/versions/:artworkId', { schema: artworkRemoveContract }, async (request) => ({ artwork: await removeArtwork(request, request.params.artworkId, request.query.version, idempotencyKeyFrom(request)) }))

  app.get('/product/styles/:styleId/revisions/:revisionId/bom/label-lines', { schema: labelLinesReadContract }, async (request) => ({ lines: await readLabelLines(request, request.params.styleId, request.params.revisionId) }))

  app.post('/product/styles/:styleId/revisions/:revisionId/bom/label-lines/refresh', { schema: labelLinesRefreshContract }, async (request) =>
    refreshLabelLines(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/production/serials/work-orders/:workOrderId/reconciliation', { schema: reconciliationContract }, async (request) => ({ reconciliation: await readReconciliation(request, request.params.workOrderId) }))

  app.post('/production/serials/work-orders/:workOrderId/spoiled', { schema: spoiledContract }, async (request, reply) => {
    const result = await logSpoiledLabels(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
})
