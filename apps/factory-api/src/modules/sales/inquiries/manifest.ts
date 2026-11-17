import { defineManifest } from '../../../core/manifest'

/**
 * Inquiries and requests for quotation (B-W2b-295; SAL-032, SAL-033, SAL-305; design sales.inquiries SCR-105). Office only: each
 * route asks sales.inquiries.* and checks the inquiry with can() over its company and customer (`record`). Making one from a mail
 * also asks email.triage over the mail; making the quote also quotes.manage; the inquiry a quote or order came from also
 * quotes.view or orders.view over that record.
 */
const view = { audiences: ['office'], permission: 'sales.inquiries.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.inquiries.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/inquiries': view,
  'GET /sales/inquiries/source': view,
  'GET /sales/inquiries/assignees': manage,
  'GET /sales/inquiries/from-mail/:inboundEmailId': manage,
  'POST /sales/inquiries/from-mail/:inboundEmailId': manage,
  'POST /sales/inquiries/assign': manage,
  'POST /sales/inquiries/decline': manage,
  'GET /sales/inquiries/:inquiryId': view,
  'POST /sales/inquiries': manage,
  'PATCH /sales/inquiries/:inquiryId': manage,
  'POST /sales/inquiries/:inquiryId/assign': manage,
  'POST /sales/inquiries/:inquiryId/ask-info': manage,
  'POST /sales/inquiries/:inquiryId/resume': manage,
  'POST /sales/inquiries/:inquiryId/decline': manage,
  'POST /sales/inquiries/:inquiryId/lost': manage,
  'POST /sales/inquiries/:inquiryId/quote': manage,
  // B-TH-025: Make order — also orders.manage over the request's company and customer (checked in the handler).
  'POST /sales/inquiries/:inquiryId/order': manage,
  // B-TH-026: Make style draft — whoever makes styles (product.styles.manage over the company) and reads the request
  // (sales.inquiries.view, checked in the handler): the production manager too.
  'POST /sales/inquiries/:inquiryId/style-draft': { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' },
  // B-W2b-394 (ML1:02): the inquiry addresses — read with the inquiries, changed as sales settings (sales.settings.manage, a
  // company's own or, over every company, the tenant's).
  'GET /sales/inquiries/addresses': view,
  'PUT /sales/inquiries/addresses': { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' },
})
