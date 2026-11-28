import { defineManifest } from '../../../core/manifest'

/**
 * Portal ordering (B-W2b-190; SAL-071, SAL-072, SAL-073, SAL-074, SAL-079). The customer's routes: partner sessions only,
 * inside their party (row-level security; the handlers keep to the portal's company). The office's: like the sales
 * orders, each request checked with can() over its company and customer (`record`).
 */
export const manifest = defineManifest({
  // The catalogue (SAL-071).
  'GET /portal/catalogue': { audiences: ['partner'], permission: 'portal.catalogue.view', scope: 'party' },
  'GET /portal/catalogue/:styleId': { audiences: ['partner'], permission: 'portal.catalogue.view', scope: 'party' },
  // Order requests (SAL-074) and their lines. B-CP-070 (D11): a draft is kept with portal.orderDrafts.edit (the Buyer and the
  // Designer; the Admin follows): read, start, fill, discard (the handler: one who may order, or the one who started it). Send and
  // Withdraw stay portal.orderRequests.manage (the Buyer, the Admin). No price for a role without the price grain (the filter).
  'GET /portal/order-requests': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // owb- po2.1 (order workflow): many drafts at once — the rights of the single commands (delete: a draft's; send: who may order).
  'POST /portal/order-requests/bulk-delete': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/bulk-send': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'GET /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PATCH /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'DELETE /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/lines': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/order-requests/:requestId/lines/:lineId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'DELETE /portal/order-requests/:requestId/lines/:lineId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // owb- po1.3 (order workflow, the ONE lines table): a line copied, a line taken out put back — a draft's, as every line write.
  'POST /portal/order-requests/:requestId/lines/:lineId/copy': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/lines/:lineId/put-back': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/prices': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // B-CP-072: the draft's files (logos, references, measurement sheets); the handler also asks portal.upload.
  'POST /portal/order-requests/:requestId/files': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/files/:fileId/complete': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'DELETE /portal/order-requests/:requestId/files/:fileId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // od-ts t.6: a file moved between the draft's logos and references (the handler also asks portal.upload, as the upload).
  'PATCH /portal/order-requests/:requestId/files/:fileId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // B-CP-075: described and made-to-measure lines, and the people of a by-person line (a draft's: portal.orderDrafts.edit).
  'POST /portal/order-requests/:requestId/custom-lines': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/order-requests/:requestId/custom-lines/:lineId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/lines/:lineId/people': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/order-requests/:requestId/lines/:lineId/people/:personId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'DELETE /portal/order-requests/:requestId/lines/:lineId/people/:personId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/send': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/withdraw': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  // owb- po1.2 (order workflow, "Take it back"): as Send and Withdraw, portal.orderRequests.manage (the Buyer, the Admin).
  'POST /portal/order-requests/:requestId/take-back': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  // Reorder (SAL-072): a past order is the orders' business — kept with portal.orderRequests.manage (a Designer reads no order).
  'GET /portal/reorder/orders': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'GET /portal/reorder/orders/:orderId': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/reorder': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  // Upload (SAL-073): filling a draft from a sheet (B-CP-070: portal.orderDrafts.edit).
  'GET /portal/order-template': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/upload': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // Delivery addresses (SAL-079).
  'GET /portal/addresses': { audiences: ['partner'], permission: 'portal.addresses.view', scope: 'party' },
  'POST /portal/addresses': { audiences: ['partner'], permission: 'portal.addresses.manage', scope: 'party' },
  'POST /portal/addresses/:addressId/archive': { audiences: ['partner'], permission: 'portal.addresses.manage', scope: 'party' },
  'POST /portal/addresses/:addressId/default': { audiences: ['partner'], permission: 'portal.addresses.manage', scope: 'party' },
  // The office decides (home.approvals; the sales orders' permissions).
  'GET /sales/order-requests': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /sales/order-requests/:requestId': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/order-requests/:requestId/accept': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/refuse': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // od-s s.3 (order start, Owner yes 1a): the office fills a customer's draft through the SAME commands — orders.manage (orders.view
  // to read) over the draft's company and customer, checked by the handler (the office writer); files also ask files.upload; Make
  // style draft asks product.styles.manage over the company (the style library's check). No Incoming route (Owner yes 3a).
  'POST /sales/order-requests': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/order-requests/:requestId/draft': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'PATCH /sales/order-requests/:requestId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'DELETE /sales/order-requests/:requestId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/custom-lines': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'PUT /sales/order-requests/:requestId/custom-lines/:lineId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'PUT /sales/order-requests/:requestId/lines/:lineId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'DELETE /sales/order-requests/:requestId/lines/:lineId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // owb- po1.3: the office's twins (orders.manage over the draft's company and customer: the office writer).
  'POST /sales/order-requests/:requestId/lines/:lineId/copy': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/lines/:lineId/put-back': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/lines/:lineId/people': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'PUT /sales/order-requests/:requestId/lines/:lineId/people/:personId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'DELETE /sales/order-requests/:requestId/lines/:lineId/people/:personId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/files': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/files/:fileId/complete': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'DELETE /sales/order-requests/:requestId/files/:fileId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // od-ts t.6: the office's twin (orders.manage + files.upload over the draft's company and customer: the handler).
  'PATCH /sales/order-requests/:requestId/files/:fileId': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/style-draft': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // od-s s.4 (Owner yes 2a): Confirm = send (if still a draft) + the accept, in ONE command (quotes.manage too for a quote: the handler).
  'POST /sales/order-requests/:requestId/confirm': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // B-CQ-030 (customer page › Quotes & incoming): the small pictures of a page of portal orders, drafts too (each one's orders.view).
  'POST /sales/order-requests/pictures': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-W2b-F13b: the delivery addresses customers add wait for the office's check (whoever takes the customer's orders).
  'GET /sales/delivery-addresses': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/delivery-addresses/:addressId/approve': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/delivery-addresses/:addressId/refuse': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // B-W2b-374 (XF3:04): an option's artwork in the portal (the office shows it; the customer opens it, logged).
  'PUT /sales/orders/:orderId/lines/:lineId/artwork/:fileId/portal': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /portal/sales-orders/:orderId/options': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'POST /portal/sales-orders/:orderId/artwork/:fileId/open': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
})
