import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { compareWithMaster } from './compare'
import { cancelContract, cellsContract, compareContract, countsContract, createContract, getContract, listContract, moveContract, openLinesContract, releaseCheckContract, releaseContract, updateContract } from './contract'
import { manifest } from './manifest'
import { moveWorkOrder } from './moves'
import { releaseCheck, releaseWorkOrder } from './release'
import { countWorkOrders, createWorkOrder, getWorkOrder, listWorkOrders, openLines, setCells, updateWorkOrder } from './work-orders'
import { createRepairWorkOrder, repairOptions, setRepairSteps } from './repairs'
import { createRepairContract, repairOptionsContract, repairStepsContract } from './contract'
import { listReadinessContract } from './release/contract'
import { listReadiness } from './release/readiness'
// B-W2b-51: split a work order (MES-010) and its travellers (MES-014).
import { splitContract, splitPreviewContract, travellerContract, travellersContract } from './contract'
import { previewSplit, splitWorkOrder } from './split'
import { inlineDisposition, travellerPdf, travellersPdf } from './traveller'

/**
 * Work orders from sales order lines with a frozen specification (B-W1-38; MES-001, MES-002, MES-005, MES-007,
 * MES-305; A2 SCR-069, SCR-070): the list and record, a DRAFT and its cells and details, the release check and the
 * release, start / complete / close / cancel, and the frozen spec against today's master. Made-to-measure work orders
 * come later (B-W1-17/18): a made-to-measure line is refused (409). B-W2b-51: the rush flag (create, PATCH, list), split a
 * DRAFT (preview and split), the travellers (PDF with a QR); the bulk release is the list frame's (platform/views/bulk).
 */
export default defineRoutes('production.work-orders', manifest, async (app) => {
  app.get('/production/work-orders', { schema: listContract }, async (request) => listWorkOrders(request, request.query))

  app.get('/production/work-orders/counts', { schema: countsContract }, async (request) => countWorkOrders(request, request.query))

  app.get('/production/work-orders/open-lines', { schema: openLinesContract }, async (request) => openLines(request, request.query.salesOrderId))

  // B-W2a-46 (MES-004; design wo-grid "Readiness (W2a word)"): the plan's readiness word of the list's work orders.
  app.get('/production/work-orders/readiness', { schema: listReadinessContract }, async (request) => listReadiness(request, request.query))

  app.get('/production/work-orders/:workOrderId', { schema: getContract }, async (request) => getWorkOrder(request, request.params.workOrderId))

  app.get('/production/work-orders/:workOrderId/release-check', { schema: releaseCheckContract }, async (request) => releaseCheck(request, request.params.workOrderId))

  app.get('/production/work-orders/:workOrderId/spec/compare', { schema: compareContract }, async (request) => compareWithMaster(request, request.params.workOrderId))

  app.post('/production/work-orders', { schema: createContract }, async (request, reply) => reply.code(201).send(await createWorkOrder(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/production/work-orders/:workOrderId', { schema: updateContract }, async (request) => updateWorkOrder(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))

  app.put('/production/work-orders/:workOrderId/cells', { schema: cellsContract }, async (request) => setCells(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/work-orders/:workOrderId/release', { schema: releaseContract }, async (request) => releaseWorkOrder(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/work-orders/:workOrderId/start', { schema: moveContract }, async (request) => moveWorkOrder(request, request.params.workOrderId, 'IN_PROGRESS', request.body, idempotencyKeyFrom(request)))

  app.post('/production/work-orders/:workOrderId/complete', { schema: moveContract }, async (request) => moveWorkOrder(request, request.params.workOrderId, 'COMPLETED', request.body, idempotencyKeyFrom(request)))

  app.post('/production/work-orders/:workOrderId/close', { schema: moveContract }, async (request) => moveWorkOrder(request, request.params.workOrderId, 'CLOSED', request.body, idempotencyKeyFrom(request)))

  app.post('/production/work-orders/:workOrderId/cancel', { schema: cancelContract }, async (request) => moveWorkOrder(request, request.params.workOrderId, 'CANCELLED', request.body, idempotencyKeyFrom(request)))

  // B-W2a-12 (MES-019): a repair work order from a repair order, its steps, and what the dialog needs.
  app.get('/production/work-orders/repair-options', { schema: repairOptionsContract }, async (request) => repairOptions(request, request.query.repairOrderId))

  app.post('/production/work-orders/repairs', { schema: createRepairContract }, async (request, reply) => reply.code(201).send(await createRepairWorkOrder(request, request.body, idempotencyKeyFrom(request))))

  app.put('/production/work-orders/:workOrderId/repair-steps', { schema: repairStepsContract }, async (request) => setRepairSteps(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-51 (MES-010): split a DRAFT in two — what each side keeps and gets, then the split.
  app.post('/production/work-orders/:workOrderId/split/preview', { schema: splitPreviewContract }, async (request) => previewSplit(request, request.params.workOrderId, request.body))

  app.post('/production/work-orders/:workOrderId/split', { schema: splitContract }, async (request, reply) => reply.code(201).send(await splitWorkOrder(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))))

  // B-W2b-51 (MES-014): the traveller PDF with its QR code, of one work order or of several.
  app.get('/production/work-orders/travellers', { schema: travellersContract }, async (request, reply) => {
    const { pdf, fileName } = await travellersPdf(request, request.query.ids, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.get('/production/work-orders/:workOrderId/traveller', { schema: travellerContract }, async (request, reply) => {
    const { pdf, fileName } = await travellerPdf(request, request.params.workOrderId, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
})
