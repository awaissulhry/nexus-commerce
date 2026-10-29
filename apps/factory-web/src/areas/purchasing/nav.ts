import { ShoppingCart, Truck } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Purchasing (A2 §1.3 row 6; design 01 office "purchasing", group Main with no label). Labels are message keys
 * (`shell:` = messages/<locale>/shell.json). B-W1-07 builds Suppliers (SCR-056, its record SCR-057: the same party
 * record as Customers, parties.view); the purchase-order steps add their rows here when their pages are built.
 */
export const officeArea: OfficeAreaNav = {
  order: 6,
  area: {
    id: 'purchasing',
    label: 'shell:nav.purchasing.area',
    href: '/purchasing',
    icon: ShoppingCart,
    phone: 'more',
    sections: [
      {
        id: 'purchasing-main',
        label: 'shell:nav.purchasing.main',
        hideLabel: true,
        noCrumb: true,
        items: [{ id: 'purchasing-suppliers', label: 'shell:nav.purchasing.suppliers', href: '/purchasing/suppliers', icon: Truck, permission: 'parties.view' }],
      },
    ],
  },
}
