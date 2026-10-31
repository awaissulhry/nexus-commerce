import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { inlineDisposition } from '../../sales/quotes/preview'
import {
  addLineContract,
  applyCountContract,
  approveCountContract,
  cancelCountContract,
  countItemsContract,
  countTilesContract,
  createCountContract,
  editCountContract,
  getCountContract,
  listCountsContract,
  listLinesContract,
  placesContract,
  reasonsContract,
  recordLinesContract,
  recountContract,
  removeLineContract,
  sendBackContract,
  sheetsContract,
  signOffContract,
  startCountContract,
  submitCountContract,
  valuedListContract,
} from './contract'
import {
  addLine,
  applyCount,
  approveCount,
  askRecounts,
  cancelCount,
  countRecord,
  countSheets,
  createCount,
  editCount,
  previewValuedList,
  recordLines,
  removeLine,
  sendBack,
  signOffCount,
  startCount,
  submitCount,
} from './counts'
import { manifest } from './manifest'
import { countItems, countPlaces, countReasons, countTiles, listCounts, listLines } from './reads'

/**
 * Stock counts and the year-end physical inventory (B-W2a-15; SCM-224, SCM-230; design warehouse.counts, SCR-132):
 *   GET   /inventory/stock-counts                       the counts the caller sees (site, state, kind, open, text)
 *   GET   /inventory/stock-counts/counts                the tiles: drafts, counting, waiting for approval, to apply, year-end
 *   GET   /inventory/stock-counts/reasons               the adjustment reasons a difference is given
 *   GET   /inventory/stock-counts/items                 what a count names: materials and finished garments (B-W2b-15)
 *   POST  /inventory/stock-counts                       a cycle count or the year-end inventory (DRAFT, or `start`)
 *   GET   /inventory/stock-counts/:id                   the record: header, summary, approval, what the caller may do
 *   PATCH /inventory/stock-counts/:id                   the team and the note
 *   POST  /inventory/stock-counts/:id/start             the expected quantities frozen: the lines of the snapshot
 *   GET   /inventory/stock-counts/:id/lines             a page of lines (all, uncounted, differs, recount, added)
 *   GET   /inventory/stock-counts/:id/places            the lines per place, counted and differing (B-W2b-15)
 *   POST  /inventory/stock-counts/:id/lines             a line found while counting (ADDED, expected 0)
 *   POST  /inventory/stock-counts/:id/lines/record      counts, recounts and reasons typed (up to 500 lines)
 *   POST  /inventory/stock-counts/:id/lines/:l/remove   a line found while counting taken back
 *   POST  /inventory/stock-counts/:id/recounts          lines to count again
 *   POST  /inventory/stock-counts/:id/submit            counted, recounted, every difference with its reason; valued
 *   POST  /inventory/stock-counts/:id/approve           the differences approved (never the counter's own, over the limit)
 *   POST  /inventory/stock-counts/:id/send-back         back to COUNTING with the reason, recounts asked
 *   POST  /inventory/stock-counts/:id/apply             one COUNT move per difference, dated at the snapshot
 *   POST  /inventory/stock-counts/:id/sign-off          a year-end inventory signed off: its valued list frozen as files
 *   POST  /inventory/stock-counts/:id/cancel            before the differences are applied, with the reason
 *   GET   /inventory/stock-counts/:id/sheets            the count sheets (PDF; ?expected=false for a blind sheet)
 *   GET   /inventory/stock-counts/:id/valued-list       a year-end valued list before its sign-off (PDF or XLSX preview)
 */
export default defineRoutes('inventory.counts', manifest, async (app) => {
  app.get('/inventory/stock-counts', { schema: listCountsContract }, async (request) => listCounts(request, request.query))

  app.get('/inventory/stock-counts/counts', { schema: countTilesContract }, async (request) => countTiles(request, request.query.siteId))

  app.get('/inventory/stock-counts/reasons', { schema: reasonsContract }, async (request) => countReasons(request))

  // B-W2b-15: what a count names (materials and finished garments), and a count's lines per place.
  app.get('/inventory/stock-counts/items', { schema: countItemsContract }, async (request) => countItems(request, request.query))

  app.post('/inventory/stock-counts', { schema: createCountContract }, async (request, reply) =>
    reply.code(201).send({ count: await createCount(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.get('/inventory/stock-counts/:countId', { schema: getCountContract }, async (request) => ({ count: await countRecord(request, request.params.countId) }))

  app.patch('/inventory/stock-counts/:countId', { schema: editCountContract }, async (request) => ({
    count: await editCount(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/stock-counts/:countId/start', { schema: startCountContract }, async (request) => ({
    count: await startCount(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/inventory/stock-counts/:countId/lines', { schema: listLinesContract }, async (request) => listLines(request, request.params.countId, request.query))

  app.get('/inventory/stock-counts/:countId/places', { schema: placesContract }, async (request) => countPlaces(request, request.params.countId))

  app.post('/inventory/stock-counts/:countId/lines', { schema: addLineContract }, async (request, reply) =>
    reply.code(201).send(await addLine(request, request.params.countId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/inventory/stock-counts/:countId/lines/record', { schema: recordLinesContract }, async (request) =>
    recordLines(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/inventory/stock-counts/:countId/lines/:lineId/remove', { schema: removeLineContract }, async (request) =>
    removeLine(request, request.params.countId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/inventory/stock-counts/:countId/recounts', { schema: recountContract }, async (request) =>
    askRecounts(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/inventory/stock-counts/:countId/submit', { schema: submitCountContract }, async (request) => ({
    count: await submitCount(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/stock-counts/:countId/approve', { schema: approveCountContract }, async (request) => ({
    count: await approveCount(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/stock-counts/:countId/send-back', { schema: sendBackContract }, async (request) => ({
    count: await sendBack(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/stock-counts/:countId/apply', { schema: applyCountContract }, async (request) => applyCount(request, request.params.countId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/stock-counts/:countId/sign-off', { schema: signOffContract }, async (request) => ({
    count: await signOffCount(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/stock-counts/:countId/cancel', { schema: cancelCountContract }, async (request) => ({
    count: await cancelCount(request, request.params.countId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/inventory/stock-counts/:countId/sheets', { schema: sheetsContract }, async (request, reply) => {
    const { pdf, fileName } = await countSheets(request, request.params.countId, request.query.expected !== 'false', request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.get('/inventory/stock-counts/:countId/valued-list', { schema: valuedListContract }, async (request, reply) => {
    const file = await previewValuedList(request, request.params.countId, request.query.format, request.query.language)
    return reply.type(file.contentType).header('content-disposition', inlineDisposition(file.fileName)).header('cache-control', 'no-store').send(file.body)
  })
})
