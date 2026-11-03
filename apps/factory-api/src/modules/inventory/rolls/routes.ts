import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { listConsumables, setPack } from './consumables'
import {
  batchProtectorsContract,
  consumablesContract,
  correctRollContract,
  describeRollContract,
  issueRollContract,
  listRollsContract,
  lookupRollContract,
  moveRollContract,
  protectorRecallContract,
  recordProtectorContract,
  returnRollContract,
  rollRecordContract,
  scrapRollContract,
  setPackContract,
  tagRollsContract,
  withdrawProtectorContract,
} from './contract'
import { manifest } from './manifest'
import { batchProtectors, protectorRecall, recordProtector, withdrawProtector } from './protectors'
import { listRolls, lookupRoll, rollRecord } from './read'
import { correctRoll, issueRoll, moveRoll, returnRoll, scrapRoll } from './stock'
import { describeRoll, tagRolls } from './write'

/**
 * Rolls, protector lots and consumables (B-W2b-107; SCM-260, SCM-261, SCM-263): fabric as tagged rolls of a lot whose length
 * left moves with the lot's moves (./read.ts, ./write.ts, ./stock.ts), which protector lot a batch or a garment holds and the
 * recall of a protector lot (./protectors.ts), consumables kept by the pack with the site's minimum and maximum
 * (./consumables.ts).
 */
export default defineRoutes('inventory.rolls', manifest, async (app) => {
  app.get('/inventory/rolls', { schema: listRollsContract }, async (request) => listRolls(request, request.query))
  app.get('/inventory/rolls/lookup', { schema: lookupRollContract }, async (request) => lookupRoll(request, request.query.code))
  app.get('/inventory/rolls/:rollId', { schema: rollRecordContract }, async (request) => rollRecord(request, request.params.rollId))
  app.post('/inventory/lots/:lotId/rolls', { schema: tagRollsContract }, async (request, reply) =>
    reply.code(201).send(await tagRolls(request, request.params.lotId, request.body, idempotencyKeyFrom(request))),
  )
  app.patch('/inventory/rolls/:rollId', { schema: describeRollContract }, async (request) => describeRoll(request, request.params.rollId, request.body, idempotencyKeyFrom(request)))
  app.post('/inventory/rolls/:rollId/issue', { schema: issueRollContract }, async (request) => issueRoll(request, request.params.rollId, request.body, idempotencyKeyFrom(request)))
  app.post('/inventory/rolls/:rollId/return', { schema: returnRollContract }, async (request) => returnRoll(request, request.params.rollId, request.body, idempotencyKeyFrom(request)))
  app.post('/inventory/rolls/:rollId/move', { schema: moveRollContract }, async (request) => moveRoll(request, request.params.rollId, request.body, idempotencyKeyFrom(request)))
  app.post('/inventory/rolls/:rollId/scrap', { schema: scrapRollContract }, async (request) => scrapRoll(request, request.params.rollId, request.body, idempotencyKeyFrom(request)))
  app.post('/inventory/rolls/:rollId/correct', { schema: correctRollContract }, async (request) => correctRoll(request, request.params.rollId, request.body, idempotencyKeyFrom(request)))

  app.get('/inventory/work-orders/:workOrderId/protector-lots', { schema: batchProtectorsContract }, async (request) => batchProtectors(request, request.params.workOrderId))
  app.get('/inventory/protector-lots/work-orders/:workOrderId', { schema: batchProtectorsContract }, async (request) => batchProtectors(request, request.params.workOrderId))
  app.post('/inventory/protector-lots', { schema: recordProtectorContract }, async (request, reply) => reply.code(201).send(await recordProtector(request, request.body, idempotencyKeyFrom(request))))
  app.post('/inventory/protector-lots/:rowId/withdraw', { schema: withdrawProtectorContract }, async (request) => withdrawProtector(request, request.params.rowId, request.body, idempotencyKeyFrom(request)))
  app.get('/inventory/lots/:lotId/protector-recall', { schema: protectorRecallContract }, async (request) => protectorRecall(request, request.params.lotId))

  app.get('/inventory/consumables', { schema: consumablesContract }, async (request) => listConsumables(request, request.query))
  app.put('/inventory/consumables/:itemId/pack', { schema: setPackContract }, async (request) => setPack(request, request.params.itemId, request.body, idempotencyKeyFrom(request)))
})
