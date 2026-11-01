import { defineManifest, PUBLIC } from '../../../core/manifest'

/**
 * Line targets and boards (B-W2b-50; MES-084, MES-161, MES-162, MES-166, ANA-007; design production.floor "Hour by hour",
 * "WIP by operation" heat map, "Why was 10:00–11:00 short?", the new tab "Line TV board"; floor.display SCR-173). The
 * office reads the boards with production.boards.view, sets a line's hourly targets with production.boards.targets and
 * gives a short hour's reason with production.boards.reason; the floor shares view and reason (the team leader's line
 * view, its own site). Handlers check each line and site with can() (`record`).
 *
 * The line TV of a DISPLAY device is public like GET /floor/device: nobody signs in on it (B-W2b-52), the handler checks
 * the device token itself (a live DISPLAY device of an active site and tenant) and reads only the line it shows.
 */
export const manifest = defineManifest({
  'GET /production/boards/targets': { audiences: ['office'], permission: 'production.boards.view', scope: 'record' },
  'PUT /production/boards/targets': { audiences: ['office'], permission: 'production.boards.targets', scope: 'record' },
  'POST /production/boards/targets/:targetId/reason': { audiences: ['office', 'floor'], permission: 'production.boards.reason', scope: 'record' },
  'GET /production/boards/hourly': { audiences: ['office', 'floor'], permission: 'production.boards.view', scope: 'record' },
  'GET /production/boards/heatmap': { audiences: ['office'], permission: 'production.boards.view', scope: 'record' },
  'GET /production/boards/tv': { audiences: ['office', 'floor'], permission: 'production.boards.view', scope: 'record' },
  'GET /production/boards/display': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
