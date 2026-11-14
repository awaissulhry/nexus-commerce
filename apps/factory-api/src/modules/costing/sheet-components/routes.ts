import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { revisionComponents, sheetSplit, workOrderCostSplit, writeSheetComponents } from './components'
import {
  archiveLeatherBasisContract,
  archiveUpliftContract,
  componentsContract,
  createLeatherBasisContract,
  createUpliftContract,
  landedContract,
  leatherBasisContract,
  listLeatherBasesContract,
  listUpliftsContract,
  pieceRateLabourContract,
  setPieceRateLabourContract,
  sheetSplitContract,
  updateLeatherBasisContract,
  updateUpliftContract,
  upliftContract,
  workOrderSplitContract,
  writeComponentsContract,
} from './contract'
import {
  archiveLeatherBasis,
  archiveUplift,
  createLeatherBasis,
  createUplift,
  landedPreview,
  leatherBasisRecord,
  listLeatherBases,
  listUplifts,
  pieceRateLabour,
  setPieceRateLabour,
  updateLeatherBasis,
  updateUplift,
  upliftRecord,
} from './inputs'
import { manifest } from './manifest'

/**
 * The cost sheet's components (B-W2b-418; FIN-003, FIN-006, FIN-008, FIN-009, FIN-011, FIN-020): a revision's components
 * computed now (leather's bought area, labour by time or piece rate, outside operations with their transport, freight and
 * duty, packaging, overhead), a draft sheet's lines written from them, a written sheet's split and a work order's split from
 * the sheet through its cost ledger to the margin; the leather bases, the uplifts with the landed cost they may be read from,
 * and the piece-rate labour switch. Every write takes an Idempotency-Key (a repeat answers from its receipt) and the row's
 * version; every refusal is a 409 `refusal/<CODE>` with its words.
 */
export default defineRoutes('costing.sheet-components', manifest, async (app) => {
  app.get('/costing/styles/:styleId/revisions/:revisionId/components', { schema: componentsContract }, async (request) => revisionComponents(request, request.params.styleId, request.params.revisionId, request.query))
  app.post('/costing/cost-sheets/:sheetId/components', { schema: writeComponentsContract }, async (request) => writeSheetComponents(request, request.params.sheetId, request.body, idempotencyKeyFrom(request)))
  app.get('/costing/cost-sheets/:sheetId/split', { schema: sheetSplitContract }, async (request) => sheetSplit(request, request.params.sheetId))
  app.get('/costing/work-orders/:workOrderId/cost-split', { schema: workOrderSplitContract }, async (request) => workOrderCostSplit(request, request.params.workOrderId))

  app.get('/costing/leather-bases', { schema: listLeatherBasesContract }, async (request) => listLeatherBases(request, request.query))
  app.get('/costing/leather-bases/:basisId', { schema: leatherBasisContract }, async (request) => leatherBasisRecord(request, request.params.basisId))
  app.post('/costing/leather-bases', { schema: createLeatherBasisContract }, async (request, reply) => reply.code(201).send(await createLeatherBasis(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/costing/leather-bases/:basisId', { schema: updateLeatherBasisContract }, async (request) => updateLeatherBasis(request, request.params.basisId, request.body, idempotencyKeyFrom(request)))
  app.post('/costing/leather-bases/:basisId/archive', { schema: archiveLeatherBasisContract }, async (request) => archiveLeatherBasis(request, request.params.basisId, request.body, idempotencyKeyFrom(request)))

  app.get('/costing/uplifts', { schema: listUpliftsContract }, async (request) => listUplifts(request, request.query))
  app.get('/costing/uplifts/landed', { schema: landedContract }, async (request) => landedPreview(request, request.query))
  app.get('/costing/uplifts/:upliftId', { schema: upliftContract }, async (request) => upliftRecord(request, request.params.upliftId))
  app.post('/costing/uplifts', { schema: createUpliftContract }, async (request, reply) => reply.code(201).send(await createUplift(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/costing/uplifts/:upliftId', { schema: updateUpliftContract }, async (request) => updateUplift(request, request.params.upliftId, request.body, idempotencyKeyFrom(request)))
  app.post('/costing/uplifts/:upliftId/archive', { schema: archiveUpliftContract }, async (request) => archiveUplift(request, request.params.upliftId, request.body, idempotencyKeyFrom(request)))

  app.get('/costing/piece-rate-labour', { schema: pieceRateLabourContract }, async (request) => pieceRateLabour(request, request.query.companyId))
  app.put('/costing/piece-rate-labour', { schema: setPieceRateLabourContract }, async (request) => setPieceRateLabour(request, request.body, idempotencyKeyFrom(request)))
})
