import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  alterationBody,
  alteredView,
  appointmentsQuery,
  appointmentsView,
  appointmentView,
  bookBody,
  bookedView,
  cancelBody,
  closeBody,
  fittingsTabView,
  inviteBody,
  ledToBody,
  moveBody,
  recordedResultView,
  remadeView,
  remakeOrderBody,
  remakeView,
  resultBody,
  resultView,
  revisionBody,
} from '@nexus/factory-domain/sales/fittings/contracts'

/** Fittings, alterations and remakes (B-W2b-360): the bodies and answers are factory-domain's sales/fittings/contracts. No money. */

const appointment = input({ appointmentId: id() })
const result = input({ resultId: id() })
const one = output({ appointment: appointmentView })

export const listAppointmentsContract = defineContract({ querystring: appointmentsQuery, response: { 200: appointmentsView } })
export const bookContract = defineContract({ body: bookBody, response: { 201: bookedView } })
export const getAppointmentContract = defineContract({ params: appointment, response: { 200: one } })
export const moveContract = defineContract({ params: appointment, body: moveBody, response: { 200: bookedView } })
export const closeContract = defineContract({ params: appointment, body: closeBody, response: { 200: one } })
export const cancelContract = defineContract({ params: appointment, body: cancelBody, response: { 200: bookedView } })
export const inviteContract = defineContract({ params: appointment, body: inviteBody, response: { 200: bookedView } })
export const ledToContract = defineContract({ params: appointment, body: ledToBody, response: { 200: one } })
export const recordResultContract = defineContract({ body: resultBody, response: { 201: recordedResultView } })
export const getResultContract = defineContract({ params: result, response: { 200: output({ result: resultView }) } })
export const alterationContract = defineContract({ params: result, body: alterationBody, response: { 201: alteredView } })
export const revisionContract = defineContract({ params: result, body: revisionBody, response: { 200: output({ result: resultView }) } })
export const profileFittingsContract = defineContract({ params: input({ profileId: id() }), /* B-W2b-F38: the screen's company, for its reminder switch */ querystring: input({ companyId: id().optional() }), response: { 200: output({ fittings: fittingsTabView }) } })
export const getRemakeContract = defineContract({ params: input({ returnId: id() }), response: { 200: output({ remake: remakeView }) } })
export const remakeOrderContract = defineContract({ params: input({ returnId: id() }), body: remakeOrderBody, response: { 201: remadeView } })
