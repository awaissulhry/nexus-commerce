import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { listTraceReports, makeTraceReport } from '../trace/report'
import { changeAttributes } from './attributes'
import { attributesContract, checkLifecycleContract, listContract, lotViewContract, regroupContract, splitContract, splitReadContract, traceReportContract, traceReportsContract } from './contract'
import { checkLifecycle } from './lifecycle'
import { listLotsDepth } from './list'
import { manifest } from './manifest'
import { readLotView } from './page'
import { readSplit, regroupLot, splitLot } from './split'

/**
 * Lots in depth (B-W2b-313): the list with the lifecycle (./list.ts), the lot page's W2b facts (./page.ts), the lifecycle
 * checked now (./lifecycle.ts), the attributes (./attributes.ts), split into shade groups and regroup (./split.ts), and the
 * dated trace report (../trace/report.ts).
 */
export default defineRoutes('inventory.lotsDepth', manifest, async (app) => {
  app.get('/inventory/lots-depth', { schema: listContract }, async (request) => listLotsDepth(request, request.query))

  app.get('/inventory/lots/:lotId/depth', { schema: lotViewContract }, async (request) => readLotView(request, request.params.lotId))

  app.post('/inventory/lots/:lotId/lifecycle/check', { schema: checkLifecycleContract }, async (request) => {
    const outcome = await checkLifecycle(request, request.params.lotId)
    return { ...outcome, lot: await readLotView(request, request.params.lotId) }
  })

  app.patch('/inventory/lots/:lotId/attributes', { schema: attributesContract }, async (request) => changeAttributes(request, request.params.lotId, request.body, idempotencyKeyFrom(request)))

  app.get('/inventory/lots/:lotId/split', { schema: splitReadContract }, async (request) => readSplit(request, request.params.lotId))

  app.post('/inventory/lots/:lotId/split', { schema: splitContract }, async (request, reply) => reply.code(201).send(await splitLot(request, request.params.lotId, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/lots/:lotId/regroup', { schema: regroupContract }, async (request) => regroupLot(request, request.params.lotId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/trace/report', { schema: traceReportContract }, async (request, reply) => reply.code(201).send(await makeTraceReport(request, request.body, idempotencyKeyFrom(request))))

  app.get('/inventory/trace/reports', { schema: traceReportsContract }, async (request) => listTraceReports(request, request.query))
})
