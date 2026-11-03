import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * The defect library and the disposition codes (B-W2a-26; QHS-001, QHS-005; design quality.defects SCR-079). Both are
 * the whole group's (scope `tenant`): reading needs quality.defects.view; every write quality.defects.manage, and the
 * handler asks it over every company. The pickers (the bench, the floor's tiles, the office's inspection) read the
 * active defects with any office or floor session: nothing personal or secret. B-W2b-90 adds the severity classes, the
 * cause codes, the leather grades with the hide defects, and the vocabulary in the person's language (below).
 */
export const manifest = defineManifest({
  'GET /quality/defects': { audiences: ['office'], permission: 'quality.defects.view', scope: 'tenant' },
  'GET /quality/defects/picker': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /quality/defects': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'PATCH /quality/defects/:defectId': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'DELETE /quality/defects/:defectId': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'POST /quality/defects/starter': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'GET /quality/dispositions': { audiences: ['office'], permission: 'quality.defects.view', scope: 'tenant' },
  'POST /quality/dispositions': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'PATCH /quality/dispositions/:dispositionId': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'POST /quality/dispositions/standard': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  // B-W2b-90: the defect vocabulary (QHS-002 severity, QHS-004 causes, QHS-006 grades and hide defects, QHS-007 the
  // picker in the person's language). The same two permissions; the vocabulary read is any office or floor session's,
  // as the picker's: codes and words, nothing personal or secret.
  'GET /quality/severity': { audiences: ['office'], permission: 'quality.defects.view', scope: 'tenant' },
  'GET /quality/causes': { audiences: ['office'], permission: 'quality.defects.view', scope: 'tenant' },
  'POST /quality/causes': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'PATCH /quality/causes/:causeId': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'DELETE /quality/causes/:causeId': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'POST /quality/causes/starter': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'GET /quality/grades': { audiences: ['office'], permission: 'quality.defects.view', scope: 'tenant' },
  'POST /quality/grades': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'PATCH /quality/grades/:gradeId': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'POST /quality/grades/starter': { audiences: ['office'], permission: 'quality.defects.manage', scope: 'tenant' },
  'GET /quality/vocabulary': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
  'GET /quality/vocabulary/coverage': { audiences: ['office'], permission: 'quality.defects.view', scope: 'tenant' },
})
