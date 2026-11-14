import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { requireStepUp } from '../../platform/auth/office/account'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { processEmail } from '../../platform/email-out/service'
import { processFiles } from '../../platform/files/service'
import {
  allocateContract,
  cancelRefundContract,
  carryDepositContract,
  changeRefundContract,
  creditBalanceContract,
  depositLinkViewContract,
  depositReceivedContract,
  getPaymentContract,
  getRefundContract,
  listPaymentsContract,
  listRefundsContract,
  openItemsContract,
  openRefundsContract,
  payRefundContract,
  recordPaymentContract,
  recordRefundContract,
  releaseOverpaymentContract,
  reverseContract,
  sendDepositLinkContract,
  voidContract,
  voidRefundContract,
} from './contract'
import { creditBalance, releaseOverpayment } from './credit-balance'
import { carryDeposit } from './deposit-carry'
import { depositLinkView, sendDepositLink } from './deposit-link'
import { depositReceived } from './deposits'
import { manifest } from './manifest'
import { openItems } from './open-items'
import { allocatePayment, getPayment, listPayments, recordPayment, reverseAllocation, voidPayment } from './payments'
import { cancelRefund, changeRefund, getRefund, listRefunds, openRefunds, payRefund, recordRefund, voidRefund } from './refunds'
// B-W2b-185: paying online (card and SEPA through the payment provider; ./online).
import { fakeConfirmContract, linkIntentContract, linkPayPageContract, linkStartContract, officeIntentsContract, portalIntentContract, portalOpenItemsContract, portalStartContract, portalStatementContract, portalStatementPdfContract, sendPayLinkContract } from './online/contract'
import { fakeConfirm } from './online/fake-provider'
import { inlineDisposition } from '../receivables/pdf'
import { linkIntent, linkPayPage, linkStart } from './online/link'
import { officeIntents, sendPayLink } from './online/office'
import { portalIntent, portalOpenItems, portalStart, portalStatement, portalStatementPdf } from './online/portal'
// B-W2b-393: bank statements, matching, the unapplied cash queue, write-offs (./bank, ./matching, ./write-offs).
import { announceStatementContract, dryRunStatementContract, getLineContract, getStatementContract, importStatementContract, lineCountsContract, listAccountsContract, listLinesContract, listStatementsContract, paymentBankLineContract } from './bank/contract'
import { getLine, getStatement, lineCounts, listAccounts, listLines, listStatements, paymentBankLine } from './bank/reads'
import { announceStatement, dryRunStatement, importStatement } from './bank/statements'
import { acceptMany, acceptMatch, chooseMatch, reverseMatch } from './matching/accept'
import { acceptManyContract, acceptMatchContract, chooseMatchContract, refreshSuggestionsContract, reverseMatchContract, unappliedContract } from './matching/contract'
import { refreshRoute } from './matching/suggest'
import { unappliedQueue } from './matching/unapplied'
import { getToleranceContract, listWriteOffsContract, putToleranceContract, reverseWriteOffContract, writeOffContract } from './write-offs/contract'
import { getTolerance, listWriteOffs, putTolerance, reverseWriteOff, writeOffPayment } from './write-offs/write-offs'

/**
 * Payments received (B-W1-28; FIN-121, FIN-066; Q12; A2 SCR-082): bank transfers typed by the office, what they pay
 * (deposit requests, issued TD01/TD24 invoices), reversals and voids, and "deposit received" with its TD02. Bank
 * statement import and card payments are W2b.
 */
