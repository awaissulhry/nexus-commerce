import { defineManifest } from '../../../core/manifest'

/**
 * B-PR-18 (production plan §4 "What a brand sees", §5 Portal › Production › My production and Order › Status & progress): the
 * customer's own production in its portal. Partner sessions only, inside their party (row-level security); every order is read
 * in the partner scope first (another customer's order is as unknown as a wrong id: 404), then the office's facts of exactly
 * those orders. Reads only. `GET /portal/production?format=csv` is the list's own file ("Export"), written here in the partner's
 * scope: every own row of the chip and search, never the export job.
 *
 * B-PR-22a: the customer's urgency (portal.production.urgency over its party, never a preview; only while its urgency switch is
 * on): mark one or many of its orders Urgent or Regular, order its Urgent list (the drag, "Move to top"), undo one of its own
 * batches — ./urgency.ts.
 *
 * B-PR-19: the quality of its own goods at the QUALITY level (released and reversed pieces per own cell; results, holds by reason
 * code, the photos shared on its order; results only of a work order that is its alone) and the inspection report PDF of such a
 * work order's decided inspection — ./quality.ts.
 * B-PR-45: "Report a problem" (portal.production.view + portal.comment over its party, never a preview): one message in each
 * named order's thread and one issue each, one task for the batch — ./problems.ts.
 * B-PR-46a: the bulk asks (portal.salesOrders.ask over its party, never a preview): Ask N — one request per own order, all of one
 * batch and one kind (pause, resume, cancel; urgent only through Mark urgent, whose rows over the quota or from Cutting become
 * "Urgent – asked" of their own batch) — and Undo of a batch (its requests that still wait are withdrawn) — ./bulk.ts.
 */
export const manifest = defineManifest({
  'GET /portal/production': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
  'GET /portal/production/:orderId': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
  // B-PR-22a: the customer marks its own orders Urgent or Regular, orders its Urgent list, undoes one of its own batches.
  'POST /portal/production/urgency': { audiences: ['partner'], permission: 'portal.production.urgency', scope: 'party' },
  'PUT /portal/production/urgent-order': { audiences: ['partner'], permission: 'portal.production.urgency', scope: 'party' },
  'POST /portal/production/urgency/undo': { audiences: ['partner'], permission: 'portal.production.urgency', scope: 'party' },
  // B-PR-19: the quality of its own goods (level QUALITY; below it 404) and a single-customer work order's inspection report PDF.
  'GET /portal/production/:orderId/quality': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
  'GET /portal/production/:orderId/quality/report/:inspectionId': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
  // B-PR-45: "Report a problem" on one or many of its own orders (the handler also checks portal.comment: it writes in their threads).
  'POST /portal/production/problems': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
  // B-PR-46a: Ask N (one request per own order, one batch, one kind: pause, resume, cancel) and its Undo (the batch's open ones).
  'POST /portal/production/asks': { audiences: ['partner'], permission: 'portal.salesOrders.ask', scope: 'party' },
  'POST /portal/production/asks/:batchId/withdraw': { audiences: ['partner'], permission: 'portal.salesOrders.ask', scope: 'party' },
})
