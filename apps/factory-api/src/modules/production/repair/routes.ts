import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { downgradeContract, downgradeOptionsContract, listDowngradesContract, repairRecordContract, scanInContract, scanOutContract, stationQueueContract, withdrawDowngradeContract } from './contract'
import { downgrade, downgradeOptions, listDowngrades, withdrawDowngrade } from './downgrade'
import { manifest } from './manifest'
import { repairRecord } from './office'
import { scanRepair, stationQueue } from './station'

/**
 * The repair station and second quality (B-W2b-126; MES-132, MES-133; design floor.mywork "repair queue", production.scrap
 * pop:sc-downgrade): the floor's repair queue and its scans in and out, a rework's repair in the office, the downgrades
 * to second quality and their withdrawal. Every write is one command; a repeated Idempotency-Key answers 200 from its
 * receipt.
 */
export default defineRoutes('production.repair', manifest, async (app) => {
  app.get('/production/repair/station', { schema: stationQueueContract }, async (request) => stationQueue(request))

  app.post('/production/repair/:reworkId/in', { schema: scanInContract }, async (request, reply) => {
    const result = await scanRepair(request, request.params.reworkId, 'IN', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/repair/:reworkId/out', { schema: scanOutContract }, async (request, reply) => {
    const result = await scanRepair(request, request.params.reworkId, 'OUT', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.get('/production/repair/:reworkId', { schema: repairRecordContract }, async (request) => repairRecord(request, request.params.reworkId))

  app.get('/production/downgrades', { schema: listDowngradesContract }, async (request) =>
    listDowngrades(request, { ...request.query, from: request.query.from ? new Date(request.query.from) : undefined, to: request.query.to ? new Date(request.query.to) : undefined }),
  )

  app.get('/production/downgrades/options', { schema: downgradeOptionsContract }, async (request) => downgradeOptions(request, request.query))

  app.post('/production/downgrades', { schema: downgradeContract }, async (request, reply) => {
    const result = await downgrade(request, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/downgrades/:downgradeId/withdraw', { schema: withdrawDowngradeContract }, async (request, reply) => {
    const result = await withdrawDowngrade(request, request.params.downgradeId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
})
