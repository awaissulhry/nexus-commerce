import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { askAgainContract, checkAgainContract, listLimitsContract, recordCreditContract, setLimitContract } from './contract'
import { listLimits, setLimit } from './limits'
import { manifest } from './manifest'
import { askAgain, checkAgain } from './override'
import { recordCredit } from './records'

/**
 * Credit limits (B-W2b-304): ./limits.ts (Finance › Receivables › Credit limits: the list and "Change limit"),
 * ./records.ts (a record's credit: the quote's reading, an order's, a work order's or a shipment's checks and hold),
 * ./override.ts (check a held record again; ask for a yes on a hold; the yes itself is the approval engine's, the kind
 * platform/approvals/kinds/credit-override.ts), ./check.ts (the check the steps' commands write), ./handlers.ts (a payment
 * checks the held orders again).
 */
export default defineRoutes('sales.credit', manifest, async (app) => {
  app.get('/sales/credit/limits', { schema: listLimitsContract }, async (request) => listLimits(request, request.query))
  app.put('/sales/credit/limits/:partyId/:companyId', { schema: setLimitContract }, async (request) => setLimit(request, request.params.partyId, request.params.companyId, request.body, idempotencyKeyFrom(request)))
  app.get('/sales/credit/records/:recordType/:recordId', { schema: recordCreditContract }, async (request) => recordCredit(request, request.params.recordType, request.params.recordId))
  app.post('/sales/credit/records/:recordType/:recordId/check', { schema: checkAgainContract }, async (request) => checkAgain(request, request.params.recordType, request.params.recordId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/credit/checks/:checkId/ask', { schema: askAgainContract }, async (request, reply) => reply.code(201).send(await askAgain(request, request.params.checkId, request.body, idempotencyKeyFrom(request))))
})
