import { defineManifest } from '../../../core/manifest'

/**
 * Order margin from estimate to actual (B-W2a-29; FIN-047; design finance.margins SCR-155, sales.orders Margin tab).
 * Office only (A1 §2.6). Read with costing.view, the costing reads' permission (finance and sales hold it; the figures
 * follow the grains): an order belongs to a company and a customer, so the list is filtered with scopeWhere() over both
 * and the record checked with can() (`record`). The value is money.price, costs money.cost, margins money.margin; a margin
 * amount only with the cost grain too.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/margins': view,
  'GET /costing/margins/orders/:orderId': view,
})
