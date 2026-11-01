import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { requireFloorStepUp } from '../auth/floor/step-up'
import { officeAuthOf } from '../auth/sessions/office-auth'
// B-W2b-52: offline conflicts to the lead (conflicts/).
import { decideConflictContract, floorConflictContract, floorConflictsContract, officeConflictsContract } from './conflicts/contract'
import { decideConflict, floorConflict, floorConflicts, officeConflicts } from './conflicts/conflicts'
import { floorDiscardContract, listRefusedContract, mineContract, officeDiscardContract, refusedOneContract, syncContract } from './contract'
import { manifest } from './manifest'
import { discardRefusedInOffice, listRefused, refusedOne } from './office'
import { discardMine, mine, syncQueue } from './sync'

/**
 * The floor sync (B-W0-30; design floor.sync SCR-023): the tablet's queue in its order, once per event, through each
 * event's own module command (sync.ts, kinds.ts); refused actions kept with their reason in words and one fix, for the
 * tablet and for the office (office.ts); the ledger and the refused actions are one seam (store.ts).
 * B-W2b-52 (MES-196): the conflicts among the refused actions go to the lead of the line (conflicts/), the office reads them
 * too; keeping the recorded report is a signing act on the floor (the PIN, after every other check).
 */
export default defineRoutes('floor-sync', manifest, async (app) => {
  app.post('/floor/sync', { schema: syncContract }, async (request) => syncQueue(request, request.body, idempotencyKeyFrom(request)))

  app.get('/floor/sync', { schema: mineContract }, async (request) => mine(request))

  app.post('/floor/sync/refused/:refusedId/discard', { schema: floorDiscardContract }, async (request) => discardMine(request, request.params.refusedId, idempotencyKeyFrom(request)))

  app.get('/floor-sync/refused', { schema: listRefusedContract }, async (request) => listRefused(request, request.query))

  app.get('/floor-sync/refused/:refusedId', { schema: refusedOneContract }, async (request) => refusedOne(request, request.params.refusedId))

  app.post('/floor-sync/refused/:refusedId/discard', { schema: officeDiscardContract }, async (request) => discardRefusedInOffice(request, request.params.refusedId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-52: offline conflicts to the lead (MES-196).
  app.get('/floor/sync/conflicts', { schema: floorConflictsContract }, async (request) => floorConflicts(request, request.query))
  app.get('/floor/sync/conflicts/:refusedId', { schema: floorConflictContract }, async (request) => floorConflict(request, request.params.refusedId))
  app.post('/floor/sync/conflicts/:refusedId/decide', { schema: decideConflictContract }, async (request) =>
    decideConflict(request, request.params.refusedId, request.body, () => requireFloorStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
  app.get('/floor-sync/conflicts', { schema: officeConflictsContract }, async (request) => officeConflicts(request, request.query))
})
