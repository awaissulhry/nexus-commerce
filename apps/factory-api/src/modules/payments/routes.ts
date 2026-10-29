import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { requireStepUp } from '../../platform/auth/office/account'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { processEmail } from '../../platform/email-out/service'
import { processFiles } from '../../platform/files/service'
import { allocateContract, depositLinkViewContract, depositReceivedContract, getPaymentContract, listPaymentsContract, recordPaymentContract, reverseContract, sendDepositLinkContract, voidContract } from './contract'
import { depositLinkView, sendDepositLink } from './deposit-link'
import { depositReceived } from './deposits'
import { manifest } from './manifest'
import { allocatePayment, getPayment, listPayments, recordPayment, reverseAllocation, voidPayment } from './payments'

/**
 * Payments received (B-W1-28; FIN-121, FIN-066; Q12; A2 SCR-082): bank transfers typed by the office, what they pay
 * (deposit requests, issued TD01/TD24 invoices), reversals and voids, and "deposit received" with its TD02. Bank
 * statement import and card payments are W2b.
 */
export default defineRoutes('payments', manifest, async (app) => {
  app.get('/payments', { schema: listPaymentsContract }, async (request) => listPayments(request, request.query))

  app.get('/payments/:paymentId', { schema: getPaymentContract }, async (request) => getPayment(request, request.params.paymentId))

  app.post('/payments', { schema: recordPaymentContract }, async (request, reply) => reply.code(201).send(await recordPayment(request, request.body, idempotencyKeyFrom(request))))

  app.post('/payments/deposit-received', { schema: depositReceivedContract }, async (request, reply) =>
    reply.code(201).send(await depositReceived(processFiles(), request, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request))),
  )

  app.post('/payments/deposit-requests/:depositRequestId/link', { schema: sendDepositLinkContract }, async (request, reply) =>
    reply.code(201).send(await sendDepositLink(processEmail(), request, request.params.depositRequestId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/payments/link/deposit', { schema: depositLinkViewContract }, async (request) => depositLinkView(request))

  app.post('/payments/:paymentId/allocations', { schema: allocateContract }, async (request) => allocatePayment(request, request.params.paymentId, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/:paymentId/allocations/:allocationId/reverse', { schema: reverseContract }, async (request) =>
    reverseAllocation(request, request.params.paymentId, request.params.allocationId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/payments/:paymentId/void', { schema: voidContract }, async (request) => voidPayment(request, request.params.paymentId, request.body, idempotencyKeyFrom(request)))
})
