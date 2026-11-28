import { defineManifest } from '../../../core/manifest'

/**
 * The style library's routes (A2 SCR-040 "Styles", SCR-041 "Style › Overview & variants", SCR-049 "Libraries", size
 * scales tab). Office only: the floor reads the styles it makes through its work orders (later steps), never this
 * library. A style or a scale belongs to one company or to every company of the tenant, so each handler checks it with
 * can() and filters the lists with scopeWhere() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' } as const
// owb-pd1 1.4 (S4 settle 6): product.styles.manage, OR product.drafts.edit while the style's newest revision is a draft — the route
// asks the read right (every holder of the manage right holds it) and the handler the write (modules/product/drafts/may-edit.ts).
const draft = view

export const manifest = defineManifest({
  // B-OL-033: `?forOrder=` — the search for an order (also orders.view over its customer, checked by the handler; else 404).
  'GET /product/styles': view,
  'GET /product/styles/:styleId': view,
  // owb-pd1 1.1: the product's open order lines ("Where it is used"); also orders.view, or orders.view.own and on the order
  // (checked by the handler: ./orders.ts).
  'GET /product/styles/:styleId/orders': view,
  'POST /product/styles': draft,
  'PATCH /product/styles/:styleId': draft,
  'POST /product/styles/:styleId/archive': manage,
  'POST /product/styles/:styleId/reactivate': manage,
  'PUT /product/styles/:styleId/garment-tracking': manage,
  'POST /product/styles/:styleId/colourways': manage,
  'PATCH /product/styles/:styleId/colourways/:colourwayId': manage,
  'POST /product/styles/:styleId/skus/generate': manage,
  'PATCH /product/styles/:styleId/skus/:skuId': manage,
  // W2a (PRD-011): what a copy can take, and the copy (the parts' own write permissions are checked by the handler).
  'GET /product/styles/:styleId/duplicate': view,
  'POST /product/styles/:styleId/duplicate': manage,
  'GET /product/styles/:styleId/revisions': view,
  'POST /product/styles/:styleId/revisions': draft,
  'GET /product/colours': view,
  'GET /product/size-scales': view,
  'GET /product/size-scales/:scaleId': view,
  'POST /product/size-scales': manage,
  'PATCH /product/size-scales/:scaleId': manage,
  'POST /product/size-scales/:scaleId/sizes': manage,
  'PUT /product/size-scales/:scaleId/order': manage,
  'PATCH /product/size-scales/:scaleId/sizes/:sizeId': manage,
  'POST /product/size-scales/:scaleId/archive': manage,
  'POST /product/size-scales/:scaleId/reactivate': manage,
})
