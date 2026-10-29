import { defineManifest } from '../../core/manifest'

/**
 * Home › Today (B-W1-52; A2 SCR-029, SCR-031 W1 "Overview"): office only (floor, portal and link sessions are refused by
 * audience). home.view reaches the page; what it shows is filtered row by row by the person's other permissions (each
 * source with scopeWhere, each row with can() in factory-domain insights: `record`). Read only.
 */
export const manifest = defineManifest({
  'GET /home/today': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/flow': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/waiting-on-others': { audiences: ['office'], permission: 'home.view', scope: 'record' },
})
