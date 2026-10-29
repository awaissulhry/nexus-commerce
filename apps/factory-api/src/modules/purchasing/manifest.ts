import { defineManifest, PUBLIC } from '../../core/manifest'

/**
 * Purchase orders (B-W1-30; SCM-050, SCM-053, SCM-054, SCM-055, SCM-075; A2 SCR-058, SCR-059, SCR-037, SCR-055 "Draft PO"):
 * office only (a floor, portal or link session is refused by audience; the supplier's confirm link is B-W1-31's, receiving
 * B-W1-32's). An order belongs to a company, a delivery site and a supplier, so the handlers check each order with can()
 * and filter the list with scopeWhere() (`record`). Sending (PDF, confirm link, mail) is its own permission; cancelling an
 * order the supplier already holds also needs it (checked in the handler).
 *
 * The supplier's confirm link (B-W1-31): the `link` audience of a PO_CONFIRM link, its action's permission, scope `record`
 * (the link's one order; command() refuses any other record). "Ask for a new link" is public: a dead link has no session,
 * and the answer is the same whatever the token (rate limited per address like the link routes).
 */
export const manifest = defineManifest({
  'GET /purchasing/orders': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'PATCH /purchasing/orders/:purchaseOrderId': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/lines': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'PATCH /purchasing/orders/:purchaseOrderId/lines/:lineId': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'DELETE /purchasing/orders/:purchaseOrderId/lines/:lineId': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/from-plan': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/from-plan/undo': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/send-check': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/send': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/send-link': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/cancel': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/documents': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/supplier-view': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  // B-W1-31: the supplier's answer on the order, and its confirm link.
  'GET /purchasing/orders/:purchaseOrderId/answer': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /link/purchase-order': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/purchase-order/confirm': { audiences: ['link'], permission: 'links.confirm', scope: 'record' },
  'POST /link/purchase-order/decline': { audiences: ['link'], permission: 'links.decline', scope: 'record' },
  'POST /link/purchase-order/renew': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
