import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Inquiries and requests for quotation (B-W2b-295; SAL-032, SAL-033, SAL-305; design sales.inquiries SCR-105). Office only: each
 * route asks sales.inquiries.* and checks the inquiry with can() over its company and customer (`record`). Making one from a mail
 * also asks email.triage over the mail; making the quote also quotes.manage; the inquiry a quote or order came from also
 * quotes.view or orders.view over that record (B-TH-261: the request a style draft came from, product.styles.view over the style).
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
  // B-TH-216 (Sales › Incoming): the Picture cell's small preview (the file also needs files.read over its company).
  'GET /sales/inquiries/:inquiryId/picture': view,
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
  // B-TH-221 (wall W23): New request's customer picker — the customers this person may make a request for (also parties.view).
  'GET /sales/inquiries/customers': manage,
  // B-TH-042 (wall W23): answer a new customer — the check and the match whoever keeps the request (the customer within their
  // rights); making a customer also parties.manage over the request's company (checked in the handler).
  'GET /sales/inquiries/:inquiryId/customer': manage,
  'POST /sales/inquiries/:inquiryId/customer': manage,
  // ---- B-TH-094 (N17): production's answer — typed by whoever records promise dates (planning.promise.manage: the planner, the
  // production manager) over the request's company and customer, and who reads the request (sales.inquiries.view, checked in the
  // handler: else 404); planning's suggestion with planning.promise.view at the site. Office only (never a portal or link route).
  // fix-pg-2: both checks are the handler's (as the freeze rules' "either"), so each refusal is the right one: no sales.inquiries.view
  // over the request → 404 (the planner, a person limited to another customer); no planning.promise.manage over it → 403 in words
  // ("planning or the production manager types it", sales). The route's own permission would answer sales "You may not do this."
  'PUT /sales/inquiries/:inquiryId/production-answer': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'GET /sales/inquiries/:inquiryId/production-answer/suggestion': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  // ---- end B-TH-094
  // ---- B-TH-071 (PROJ-G20): Start a project — who reads the request (sales.inquiries.view, checked in the handler) and keeps
  // projects (projects.manage over its company and customer: createProject).
  'POST /sales/inquiries/:inquiryId/project': { audiences: ['office'], permission: 'projects.manage', scope: 'record' },
  // ---- end B-TH-071
})
