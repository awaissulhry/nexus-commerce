import { ClipboardList, Contact, FileText, Handshake, Tags } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Sales (design 01 area 2 "Sales / Vendite", group Main with no label). Labels are message keys (`shell:` =
 * messages/<locale>/shell.json). B-W1-07 builds Customers (SCR-032, its record SCR-033: one party record, parties.view);
 * B-W1-21/24 build Quotes (SCR-034, SCR-035); B-W1-25 part 2 builds Orders (SCR-038 list and board, SCR-039 the order
 * studio with the deposit: orders.view).
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
        items: [
          { id: 'sales-customers', label: 'shell:nav.sales.customers', href: '/sales/customers', icon: Contact, permission: 'parties.view' },
          // SCR-034 / SCR-035 (B-W1-21, B-W1-24): quotes by style, colour and size with price, margin, approval and send.
          { id: 'sales-quotes', label: 'shell:nav.sales.quotes', href: '/sales/quotes', icon: FileText, permission: 'quotes.view' },
          // SCR-038 / SCR-039 (B-W1-25): orders from accepted quotes, the board by state, the order studio with the deposit.
          { id: 'sales-orders', label: 'shell:nav.sales.orders', href: '/sales/orders', icon: ClipboardList, permission: 'orders.view' },
        ],
      },
      // SCR-106 (B-W2a-49): Pricing › Price lists & contracts — customer price lists by dated version, their customers.
      {
        id: 'sales-pricing',
        label: 'shell:nav.sales.pricing',
        items: [{ id: 'sales-pricelists', label: 'shell:nav.sales.pricelists', href: '/sales/price-lists', icon: Tags, permission: 'pricelists.view' }],
      },
    ],
  },
}
