import { defineManifest } from '../../../core/manifest'

/**
 * Sample decisions (B-W2b-252; SAL-312, SAL-314, PRD-070, PRD-158; design products.samples › Fit & comments, Approval).
 * Office only: each route checks the round (or the swatch's round or style) with can() over its company and brand
 * (`record`). Asking the brand is the approvals engine's POST /approvals-out (platform/approvals-out; record types
 * SampleRound and SampleSwatch registered by ./approvals.ts).
 */
const view = { audiences: ['office'], permission: 'sales.samples.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.samples.manage', scope: 'record' } as const
const decide = { audiences: ['office'], permission: 'sales.samples.decide', scope: 'record' } as const
const measure = { audiences: ['office'], permission: 'sales.samples.measure', scope: 'record' } as const
// The notified body's result of a CE test sample: whoever keeps certificates (and sees the round).
const certify = { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/samples/rounds/:roundId/approval': view,
  'POST /sales/samples/rounds/:roundId/decision': decide,
  'POST /sales/samples/rounds/:roundId/next-round': manage,
  'POST /sales/samples/rounds/:roundId/test-result': certify,
  'GET /sales/samples/rounds/:roundId/fit': view,
  'PUT /sales/samples/rounds/:roundId/fit': measure,
  'POST /sales/samples/rounds/:roundId/comments': measure,
  'PATCH /sales/samples/comments/:commentId': measure,
  'DELETE /sales/samples/comments/:commentId': measure,
  'GET /sales/samples/swatches': view,
  'POST /sales/samples/swatches': manage,
  'PATCH /sales/samples/swatches/:swatchId': manage,
  'DELETE /sales/samples/swatches/:swatchId': manage,
  'POST /sales/samples/swatches/:swatchId/decision': decide,
})
