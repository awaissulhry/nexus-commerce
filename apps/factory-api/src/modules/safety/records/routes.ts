import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { inlineDisposition } from '../../inventory/receipts/report'
import {
  addInstructionContract,
  cancelSessionContract,
  closeSessionContract,
  correctRecordContract,
  countersignContract,
  dueListContract,
  dueListPdfContract,
  editSessionContract,
  floorCountersignContract,
  floorInstructionPendingContract,
  floorInstructionSignContract,
  floorSessionContract,
  floorSessionsContract,
  floorSignContract,
  listInstructionContract,
  listSessionsContract,
  openSessionContract,
  paperAttendanceContract,
  paperInstructionContract,
  personTrainingContract,
  recordPdfContract,
  recordTrainingContract,
  sessionRecordContract,
  voidAttendanceContract,
  voidInstructionContract,
} from './contract'
import { dueList, dueListPdf } from './due'
import { floorCountersign, floorInstructionPending, floorInstructionSign, floorSession, floorSessions, floorSign } from './floor'
import { addInstruction, listInstruction, paperInstruction, voidInstruction } from './instruction'
import { manifest } from './manifest'
import { correctRecord, personTraining, recordPdf, recordTraining } from './records'
import { cancelSession, closeSession, countersignInOffice, editSession, listSessions, openSession, recordPaperAttendance, sessionRecord, voidAttendance } from './sessions'

/**
 * The training records (B-W2b-139): sessions and attendance in the office (./sessions.ts), a person's records, training given
 * elsewhere and corrections (./records.ts), due and overdue (./due.ts), the instruction register (./instruction.ts) and the
 * floor's signatures (./floor.ts). Each write is one command with an Idempotency-Key (required on the floor); a repeated key
 * answers from its receipt. The PDFs are made in memory, never stored.
 */
export default defineRoutes('safety.records', manifest, async (app) => {
  app.get('/safety/training/sessions', { schema: listSessionsContract }, async (request) => listSessions(request, request.query))
  app.get('/safety/training/sessions/:sessionId', { schema: sessionRecordContract }, async (request) => sessionRecord(request, request.params.sessionId))
  app.post('/safety/training/sessions', { schema: openSessionContract }, async (request, reply) => {
    const answer = await openSession(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ session: answer.session })
  })
  app.patch('/safety/training/sessions/:sessionId', { schema: editSessionContract }, async (request) => editSession(request, request.params.sessionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/training/sessions/:sessionId/paper', { schema: paperAttendanceContract }, async (request) => recordPaperAttendance(request, request.params.sessionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/training/sessions/:sessionId/countersign', { schema: countersignContract }, async (request) => countersignInOffice(request, request.params.sessionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/training/sessions/:sessionId/attendances/:attendanceId/void', { schema: voidAttendanceContract }, async (request) =>
    voidAttendance(request, request.params.sessionId, request.params.attendanceId, request.body, idempotencyKeyFrom(request)),
  )
  app.post('/safety/training/sessions/:sessionId/close', { schema: closeSessionContract }, async (request) => closeSession(request, request.params.sessionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/training/sessions/:sessionId/cancel', { schema: cancelSessionContract }, async (request) => cancelSession(request, request.params.sessionId, request.body, idempotencyKeyFrom(request)))

  app.get('/safety/training/people/:employeeId', { schema: personTrainingContract }, async (request) => personTraining(request, request.params.employeeId))
  app.post('/safety/training/records', { schema: recordTrainingContract }, async (request, reply) => {
    const answer = await recordTraining(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ records: answer.records, certificate: answer.certificate })
  })
  app.post('/safety/training/records/:recordId/correct', { schema: correctRecordContract }, async (request) => correctRecord(request, request.params.recordId, request.body, idempotencyKeyFrom(request)))
  app.get('/safety/training/records/:recordId/pdf', { schema: recordPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await recordPdf(request, request.params.recordId, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.get('/safety/training/due', { schema: dueListContract }, async (request) => dueList(request, request.query))
  app.get('/safety/training/due/pdf', { schema: dueListPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await dueListPdf(request, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.get('/safety/training/instruction', { schema: listInstructionContract }, async (request) => listInstruction(request, request.query))
  app.post('/safety/training/instruction', { schema: addInstructionContract }, async (request, reply) => {
    const answer = await addInstruction(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ entry: answer.entry, scan: answer.scan })
  })
  app.post('/safety/training/instruction/:instructionId/paper', { schema: paperInstructionContract }, async (request) => paperInstruction(request, request.params.instructionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/training/instruction/:instructionId/void', { schema: voidInstructionContract }, async (request) => voidInstruction(request, request.params.instructionId, request.body, idempotencyKeyFrom(request)))

  app.get('/safety/floor/training/sessions', { schema: floorSessionsContract }, async (request) => floorSessions(request))
  app.get('/safety/floor/training/sessions/:sessionId', { schema: floorSessionContract }, async (request) => floorSession(request, request.params.sessionId))
  app.post('/safety/floor/training/sessions/:sessionId/sign', { schema: floorSignContract }, async (request) => floorSign(officeAuthOf(app), request, request.params.sessionId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/floor/training/sessions/:sessionId/countersign', { schema: floorCountersignContract }, async (request) =>
    floorCountersign(officeAuthOf(app), request, request.params.sessionId, request.body, idempotencyKeyFrom(request)),
  )
  app.post('/safety/floor/training/instruction/pending', { schema: floorInstructionPendingContract }, async (request) => floorInstructionPending(request, request.body))
  app.post('/safety/floor/training/instruction/:instructionId/sign', { schema: floorInstructionSignContract }, async (request) =>
    floorInstructionSign(officeAuthOf(app), request, request.params.instructionId, request.body, idempotencyKeyFrom(request)),
  )
})
