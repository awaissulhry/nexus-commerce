import { defineManifest } from '../../../core/manifest'

/**
 * Landed cost over the received lots (B-W2b-407; FIN-044; finance owns it). Office only: the floor, partner and link
 * sessions never see a cost (A1 §2.6). Each handler checks the invoice's company and supplier with can() and filters the
 * list with scopeWhere() (`record`); every amount is money.cost. Preparing, changing, removing, posting and reversing are
 * costing.landed.manage; posting also waits for the company's figures for the accountant (GATE-ACCOUNTANT).
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'costing.landed.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/landed': view,
  'GET /costing/landed/:allocationId': view,
  'POST /costing/landed': manage,
  'PATCH /costing/landed/:allocationId': manage,
  'DELETE /costing/landed/:allocationId': manage,
  'POST /costing/landed/:allocationId/post': manage,
  'POST /costing/landed/:allocationId/reverse': manage,
})
