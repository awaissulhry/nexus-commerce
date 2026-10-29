import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The office side of the floor sync (apps/factory-api platform/floor-sync; B-W0-30; PLT-239; design floor.sync
 * connections "Production › Labour & corrections", "Admin › Devices & printers"): the actions the floor tablets' queues
 * sent that the server refused, with the reason in words and one fix, for the people who must act. Checked with can()
 * against the tablet's company and site. A floor session sees and discards its own tablet's refused actions with
 * floor.work; these are never floor permissions. No figure here is per person (Statuto dei Lavoratori art. 4): a list
 * names devices and stations, one record names its worker.
 */
export const FLOOR_SYNC_DEFINITIONS = definePermissions('floorsync', {
  view: { risk: 'read', description: "See the actions the floor tablets' offline queues sent that were refused, why in words, and their one fix." },
  discard: { risk: 'write', description: "Discard a floor tablet's refused action with a reason: it will not be recorded, and the tablet stops showing it." },
})

export const FLOOR_SYNC_VIEW = 'floorsync.view' satisfies Permission
export const FLOOR_SYNC_DISCARD = 'floorsync.discard' satisfies Permission

export const FLOOR_SYNC_PERMISSIONS: readonly Permission[] = Object.freeze([FLOOR_SYNC_VIEW, FLOOR_SYNC_DISCARD])
