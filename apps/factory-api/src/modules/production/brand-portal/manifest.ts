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
 */
export const manifest = defineManifest({
  'GET /portal/production': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
  'GET /portal/production/:orderId': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
  // B-PR-22a: the customer marks its own orders Urgent or Regular, orders its Urgent list, undoes one of its own batches.
  'POST /portal/production/urgency': { audiences: ['partner'], permission: 'portal.production.urgency', scope: 'party' },
  'PUT /portal/production/urgent-order': { audiences: ['partner'], permission: 'portal.production.urgency', scope: 'party' },
  'POST /portal/production/urgency/undo': { audiences: ['partner'], permission: 'portal.production.urgency', scope: 'party' },
})
