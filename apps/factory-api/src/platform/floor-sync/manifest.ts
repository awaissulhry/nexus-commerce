import { defineManifest } from '../../core/manifest'

/**
 * The floor sync's routes (B-W0-30; PLT-237, PLT-239, PLT-240, PLT-189): the tablet sends its queue, reads and discards
 * its own refused actions (floor.work at its own site; each queued kind's own permission is checked per event with
 * can()); the office reads the refused actions of the sites it reaches and discards them with a reason (record: can() on
 * the tablet's company and site, scopeWhere() for the list).
 */
export const manifest = defineManifest({
  'POST /floor/sync': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /floor/sync': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /floor/sync/refused/:refusedId/discard': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /floor-sync/refused': { audiences: ['office'], permission: 'floorsync.view', scope: 'record' },
  'GET /floor-sync/refused/:refusedId': { audiences: ['office'], permission: 'floorsync.view', scope: 'record' },
  'POST /floor-sync/refused/:refusedId/discard': { audiences: ['office'], permission: 'floorsync.discard', scope: 'record' },
  // B-W2b-52 (MES-196): offline conflicts go to the lead (floor.lead at the tablet's site); the office reads them too.
  'GET /floor/sync/conflicts': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'GET /floor/sync/conflicts/:refusedId': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'POST /floor/sync/conflicts/:refusedId/decide': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'GET /floor-sync/conflicts': { audiences: ['office'], permission: 'floorsync.view', scope: 'record' },
})
