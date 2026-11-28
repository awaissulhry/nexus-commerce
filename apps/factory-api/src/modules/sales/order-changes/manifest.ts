import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Order changes (B-W2b-309; SAL-190, SAL-218, SAL-219, SAL-221, SAL-248). Office only; each handler checks the order (or the
 * company) with can() (`record`). The freeze rules are kept with sales.settings.manage and read with orders.view or it (B-PR-14:
 * a customer's own rules also with partners.production.manage, read with partners.view too, each over that customer); the
 * new yes after an edit is the approval engine's (kind SALES_ORDER_CHANGE, Home › Approvals); the customer's acceptance of a
 * priced change is B-W2b-184's REVISED_ORDER request on the amendment (POST /partners/approvals).
 */
const view = { audiences: ['office'], permission: 'orders.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'orders.manage', scope: 'record' } as const
// owb-of1a (plan.md § 5 D R20): the order's freeze and Changes reads take orders.view OR orders.view.own (the designer, on the
// order): signed-in here, refused in routes.ts without either (orders/access.ts assertOrdersReader), the order checked by
// orders/moves.ts officeOrder (orders/access.ts assertSees → orders/on-the-order.ts, the ONE rule).
const orderRead = { audiences: ['office'], permission: SIGNED_IN, scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/order-freeze-rules': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  // B-PR-14: a customer's own rule is also kept with partners.production.manage over it: the handler checks either.
  'POST /sales/order-freeze-rules': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'PATCH /sales/order-freeze-rules/:ruleId': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'GET /sales/orders/:orderId/freeze': orderRead, // owb-of1a
  'POST /sales/orders/:orderId/priced-changes/preview': manage,
  'POST /sales/orders/:orderId/priced-changes': manage,
  'GET /sales/orders/:orderId/changes': orderRead, // owb-of1a
  'POST /sales/orders/:orderId/changes/:amendmentId/put-back': manage,
  'GET /sales/deposit-kinds': view,
})
