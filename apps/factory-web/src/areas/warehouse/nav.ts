import { PackageCheck, Settings, Truck, Warehouse } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Warehouse (A2 §1.3 row 7; design 01 warehouse: Main (Stock, Hides, Lots & traceability, Movements), Inbound (Receipts),
 * In the warehouse, Outbound, Reports, Settings). Labels are message keys (`shell:` = messages/<locale>/shell.json). Each
 * row's permission is the one its page's API needs. B-W1-32 part 2 builds Inbound › Receipts (SCR-063, with the
 * receipt's lots and hides one by one, SCR-061/062; inventory.stock.view: warehouse, buyer, planner, read-only, the
 * owner); the shipping steps (B-W1-46 … 49, part 2) build Outbound › Shipments (SCR-066, its record SCR-067:
 * shipping.view) and Settings › Carriers & shipping (SCR-068: shipping.settings.view). The other pages join with their
 * steps, in the tree's order.
 */
export const officeArea: OfficeAreaNav = {
  order: 7,
  area: {
    id: 'warehouse',
    label: 'shell:nav.warehouse.area',
    href: '/warehouse',
    icon: Warehouse,
    phone: 'more',
    sections: [
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
        // SCR-068: each site's shipping settings (the carrier account, ship-from and return addresses, defaults, printers).
        items: [{ id: 'warehouse-shipping', label: 'shell:nav.warehouse.shipping', href: '/warehouse/shipping', icon: Settings, permission: 'shipping.settings.view' }],
      },
    ],
  },
}
