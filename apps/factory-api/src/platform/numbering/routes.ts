import { idempotencyKeyFrom } from '../../core/command'
import { actorOf, requireContext } from '../../core/context'
import { defineRoutes } from '../../core/manifest'
import {
  advanceContract,
  closeBlockContract,
  createSeriesContract,
  listBlocksContract,
  listSeriesContract,
  myBlocksContract,
  reserveBlockContract,
  setStartContract,
  topUpContract,
} from './contract'
import { manifest } from './manifest'
import { closeBlock, listBlocks, myBlocks, reserveBlock, topUpBlocks } from './scan-ids'
import { advanceSeries, createSeries, listSeries, setSeriesStart } from './series'

/**
 * Number series (platform part): the admin's list and its three writes. Numbers are issued by allocateNumber. And the
 * tablets' scan-id blocks: the office's list, reserve and close; the tablet's own list and top-up. Scan ids are taken
 * by allocateScanIds and recorded by useScanIds (scan-ids.ts) inside the modules' commands.
 */
export default defineRoutes('numbering', manifest, async (app) => {
  app.get('/numbering/series', { schema: listSeriesContract }, async (request) => {
    const actor = actorOf(requireContext(request))
    const series = await request.withClient((client) => listSeries(client, actor, request.query))
    return { series }
  })

  app.post('/numbering/series', { schema: createSeriesContract }, async (request, reply) => {
    const series = await createSeries(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send({ series })
  })

  app.put('/numbering/series/:seriesId/start', { schema: setStartContract }, async (request) => {
    const series = await setSeriesStart(request, request.params.seriesId, request.body, idempotencyKeyFrom(request))
    return { series }
  })

  app.post('/numbering/series/:seriesId/advance', { schema: advanceContract }, async (request) => {
    const series = await advanceSeries(request, request.params.seriesId, request.body, idempotencyKeyFrom(request))
    return { series }
  })

  app.get('/numbering/blocks', { schema: listBlocksContract }, async (request) => {
    const actor = actorOf(requireContext(request))
    const blocks = await request.withClient((client) => listBlocks(client, actor, request.query))
    return { blocks }
  })

  app.post('/numbering/blocks', { schema: reserveBlockContract }, async (request, reply) => {
    const block = await reserveBlock(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send({ block })
  })

  app.post('/numbering/blocks/:blockId/close', { schema: closeBlockContract }, async (request) => {
    const block = await closeBlock(request, request.params.blockId, request.body, idempotencyKeyFrom(request))
    return { block }
  })

  app.get('/numbering/floor/blocks', { schema: myBlocksContract }, async (request) => myBlocks(request))

  app.post('/numbering/floor/blocks/top-up', { schema: topUpContract }, async (request) => topUpBlocks(request, request.body.kinds, idempotencyKeyFrom(request)))
})
