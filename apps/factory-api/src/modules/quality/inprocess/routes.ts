import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { cancelCheck, decideCheck, openCheck, saveResults } from './checks'
import { cancelContract, chargesContract, countContract, decideContract, dhuContract, dueContract, firstPieceContract, getContract, listContract, mineContract, openContract, resultsContract, rovingContract } from './contract'
import { countCheck, setCheckDue } from './count'
import { manifest } from './manifest'
import { chargesRead, firstPieceRead, lineDhuRead, listChecks, mineRead, rovingBoard } from './reads'
import { checkViewOf } from './views'

/**
 * In-process checks (B-W2b-99): open, record the plan results, decide and cancel a check (./checks.ts: one-step for a cutting,
 * roving or end-of-line result), the list, one record, the line's DHU, the roving board, the first-piece flag, the defects
 * charged per operation and the worker's own charges (./reads.ts, ./views.ts). Deciding a first piece is a signing act: the
 * office's fresh code (requireStepUp) or the floor's PIN (requireFloorStepUp), asked after every other check.
 */
export default defineRoutes('quality.inprocess', manifest, async (app) => {
  const sign = (request: FastifyRequest) => () => (request.factoryContext?.audience === 'floor' ? requireFloorStepUp(officeAuthOf(app), request) : requireStepUp(officeAuthOf(app), request))

  app.get('/quality/inprocess/checks', { schema: listContract }, async (request) => listChecks(request, request.query))

  app.get('/quality/inprocess/checks/:checkId', { schema: getContract }, async (request) => ({ check: await checkViewOf(request, request.params.checkId) }))

  app.post('/quality/inprocess/checks', { schema: openContract }, async (request, reply) => reply.code(201).send(await openCheck(request, request.body, idempotencyKeyFrom(request))))

  app.put('/quality/inprocess/checks/:checkId/results', { schema: resultsContract }, async (request) => saveResults(request, request.params.checkId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/inprocess/checks/:checkId/decide', { schema: decideContract }, async (request) =>
    decideCheck(request, request.params.checkId, request.body, { sign: sign(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.post('/quality/inprocess/checks/:checkId/cancel', { schema: cancelContract }, async (request) => cancelCheck(request, request.params.checkId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/inprocess/checks/:checkId/count', { schema: countContract }, async (request) => countCheck(request, request.params.checkId, request.body, idempotencyKeyFrom(request)))

  app.patch('/quality/inprocess/checks/:checkId/due', { schema: dueContract }, async (request) => setCheckDue(request, request.params.checkId, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/inprocess/dhu', { schema: dhuContract }, async (request) => lineDhuRead(request, request.query))

  app.get('/quality/inprocess/roving', { schema: rovingContract }, async (request) => rovingBoard(request, request.query))

  app.get('/quality/inprocess/first-piece', { schema: firstPieceContract }, async (request) => firstPieceRead(request, request.query))

  app.get('/quality/inprocess/charges', { schema: chargesContract }, async (request) => chargesRead(request, request.query))

  app.get('/quality/inprocess/floor/mine', { schema: mineContract }, async (request) => mineRead(request, request.query))
})
