import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { waitingAdjustments } from '../stock/adjust-approval'
import { checkPostingDate } from './check'
import { postingCheckContract, rulesContract, saveAdjustmentApprovalContract, saveLowStockAlertsContract, savePostingDatesContract, waitingAdjustmentsContract } from './contract'
import { manifest } from './manifest'
import { getRules, saveAdjustmentApproval, saveLowStockAlerts, savePostingDates } from './rules'

/**
 * Warehouse rules (B-W2b-314): the read and the three cards of this step (./rules.ts; loosening a rule asks a fresh code
 * here), a posting date checked before a move is sent (./check.ts), and the adjustments that wait for a yes
 * (../stock/adjust-approval.ts). The posting date itself is postMoves' (ledger/post-moves.ts, through ./store.ts).
 */
export default defineRoutes('inventory.posting', manifest, async (app) => {
  app.get('/inventory/rules', { schema: rulesContract }, async (request) => getRules(request, request.query))

  app.put('/inventory/rules/posting-dates', { schema: savePostingDatesContract }, async (request) =>
    savePostingDates(request, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.put('/inventory/rules/adjustment-approval', { schema: saveAdjustmentApprovalContract }, async (request) =>
    saveAdjustmentApproval(request, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.put('/inventory/rules/low-stock-alerts', { schema: saveLowStockAlertsContract }, async (request) => saveLowStockAlerts(request, request.body, idempotencyKeyFrom(request)))

  app.get('/inventory/posting/check', { schema: postingCheckContract }, async (request) => checkPostingDate(request, request.query))

  app.get('/inventory/adjustments/waiting', { schema: waitingAdjustmentsContract }, async (request) => waitingAdjustments(request, request.query))
})
