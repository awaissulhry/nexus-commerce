import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Inspection plans (B-W2b-92; QHS-008 templates, QHS-009 check types, QHS-016 versions frozen on each record; design
 * quality.plans SCR-077). A plan is a company's: handlers check each with can() over its company (`record`). Reading
 * needs quality.plans.view; writing quality.plans.manage; approving another person's draft quality.plans.approve with the
 * office's step-up (an e-signature). The version a record runs on is read by any office or floor session (the bench shows
 * its checklist): codes and words, nothing personal or secret, as the defect vocabulary.
 */
export const manifest = defineManifest({
  'GET /quality/plans': { audiences: ['office'], permission: 'quality.plans.view', scope: 'record' },
  'POST /quality/plans': { audiences: ['office'], permission: 'quality.plans.manage', scope: 'record' },
  'GET /quality/plans/starter': { audiences: ['office'], permission: 'quality.plans.view', scope: 'record' },
  'POST /quality/plans/starter': { audiences: ['office'], permission: 'quality.plans.manage', scope: 'record' },
  'GET /quality/plans/:planId': { audiences: ['office'], permission: 'quality.plans.view', scope: 'record' },
  'PATCH /quality/plans/:planId': { audiences: ['office'], permission: 'quality.plans.manage', scope: 'record' },
  'POST /quality/plans/:planId/versions': { audiences: ['office'], permission: 'quality.plans.manage', scope: 'record' },
  'GET /quality/plans/:planId/versions/:versionId': { audiences: ['office'], permission: 'quality.plans.view', scope: 'record' },
  'PUT /quality/plans/:planId/versions/:versionId': { audiences: ['office'], permission: 'quality.plans.manage', scope: 'record' },
  'POST /quality/plans/:planId/versions/:versionId/submit': { audiences: ['office'], permission: 'quality.plans.manage', scope: 'record' },
  'POST /quality/plans/:planId/versions/:versionId/approve': { audiences: ['office'], permission: 'quality.plans.approve', scope: 'record' },
  'POST /quality/plans/:planId/versions/:versionId/retire': { audiences: ['office'], permission: 'quality.plans.manage', scope: 'record' },
  'GET /quality/plans/:planId/versions/:versionId/checklist': { audiences: ['office'], permission: 'quality.plans.view', scope: 'record' },
  'GET /quality/plan-versions/:versionId': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
})
