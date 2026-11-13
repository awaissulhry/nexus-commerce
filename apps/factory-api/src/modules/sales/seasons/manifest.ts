import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Seasons per company (B-W2b-303; SAL-277). Office only. Reading the list needs no one permission (`record`): the handler
 * keeps the companies where the reader holds orders.view, quotes.view, product.styles.view or sales.settings.manage (the
 * style's Set season picks from it, SO1:01). Keeping them is sales.settings.manage over the season's company; naming one on
 * a quote is quotes.manage, on an order orders.manage.
 */
const read = { audiences: ['office'], permission: SIGNED_IN, scope: 'record' } as const
const keep = { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/seasons': read,
  'GET /sales/seasons/:seasonId': read,
  'POST /sales/seasons': keep,
  'PATCH /sales/seasons/:seasonId': keep,
  'POST /sales/seasons/:seasonId/close': keep,
  'POST /sales/seasons/:seasonId/reopen': keep,
  'PUT /sales/quotes/:quoteId/season': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'PUT /sales/orders/:orderId/season': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
})
