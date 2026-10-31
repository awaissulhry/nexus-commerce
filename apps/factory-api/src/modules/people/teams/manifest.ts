import { defineManifest } from '../../../core/manifest'

/**
 * Lines, teams and leads, loans to another line, and the org tree (B-W2b-26; MES-210, PLT-020, PLT-005): office only.
 * people.view reads the teams and loans (My team: people.team.view), people.teams.manage keeps the teams, leads and
 * moves, people.loans.manage the loans; the site's areas are its structure (sites.view, sites.manage). Handlers check
 * each record with can() against its company and site (`record`).
 */
export const manifest = defineManifest({
  'GET /people/teams': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/teams/mine': { audiences: ['office'], permission: 'people.team.view', scope: 'record' },
  'GET /people/teams/:teamId': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'POST /people/teams': { audiences: ['office'], permission: 'people.teams.manage', scope: 'record' },
  'PATCH /people/teams/:teamId': { audiences: ['office'], permission: 'people.teams.manage', scope: 'record' },
  'POST /people/teams/:teamId/archive': { audiences: ['office'], permission: 'people.teams.manage', scope: 'record' },
  'PUT /people/teams/:teamId/lead': { audiences: ['office'], permission: 'people.teams.manage', scope: 'record' },
  'POST /people/teams/moves/preview': { audiences: ['office'], permission: 'people.teams.manage', scope: 'record' },
  'POST /people/teams/moves': { audiences: ['office'], permission: 'people.teams.manage', scope: 'record' },
  'GET /people/loans': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'POST /people/loans': { audiences: ['office'], permission: 'people.loans.manage', scope: 'record' },
  'POST /people/loans/:loanId/end': { audiences: ['office'], permission: 'people.loans.manage', scope: 'record' },
  'POST /people/loans/:loanId/remove': { audiences: ['office'], permission: 'people.loans.manage', scope: 'record' },
  'GET /org/tree': { audiences: ['office'], permission: 'sites.view', scope: 'record' },
  'POST /org/sites/:siteId/areas': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'PATCH /org/areas/:areaId': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'POST /org/areas/:areaId/archive': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
  'PUT /org/lines/:lineId/area': { audiences: ['office'], permission: 'sites.manage', scope: 'record' },
})
