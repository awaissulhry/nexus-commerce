import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { tagW1Remnant } from './backfill'
import { listRemnantsContract, lookupRemnantContract, remnantRecordContract, tagRemnantContract } from './contract'
import { manifest } from './manifest'
import { listRemnants, lookupRemnant, remnantRecord } from './read'

/**
 * Remnant stock (B-W2b-100; SCM-254): a usable offcut of a hide is stock with its own tag (RM-…). The list and one piece,
 * the lookup of a scanned tag, and the office's tag for a W1 remnant. The tags themselves are made where the offcut comes
 * back (the pick's return and Hide done at the cutting table: lifecycle.ts tagRemnantInCommand, in their commands).
 */
export default defineRoutes('inventory.remnants', manifest, async (app) => {
  app.get('/inventory/remnants', { schema: listRemnantsContract }, async (request) => listRemnants(request, request.query))
  app.get('/inventory/remnants/lookup', { schema: lookupRemnantContract }, async (request) => lookupRemnant(request, request.query.code))
  app.get('/inventory/remnants/:remnantId', { schema: remnantRecordContract }, async (request) => remnantRecord(request, request.params.remnantId))
  app.post('/inventory/remnants', { schema: tagRemnantContract }, async (request, reply) => {
    const tagged = await tagW1Remnant(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(await lookupRemnant(request, tagged.code))
  })
})
