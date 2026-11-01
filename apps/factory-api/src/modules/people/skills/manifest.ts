import { defineManifest } from '../../../core/manifest'

/**
 * Skills and machine authorisations (B-W2b-39; MES-241, MES-244, MES-246, MES-024): office routes check each person (or
 * skill) with can() against their company and site (`record`); people.skills.view reads, people.skills.manage keeps the
 * skills, levels and trainees (a sign-off is a signing act: the office's fresh code), people.authorisations.manage the
 * machine authorisations. The floor's qualification check reads at the device's own site with floor.work (`site`).
 */
export const manifest = defineManifest({
  'GET /people/skills': { audiences: ['office'], permission: 'people.skills.view', scope: 'record' },
  'POST /people/skills': { audiences: ['office'], permission: 'people.skills.manage', scope: 'record' },
  'PATCH /people/skills/:skillId': { audiences: ['office'], permission: 'people.skills.manage', scope: 'record' },
  'POST /people/skills/:skillId/archive': { audiences: ['office'], permission: 'people.skills.manage', scope: 'record' },
  'POST /people/skills/:skillId/restore': { audiences: ['office'], permission: 'people.skills.manage', scope: 'record' },
  'GET /people/skills/matrix': { audiences: ['office'], permission: 'people.skills.view', scope: 'record' },
  'GET /people/skills/cell': { audiences: ['office'], permission: 'people.skills.view', scope: 'record' },
  'GET /people/employees/:employeeId/skills': { audiences: ['office'], permission: 'people.skills.view', scope: 'record' },
  'POST /people/skills/levels': { audiences: ['office'], permission: 'people.skills.manage', scope: 'record' },
  'POST /people/skills/levels/:levelId/sign-off': { audiences: ['office'], permission: 'people.skills.manage', scope: 'record' },
  'POST /people/skills/levels/:levelId/remove': { audiences: ['office'], permission: 'people.skills.manage', scope: 'record' },
  'POST /people/skills/authorisations': { audiences: ['office'], permission: 'people.authorisations.manage', scope: 'record' },
  'POST /people/skills/authorisations/:authorisationId/valid-until': { audiences: ['office'], permission: 'people.authorisations.manage', scope: 'record' },
  'POST /people/skills/authorisations/:authorisationId/revoke': { audiences: ['office'], permission: 'people.authorisations.manage', scope: 'record' },
  'GET /people/skills/check': { audiences: ['office'], permission: 'people.skills.view', scope: 'record' },
  'GET /people/skills/line-check': { audiences: ['office'], permission: 'people.skills.view', scope: 'record' },
  'GET /people/skills/floor/check': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
