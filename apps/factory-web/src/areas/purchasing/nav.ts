import { Factory, FileText, Inbox, ShoppingCart, Truck, Undo2 } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Purchasing (design 01 area 5 "Purchasing / Acquisti", group Main with no label). Labels are message keys
 * (`shell:` = messages/<locale>/shell.json). B-W1-07 builds Suppliers (SCR-056, its record SCR-057: the same party
 * record as Customers, parties.view); the purchase-order steps add their rows here when their pages are built.
 */
export const officeArea: OfficeAreaNav = {
  order: 5,
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
        items: [
          { id: 'purchasing-suppliers', label: 'shell:nav.purchasing.suppliers', href: '/purchasing/suppliers', icon: Truck, permission: 'parties.view' },
          // B-W2a-69: Requests to buy (SCR-236; GET /purchasing/requests).
          { id: 'purchasing-requests', label: 'shell:nav.purchasing.requests', href: '/purchasing/requests', icon: Inbox, permission: 'purchasing.view' },
          { id: 'purchasing-orders', label: 'shell:nav.purchasing.orders', href: '/purchasing/orders', icon: FileText, permission: 'purchasing.view' },
        ],
      },
      // B-W2a-56: Outside work › Subcontract orders (SCR-128; its view Stock at subcontractors, SCR-129).
      {
        id: 'purchasing-outside',
        label: 'shell:nav.purchasing.outside',
        items: [{ id: 'purchasing-subcontracting', label: 'shell:nav.purchasing.subcontracting', href: '/purchasing/subcontracting', icon: Factory, permission: 'purchasing.view' }],
      },
      // B-W2a-63: Sourcing & claims › Returns & claims (SCR-131). RFQs & sourcing (W2b) joins before it with its step.
      {
        id: 'purchasing-claims',
        label: 'shell:nav.purchasing.sourcingClaims',
        items: [{ id: 'purchasing-claims', label: 'shell:nav.purchasing.claims', href: '/purchasing/claims', icon: Undo2, permission: 'purchasing.view' }],
      },
    ],
  },
}
