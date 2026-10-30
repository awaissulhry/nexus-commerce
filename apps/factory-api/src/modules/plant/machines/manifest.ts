import { defineManifest } from '../../../core/manifest'

/**
 * The machine and equipment register (B-W2a-35; QHS-162; design plant.machines SCR-150): office only; plant.view reads,
 * plant.machines.manage registers, changes and retires. Handlers check each machine with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /plant/machines': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/machines/counts': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/machines/:machineId': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/machines': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'PATCH /plant/machines/:machineId': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'POST /plant/machines/:machineId/retire': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
})
