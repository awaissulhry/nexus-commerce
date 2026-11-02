import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { inlineDisposition } from '../work-orders/traveller'
import { assignOperator, reassign, removeAssignment } from './assignments'
import { dispatchBoard } from './board'
import {
  assignContract,
  boardContract,
  floorLineContract,
  handoverContract,
  mineContract,
  moveContract,
  newHandoverContract,
  officeDispatchContract,
  operatorsContract,
  paperContract,
  printContract,
  reassignContract,
  removeContract,
  stationDispatchContract,
  writeHandoverContract,
} from './contract'
import { officeDispatch, stationDispatch } from './dispatch'
import { lineHandover, newHandover, writeHandover } from './handover'
import { manifest } from './manifest'
import { floorLine, myWork } from './mine'
import { moveWork } from './moves'
import { myMessagesContract, myWorkMessages } from './mywork-messages'
import { dispatchOperators } from './operators'
import { printedPaper, printedPdf } from './print'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021; design floor.mywork "Next" and "Then"): the published plan's
 * queue for a line, a work centre or a station, rush first, then due date, then sequence, each entry with where its work
 * stands from the floor's scans. The office reads any lane of its sites; a floor device its own station.
 *
 * Dispatch every shift (B-W2b-49; ./board.ts, ./assignments.ts, ./moves.ts, ./mine.ts, ./handover.ts, ./print.ts): the board
 * the supervisor runs. Each write is one command with an Idempotency-Key; a repeated key answers from its receipt.
 */
export default defineRoutes('production.dispatch', manifest, async (app) => {
  app.get('/production/dispatch', { schema: officeDispatchContract }, async (request) => officeDispatch(request, request.query))
  app.get('/production/dispatch/station', { schema: stationDispatchContract }, async (request) => stationDispatch(request))

  app.get('/production/dispatch/board', { schema: boardContract }, async (request) => dispatchBoard(request, request.query))
  app.get('/production/dispatch/operators', { schema: operatorsContract }, async (request) => dispatchOperators(request, request.query))

  app.post('/production/dispatch/assignments', { schema: assignContract }, async (request, reply) => {
    const answer = await assignOperator(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(answer)
  })
  app.post('/production/dispatch/assignments/:assignmentId/reassign', { schema: reassignContract }, async (request) => reassign(request, request.params.assignmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/dispatch/assignments/:assignmentId/remove', { schema: removeContract }, async (request) => removeAssignment(request, request.params.assignmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/dispatch/moves', { schema: moveContract }, async (request) => moveWork(request, request.body, idempotencyKeyFrom(request)))

  app.get('/production/dispatch/mine', { schema: mineContract }, async (request) => myWork(request))
  app.get('/production/dispatch/mine/messages', { schema: myMessagesContract }, async (request) => myWorkMessages(request))
  app.get('/production/dispatch/floor/line', { schema: floorLineContract }, async (request) => floorLine(request, request.query))

  app.get('/production/dispatch/handover', { schema: handoverContract }, async (request) => lineHandover(request, request.query))
  app.post('/production/dispatch/handover', { schema: writeHandoverContract }, async (request) => {
    const { replayed: _replayed, ...answer } = await writeHandover(request, request.body, idempotencyKeyFrom(request))
    return answer
  })
  app.get('/production/dispatch/handover/new', { schema: newHandoverContract }, async (request) => newHandover(request))

  app.get('/production/dispatch/print/paper', { schema: paperContract }, async (request) => {
    const paper = await printedPaper(request, request.query)
    return { ...paper, facts: [...paper.facts], columns: [...paper.columns], sections: paper.sections.map((section) => ({ ...section, rows: section.rows.map((row) => ({ ...row, cells: [...row.cells] })) })) }
  })
  app.get('/production/dispatch/print', { schema: printContract }, async (request, reply) => {
    const { pdf, fileName } = await printedPdf(request, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
})
