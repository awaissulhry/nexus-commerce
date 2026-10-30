import { Banknote, FileText, SlidersHorizontal, Receipt } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Finance (A2 §1.3 row 11; design 01 office "finance / Amministrazione", after Compliance): getting paid — invoices from
 * shipped goods through SDI with their status, deposit invoices and credit notes (SCR-080, the record SCR-081), payments
 * placed on deposits and invoices (SCR-082), and the finance settings invoicing reads (SCR-083). Receivables, supplier
 * invoices, bank, costing, margins and the accounting export come with W2a/W2b. Labels are message keys (`shell:` =
 * messages/<locale>/shell.json); each row's permission is the one its page's API needs.
 */
export const officeArea: OfficeAreaNav = {
  order: 11,
  area: {
    id: 'finance',
    label: 'shell:nav.finance.area',
    href: '/finance',
    icon: Receipt,
    phone: 'more',
    sections: [
      {
        id: 'finance-main',
        label: 'shell:nav.finance.main',
        hideLabel: true,
        noCrumb: true,
        items: [
          // SCR-080 / SCR-081: invoices, deposit invoices and credit notes, from shipped goods to SDI (invoices.view).
          { id: 'finance-invoices', label: 'shell:nav.finance.invoices', href: '/finance/invoices', icon: FileText, permission: 'invoices.view' },
          // SCR-082: payments received and where they are placed (payments.view).
          { id: 'finance-payments', label: 'shell:nav.finance.payments', href: '/finance/payments', icon: Banknote, permission: 'payments.view' },
        ],
      },
      {
        id: 'finance-settings',
        label: 'shell:nav.finance.settingsGroup',
        items: [
          // SCR-083: what invoicing reads per company (GET /invoicing/settings: invoices.view).
          { id: 'finance-settings-page', label: 'shell:nav.finance.settings', href: '/finance/settings', icon: SlidersHorizontal, permission: 'invoices.view' },
        ],
      },
    ],
  },
}
