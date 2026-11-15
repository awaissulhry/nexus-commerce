import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processSecrets } from '../../../platform/secrets/service'
import { addContractContract, changeContractContract, getCustomerAccountContract, listContractsContract, setCustomerAccountContract, switchOffContractContract } from './contract'
import { addContract, changeContract, listContracts, switchOffContract } from './contracts'
import { getCustomerAccount, setCustomerAccount } from './customer'
import { manifest } from './manifest'

/**
 * Carrier accounts (B-W2b-400; LOG-033 our own contracts per company and site, sealed, "use only our rates"; LOG-038 the
 * customer's own carrier account, who the carrier bills and its default service). A number is typed once and sealed; a new
 * contract number asks a fresh step-up (as the connection's credentials).
 */
export default defineRoutes('shipping.carrier-accounts', manifest, async (app) => {
  const stepUpFor = (request: Parameters<typeof requireStepUp>[1]) => () => requireStepUp(officeAuthOf(app), request)

  app.get('/shipping/carrier-contracts', { schema: listContractsContract }, async (request) => listContracts(request, request.query))

  app.post('/shipping/carrier-contracts', { schema: addContractContract }, async (request, reply) =>
    reply.code(201).send(await addContract(processSecrets(), request, request.body, stepUpFor(request), idempotencyKeyFrom(request))),
  )

  app.patch('/shipping/carrier-contracts/:contractId', { schema: changeContractContract }, async (request) =>
    changeContract(processSecrets(), request, request.params.contractId, request.body, stepUpFor(request), idempotencyKeyFrom(request)),
  )

  app.post('/shipping/carrier-contracts/:contractId/switch-off', { schema: switchOffContractContract }, async (request) =>
    switchOffContract(request, request.params.contractId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/shipping/customer-carrier-accounts/:partyId', { schema: getCustomerAccountContract }, async (request) => getCustomerAccount(request, request.params.partyId))

  app.put('/shipping/customer-carrier-accounts/:partyId', { schema: setCustomerAccountContract }, async (request) =>
    setCustomerAccount(processSecrets(), request, request.params.partyId, request.body, idempotencyKeyFrom(request)),
  )
})
