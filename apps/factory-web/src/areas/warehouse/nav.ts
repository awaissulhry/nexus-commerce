import { PackageCheck, Warehouse } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Warehouse (A2 §1.3 row 7; design 01 warehouse: Main (Stock, Hides, Lots & traceability, Movements), Inbound (Receipts),
 * Outbound, Setup). Labels are message keys (`shell:` = messages/<locale>/shell.json). B-W1-32 part 2 builds Inbound ›
 * Receipts (SCR-063, with the receipt's lots and hides one by one, SCR-061/062; inventory.stock.view: warehouse, buyer,
 * planner, read-only, the owner). The other pages join with their steps.
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
    ],
  },
}
