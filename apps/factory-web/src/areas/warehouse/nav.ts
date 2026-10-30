import { ArrowLeftRight, Boxes, Layers, MapPin, PackageCheck, Settings, Squircle, Truck, Warehouse } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Warehouse (design 01 area 6 "Warehouse / Magazzino": Main (Stock, Hides, Lots & traceability, Movements), Inbound (Receipts),
 * In the warehouse, Outbound, Reports, Settings). Labels are message keys (`shell:` = messages/<locale>/shell.json). Each
 * row's permission is the one its page's API needs. Main › Stock, Hides, Lots & traceability, Movements and Settings ›
 * Locations (SCR-060, SCR-200, SCR-201, SCR-064, SCR-065): the stock screens step. B-W1-32 part 2 builds Inbound › Receipts (SCR-063, with the
 * receipt's lots and hides one by one, SCR-061/062; inventory.stock.view: warehouse, buyer, planner, read-only, the
 * owner); the shipping steps (B-W1-46 … 49, part 2) build Outbound › Shipments (SCR-066, its record SCR-067:
 * shipping.view) and Settings › Carriers & shipping (SCR-068: shipping.settings.view). The other pages join with their
 * steps, in the tree's order.
 */
export const officeArea: OfficeAreaNav = {
  order: 6,
  area: {
    id: 'warehouse',
    label: 'shell:nav.warehouse.area',
    href: '/warehouse',
    icon: Warehouse,
    phone: 'more',
    sections: [
      {
        id: 'warehouse-main',
        label: 'shell:nav.warehouse.main',
        hideLabel: true,
        noCrumb: true,
        // SCR-060 stock, SCR-200 hides one by one, SCR-201 lots with their trace, SCR-064 the ledger (inventory.stock.view).
        items: [
          { id: 'warehouse-stock', label: 'shell:nav.warehouse.stock', href: '/warehouse/stock', icon: Boxes, permission: 'inventory.stock.view' },
          { id: 'warehouse-hides', label: 'shell:nav.warehouse.hides', href: '/warehouse/hides', icon: Squircle, permission: 'inventory.stock.view' },
          { id: 'warehouse-lots', label: 'shell:nav.warehouse.lots', href: '/warehouse/lots', icon: Layers, permission: 'inventory.stock.view' },
          { id: 'warehouse-moves', label: 'shell:nav.warehouse.moves', href: '/warehouse/moves', icon: ArrowLeftRight, permission: 'inventory.stock.view' },
        ],
      },
      {
        id: 'warehouse-inbound',
        label: 'shell:nav.warehouse.inbound',
        items: [{ id: 'warehouse-receipts', label: 'shell:nav.warehouse.receipts', href: '/warehouse/receipts', icon: PackageCheck, permission: 'inventory.stock.view' }],
      },
      {
        id: 'warehouse-outbound',
        label: 'shell:nav.warehouse.outbound',
        // SCR-066 / SCR-067: the ship-today queue with the carrier cut-off, then every shipment and its record.
        items: [{ id: 'warehouse-shipments', label: 'shell:nav.warehouse.shipments', href: '/warehouse/shipments', icon: Truck, permission: 'shipping.view' }],
      },
      {
        id: 'warehouse-settings',
        label: 'shell:nav.warehouse.settings',
        // SCR-065: the site's places (warehouses, zones, bins); SCR-068: each site's shipping settings (the carrier
        // account, ship-from and return addresses, defaults, printers).
        items: [
          { id: 'warehouse-locations', label: 'shell:nav.warehouse.locations', href: '/warehouse/locations', icon: MapPin, permission: 'inventory.locations.view' },
          { id: 'warehouse-shipping', label: 'shell:nav.warehouse.shipping', href: '/warehouse/shipping', icon: Settings, permission: 'shipping.settings.view' },
        ],
      },
    ],
  },
}
