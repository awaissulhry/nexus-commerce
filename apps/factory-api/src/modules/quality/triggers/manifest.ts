import { defineManifest } from '../../../core/manifest'

/**
 * Inspection triggers (B-W2b-101; QHS-010, QHS-011; design quality.plans "When inspections are created"). A rule is a
 * company's: handlers check each with can() over its company (`record`). Reading and the preview need
 * quality.triggers.view; writing quality.triggers.manage. Which plan the rules pick for a subject is for the person who
 * opens an inspection (quality.inspections.view over the subject's company and site). The worker applies the rules (no
 * route): background.ts W2B_101_HANDLERS.
 */
export const manifest = defineManifest({
  'GET /quality/inspection-triggers': { audiences: ['office'], permission: 'quality.triggers.view', scope: 'record' },
  'POST /quality/inspection-triggers': { audiences: ['office'], permission: 'quality.triggers.manage', scope: 'record' },
  'POST /quality/inspection-triggers/order': { audiences: ['office'], permission: 'quality.triggers.manage', scope: 'record' },
  'POST /quality/inspection-triggers/preview': { audiences: ['office'], permission: 'quality.triggers.view', scope: 'record' },
  'GET /quality/inspection-triggers/pick': { audiences: ['office'], permission: 'quality.inspections.view', scope: 'record' },
  'GET /quality/inspection-triggers/:triggerId': { audiences: ['office'], permission: 'quality.triggers.view', scope: 'record' },
  'PATCH /quality/inspection-triggers/:triggerId': { audiences: ['office'], permission: 'quality.triggers.manage', scope: 'record' },
  'DELETE /quality/inspection-triggers/:triggerId': { audiences: ['office'], permission: 'quality.triggers.manage', scope: 'record' },
})
