import { defineManifest } from '../../../core/manifest'

/**
 * The chemical register and the safety data sheet library (B-W2b-143; QHS-277, QHS-278; design plant.chemicals). Office:
 * safety.view reads (no person, no money), safety.chemicals.manage keeps the register and replaces the sheets; handlers
 * check each chemical with can() against its company and site (`record`). Floor: floor.work at the device's own site reads
 * what the tablet keeps for the cabinet QR (offline), never writes.
 */
export const manifest = defineManifest({
  'GET /safety/chemicals': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/chemicals/counts': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/chemicals/data-sheets': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/chemicals/cabinets': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/chemicals/cabinets/:siteId/:code': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/chemicals/choices': { audiences: ['office'], permission: 'safety.chemicals.manage', scope: 'record' },
  'GET /safety/chemicals/:chemicalId': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'POST /safety/chemicals': { audiences: ['office'], permission: 'safety.chemicals.manage', scope: 'record' },
  'PATCH /safety/chemicals/:chemicalId': { audiences: ['office'], permission: 'safety.chemicals.manage', scope: 'record' },
  'POST /safety/chemicals/:chemicalId/archive': { audiences: ['office'], permission: 'safety.chemicals.manage', scope: 'record' },
  'POST /safety/chemicals/:chemicalId/restore': { audiences: ['office'], permission: 'safety.chemicals.manage', scope: 'record' },
  'POST /safety/chemicals/:chemicalId/data-sheets/upload': { audiences: ['office'], permission: 'safety.chemicals.manage', scope: 'record' },
  'POST /safety/chemicals/:chemicalId/data-sheets/upload/:fileId/complete': { audiences: ['office'], permission: 'safety.chemicals.manage', scope: 'record' },
  'POST /safety/chemicals/:chemicalId/data-sheets': { audiences: ['office'], permission: 'safety.chemicals.manage', scope: 'record' },
  'GET /safety/chemicals/:chemicalId/data-sheets/:sheetId/download': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/floor/chemicals': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /safety/floor/data-sheets/:sheetId/download': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
