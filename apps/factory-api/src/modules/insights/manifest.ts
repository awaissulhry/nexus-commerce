import { defineManifest } from '../../core/manifest'

/**
 * Home › Today (B-W1-52; A2 SCR-029, SCR-031 W1 "Overview"): office only (floor, portal and link sessions are refused by
 * audience). home.view reaches the page; what it shows is filtered row by row by the person's other permissions (each
 * source with scopeWhere, each row with can() in factory-domain insights: `record`). The actions on a row (assign,
 * resolve, acknowledge) need home.view to reach and, row by row, the right to act on the row's record
 * (actingPermission: `record`); a layout is the person's own.
 */
export const manifest = defineManifest({
  'GET /home/today': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/flow': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/waiting-on-others': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/today/handled': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/today/rows/:key/assignees': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /home/today/rows/:key/assign': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /home/today/rows/:key/resolve': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /home/today/rows/:key/acknowledge': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/today/layout': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'PUT /home/today/layout': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  // B-W2a-20: Snooze (an alert row, the record's act right), Nudge (my own waits), Coming up (my next working days).
  'POST /home/today/rows/:key/snooze': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /home/waiting-on-others/:key/nudge': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/coming-up': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  // B-W2a-79 (reports/): My numbers reach with home.view (each number asks its list's permission and grain); the report
  // library and its reports with home.reports.view (each report asks its list's permission, and its grain: `record`).
  'GET /home/numbers': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /reports': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  'GET /reports/:key': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  'GET /reports/:key/results': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  'GET /reports/:key/schedule': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
})
