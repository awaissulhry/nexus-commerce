import { defineManifest } from '../../../core/manifest'

/**
 * The order profitability report's documents (B-W2b-416; FIN-053; design finance.margins pop:order "Documents"). Office
 * only. Read with costing.view, the order margin's own permission, over the order's company and customer (`record`: the
 * record is checked with can()); each group of documents needs its own reading permission besides (invoices.view,
 * payments.view, shipping.view), said in the answer. Amounts by grain.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/margins/orders/:orderId/documents': view,
})
