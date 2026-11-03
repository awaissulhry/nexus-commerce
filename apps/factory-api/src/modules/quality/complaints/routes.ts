import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../inventory/receipts/report'
import { answerCheck, investigateComplaint, previewAnswerLetter, saveAnswer, sendAnswer } from './answer'
import {
  acknowledgeContract,
  answerCheckContract,
  answerLetterContract,
  changeContract,
  closeContract,
  countsContract,
  getContract,
  investigationContract,
  linkContract,
  listContract,
  logContract,
  peopleContract,
  previewContract,
  registerContract,
  saveAnswerContract,
  sendAnswerContract,
  statusContract,
  triageContract,
  unlinkContract,
} from './contract'
import { linkToComplaint, unlinkFromComplaint } from './links'
import { complaintCounts, complaintPeople, listComplaints } from './list'
import { logComplaint, previewComplaint } from './log'
import { manifest } from './manifest'
import { acknowledgeComplaint, changeComplaint, closeComplaint, getComplaint, moveComplaint, registerComplaint, triageComplaint } from './steps'

/**
 * Customer complaints of B-W2a-65: the list, its tiles and the safety banner (./list.ts), logging one as the customer made
 * it (./log.ts), the record and its steps — triage with the safety escalation, the owner's acknowledgement, the status
 * moves, the PPE register, the close (./steps.ts). An NCR is raised from a complaint through POST /quality/ncr (from:
 * Complaint) and a repair through POST /sales/repairs (complaintId): their modules' own routes.
 */
export default defineRoutes('quality.complaints', manifest, async (app) => {
  app.get('/quality/complaints', { schema: listContract }, async (request) => listComplaints(request, request.query))
  app.get('/quality/complaints/counts', { schema: countsContract }, async (request) => complaintCounts(request))
  app.get('/quality/complaints/people', { schema: peopleContract }, async (request) => complaintPeople(request, request.query.companyId))
  app.post('/quality/complaints/preview', { schema: previewContract }, async (request) => previewComplaint(request, request.body))
  app.post('/quality/complaints', { schema: logContract }, async (request, reply) => reply.code(201).send(await logComplaint(request, request.body, idempotencyKeyFrom(request))))

  app.get('/quality/complaints/:complaintId', { schema: getContract }, async (request) => getComplaint(request, request.params.complaintId))
  app.patch('/quality/complaints/:complaintId', { schema: changeContract }, async (request) => changeComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/complaints/:complaintId/triage', { schema: triageContract }, async (request) => triageComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/complaints/:complaintId/acknowledge', { schema: acknowledgeContract }, async (request) => acknowledgeComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/complaints/:complaintId/status', { schema: statusContract }, async (request) => moveComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  app.post('/quality/complaints/:complaintId/close', { schema: closeContract }, async (request) => closeComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-17: Link… / Unlink on Linked records (the complaint's own facts, or an NCR that names it).
  app.post('/quality/complaints/:complaintId/links', { schema: linkContract }, async (request) => linkToComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  app.delete('/quality/complaints/:complaintId/links/:recordType/:recordId', { schema: unlinkContract }, async (request) =>
    unlinkFromComplaint(request, request.params.complaintId, { recordType: request.params.recordType, recordId: request.params.recordId }, request.query, idempotencyKeyFrom(request)),
  )
  app.post('/quality/complaints/:complaintId/register', { schema: registerContract }, async (request) => registerComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-113 (QHS-116): the investigation, the answer letter written, previewed and sent (review then send; FAKE e-mail).
  app.patch('/quality/complaints/:complaintId/investigation', { schema: investigationContract }, async (request) => investigateComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  app.put('/quality/complaints/:complaintId/answer', { schema: saveAnswerContract }, async (request) => saveAnswer(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
  app.get('/quality/complaints/:complaintId/answer/check', { schema: answerCheckContract }, async (request) => answerCheck(request, request.params.complaintId))
  app.get('/quality/complaints/:complaintId/answer/letter', { schema: answerLetterContract }, async (request, reply) => {
    const { pdf, fileName } = await previewAnswerLetter(request, request.params.complaintId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.post('/quality/complaints/:complaintId/answer/send', { schema: sendAnswerContract }, async (request) => sendAnswer(processFiles(), request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
})
