import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { acceptDifference, approveInvoice, approveMany, payInvoice, sendToBuyer, settleClaim, withdrawApproval } from './approval'
import {
  acceptContract,
  addLineContract,
  approveContract,
  bulkApproveContract,
  candidatesContract,
  countsContract,
  createContract,
  dismissInboxContract,
  getContract,
  getSettingsContract,
  listInboxContract,
  listContract,
  patchContract,
  patchLineContract,
  payContract,
  pickupContract,
  putSettingsContract,
  reasonContract,
  removeLineContract,
  reopenContract,
  reopenInboxContract,
  sdiStatusContract,
  sendToBuyerContract,
  settleClaimContract,
  versionContract,
  xmlContract,
} from './contract'
import { invoiceXml } from './files'
import { dismissInboxItem, listInbox, reopenInboxItem } from './inbox'
import { addLine, createInvoice, disputeInvoice, getInvoice, invoiceCounts, listInvoices, mappingCandidates, markWithoutOrder, matchAgain, patchInvoice, patchLine, removeLine, reopenInvoice, voidInvoice } from './invoices'
import { manifest } from './manifest'
import { pickUpNow, sdiStatus } from './sdi'
import { getPayablesSettings, putPayablesSettings } from './settings'
// B-W2b-403: payables in depth (the leather area check, the subcontract match, the weekly proposal, dual approval, controls).
import { requireStepUp } from '../../platform/auth/office/account'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { invoiceDualApproval } from './approve'
import { areaCheckContract, areaClaimContract } from './area-check/contract'
import { invoiceAreaCheck, openAreaClaim } from './area-check/check'
import { approveProposalContract, candidatesContract as proposalCandidatesContract, createProposalContract, getProposalContract, getRemittanceContract, invoiceDualContract, listProposalsContract, moneyControlsContract, paidProposalContract, putLinesContract, putRemittanceContract, reasonProposalContract } from './proposal/contract'
import { moneyControls } from './proposal/controls'
import { approveProposal, cancelProposal, createProposal, getProposal, listProposals, proposalCandidates, putProposalLines, recordProposalPaid, sendBackProposal } from './proposal/proposals'
import { getRemittanceSettings, putRemittanceSettings } from './proposal/remittance'
import { bookFeeContract, subcontractMatchContract } from './subcontract-match/contract'
import { bookInvoiceFee, invoiceSubcontractMatch } from './subcontract-match/match'

/**
 * Payables (B-W2a-62; FIN-136, FIN-137; design finance.payables, SCR-153 "Supplier invoices"): supplier and
 * subcontractor invoices from SDI (picked up from the company's SDI intermediary: the FAKE until Owner question Q21) or
 * typed from their PDF (a foreign supplier's, one sent by e-mail); their lines mapped to purchase and subcontract
 * orders; the three-way match against the receipts and the order's price; differences accepted in words or sent to
 * the buyer; approval by another person than the registrant; the payment recorded. The payment proposal, self-invoices
 * (TD17–TD19) and the dual approval above a limit are W2b. The screens are B-W2a-81.
 */
