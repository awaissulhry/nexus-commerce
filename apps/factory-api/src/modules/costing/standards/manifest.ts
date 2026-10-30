import { defineManifest } from '../../../core/manifest'

/**
 * Standard costs (B-W2a-21; FIN-024; design finance.costing "Standard cost per item"). Office only: the floor, partner and
 * link sessions never see a cost (A1 §2.6). Each handler checks the standard's company with can() and filters the list
 * with scopeWhere() (`record`). Writes need costing.standards.manage over the company; a figure sent, the cost grain.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'costing.standards.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/standards': view,
  'GET /costing/standards/:standardId': view,
  'POST /costing/standards': manage,
  'POST /costing/standards/prepare': manage,
  'PATCH /costing/standards/:standardId': manage,
  'POST /costing/standards/:standardId/discard': manage,
  'POST /costing/standards/:standardId/freeze': manage,
})
