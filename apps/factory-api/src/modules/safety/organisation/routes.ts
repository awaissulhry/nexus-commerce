import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { appoint, editAppointment, endAppointment, signAppointment } from './appointments'
import {
  appointmentRecordContract,
  cancelNoticeContract,
  contactsContract,
  createAppointmentContract,
  editAppointmentContract,
  endAppointmentContract,
  fileNoticeContract,
  listNoticesContract,
  noticeDueContract,
  organisationContract,
  peopleContract,
  shiftsContract,
  signAppointmentContract,
} from './contract'
import { manifest } from './manifest'
import { cancelNotice, fileNotice, setNoticeDue } from './notices'
import { appointmentRecord, listNotices, pickContacts, pickPeople, pickShifts, readOrganisation } from './reads'

/**
 * The safety organisation and the RLS notice to INAIL (B-W2b-120; ./reads.ts, ./appointments.ts, ./notices.ts). Each write
 * is one command with an Idempotency-Key; a repeated key answers from its receipt.
 */
export default defineRoutes('safety.organisation', manifest, async (app) => {
  app.get('/safety/organisation', { schema: organisationContract }, async (request) => readOrganisation(request, request.query))
  app.get('/safety/organisation/people', { schema: peopleContract }, async (request) => pickPeople(request, request.query))
  app.get('/safety/organisation/contacts', { schema: contactsContract }, async (request) => pickContacts(request, request.query))
  app.get('/safety/organisation/shifts', { schema: shiftsContract }, async (request) => pickShifts(request, request.query))

  app.get('/safety/appointments/:appointmentId', { schema: appointmentRecordContract }, async (request) => appointmentRecord(request, request.params.appointmentId))
  app.post('/safety/appointments', { schema: createAppointmentContract }, async (request, reply) => {
    const answer = await appoint(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/safety/appointments/:appointmentId', { schema: editAppointmentContract }, async (request) => editAppointment(request, request.params.appointmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/appointments/:appointmentId/sign', { schema: signAppointmentContract }, async (request) => signAppointment(request, request.params.appointmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/appointments/:appointmentId/end', { schema: endAppointmentContract }, async (request) => endAppointment(request, request.params.appointmentId, request.body, idempotencyKeyFrom(request)))

  app.get('/safety/rls-notices', { schema: listNoticesContract }, async (request) => listNotices(request, request.query))
  app.post('/safety/rls-notices/:noticeId/file', { schema: fileNoticeContract }, async (request) => fileNotice(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/rls-notices/:noticeId/due', { schema: noticeDueContract }, async (request) => setNoticeDue(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/rls-notices/:noticeId/cancel', { schema: cancelNoticeContract }, async (request) => cancelNotice(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))
})
