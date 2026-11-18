import { idempotencyKeyFrom } from '../../core/command'
import { actorOf, requireContext } from '../../core/context'
import { defineRoutes } from '../../core/manifest'
import {
  advanceContract,
  allocationsContract,
  closeBlockContract,
  closeSeriesContract,
  createSeriesContract,
  listBlocksContract,
  listSeriesContract,
  myBlocksContract,
  overrideCheckContract,
  previewContract,
  reserveBlockContract,
  setStartContract,
  topUpContract,
} from './contract'
import { manifest } from './manifest'
import { checkOverride, previewNumber } from './override'
import { closeBlock, listBlocks, myBlocks, reserveBlock, topUpBlocks } from './scan-ids'
import { advanceSeries, closeSeries, createSeries, listSeries, seriesAllocations, setSeriesStart } from './series'
import { assertEveryCustomer } from '../auth/every-customer'

/**
 * Number series (platform part): the admin's list, the numbers one series issued with its gap proof (B-W0-28), and its
 * four writes. Numbers are issued by allocateNumber. And the tablets' scan-id blocks: the office's list, reserve and
 * close; the tablet's own list and top-up. Scan ids are taken by allocateScanIds and recorded by useScanIds
 * (scan-ids.ts) inside the modules' commands.
 */
// fix-pr-8 (the brand wall; the B-PR-10 sweep of every office route): the series and blocks are every customer's — the counters
// of every customer's documents, the numbers each record took — so their admin refuses a person limited to some customers (403
// in words that name none). A form's next number (preview, override check) stays everyone's.
export default defineRoutes('numbering', manifest, async (app) => {
  app.get('/numbering/series', { schema: listSeriesContract }, async (request) => {
    assertEveryCustomer(request, 'numbering.view') // fix-pr-8: every customer's documents' counters and numbers
    const actor = actorOf(requireContext(request))
    const series = await request.withClient((client) => listSeries(client, actor, request.query))
    return { series }
  })

  app.post('/numbering/series', { schema: createSeriesContract }, async (request, reply) => {
    assertEveryCustomer(request, 'numbering.manage') // fix-pr-8: every customer's documents' counters and numbers
    const series = await createSeries(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send({ series })
  })

  app.put('/numbering/series/:seriesId/start', { schema: setStartContract }, async (request) => {
    assertEveryCustomer(request, 'numbering.manage') // fix-pr-8: every customer's documents' counters and numbers
    const series = await setSeriesStart(request, request.params.seriesId, request.body, idempotencyKeyFrom(request))
    return { series }
  })

  app.post('/numbering/series/:seriesId/advance', { schema: advanceContract }, async (request) => {
    assertEveryCustomer(request, 'numbering.manage') // fix-pr-8: every customer's documents' counters and numbers
    const series = await advanceSeries(request, request.params.seriesId, request.body, idempotencyKeyFrom(request))
    return { series }
  })

  app.get('/numbering/series/:seriesId/allocations', { schema: allocationsContract }, async (request) => {
    assertEveryCustomer(request, 'numbering.view') // fix-pr-8: every customer's documents' counters and numbers
    const actor = actorOf(requireContext(request))
    return request.withClient((client) => seriesAllocations(client, actor, request.params.seriesId, request.query.limit))
  })

  app.post('/numbering/series/:seriesId/close', { schema: closeSeriesContract }, async (request) => {
    assertEveryCustomer(request, 'numbering.manage') // fix-pr-8: every customer's documents' counters and numbers
    const series = await closeSeries(request, request.params.seriesId, request.body, idempotencyKeyFrom(request))
    return { series }
  })

  app.get('/numbering/blocks', { schema: listBlocksContract }, async (request) => {
    assertEveryCustomer(request, 'numbering.view') // fix-pr-8: every customer's documents' counters and numbers
    const actor = actorOf(requireContext(request))
    const blocks = await request.withClient((client) => listBlocks(client, actor, request.query))
    return { blocks }
  })

  app.post('/numbering/blocks', { schema: reserveBlockContract }, async (request, reply) => {
    assertEveryCustomer(request, 'numbering.manage') // fix-pr-8: every customer's documents' counters and numbers
    const block = await reserveBlock(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send({ block })
  })

  app.post('/numbering/blocks/:blockId/close', { schema: closeBlockContract }, async (request) => {
    assertEveryCustomer(request, 'numbering.manage') // fix-pr-8: every customer's documents' counters and numbers
    const block = await closeBlock(request, request.params.blockId, request.body, idempotencyKeyFrom(request))
    return { block }
  })

  app.get('/numbering/floor/blocks', { schema: myBlocksContract }, async (request) => myBlocks(request))

  app.post('/numbering/floor/blocks/top-up', { schema: topUpContract }, async (request) => topUpBlocks(request, request.body.kinds, idempotencyKeyFrom(request)))

  // B-W2b-24 (PLT-125): the number preview, and the check of a migrated document's typed number (read only).
  app.get('/numbering/preview', { schema: previewContract }, async (request) => previewNumber(request, request.query))
  app.post('/numbering/override/check', { schema: overrideCheckContract }, async (request) => checkOverride(request, request.body))
})
