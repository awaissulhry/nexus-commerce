import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { allocateRolls, removeRoll, rollCandidates } from './allocate'
import {
  allocateRollsContract,
  cancelCutOrderContract,
  createCutOrderContract,
  cutOrderRecordContract,
  finishTicketContract,
  listCutOrdersContract,
  makePlyRunContract,
  plyRunStickersContract,
  printTicketContract,
  releaseCutOrderContract,
  removeLayRollContract,
  replanCutOrderContract,
  reprintPlyRunContract,
  rollCandidatesContract,
  scanTicketContract,
  startTicketContract,
  unreleaseCutOrderContract,
  voidPlyRunContract,
  voidTicketContract,
  waitingCellsContract,
  waitingTicketsContract,
} from './contract'
import { manifest } from './manifest'
import { cancelCutOrder, createCutOrder, releaseCutOrder, replanCutOrder, unreleaseCutOrder } from './plan'
import { makePlyRun, plyRunStickers, reprintPlyRun, voidPlyRun } from './plies'
import { listCutOrders, readRecord, waitingCells } from './read'
import { finishTicket, printTicket, scanTicket, startTicket, voidTicket, waitingTickets } from './tickets'

/**
 * Cut orders and cut tickets (B-W2b-112; MES-034 cut order plan, MES-037 rolls by shade, width and shrinkage, MES-041 the cut
 * ticket, MES-043 ply numbering): the office plans cut orders over several work orders (./plan.ts), reads them (./read.ts),
 * allocates rolls to their lays (./allocate.ts) and prints or voids their tickets; the table scans a ticket at the start and at
 * the end of cutting (./tickets.ts) and numbers a counted lay's plies with stickers (./plies.ts). Every write is ONE command.
 */
export default defineRoutes('production.cutorders', manifest, async (app) => {
  app.get('/production/cut-orders', { schema: listCutOrdersContract }, async (request) => listCutOrders(request, request.query))
  app.get('/production/cut-orders/waiting', { schema: waitingCellsContract }, async (request) => waitingCells(request, request.query))
  app.get('/production/cut-orders/:cutOrderId', { schema: cutOrderRecordContract }, async (request) => readRecord(request, request.params.cutOrderId))
  app.post('/production/cut-orders', { schema: createCutOrderContract }, async (request, reply) => reply.code(201).send(await createCutOrder(request, request.body, idempotencyKeyFrom(request))))
  app.put('/production/cut-orders/:cutOrderId', { schema: replanCutOrderContract }, async (request) => replanCutOrder(request, request.params.cutOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/cut-orders/:cutOrderId/release', { schema: releaseCutOrderContract }, async (request) => releaseCutOrder(request, request.params.cutOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/cut-orders/:cutOrderId/unrelease', { schema: unreleaseCutOrderContract }, async (request) => unreleaseCutOrder(request, request.params.cutOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/cut-orders/:cutOrderId/cancel', { schema: cancelCutOrderContract }, async (request) => cancelCutOrder(request, request.params.cutOrderId, request.body, idempotencyKeyFrom(request)))

  app.get('/production/cut-orders/:cutOrderId/rolls', { schema: rollCandidatesContract }, async (request) => rollCandidates(request, request.params.cutOrderId, request.query))
  app.post('/production/cut-orders/:cutOrderId/lays/:layId/rolls', { schema: allocateRollsContract }, async (request, reply) =>
    reply.code(201).send(await allocateRolls(request, request.params.cutOrderId, request.params.layId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/production/cut-orders/:cutOrderId/lays/:layId/rolls/:layRollId/remove', { schema: removeLayRollContract }, async (request) =>
    removeRoll(request, request.params.cutOrderId, request.params.layId, request.params.layRollId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/production/cut-tickets/waiting', { schema: waitingTicketsContract }, async (request) => waitingTickets(request, request.query))
  app.get('/production/cut-tickets/scan', { schema: scanTicketContract }, async (request) => scanTicket(request, request.query.code))
  app.post('/production/cut-tickets/start', { schema: startTicketContract }, async (request) => startTicket(request, request.body, idempotencyKeyFrom(request)))
  app.post('/production/cut-tickets/finish', { schema: finishTicketContract }, async (request) => finishTicket(request, request.body, idempotencyKeyFrom(request)))
  app.post('/production/cut-tickets/:ticketId/void', { schema: voidTicketContract }, async (request) => voidTicket(request, request.params.ticketId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/cut-tickets/:ticketId/print', { schema: printTicketContract }, async (request) => printTicket(request, request.params.ticketId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/lays/:layId/ply-runs', { schema: makePlyRunContract }, async (request, reply) => reply.code(201).send(await makePlyRun(request, request.params.layId, request.body, idempotencyKeyFrom(request))))
  app.post('/production/ply-runs/:runId/print', { schema: reprintPlyRunContract }, async (request) => reprintPlyRun(request, request.params.runId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/ply-runs/:runId/void', { schema: voidPlyRunContract }, async (request) => voidPlyRun(request, request.params.runId, request.body, idempotencyKeyFrom(request)))
  app.get('/production/ply-runs/:runId/stickers', { schema: plyRunStickersContract }, async (request) => plyRunStickers(request, request.params.runId, request.query))
})
