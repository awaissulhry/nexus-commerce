import { defineManifest } from '../../../core/manifest'

/**
 * B-OF-031 (order files tab; 13-backend §2): an ask for a file on a sales order, office only. Every route is checked per record: the
 * order with can() over its company AND customer (a person limited to other customers gets the same not-found as an unknown id: the
 * brand wall), then the ask by (order, id); the handler asks tasks.manage (+ threads.post to make one and to chase) over the order,
 * the price grain for a priced ask, the measurements right for body data. Sending the files for an ask is files.upload over the
 * record it lands on. Swept by the brand-wall sweep (B-OF block), never EXEMPT.
 */
const manage = { audiences: ['office'], permission: 'tasks.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'POST /sales/orders/:orderId/file-asks': manage,
  'PATCH /sales/orders/:orderId/file-asks/:askId': manage,
  'POST /sales/orders/:orderId/file-asks/:askId/reassign': manage,
  'POST /sales/orders/:orderId/file-asks/:askId/cancel': manage,
})
