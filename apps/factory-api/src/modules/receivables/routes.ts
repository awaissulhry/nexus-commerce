import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { requireStepUp } from '../../platform/auth/office/account'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { ageing } from './ageing'
import {
  ageingContract,
  approveContract,
  bulkApproveContract,
  correctInterestRateContract,
  editContract,
  getReminderContract,
  letterPdfContract,
  listInterestRatesContract,
  listRemindersContract,
  prepareContract,
  recordInterestRateContract,
  putSettingsContract,
  reasonContract,
  reminderCountsContract,
  sendContract,
  sendStatementContract,
  settingsContract,
  statementContract,
  statementPdfContract,
  switchContract,
} from './contract'
import { correctInterestRate, listInterestRates, recordInterestRate } from './interest-rates'
import { manifest } from './manifest'
import { inlineDisposition, letterPreview } from './pdf'
import { approveMany, approveReminder, cancelReminder, editReminder, getReminder, listReminders, prepareReminder, reminderCounts, sendReminder, skipReminder } from './reminders'
import { getSettings, putSettings, putSwitch } from './settings'
import { getStatement, sendStatement, statementPdf } from './statement'

/**
 * Receivables (B-W2a-55; FIN-109, FIN-110, FIN-111; design finance.receivables, SCR-151): what customers owe and how late,
 * each customer's ledger and statement (and its PDF, printed or e-mailed), the reminder ladder's settings and the
 * reminders a person approves. Nothing reaches a customer while the company's reminders are switched off (the Owner's
 * switch); e-mail goes out on the FAKE provider locally and in tests. The ladder itself runs in the worker and the
 * scheduler (./ladder.ts). Credit limits are W2b.
 */
export default defineRoutes('receivables', manifest, async (app) => {
  app.get('/receivables/ageing', { schema: ageingContract }, async (request) => ageing(request, request.query))

  app.get('/receivables/customers/:partyId/statement', { schema: statementContract }, async (request) => getStatement(request, request.params.partyId, request.query))

  app.get('/receivables/customers/:partyId/statement/pdf', { schema: statementPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await statementPdf(request, request.params.partyId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/receivables/customers/:partyId/statement/send', { schema: sendStatementContract }, async (request, reply) =>
    reply.code(201).send(await sendStatement(request, request.params.partyId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/receivables/settings', { schema: settingsContract }, async (request) => getSettings(request, request.query))

  app.put('/receivables/settings', { schema: putSettingsContract }, async (request) => putSettings(request, request.body, idempotencyKeyFrom(request)))

  app.put('/receivables/settings/switch', { schema: switchContract }, async (request) => putSwitch(request, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)))

  app.get('/receivables/reminders', { schema: listRemindersContract }, async (request) => listReminders(request, request.query))

  app.get('/receivables/reminders/counts', { schema: reminderCountsContract }, async (request) => reminderCounts(request, request.query))

  app.post('/receivables/reminders', { schema: prepareContract }, async (request, reply) => reply.code(201).send(await prepareReminder(request, request.body, idempotencyKeyFrom(request))))

  app.post('/receivables/reminders/approve', { schema: bulkApproveContract }, async (request) => approveMany(request, request.body, idempotencyKeyFrom(request)))

  app.get('/receivables/reminders/:reminderId', { schema: getReminderContract }, async (request) => getReminder(request, request.params.reminderId))

  app.get('/receivables/reminders/:reminderId/pdf', { schema: letterPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await letterPreview(request, request.params.reminderId)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.patch('/receivables/reminders/:reminderId', { schema: editContract }, async (request) => editReminder(request, request.params.reminderId, request.body, idempotencyKeyFrom(request)))

  app.post('/receivables/reminders/:reminderId/approve', { schema: approveContract }, async (request) => approveReminder(request, request.params.reminderId, request.body, idempotencyKeyFrom(request)))

  app.post('/receivables/reminders/:reminderId/send', { schema: sendContract }, async (request) => sendReminder(request, request.params.reminderId, request.body, idempotencyKeyFrom(request)))

  app.post('/receivables/reminders/:reminderId/skip', { schema: reasonContract }, async (request) => skipReminder(request, request.params.reminderId, request.body, idempotencyKeyFrom(request)))

  app.post('/receivables/reminders/:reminderId/cancel', { schema: reasonContract }, async (request) => cancelReminder(request, request.params.reminderId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-21: the half-year reference rates statutory late-payment interest is computed from (D.Lgs. 231/2002 art. 5).
  app.get('/receivables/interest-rates', { schema: listInterestRatesContract }, async (request) => listInterestRates(request))

  app.post('/receivables/interest-rates', { schema: recordInterestRateContract }, async (request, reply) => reply.code(201).send(await recordInterestRate(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/receivables/interest-rates/:rateId', { schema: correctInterestRateContract }, async (request) => correctInterestRate(request, request.params.rateId, request.body, idempotencyKeyFrom(request)))
})
