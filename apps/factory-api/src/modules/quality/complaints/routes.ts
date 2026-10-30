import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { acknowledgeContract, changeContract, closeContract, countsContract, getContract, listContract, logContract, peopleContract, previewContract, registerContract, statusContract, triageContract } from './contract'
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
  app.post('/quality/complaints/:complaintId/register', { schema: registerContract }, async (request) => registerComplaint(request, request.params.complaintId, request.body, idempotencyKeyFrom(request)))
})
