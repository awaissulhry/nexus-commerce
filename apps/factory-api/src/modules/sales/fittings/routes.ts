import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { bookAppointment, cancelAppointment, closeAppointment, getAppointment, inviteAgain, ledTo, listAppointments, moveAppointment } from './appointments'
import {
  alterationContract,
  bookContract,
  cancelContract,
  closeContract,
  getAppointmentContract,
  getRemakeContract,
  getResultContract,
  inviteContract,
  ledToContract,
  listAppointmentsContract,
  moveContract,
  profileFittingsContract,
  recordResultContract,
  remakeOrderContract,
  revisionContract,
} from './contract'
import { manifest } from './manifest'
import { getRemake, makeRemakeOrder } from './remake'
import { getResult, nameRevision, openAlteration, profileFittings, recordResult } from './results'

/**
 * Fittings, alterations and remakes of made-to-measure units (sales module, B-W2b-360; SAL-054, SAL-297, SAL-353; design sales.mtm ›
 * Fittings "Book a fitting", "Record outcome", drawn by B-W2b-362): appointments with the rider's invite, update, reminder and
 * cancellation mails (./appointments.ts, ./mail.ts, the hourly cron ./reminders.ts), what a fitting found and the alteration loop
 * (./results.ts), the remake order of a returned unit (./remake.ts; the REMAKE decision is one marked block of returns/decide.ts).
 * Built switched OFF per template (Owner 11-10, GATE-MTM): nothing is booked, recorded, mailed or remade while the garment type's
 * template has its made-to-measure rules off.
 */
export default defineRoutes('sales.fittings', manifest, async (app) => {
  app.get('/sales/fittings/appointments', { schema: listAppointmentsContract }, async (request) => listAppointments(request, request.query))
  app.post('/sales/fittings/appointments', { schema: bookContract }, async (request, reply) => reply.code(201).send(await bookAppointment(request, request.body, idempotencyKeyFrom(request))))
  app.get('/sales/fittings/appointments/:appointmentId', { schema: getAppointmentContract }, async (request) => getAppointment(request, request.params.appointmentId))
  app.patch('/sales/fittings/appointments/:appointmentId', { schema: moveContract }, async (request) => moveAppointment(request, request.params.appointmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/fittings/appointments/:appointmentId/close', { schema: closeContract }, async (request) => closeAppointment(request, request.params.appointmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/fittings/appointments/:appointmentId/cancel', { schema: cancelContract }, async (request) => cancelAppointment(request, request.params.appointmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/fittings/appointments/:appointmentId/invite', { schema: inviteContract }, async (request) => inviteAgain(request, request.params.appointmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/fittings/appointments/:appointmentId/led-to', { schema: ledToContract }, async (request) => ledTo(request, request.params.appointmentId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/fittings/results', { schema: recordResultContract }, async (request, reply) => reply.code(201).send(await recordResult(request, request.body, idempotencyKeyFrom(request))))
  app.get('/sales/fittings/results/:resultId', { schema: getResultContract }, async (request) => getResult(request, request.params.resultId))
  app.post('/sales/fittings/results/:resultId/alteration', { schema: alterationContract }, async (request, reply) => reply.code(201).send(await openAlteration(request, request.params.resultId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/fittings/results/:resultId/revision', { schema: revisionContract }, async (request) => nameRevision(request, request.params.resultId, request.body, idempotencyKeyFrom(request)))
  app.get('/sales/mtm/profiles/:profileId/fittings', { schema: profileFittingsContract }, async (request) => ({ fittings: await profileFittings(request, request.params.profileId, /* B-W2b-F38 */ request.query) }))
  app.get('/sales/returns/:returnId/remake-order', { schema: getRemakeContract }, async (request) => getRemake(request, request.params.returnId))
  app.post('/sales/returns/:returnId/remake-order', { schema: remakeOrderContract }, async (request, reply) => reply.code(201).send(await makeRemakeOrder(request, request.params.returnId, request.body, idempotencyKeyFrom(request))))
})
