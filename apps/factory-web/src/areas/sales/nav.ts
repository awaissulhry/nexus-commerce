import { FileText, Handshake } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Sales (A2 §1.3 row 2; design 01 §3.2 "Sales / Vendite"): from the first inquiry to a confirmed order. Labels are
 * message keys (`shell:` = messages/<locale>/shell.json). B-W1-21/24 build Quotes (SCR-034, SCR-035); Customers and
 * Orders join the Main group with their own steps.
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
          // SCR-034 / SCR-035 (B-W1-21, B-W1-24): quotes by style, colour and size with price, margin, approval and send.
          { id: 'sales-quotes', label: 'shell:nav.sales.quotes', href: '/sales/quotes', icon: FileText, permission: 'quotes.view' },
        ],
      },
    ],
  },
}
