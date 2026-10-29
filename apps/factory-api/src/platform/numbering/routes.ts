import { idempotencyKeyFrom } from '../../core/command'
import { actorOf, requireContext } from '../../core/context'
import { defineRoutes } from '../../core/manifest'
import { advanceContract, allocationsContract, closeSeriesContract, createSeriesContract, listSeriesContract, setStartContract } from './contract'
import { manifest } from './manifest'
import { advanceSeries, closeSeries, createSeries, listSeries, seriesAllocations, setSeriesStart } from './series'

/**
 * Number series (platform part): the admin's list, the numbers one series issued with its gap proof (B-W0-28), and its
 * four writes. Numbers are issued by allocateNumber.
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

  app.get('/numbering/series/:seriesId/allocations', { schema: allocationsContract }, async (request) => {
    const actor = actorOf(requireContext(request))
    return request.withClient((client) => seriesAllocations(client, actor, request.params.seriesId, request.query.limit))
  })

  app.post('/numbering/series/:seriesId/close', { schema: closeSeriesContract }, async (request) => {
    const series = await closeSeries(request, request.params.seriesId, request.body, idempotencyKeyFrom(request))
    return { series }
  })
})
