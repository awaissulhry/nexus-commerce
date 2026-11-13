import { defineManifest } from '../../../core/manifest'

/**
 * Size curves (B-W2b-302; SAL-269; Sales settings › Size curves): office only, each curve checked with can() over its company
 * inside (`record`; a curve of every company needs a grant over every company to keep). No new permission: read with the quotes
 * (quotes.view), kept with the quote templates (quotes.templates.manage: the saved starts of quotes).
 */
const read = { audiences: ['office'], permission: 'quotes.view', scope: 'record' } as const
const keep = { audiences: ['office'], permission: 'quotes.templates.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/size-curves': read,
  'GET /sales/size-curves/:curveId': read,
  'POST /sales/size-curves': keep,
  'PATCH /sales/size-curves/:curveId': keep,
  'POST /sales/size-curves/status': keep,
})
