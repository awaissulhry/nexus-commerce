import { defineManifest } from '../../../core/manifest'

/**
 * The role risk sheets (B-W2b-128; QHS-236; design plant.risk "Role sheets", people.employees "Role"). Office only; safety.view
 * reads a sheet, safety.rolesheets.manage keeps them (add, preview and apply, archive, restore, the pickers); a person's role
 * is the HR record's: people.view reads it, people.employees.manage previews and changes it. Handlers check each record with
 * can() against its company and site (`record`).
 */
const view = { audiences: ['office'], permission: 'safety.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'safety.rolesheets.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /safety/rolesheets': view,
  'GET /safety/rolesheets/catalogue': manage,
  'GET /safety/rolesheets/:roleSheetId': view,
  'POST /safety/rolesheets': manage,
  'POST /safety/rolesheets/:roleSheetId/preview': manage,
  'POST /safety/rolesheets/:roleSheetId/apply': manage,
  'POST /safety/rolesheets/:roleSheetId/archive': manage,
  'POST /safety/rolesheets/:roleSheetId/restore': manage,
  'GET /people/employees/:employeeId/role-sheet': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'POST /people/employees/:employeeId/role-sheet/preview': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
  'PUT /people/employees/:employeeId/role-sheet': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
})
