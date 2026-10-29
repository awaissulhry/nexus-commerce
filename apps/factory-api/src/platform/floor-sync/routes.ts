import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { floorDiscardContract, listRefusedContract, mineContract, officeDiscardContract, refusedOneContract, syncContract } from './contract'
import { manifest } from './manifest'
import { discardRefusedInOffice, listRefused, refusedOne } from './office'
import { discardMine, mine, syncQueue } from './sync'

/**
 * The floor sync (B-W0-30; design floor.sync SCR-023): the tablet's queue in its order, once per event, through each
 * event's own module command (sync.ts, kinds.ts); refused actions kept with their reason in words and one fix, for the
 * tablet and for the office (office.ts); the ledger and the refused actions are one seam (store.ts).
 */
export default defineRoutes('floor-sync', manifest, async (app) => {
  app.post('/floor/sync', { schema: syncContract }, async (request) => syncQueue(request, request.body, idempotencyKeyFrom(request)))

  app.get('/floor/sync', { schema: mineContract }, async (request) => mine(request))

  app.post('/floor/sync/refused/:refusedId/discard', { schema: floorDiscardContract }, async (request) => discardMine(request, request.params.refusedId, idempotencyKeyFrom(request)))

  app.get('/floor-sync/refused', { schema: listRefusedContract }, async (request) => listRefused(request, request.query))

  app.get('/floor-sync/refused/:refusedId', { schema: refusedOneContract }, async (request) => refusedOne(request, request.params.refusedId))

  app.post('/floor-sync/refused/:refusedId/discard', { schema: officeDiscardContract }, async (request) => discardRefusedInOffice(request, request.params.refusedId, request.body, idempotencyKeyFrom(request)))
})
