import { defineManifest } from '../../../core/manifest'

/**
 * Price lists in depth (B-W2b-325; SAL-166, SAL-167, SAL-170, SAL-178, SAL-180, SAL-183): office only (no list price on
 * the floor, a link or the portal). A list, a style or a minimum belongs to a company or to every company, so each
 * handler checks it with can() (`record`). Reading is pricelists.view, changing pricelists.manage (a list or style of
 * every company: a grant over every company). A quote's list prices and line checks are quotes.view over the quote, an
 * order's line checks orders.view over the order. The import runs through the imports routes (`sales.priceLists`).
 */
const view = { audiences: ['office'], permission: 'pricelists.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'pricelists.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/price-lists/:listId/versions/:versionId/rules': view,
  'PUT /sales/price-lists/:listId/versions/:versionId/breaks': manage,
  'PUT /sales/price-lists/:listId/versions/:versionId/size-surcharges': manage,
  'PUT /sales/price-lists/:listId/versions/:versionId/dated-prices': manage,
  'GET /sales/price-lists/:listId/versions/:versionId/export': view,
  'PUT /sales/price-lists/:listId/discount-display': manage,
  'GET /sales/styles/:styleId/size-surcharges': view,
  'PUT /sales/styles/:styleId/size-surcharges': manage,
  'GET /sales/minimums': view,
  'GET /sales/minimums/:ruleId': view,
  'POST /sales/minimums': manage,
  'PATCH /sales/minimums/:ruleId': manage,
  'POST /sales/minimums/:ruleId/archive': manage,
  'POST /sales/minimums/:ruleId/reactivate': manage,
  'DELETE /sales/minimums/:ruleId': manage,
  'GET /sales/quotes/:quoteId/list-prices': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  'GET /sales/quotes/:quoteId/line-checks': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  'GET /sales/orders/:orderId/line-checks': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
})
