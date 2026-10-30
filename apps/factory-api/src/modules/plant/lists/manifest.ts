import { defineManifest } from '../../../core/manifest'

/**
 * The machine classes and the symptoms (B-W2a-35; QHS-162, QHS-178; design plant.machines "Type", plant.settings
 * "Symptoms on the floor", SCR-241): the whole group's lists (scope `tenant`). Reading the classes needs plant.view in the
 * office; the symptoms also any floor device that reports (plant.report: the station's tiles). Every write needs
 * plant.machines.manage, and the handler asks it over every company.
 */
export const manifest = defineManifest({
  'GET /plant/classes': { audiences: ['office'], permission: 'plant.view', scope: 'tenant' },
  'POST /plant/classes': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'tenant' },
  'PATCH /plant/classes/:classId': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'tenant' },
  'GET /plant/symptoms': { audiences: ['office'], permission: 'plant.view', scope: 'tenant' },
  'POST /plant/symptoms': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'tenant' },
  'PATCH /plant/symptoms/:symptomId': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'tenant' },
  'POST /plant/starter': { audiences: ['office'], permission: 'plant.machines.manage', scope: 'tenant' },
})
