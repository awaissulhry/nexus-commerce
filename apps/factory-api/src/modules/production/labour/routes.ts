import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  answerContract,
  closeContract,
  countsContract,
  dayContract,
  daysContract,
  disputeContract,
  editsContract,
  inboxContract,
  mineContract,
  raiseContract,
  recordContract,
  reopenContract,
  sheetContract,
  withdrawContract,
} from './contract'
import { closeDay, dayOf, listDays, reopenDay } from './days'
import { answerDispute, disputeOf, raiseDispute, withdrawDispute } from './disputes'
import { listEdits } from './edits'
import { labourCounts, labourInbox } from './inbox'
import { manifest } from './manifest'
import { mine } from './mine'
import { recordOf } from './records'
import { openSheet } from './sheet'

/**
 * Labour records and corrections (B-W2b-45; MES-201 the labour record per scan, MES-202 the operator's daily sheet, MES-203
 * close the day per line, MES-204 the changes to labour and attendance records, MES-205 workers see their own records,
 * MES-206 dispute an entry). Every write is one command with an Idempotency-Key (the floor's: `<device>.<client event
 * id>`); a repeat answers from its receipt. On the floor, a worker's own records and a dispute are My day's: the PIN is
 * asked again (requireFloorStepUp), even after a badge sign-in.
 */
export default defineRoutes('production.labour', manifest, async (app) => {
  app.get('/production/labour/counts', { schema: countsContract }, async (request) => labourCounts(request, request.query))

  app.get('/production/labour/inbox', { schema: inboxContract }, async (request) => labourInbox(request, request.query))

  app.get('/production/labour/days', { schema: daysContract }, async (request) => listDays(request, request.query))

  app.get('/production/labour/days/:lineId/:workDate', { schema: dayContract }, async (request) => dayOf(request, request.params.lineId, request.params.workDate))

  app.post('/production/labour/days/:lineId/:workDate/close', { schema: closeContract }, async (request) => closeDay(request, request.params.lineId, request.params.workDate, request.body, idempotencyKeyFrom(request)))

  app.post('/production/labour/days/:lineId/:workDate/reopen', { schema: reopenContract }, async (request) => reopenDay(request, request.params.lineId, request.params.workDate, request.body, idempotencyKeyFrom(request)))

  app.get('/production/labour/edits', { schema: editsContract }, async (request) => listEdits(request, request.query))

  app.get('/production/labour/records/:scanId', { schema: recordContract }, async (request) => recordOf(request, request.params.scanId))

  app.get('/production/labour/disputes/:disputeId', { schema: disputeContract }, async (request) => disputeOf(request, request.params.disputeId))

  app.post('/production/labour/disputes/:disputeId/answer', { schema: answerContract }, async (request) => answerDispute(request, request.params.disputeId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/labour/sheets', { schema: sheetContract }, async (request) => openSheet(request, request.body, idempotencyKeyFrom(request)))

  app.get('/production/labour/floor/mine', { schema: mineContract }, async (request) => {
    requireFloorStepUp(officeAuthOf(app), request)
    return mine(request, request.query)
  })

  app.post('/production/labour/floor/disputes', { schema: raiseContract }, async (request, reply) => {
    requireFloorStepUp(officeAuthOf(app), request)
    const { replayed, existing, dispute } = await raiseDispute(request, request.body)
    return reply.code(replayed || existing ? 200 : 201).send({ dispute, existing })
  })

  app.post('/production/labour/floor/disputes/:disputeId/withdraw', { schema: withdrawContract }, async (request) => {
    requireFloorStepUp(officeAuthOf(app), request)
    return withdrawDispute(request, request.params.disputeId, request.body)
  })
})