export default defineRoutes('payments', manifest, async (app) => {
  app.get('/payments', { schema: listPaymentsContract }, async (request) => listPayments(request, request.query))

  app.get('/payments/open-items', { schema: openItemsContract }, async (request) => openItems(request, request.query))

  // B-W2a-61: refunds (FIN-127) and the credit balance (FIN-122). Literal paths before /payments/:paymentId.
  app.get('/payments/refunds', { schema: listRefundsContract }, async (request) => listRefunds(request, request.query))

  app.get('/payments/refunds/open', { schema: openRefundsContract }, async (request) => openRefunds(request, request.query))

  app.get('/payments/refunds/:refundId', { schema: getRefundContract }, async (request) => getRefund(request, request.params.refundId))

  app.post('/payments/refunds', { schema: recordRefundContract }, async (request, reply) => reply.code(201).send(await recordRefund(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/payments/refunds/:refundId', { schema: changeRefundContract }, async (request) => changeRefund(request, request.params.refundId, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/refunds/:refundId/paid', { schema: payRefundContract }, async (request) => payRefund(request, request.params.refundId, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/refunds/:refundId/cancel', { schema: cancelRefundContract }, async (request) => cancelRefund(request, request.params.refundId, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/refunds/:refundId/void', { schema: voidRefundContract }, async (request) => voidRefund(request, request.params.refundId, request.body, idempotencyKeyFrom(request)))

  app.get('/payments/credit-balance', { schema: creditBalanceContract }, async (request) => creditBalance(request, request.query))

  app.post('/payments/release-overpayment', { schema: releaseOverpaymentContract }, async (request) => releaseOverpayment(request, request.body, idempotencyKeyFrom(request)))

  app.get('/payments/:paymentId', { schema: getPaymentContract }, async (request) => getPayment(request, request.params.paymentId))

  app.post('/payments', { schema: recordPaymentContract }, async (request, reply) => reply.code(201).send(await recordPayment(request, request.body, idempotencyKeyFrom(request))))

  app.post('/payments/deposit-received', { schema: depositReceivedContract }, async (request, reply) =>
    reply.code(201).send(await depositReceived(processFiles(), request, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request))),
  )

  app.post('/payments/deposit-requests/:depositRequestId/link', { schema: sendDepositLinkContract }, async (request, reply) =>
    reply.code(201).send(await sendDepositLink(processEmail(), request, request.params.depositRequestId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/payments/link/deposit', { schema: depositLinkViewContract }, async (request) => depositLinkView(request))

  // B-W2b-21: a PAID deposit that issues no deposit invoice (NONE) carried onto its order's invoice, in one command.
  app.post('/payments/deposit-requests/:depositRequestId/carry', { schema: carryDepositContract }, async (request) => carryDeposit(request, request.params.depositRequestId, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/:paymentId/allocations', { schema: allocateContract }, async (request) => allocatePayment(request, request.params.paymentId, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/:paymentId/allocations/:allocationId/reverse', { schema: reverseContract }, async (request) =>
    reverseAllocation(request, request.params.paymentId, request.params.allocationId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/payments/:paymentId/void', { schema: voidContract }, async (request) => voidPayment(request, request.params.paymentId, request.body, idempotencyKeyFrom(request)))

  // ---- B-W2b-185: paying online (./online; FIN-118, FIN-123) ----------------------------------------------------------
  // The office: the page to pay an invoice, sent by link; the online payments of a record.
  app.post('/payments/invoices/:invoiceId/link', { schema: sendPayLinkContract }, async (request, reply) =>
    reply.code(201).send(await sendPayLink(processEmail(), request, request.params.invoiceId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/payments/intents', { schema: officeIntentsContract }, async (request) => officeIntents(request, request.query))

  // The link (PAYMENT, DEPOSIT_INFO): what you pay, the bank transfer, card and SEPA.
  app.get('/payments/link/pay', { schema: linkPayPageContract }, async (request) => linkPayPage(request))

  app.post('/payments/link/pay/intents', { schema: linkStartContract }, async (request, reply) => reply.code(201).send(await linkStart(request, request.body.method)))

  app.get('/payments/link/pay/intents/:intentId', { schema: linkIntentContract }, async (request) => linkIntent(request, request.params.intentId))

  // The customer portal (Finance and Admin): open items, the statement, pay.
  app.get('/portal/payments/open-items', { schema: portalOpenItemsContract }, async (request) => portalOpenItems(request, officeAuthOf(app).clock.now()))

  app.get('/portal/payments/statement', { schema: portalStatementContract }, async (request) => portalStatement(request, request.query))

  app.get('/portal/payments/statement/pdf', { schema: portalStatementPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await portalStatementPdf(request, request.query, officeAuthOf(app).clock.now())
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/portal/payments/intents', { schema: portalStartContract }, async (request, reply) => reply.code(201).send(await portalStart(request, request.body)))

  app.get('/portal/payments/intents/:intentId', { schema: portalIntentContract }, async (request) => portalIntent(request, request.params.intentId))

  // The FAKE provider's own fields (local and test only: 404 elsewhere).
  app.post('/payment-fake/confirm', { schema: fakeConfirmContract }, async (request) => fakeConfirm(request, request.body))

  // ---- B-W2b-393: bank statements, matching, the unapplied cash queue, write-offs (FIN-130, FIN-132, FIN-117, FIN-119) ----
  app.get('/payments/bank/accounts', { schema: listAccountsContract }, async (request) => listAccounts(request, request.query))

  app.get('/payments/bank/statements', { schema: listStatementsContract }, async (request) => listStatements(request, request.query))

  app.get('/payments/bank/statements/:statementId', { schema: getStatementContract }, async (request) => getStatement(request, request.params.statementId))

  app.post('/payments/bank/statements/uploads', { schema: announceStatementContract }, async (request, reply) => reply.code(201).send(await announceStatement(request, request.body, idempotencyKeyFrom(request))))

  app.post('/payments/bank/statements/dry-run', { schema: dryRunStatementContract }, async (request) => dryRunStatement(request, request.body))

  app.post('/payments/bank/statements', { schema: importStatementContract }, async (request, reply) => reply.code(201).send(await importStatement(request, request.body, idempotencyKeyFrom(request))))

  app.get('/payments/bank/lines', { schema: listLinesContract }, async (request) => listLines(request, request.query))

  app.get('/payments/bank/lines/counts', { schema: lineCountsContract }, async (request) => lineCounts(request, request.query))

  app.get('/payments/bank/lines/:lineId', { schema: getLineContract }, async (request) => getLine(request, request.params.lineId))

  app.post('/payments/bank/lines/:lineId/match', { schema: chooseMatchContract }, async (request, reply) => reply.code(201).send(await chooseMatch(request, request.params.lineId, request.body, idempotencyKeyFrom(request))))

  app.post('/payments/bank/matches/accept', { schema: acceptManyContract }, async (request) => acceptMany(request, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/bank/matches/:matchId/accept', { schema: acceptMatchContract }, async (request) => acceptMatch(request, request.params.matchId, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/bank/matches/:matchId/reverse', { schema: reverseMatchContract }, async (request) => reverseMatch(request, request.params.matchId, request.body, idempotencyKeyFrom(request)))

  app.post('/payments/bank/suggestions/refresh', { schema: refreshSuggestionsContract }, async (request) => refreshRoute(request, request.body, idempotencyKeyFrom(request)))

  app.get('/payments/unapplied', { schema: unappliedContract }, async (request) => unappliedQueue(request, request.query))

  app.get('/payments/:paymentId/bank-line', { schema: paymentBankLineContract }, async (request) => paymentBankLine(request, request.params.paymentId))

  app.get('/payments/:paymentId/write-offs', { schema: listWriteOffsContract }, async (request) => listWriteOffs(request, request.params.paymentId))

  app.post('/payments/:paymentId/write-offs', { schema: writeOffContract }, async (request, reply) => reply.code(201).send(await writeOffPayment(request, request.params.paymentId, request.body, idempotencyKeyFrom(request))))

  app.post('/payments/:paymentId/write-offs/:writeOffId/reverse', { schema: reverseWriteOffContract }, async (request) =>
    reverseWriteOff(request, request.params.paymentId, request.params.writeOffId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/payments/write-offs/tolerance', { schema: getToleranceContract }, async (request) => getTolerance(request, request.query))

  app.put('/payments/write-offs/tolerance', { schema: putToleranceContract }, async (request) => putTolerance(request, request.body, idempotencyKeyFrom(request)))
})
