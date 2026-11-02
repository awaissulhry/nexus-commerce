import { defineManifest } from '../../../core/manifest'

/**
 * Floor My day (B-W2b-68; MES-111, MES-112, MES-261; c.c. art. 2101; GDPR art. 15). The floor only: the device's own site
 * (`site`), the signed-in worker's own day, with the PIN again where a figure is read (the handlers ask requireFloorStepUp).
 * The tile's badge names no figure and asks no PIN.
 */
export const manifest = defineManifest({
  'GET /people/myday': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /people/myday/answers': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /people/myday/statements/:statementId/pdf': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /people/myday/statements/:statementId/print': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
})
