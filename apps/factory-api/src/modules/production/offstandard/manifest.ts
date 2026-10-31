import { defineManifest } from '../../../core/manifest'

/**
 * Off-standard and indirect time (B-W2b-29; MES-155 … MES-158). The office: the codes (production.offstandard.view |
 * codes, checked with can() on the code's company) and the blocks (view | approve, on the block's company and site; lists
 * filtered with scopeWhere()) — `record`. The floor: the device's own site (`site`): floor.work starts and ends the
 * signed-in worker's (or the station's) block and reads the tiles; floor.lead lets a team leader approve or reject the
 * site's waiting blocks with the PIN.
 */
export const manifest = defineManifest({
  'GET /production/offstandard/codes': { audiences: ['office'], permission: 'production.offstandard.view', scope: 'record' },
  'POST /production/offstandard/codes': { audiences: ['office'], permission: 'production.offstandard.codes', scope: 'record' },
  'PATCH /production/offstandard/codes/:codeId': { audiences: ['office'], permission: 'production.offstandard.codes', scope: 'record' },
  'GET /production/offstandard/blocks': { audiences: ['office'], permission: 'production.offstandard.view', scope: 'record' },
  'GET /production/offstandard/counts': { audiences: ['office'], permission: 'production.offstandard.view', scope: 'record' },
  'POST /production/offstandard/blocks': { audiences: ['office'], permission: 'production.offstandard.approve', scope: 'record' },
  'POST /production/offstandard/blocks/approve': { audiences: ['office'], permission: 'production.offstandard.approve', scope: 'record' },
  'GET /production/offstandard/blocks/:blockId': { audiences: ['office'], permission: 'production.offstandard.view', scope: 'record' },
  'POST /production/offstandard/blocks/:blockId/approve': { audiences: ['office'], permission: 'production.offstandard.approve', scope: 'record' },
  'POST /production/offstandard/blocks/:blockId/reject': { audiences: ['office'], permission: 'production.offstandard.approve', scope: 'record' },
  'POST /production/offstandard/blocks/:blockId/reopen': { audiences: ['office'], permission: 'production.offstandard.approve', scope: 'record' },
  'POST /production/offstandard/blocks/:blockId/correct': { audiences: ['office'], permission: 'production.offstandard.approve', scope: 'record' },
  'POST /production/offstandard/blocks/:blockId/end': { audiences: ['office'], permission: 'production.offstandard.approve', scope: 'record' },
  'GET /production/offstandard/floor': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /production/offstandard/floor/start': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /production/offstandard/floor/end': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /production/offstandard/floor/lead': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'POST /production/offstandard/floor/lead/:blockId/approve': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
  'POST /production/offstandard/floor/lead/:blockId/reject': { audiences: ['floor'], permission: 'floor.lead', scope: 'site' },
})
