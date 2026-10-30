import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * The defect library and the disposition codes (B-W2a-26; QHS-001, QHS-005; design quality.defects SCR-079). Both are
 * the whole group's (scope `tenant`): reading needs quality.defects.view; every write quality.defects.manage, and the
 * handler asks it over every company. The pickers (the bench, the floor's tiles, the office's inspection) read the
 * active defects with any office or floor session: nothing personal or secret.
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
})
