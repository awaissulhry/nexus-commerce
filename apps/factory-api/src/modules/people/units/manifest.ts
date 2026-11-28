import { defineManifest } from '../../../core/manifest'

/**
 * The factory structure (owb-ss5 steps 5.2 + 5.3; _owb-ss-common L3): office only (the designer and the floor have no route here:
 * the floor audience is absent, and the designer's role holds neither right). people.view reads the units, the people, a unit's
 * profile and the histories; people.structure.manage keeps the structure: add, change, move, merge and close units and apply a
 * ready-made structure. The leader stays today's PUT /people/teams/:teamId/lead (people.teams.manage); a person's own record
 * stays today's employee routes. Handlers check each record with can() against its company and site (`record`).
 */
export const manifest = defineManifest({
  'GET /people/structure': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/units/:unitId': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/units/:unitId/history': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/employees/:employeeId/history': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'POST /people/units': { audiences: ['office'], permission: 'people.structure.manage', scope: 'record' },
  'PATCH /people/units/:unitId': { audiences: ['office'], permission: 'people.structure.manage', scope: 'record' },
  'POST /people/units/:unitId/move': { audiences: ['office'], permission: 'people.structure.manage', scope: 'record' },
  'POST /people/units/merge': { audiences: ['office'], permission: 'people.structure.manage', scope: 'record' },
  'POST /people/units/:unitId/close': { audiences: ['office'], permission: 'people.structure.manage', scope: 'record' },
  'POST /people/units/ready-made/preview': { audiences: ['office'], permission: 'people.structure.manage', scope: 'record' },
  'POST /people/units/ready-made/apply': { audiences: ['office'], permission: 'people.structure.manage', scope: 'record' },
})
