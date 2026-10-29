import { Contact, Handshake } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Sales (A2 §1.3 row 2; design 01 office "sales", group Main with no label). Labels are message keys (`shell:` =
 * messages/<locale>/shell.json). B-W1-07 builds Customers (SCR-032, its record SCR-033: one party record, parties.view);
 * the quotes and orders steps add their rows here when their pages are built (no row before its page opens).
 */
export const officeArea: OfficeAreaNav = {
  order: 2,
  area: {
    id: 'sales',
    label: 'shell:nav.sales.area',
    href: '/sales',
    icon: Handshake,
    phone: 'tab',
    sections: [
      {
        id: 'sales-main',
        label: 'shell:nav.sales.main',
        hideLabel: true,
        noCrumb: true,
        items: [{ id: 'sales-customers', label: 'shell:nav.sales.customers', href: '/sales/customers', icon: Contact, permission: 'parties.view' }],
      },
    ],
  },
}
