import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Order changes (B-W2b-309; SAL-190, SAL-218, SAL-219, SAL-221, SAL-248). Office only; each handler checks the order (or the
 * company) with can() (`record`). The freeze rules are kept with sales.settings.manage and read with orders.view or it; the
 * new yes after an edit is the approval engine's (kind SALES_ORDER_CHANGE, Home › Approvals); the customer's acceptance of a
 * priced change is B-W2b-184's REVISED_ORDER request on the amendment (POST /partners/approvals).
 */
const view = { audiences: ['office'], permission: 'orders.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'orders.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/order-freeze-rules': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /sales/order-freeze-rules': { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' },
  'PATCH /sales/order-freeze-rules/:ruleId': { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' },
  'GET /sales/orders/:orderId/freeze': view,
  'POST /sales/orders/:orderId/priced-changes/preview': manage,
  'POST /sales/orders/:orderId/priced-changes': manage,
  'GET /sales/orders/:orderId/changes': view,
  'POST /sales/orders/:orderId/changes/:amendmentId/put-back': manage,
  'GET /sales/deposit-kinds': view,
})
