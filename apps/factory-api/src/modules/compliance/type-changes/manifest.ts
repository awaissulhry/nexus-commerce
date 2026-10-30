import { defineManifest } from '../../../core/manifest'

/**
 * The changes to an approved type (B-W2a-66; PRD-285; Reg. (EU) 2016/425 Annex V 7.2). Office only; a review belongs to
 * its certificate's company and holder, so the handlers check each one with can() and filter the list with scopeWhere()
 * (`record`). The answer's file only through its own two routes (platform/files/owned.ts).
 */
const view = { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'compliance.certificates.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /compliance/type-changes': view,
  'GET /compliance/type-changes/styles/:styleId': view,
  'GET /compliance/type-changes/:reviewId': view,
  'POST /compliance/type-changes/:reviewId/notify': manage,
  'POST /compliance/type-changes/:reviewId/not-needed': manage,
  'POST /compliance/type-changes/:reviewId/answer': manage,
  'POST /compliance/type-changes/:reviewId/answer-file': manage,
  'POST /compliance/type-changes/:reviewId/answer-file/:fileId/complete': manage,
})
