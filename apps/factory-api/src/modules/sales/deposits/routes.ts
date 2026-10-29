import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { getBankDetails, saveBankDetails } from './bank'
import { getBankDetailsContract, saveBankDetailsContract } from './contract'
import { manifest } from './manifest'

/**
 * Deposits (B-W1-24): the company's bank account its customers pay deposits to (a step-up to change it). The deposit
 * requests themselves are made by the system after an acceptance (quotes/after-acceptance.ts) and paid through
 * payments (deposit received).
 */
export default defineRoutes('sales.deposits', manifest, async (app) => {
  app.get('/companies/:companyId/bank-details', { schema: getBankDetailsContract }, async (request) => getBankDetails(request, request.params.companyId))

  app.put('/companies/:companyId/bank-details', { schema: saveBankDetailsContract }, async (request) =>
    saveBankDetails(request, request.params.companyId, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request)),
  )
})
