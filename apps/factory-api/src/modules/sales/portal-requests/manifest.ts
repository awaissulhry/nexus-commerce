import { defineManifest } from '../../../core/manifest'

/**
 * The customer's requests in the portal (threads plan TH-1b: B-TH-010 send, B-TH-103 reads, B-TH-011 states, B-TH-105 its own
 * numbers, B-TH-012 whether the door is open). Partner sessions only, inside their party (row-level security: factory-db's
 * B-TH-009 grant on Inquiry and InquiryLine); the request's company is the portal's (the handler: else 404). Sending is the
 * catalogue order's capability (portal.orderRequests.manage: "New order"); reading is the orders' (portal.salesOrders.view:
 * requests and orders are one list for the customer, P-CUS-ORD-LIST).
 */
const send = { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' } as const
const read = { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' } as const

export const manifest = defineManifest({
  'POST /portal/inquiries': send,
  'GET /portal/inquiries/open': send,
  'GET /portal/inquiries': read,
  'GET /portal/inquiries/:inquiryId': read,
  // ---- B-TH-085: files after Send — who sends requests; the handler also asks the upload capability (portal.upload).
  'POST /portal/inquiries/:inquiryId/files': send,
  'POST /portal/inquiries/:inquiryId/files/:fileId/complete': send,
  'POST /portal/inquiries/:inquiryId/files/attach': send,
})
