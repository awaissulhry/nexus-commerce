import { defineManifest } from '../../../core/manifest'

/**
 * The machine and equipment register (B-W2a-35; QHS-162; design plant.machines SCR-150): office only; plant.view reads,
 * plant.machines.manage registers, changes and retires. Handlers check each machine with can() (`record`).
 *
 * B-W2b-136 (machines in depth; QHS-164, QHS-165, QHS-167): the register's depth (tiles, next check, CE on file, tag
 * printed), the status wall, Change status (out of do-not-use: plant.signSafe and a fresh code, checked in the handler),
 * the status history, Documents & CE (files kept with plant.machines.manage through the tenant's system caller), and the
 * QR tags sent to a label printer (print.labels at the printer's site, checked by platform/print).
 */
export const manifest = defineManifest({
  'GET /plant/machines': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/machines/counts': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/machines/:machineId': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/machines': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'PATCH /plant/machines/:machineId': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'POST /plant/machines/:machineId/retire': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  // B-W2b-136: machines in depth.
  'GET /plant/machines/depth': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/machines/attention': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/machines/wall': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/machines/:machineId/status': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'GET /plant/machines/:machineId/status-history': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/machines/:machineId/documents': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/machines/:machineId/documents': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'POST /plant/machines/:machineId/documents/:fileId/complete': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'GET /plant/machines/:machineId/documents/:fileId/download': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/machines/:machineId/documents/:fileId/remove': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'GET /plant/machines/tags/printers': { audiences: ['office'], permission: 'print.labels', scope: 'record' },
  'POST /plant/machines/tags/print': { audiences: ['office'], permission: 'print.labels', scope: 'record' },
  'GET /plant/machines/tags/jobs': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
})
