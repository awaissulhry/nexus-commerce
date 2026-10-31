import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { approveBlock, approveMany, blockCounts, blockRecord, correctBlock, endBlockByLead, listBlocks, recordBlock, rejectBlock, reopenBlock } from './blocks'
import { createCode, editCode, listCodes } from './codes'
import {
  approveContract,
  blockContract,
  bulkApproveContract,
  correctContract,
  countsContract,
  createCodeContract,
  editCodeContract,
  endBlockContract,
  floorApproveContract,
  floorEndContract,
  floorLeadContract,
  floorRejectContract,
  floorStartContract,
  floorStateContract,
  listBlocksContract,
  listCodesContract,
  recordBlockContract,
  rejectContract,
  reopenContract,
} from './contract'
import { floorApprove, floorEnd, floorLeadList, floorReject, floorStart, floorState } from './floor'
import { manifest } from './manifest'

/**
 * Off-standard and indirect time (B-W2b-29; MES-155 codes with pay rules, MES-156 time with no bundle, MES-157 the lead's
 * approval, MES-158 indirect work codes): the office's codes and blocks (codes.ts, blocks.ts) and the floor's tiles,
 * start and end and the team leader's decisions (floor.ts). Every write is one command with an Idempotency-Key (the
 * floor's: `<device>.<client event id>`); a repeat answers from its receipt. The team leader's approve and reject on the
 * tablet are signing acts: the PIN (requireFloorStepUp), asked after every other check.
 */
export default defineRoutes('production.offstandard', manifest, async (app) => {
  const pin = (request: FastifyRequest) => () => requireFloorStepUp(officeAuthOf(app), request)

  app.get('/production/offstandard/codes', { schema: listCodesContract }, async (request) => listCodes(request, request.query))

  app.post('/production/offstandard/codes', { schema: createCodeContract }, async (request, reply) => reply.code(201).send({ code: await createCode(request, request.body, idempotencyKeyFrom(request)) }))

  app.patch('/production/offstandard/codes/:codeId', { schema: editCodeContract }, async (request) => ({ code: await editCode(request, request.params.codeId, request.body, idempotencyKeyFrom(request)) }))

  app.get('/production/offstandard/blocks', { schema: listBlocksContract }, async (request) => listBlocks(request, request.query))

  app.get('/production/offstandard/counts', { schema: countsContract }, async (request) => blockCounts(request, request.query))

  app.post('/production/offstandard/blocks', { schema: recordBlockContract }, async (request, reply) => reply.code(201).send(await recordBlock(request, request.body, idempotencyKeyFrom(request))))

  app.post('/production/offstandard/blocks/approve', { schema: bulkApproveContract }, async (request) => approveMany(request, request.body, idempotencyKeyFrom(request)))

  app.get('/production/offstandard/blocks/:blockId', { schema: blockContract }, async (request) => blockRecord(request, request.params.blockId))

  app.post('/production/offstandard/blocks/:blockId/approve', { schema: approveContract }, async (request) => approveBlock(request, request.params.blockId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/offstandard/blocks/:blockId/reject', { schema: rejectContract }, async (request) => rejectBlock(request, request.params.blockId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/offstandard/blocks/:blockId/reopen', { schema: reopenContract }, async (request) => reopenBlock(request, request.params.blockId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/offstandard/blocks/:blockId/correct', { schema: correctContract }, async (request) => correctBlock(request, request.params.blockId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/offstandard/blocks/:blockId/end', { schema: endBlockContract }, async (request) => endBlockByLead(request, request.params.blockId, request.body, idempotencyKeyFrom(request)))

  app.get('/production/offstandard/floor', { schema: floorStateContract }, async (request) => floorState(request))

  app.post('/production/offstandard/floor/start', { schema: floorStartContract }, async (request, reply) => {
    const { replayed, ...answer } = await floorStart(request, request.body)
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.post('/production/offstandard/floor/end', { schema: floorEndContract }, async (request) => ({ block: (await floorEnd(request, request.body)).block }))

  app.get('/production/offstandard/floor/lead', { schema: floorLeadContract }, async (request) => floorLeadList(request))

  app.post('/production/offstandard/floor/lead/:blockId/approve', { schema: floorApproveContract }, async (request) => floorApprove(request, request.params.blockId, request.body, pin(request), idempotencyKeyFrom(request)))

  app.post('/production/offstandard/floor/lead/:blockId/reject', { schema: floorRejectContract }, async (request) => floorReject(request, request.params.blockId, request.body, pin(request), idempotencyKeyFrom(request)))
})