export default defineRoutes('payables', manifest, async (app) => {
  app.get('/payables/invoices', { schema: listContract }, async (request) => listInvoices(request, request.query))
  app.get('/payables/invoices/counts', { schema: countsContract }, async (request) => invoiceCounts(request, request.query))
  app.get('/payables/invoices/:invoiceId', { schema: getContract }, async (request) => getInvoice(request, request.params.invoiceId))
  app.get('/payables/invoices/:invoiceId/xml', { schema: xmlContract }, async (request) => invoiceXml(request, request.params.invoiceId))
  app.get('/payables/invoices/:invoiceId/candidates', { schema: candidatesContract }, async (request) => mappingCandidates(request, request.params.invoiceId, request.query))

  app.post('/payables/invoices', { schema: createContract }, async (request, reply) => reply.code(201).send(await createInvoice(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/payables/invoices/:invoiceId', { schema: patchContract }, async (request) => patchInvoice(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/lines', { schema: addLineContract }, async (request, reply) => reply.code(201).send(await addLine(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request))))
  app.patch('/payables/invoices/:invoiceId/lines/:lineId', { schema: patchLineContract }, async (request) => patchLine(request, request.params.invoiceId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.delete('/payables/invoices/:invoiceId/lines/:lineId', { schema: removeLineContract }, async (request) => removeLine(request, request.params.invoiceId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/without-order', { schema: versionContract }, async (request) => markWithoutOrder(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/match', { schema: versionContract }, async (request) => matchAgain(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/matches/:matchId/accept', { schema: acceptContract }, async (request) => acceptDifference(request, request.params.invoiceId, request.params.matchId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/send-to-buyer', { schema: sendToBuyerContract }, async (request) => sendToBuyer(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/dispute', { schema: reasonContract }, async (request) => disputeInvoice(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/reopen', { schema: reopenContract }, async (request) => reopenInvoice(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/void', { schema: reasonContract }, async (request) => voidInvoice(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/settle-claim', { schema: settleClaimContract }, async (request) => settleClaim(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))

  app.post('/payables/invoices/:invoiceId/approve', { schema: approveContract }, async (request) => approveInvoice(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/approve', { schema: bulkApproveContract }, async (request) => approveMany(request, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/withdraw-approval', { schema: reasonContract }, async (request) => withdrawApproval(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/invoices/:invoiceId/pay', { schema: payContract }, async (request) => payInvoice(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))

  app.get('/payables/sdi', { schema: sdiStatusContract }, async (request) => sdiStatus(request, request.query))
  app.post('/payables/sdi/pickup', { schema: pickupContract }, async (request) => pickUpNow(request, request.body))

  // B-W2b-21: the payables settings (Z8:03) and the SDI inbox (Z8:06). Literal paths, before nothing that could shadow them.
  app.get('/payables/settings', { schema: getSettingsContract }, async (request) => getPayablesSettings(request, request.query))
  app.put('/payables/settings', { schema: putSettingsContract }, async (request) => putPayablesSettings(request, request.body, idempotencyKeyFrom(request)))
  app.get('/payables/sdi/inbox', { schema: listInboxContract }, async (request) => listInbox(request, request.query))
  app.post('/payables/sdi/inbox/:itemId/dismiss', { schema: dismissInboxContract }, async (request) => dismissInboxItem(request, request.params.itemId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/sdi/inbox/:itemId/reopen', { schema: reopenInboxContract }, async (request) => reopenInboxItem(request, request.params.itemId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-403 (SCM-132, FIN-138, FIN-140, FIN-142, FIN-167; PQ1:01-03). The literal /payables/proposals/candidates before /:proposalId.
  app.get('/payables/invoices/:invoiceId/area-check', { schema: areaCheckContract }, async (request) => invoiceAreaCheck(request, request.params.invoiceId))
  app.post('/payables/invoices/:invoiceId/area-check/:lineId/claim', { schema: areaClaimContract }, async (request, reply) => reply.code(201).send(await openAreaClaim(request, request.params.invoiceId, request.params.lineId, request.body, idempotencyKeyFrom(request))))
  app.get('/payables/invoices/:invoiceId/subcontract-match', { schema: subcontractMatchContract }, async (request) => invoiceSubcontractMatch(request, request.params.invoiceId))
  app.post('/payables/invoices/:invoiceId/subcontract-match/:lineId/fee', { schema: bookFeeContract }, async (request, reply) => reply.code(201).send(await bookInvoiceFee(request, request.params.invoiceId, request.params.lineId, request.body, idempotencyKeyFrom(request))))
  app.get('/payables/invoices/:invoiceId/dual-approval', { schema: invoiceDualContract }, async (request) => invoiceDualApproval(request, request.params.invoiceId))
  app.get('/payables/proposals', { schema: listProposalsContract }, async (request) => listProposals(request, request.query))
  app.get('/payables/proposals/candidates', { schema: proposalCandidatesContract }, async (request) => proposalCandidates(request, request.query))
  app.post('/payables/proposals', { schema: createProposalContract }, async (request, reply) => reply.code(201).send(await createProposal(request, request.body, idempotencyKeyFrom(request))))
  app.get('/payables/proposals/:proposalId', { schema: getProposalContract }, async (request) => getProposal(request, request.params.proposalId))
  app.put('/payables/proposals/:proposalId/lines', { schema: putLinesContract }, async (request) => putProposalLines(request, request.params.proposalId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/proposals/:proposalId/approve', { schema: approveProposalContract }, async (request) => approveProposal(request, request.params.proposalId, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)))
  app.post('/payables/proposals/:proposalId/send-back', { schema: reasonProposalContract }, async (request) => sendBackProposal(request, request.params.proposalId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/proposals/:proposalId/cancel', { schema: reasonProposalContract }, async (request) => cancelProposal(request, request.params.proposalId, request.body, idempotencyKeyFrom(request)))
  app.post('/payables/proposals/:proposalId/paid', { schema: paidProposalContract }, async (request) => recordProposalPaid(request, request.params.proposalId, request.body, idempotencyKeyFrom(request)))
  app.get('/payables/remittance/settings', { schema: getRemittanceContract }, async (request) => getRemittanceSettings(request, request.query))
  app.put('/payables/remittance/settings', { schema: putRemittanceContract }, async (request) => putRemittanceSettings(request, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)))
  app.get('/payables/money-controls', { schema: moneyControlsContract }, async (request) => moneyControls(request, request.query))
})
