import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The shipping module's permissions (apps/factory-api modules/shipping; features LOG-001, LOG-002, LOG-039, LOG-117;
 * A2 SCR-066, SCR-067, SCR-068, SCR-098). Each is checked with can() against the shipment's company, site and party
 * (the settings: the site's company and the site); a floor device packs at its own site only (can() pins it, row-level
 * security too). Declared in `auth/permissions/catalogue.ts` (FACTORY_PERMISSIONS). Nothing here carries money.
 */
export const SHIPPING_DEFINITIONS = definePermissions('shipping', {
  view: { risk: 'read', description: 'See the shipments and their lines, parcels and serials, and what each sales order has released and not yet shipped.' },
  manage: { risk: 'write', description: "Plan a shipment from a sales order's released garments, change its lines and delivery details, and cancel it." },
  pack: { risk: 'write', description: 'Pack a shipment: parcels, which garments go in which parcel, serials, weights and sizes, packed and unpacked; print its packing list (a floor device: at its own site).' },
  'settings.view': { risk: 'read', description: "See each site's shipping settings: sender and return addresses, default carrier and service, packing printers, cut-off." },
  'settings.manage': { risk: 'write', description: "Change a site's shipping settings." },
})

export const SHIPPING_VIEW = 'shipping.view' satisfies Permission
export const SHIPPING_MANAGE = 'shipping.manage' satisfies Permission
export const SHIPPING_PACK = 'shipping.pack' satisfies Permission
export const SHIPPING_SETTINGS_VIEW = 'shipping.settings.view' satisfies Permission
export const SHIPPING_SETTINGS_MANAGE = 'shipping.settings.manage' satisfies Permission

export const SHIPPING_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_VIEW, SHIPPING_MANAGE, SHIPPING_PACK, SHIPPING_SETTINGS_VIEW, SHIPPING_SETTINGS_MANAGE])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): packing at its own site. Never shipping or cancelling. */
export const SHIPPING_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_PACK])
