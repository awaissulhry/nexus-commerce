import { defineManifest } from '../../../core/manifest'

/**
 * Technical files (B-W2b-251; PRD-296, PRD-299, PRD-301, PRD-302, QHS-048, QHS-110; design compliance.techfiles). Office only.
 * Reading needs the certificate register's view permission; keeping a file, its evidence, its risk assessment drafts, the
 * production-control tests and building packs needs compliance.techfiles.manage; signing a risk assessment
 * compliance.techfiles.sign (step-up); sending a pack by link compliance.techfiles.share (step-up). Handlers check each record
 * with can() against its company (`record`).
 */
const view = { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'compliance.techfiles.manage', scope: 'record' } as const
const sign = { audiences: ['office'], permission: 'compliance.techfiles.sign', scope: 'record' } as const
const share = { audiences: ['office'], permission: 'compliance.techfiles.share', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /compliance/techfiles': view,
  'POST /compliance/techfiles': manage,
  'GET /compliance/techfiles/:fileId': view,
  'PATCH /compliance/techfiles/:fileId': manage,
  'POST /compliance/techfiles/:fileId/complete': manage,
  'POST /compliance/techfiles/:fileId/reopen': manage,
  'POST /compliance/techfiles/:fileId/archive': manage,
  'GET /compliance/techfiles/:fileId/evidence-options': view,
  'POST /compliance/techfiles/:fileId/items': manage,
  'PATCH /compliance/techfiles/:fileId/items/:itemId': manage,
  'DELETE /compliance/techfiles/:fileId/items/:itemId': manage,
  'GET /compliance/techfiles/:fileId/risk': view,
  'POST /compliance/techfiles/:fileId/risk': manage,
  'PATCH /compliance/techfiles/:fileId/risk/:assessmentId': manage,
  'DELETE /compliance/techfiles/:fileId/risk/:assessmentId': manage,
  'POST /compliance/techfiles/:fileId/risk/:assessmentId/rows': manage,
  'PATCH /compliance/techfiles/:fileId/risk/:assessmentId/rows/:rowId': manage,
  'DELETE /compliance/techfiles/:fileId/risk/:assessmentId/rows/:rowId': manage,
  'POST /compliance/techfiles/:fileId/risk/:assessmentId/sign': sign,
  'GET /compliance/techfiles/:fileId/test-reports': view,
  'GET /compliance/techfiles/:fileId/production': view,
  'GET /compliance/techfiles/:fileId/packs': view,
  'POST /compliance/techfiles/:fileId/packs': manage,
  'GET /compliance/production-tests': view,
  'POST /compliance/production-tests': manage,
  'PATCH /compliance/production-tests/:testId': manage,
  'POST /compliance/production-tests/:testId/record': manage,
  'DELETE /compliance/production-tests/:testId': manage,
  'GET /compliance/evidence-packs/:packId': view,
  'GET /compliance/evidence-packs/:packId/download': view,
  'DELETE /compliance/evidence-packs/:packId': manage,
  'POST /compliance/evidence-packs/:packId/link': share,
  'POST /compliance/evidence-packs/:packId/links/:linkId/withdraw': share,
})
