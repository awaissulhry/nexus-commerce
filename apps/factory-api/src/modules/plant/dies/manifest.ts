import { defineManifest } from '../../../core/manifest'

/**
 * The clicking-die register (B-W2b-136; QHS-173; design plant.machines "Clicking dies"): office only; plant.view reads,
 * plant.machines.manage registers, changes and retires (the plant's register of machines and equipment, dies included).
 * Handlers check each die with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /plant/dies': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/dies/styles': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/dies/choices': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/dies': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'PATCH /plant/dies/:dieId': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
  'POST /plant/dies/:dieId/retire': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'record' },
})
