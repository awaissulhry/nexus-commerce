import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: the chemical register and the safety data sheet library (apps/factory-api modules/safety/chemicals;
 * B-W2b-143; QHS-277, QHS-278; design plant.chemicals, SCR-213), in the safety area. Reading the register and the data
 * sheets is safety.view (../organisation/permissions.ts): no person, no money, so every role that reads the safety
 * calendar reads it too. A tablet of the site reads its own site's register and current sheets with floor.work (the
 * cabinet QR, offline); it never writes. Checked with can() against the chemical's company and site.
 *
 *   safety.chemicals.manage   add a chemical to the register (supplier, use, GHS pictograms, H and P statements, place and
 *                             cabinet, most kept, roles and PPE), change or archive it, upload a safety data sheet and
 *                             replace the current one (the older one is kept, superseded).
 */
export const SAFETY_CHEMICALS_DEFINITIONS = definePermissions('safety', {
  'chemicals.manage': {
    risk: 'write',
    description:
      'Keep the chemical register (D.Lgs. 81/2008 art. 223): add a chemical with its supplier, use, GHS pictograms, hazard and precautionary statements, place and cabinet, the most kept, the roles that use it and the PPE to handle it; change or archive it; upload its safety data sheet and replace the current one with a newer version (REACH art. 35; the older one is kept, superseded).',
  },
})

export const SAFETY_CHEMICALS_MANAGE = 'safety.chemicals.manage' satisfies Permission

export const SAFETY_CHEMICALS_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_CHEMICALS_MANAGE])
