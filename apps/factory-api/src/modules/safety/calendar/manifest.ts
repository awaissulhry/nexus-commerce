import { defineManifest } from '../../../core/manifest'

/**
 * The safety calendar (B-W2b-120; QHS-227; design plant.calendar). Office only; safety.view reads the calendar and its
 * tiles, safety.calendar.manage keeps the deadlines typed here (the others are kept on their own pages). Handlers check
 * each record with can() against its company and site (`record`).
 */
export const manifest = defineManifest({
  'GET /safety/calendar': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/calendar/counts': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/deadlines/owners': { audiences: ['office'], permission: 'safety.calendar.manage', scope: 'record' },
  'GET /safety/deadlines/:deadlineId': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'POST /safety/deadlines': { audiences: ['office'], permission: 'safety.calendar.manage', scope: 'record' },
  'PATCH /safety/deadlines/:deadlineId': { audiences: ['office'], permission: 'safety.calendar.manage', scope: 'record' },
  'POST /safety/deadlines/:deadlineId/done': { audiences: ['office'], permission: 'safety.calendar.manage', scope: 'record' },
  'POST /safety/deadlines/:deadlineId/cancel': { audiences: ['office'], permission: 'safety.calendar.manage', scope: 'record' },
})
